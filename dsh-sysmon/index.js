/**
 * 系统资源监视 —— Host 半。
 *
 * 对外两条同源路由：
 *
 *   GET /sysmon/metrics     CPU / 内存占用（Node 的 os 采样，毫秒级返回）
 *   GET /sysmon/processes   CPU / 内存各排前 5 的进程
 *
 * 为什么 Windows 上要养一个常驻 PowerShell：本机每次创建 pwsh 进程约 2–3 秒
 * （安全软件扫描进程创建），按需 spawn 会让「悬停看进程」先等好几秒。常驻进程
 * 启动一次，之后每采一次约 0.9 秒（含 700ms 的采样窗口），空闲时阻塞在 stdin 上
 * 不耗 CPU。页面加载时先把它暖起来；连续 3 分钟没人看进程就杀掉，下次悬停再启动。
 *
 * 口径：
 *   - CPU 百分比是「占整机」的比例（除以逻辑核数），与任务管理器一致，
 *     所有进程加起来接近系统总占用；
 *   - 进程内存取 WorkingSet64；只读进程名，不读命令行，避免把敏感参数带出去；
 *   - macOS / Linux 用 `ps` 兜底，`pcpu` 是进程生命周期均值（见 cpuMode 字段），
 *     没有常驻采样器。
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cpus, freemem, platform, totalmem, uptime } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'

/** Cordis 插件名。 */
export const name = 'sysmon'
/** 两条路由都挂在 webServer 上；connection 可选（存在时做鉴权检查）。 */
export const inject = ['webServer']

const METRICS_PATH = '/sysmon/metrics'
const PROCESSES_PATH = '/sysmon/processes'
/** 榜单长度：需求就是前 5。 */
const TOP_COUNT = 5
/** 首次 CPU 采样窗口；之后直接用两次请求间的差值，不必再等。 */
const CPU_SAMPLE_MS = 250
/** 进程 CPU 的采样窗口：越短越灵敏，但太短会让榜单抖动。 */
const PROCESS_SAMPLE_MS = 700
/** 进程快照复用窗口：页面每 10 秒拉一次，这个值让同一轮悬停不会重复采样。 */
const PROCESS_CACHE_MS = 10_000
/** 一次进程请求最多等多久（含 PowerShell 冷启动）。 */
const PROCESS_WAIT_MS = 9_000
/** 常驻采样器空闲多久后杀掉：页面一直开着但没人悬停时不白占内存。 */
const HELPER_IDLE_MS = 180_000
/** 启动失败后的冷却时间，避免每个请求都重试拉起一个坏掉的采样器。 */
const HELPER_RETRY_MS = 60_000
/** 单行 JSON 的兜底大小；正常约 2 KB，超过说明输出异常。 */
const MAX_LINE_LENGTH = 512 * 1024

/**
 * 常驻采样器的 PowerShell 脚本。
 *
 * 用 stdin 收命令、stdout 回一行 JSON：只有 host 发 `S` 时才采样，其余时间
 * 阻塞在 ReadLine 上。`$PID` 是采样器自己，从榜单里排除，否则它每次都会占一个名额。
 * 所有输出都显式 Flush：stdout 是管道时，PowerShell 默认可能攒着不吐。
 */
const HELPER_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "[Console]::Out.WriteLine('READY')",
  '[Console]::Out.Flush()',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  "  if ($line.Trim() -ne 'S') { continue }",
  '  try {',
  '    $first = @{}',
  '    foreach ($p in Get-Process) { $first[[int]$p.Id] = [double]$p.CPU }',
  '    $start = Get-Date',
  `    Start-Sleep -Milliseconds ${PROCESS_SAMPLE_MS}`,
  '    $elapsed = ((Get-Date) - $start).TotalSeconds',
  '    $cores = [Environment]::ProcessorCount',
  '    if ($elapsed -le 0) { $elapsed = 0.001 }',
  '    $rows = foreach ($p in Get-Process) {',
  '      $procId = [int]$p.Id',
  '      if ($procId -eq $PID) { continue }',
  '      $before = $first[$procId]',
  '      $delta = if ($null -ne $before) { [double]$p.CPU - $before } else { 0 }',
  '      $pct = [Math]::Max(0, (($delta / $elapsed) / $cores) * 100)',
  '      [pscustomobject]@{ pid = $procId; name = $p.ProcessName; cpu = [math]::Round($pct, 1); mem = [int64]$p.WorkingSet64 }',
  '    }',
  `    $topCpu = @($rows | Sort-Object cpu -Descending | Select-Object -First ${TOP_COUNT})`,
  `    $topMem = @($rows | Sort-Object mem -Descending | Select-Object -First ${TOP_COUNT})`,
  '    $json = [pscustomobject]@{ cores = $cores; sampleMs = [int]($elapsed * 1000); processes = @($rows).Count; cpu = $topCpu; mem = $topMem } | ConvertTo-Json -Depth 4 -Compress',
  "    [Console]::Out.WriteLine('SYSMON ' + $json)",
  '    [Console]::Out.Flush()',
  '  } catch {',
  "    [Console]::Out.WriteLine('SYSMON-ERROR ' + $_.Exception.Message)",
  '    [Console]::Out.Flush()',
  '  }',
  '}',
].join('\n')

/** 解析出来的 PowerShell 路径；只探测一次。 */
let resolvedPowerShell

/**
 * 把浮点数夹到 0–100；非有限值当作 0。
 * @param value - 原始百分比。
 */
function clampPercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, number))
}

/**
 * 读一次 CPU 累计时间（所有逻辑核相加）。
 * @returns idle / total 与采样时刻。
 */
function readCpuTimes() {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { idle, total, at: Date.now() }
}

/**
 * 用两次累计时间算占用率。
 * @param before - 上一次采样。
 * @param after - 本次采样。
 */
function cpuPercentBetween(before, after) {
  const total = after.total - before.total
  const idle = after.idle - before.idle
  if (!(total > 0)) return 0
  return clampPercent((1 - idle / total) * 100)
}

/**
 * 读内存占用。
 * @returns 总/可用/已用字节与百分比。
 */
function readMemory() {
  const total = totalmem()
  const free = freemem()
  const used = Math.max(0, total - free)
  return { total, free, used, percent: total > 0 ? (used / total) * 100 : 0 }
}

/**
 * 找 PowerShell：优先 PowerShell 7，其次 Windows PowerShell 5.1。
 * @returns 可执行文件路径；非 Windows 返回 null。
 */
function resolvePowerShell() {
  if (platform() !== 'win32') return null
  if (resolvedPowerShell !== undefined) return resolvedPowerShell
  const candidates = []
  for (const key of ['ProgramFiles', 'ProgramW6432']) {
    const root = process.env[key]
    if (typeof root === 'string' && root !== '') candidates.push(join(root, 'PowerShell', '7', 'pwsh.exe'))
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        resolvedPowerShell = candidate
        return candidate
      }
    } catch {
      /* 单个候选不可读就继续看下一个 */
    }
  }
  resolvedPowerShell = 'powershell.exe'
  return resolvedPowerShell
}

/**
 * 清洗一条进程记录：只保留能确定归属的字段，数值全部夹到合法范围。
 * @param item - PowerShell 输出的一行。
 * @param key - `cpu` 或 `mem`（排序依据）。
 * @returns 记录数组；非法项丢弃。
 */
function sanitizeRows(value, key) {
  const rows = []
  if (!Array.isArray(value)) return rows
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const pid = Number(item.pid)
    const processName = typeof item.name === 'string' ? item.name.trim() : ''
    if (!Number.isFinite(pid) || pid < 0 || processName === '') continue
    rows.push({
      pid: Math.trunc(pid),
      name: processName.slice(0, 80),
      cpu: clampPercent(item.cpu),
      mem: Math.max(0, Number(item.mem) || 0),
    })
  }
  return rows.sort((left, right) => right[key] - left[key]).slice(0, TOP_COUNT)
}

/**
 * 把采样器吐的一行 JSON 变成快照。
 * @param text - `SYSMON ` 之后的 JSON。
 * @returns 快照；格式不对返回 null。
 */
function parseSample(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const cores = Number(raw.cores)
  const processCount = Number(raw.processes)
  const sampleMs = Number(raw.sampleMs)
  return {
    at: Date.now(),
    cpuMode: 'interval',
    cores: Number.isFinite(cores) && cores > 0 ? Math.trunc(cores) : 0,
    processCount: Number.isFinite(processCount) && processCount >= 0 ? Math.trunc(processCount) : 0,
    sampleMs: Number.isFinite(sampleMs) && sampleMs > 0 ? Math.trunc(sampleMs) : 0,
    cpu: sanitizeRows(raw.cpu, 'cpu'),
    mem: sanitizeRows(raw.mem, 'mem'),
  }
}

/**
 * execFile 的 Promise 包装；失败时把 stderr 带出来。
 * @param file - 可执行文件。
 * @param args - 参数。
 * @param timeout - 超时毫秒。
 */
function runProcess(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr ?? '').trim() || error.message))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/**
 * macOS / Linux 的进程榜：`ps` 一次采样，pcpu 是生命周期均值。
 * @returns 与 Windows 采样器同形的快照。
 */
async function collectPosixProcesses() {
  const stdout = await runProcess('ps', ['-eo', 'pid=,pcpu=,rss=,comm='], PROCESS_WAIT_MS)
  const cpu = []
  const mem = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
    if (match === null) continue
    const processName = match[4].trim()
    if (processName === '') continue
    const row = {
      pid: Number(match[1]),
      name: processName.slice(0, 80),
      cpu: clampPercent(match[2]),
      mem: Math.max(0, Number(match[3]) * 1024),
    }
    cpu.push(row)
    mem.push(row)
  }
  return {
    at: Date.now(),
    cpuMode: 'lifetime',
    cores: cpus().length,
    processCount: cpu.length,
    sampleMs: 0,
    cpu: cpu.sort((left, right) => right.cpu - left.cpu).slice(0, TOP_COUNT),
    mem: mem.sort((left, right) => right.mem - left.mem).slice(0, TOP_COUNT),
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * 安装资源监视：两条路由 + 进程采样器的生命周期。
 * @param ctx - 拥有路由与 effect 的插件上下文。
 */
export function apply(ctx) {
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[sysmon] ${message}`)
    } catch {
      /* 日志失败不影响采样 */
    }
  }

  // ---- CPU：第一次等 250ms，之后用两次请求的差值 ----
  /** 上一次 CPU 累计时间。 */
  let lastCpu = null
  /** 同一时刻只跑一个采样窗口。 */
  let pendingCpu = null

  /**
   * 当前 CPU 占用率。
   * @returns `{ percent, windowMs }`。
   */
  function readCpuPercent() {
    if (pendingCpu !== null) return pendingCpu
    if (lastCpu !== null && Date.now() - lastCpu.at >= 1000) {
      const current = readCpuTimes()
      const percent = cpuPercentBetween(lastCpu, current)
      const windowMs = Math.max(1, current.at - lastCpu.at)
      lastCpu = current
      return Promise.resolve({ percent, windowMs })
    }
    pendingCpu = new Promise((resolve) => {
      const before = readCpuTimes()
      setTimeout(() => {
        const after = readCpuTimes()
        lastCpu = after
        resolve({ percent: cpuPercentBetween(before, after), windowMs: Math.max(1, after.at - before.at) })
      }, CPU_SAMPLE_MS)
    }).finally(() => {
      pendingCpu = null
    })
    return pendingCpu
  }

  // ---- 进程：Windows 常驻采样器 / 其它平台按需 ps ----
  /** 最近一次快照。 */
  let processCache = null
  /** 正在等下一份快照的请求。 */
  let processWaiters = []
  /** 常驻采样器与其读行器。 */
  let helper = null
  let helperReader = null
  let helperBusy = false
  let helperReady = false
  let helperFailedUntil = 0
  let helperKillTimer = null
  /** 一次采样最多允许跑多久；卡住就杀掉重来，避免 helperBusy 永远为真。 */
  let helperWatchdog = null
  /** 页面加载时暖一次；空闲杀掉后不再由 metrics 轮询重新拉起。 */
  let helperWarmed = false
  /** 采样器报错时的最后一条信息，只进日志和 reason，不进页面文案。 */
  let helperError = ''

  /** 采样器的停止：kill 子进程、关闭读行器、唤醒等待者。 */
  function dropHelper() {
    const child = helper
    helper = null
    helperBusy = false
    helperReady = false
    if (helperKillTimer !== null) {
      clearTimeout(helperKillTimer)
      helperKillTimer = null
    }
    if (helperWatchdog !== null) {
      clearTimeout(helperWatchdog)
      helperWatchdog = null
    }
    if (helperReader !== null) {
      try {
        helperReader.close()
      } catch {
        /* 已经随子进程结束 */
      }
      helperReader = null
    }
    if (child !== null && child.exitCode === null) {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
    }
  }

  /**
   * 唤醒所有等待者。
   * @param payload - 成功快照或失败占位。
   */
  function settleWaiters(payload) {
    const waiting = processWaiters
    processWaiters = []
    for (const waiter of waiting) {
      clearTimeout(waiter.timer)
      waiter.resolve(payload)
    }
  }

  /**
   * 把快照包装成路由响应。
   * @param snapshot - 进程快照。
   * @param fromCache - 是否直接复用了缓存。
   */
  function processPayload(snapshot, fromCache) {
    return {
      ok: true,
      available: true,
      cached: fromCache,
      ageMs: Math.max(0, Date.now() - snapshot.at),
      sampledAt: snapshot.at,
      cpuMode: snapshot.cpuMode,
      cores: snapshot.cores,
      sampleMs: snapshot.sampleMs,
      processCount: snapshot.processCount,
      cpu: snapshot.cpu,
      mem: snapshot.mem,
    }
  }

  /**
   * 失败占位：页面据此显示「采样中/读取失败」，不抛 500。
   * @param reason - `warming` / `timeout` / `unavailable`。
   */
  function unavailable(reason) {
    return { ok: false, available: false, cached: false, reason }
  }

  /** 收到采样器的一行输出。 */
  function handleHelperLine(line) {
    const text = line.trim()
    if (text === 'READY') {
      helperReady = true
      return
    }
    if (text.startsWith('SYSMON-ERROR ')) {
      if (helperWatchdog !== null) {
        clearTimeout(helperWatchdog)
        helperWatchdog = null
      }
      helperError = text.slice('SYSMON-ERROR '.length).slice(0, 300)
      helperBusy = false
      log('warn', `进程采样失败：${helperError}`)
      settleWaiters(unavailable('unavailable'))
      return
    }
    if (!text.startsWith('SYSMON ')) return
    if (helperWatchdog !== null) {
      clearTimeout(helperWatchdog)
      helperWatchdog = null
    }
    const snapshot = parseSample(text.slice('SYSMON '.length))
    helperBusy = false
    if (snapshot === null) {
      log('warn', '进程采样输出无法解析，已丢弃这一份。')
      settleWaiters(unavailable('unavailable'))
      return
    }
    processCache = snapshot
    settleWaiters(processPayload(snapshot, false))
  }

  /** 拉起常驻采样器；失败时进入冷却期。 */
  function spawnHelper() {
    if (helper !== null) return helper
    if (Date.now() < helperFailedUntil) return null
    const exe = resolvePowerShell()
    if (exe === null) return null
    let child
    try {
      child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64')], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      helperError = error instanceof Error ? error.message : String(error)
      helperFailedUntil = Date.now() + HELPER_RETRY_MS
      log('warn', `进程采样器启动失败：${helperError}`)
      return null
    }
    helper = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    helperReader = readline.createInterface({ input: child.stdout })
    helperReader.on('line', handleHelperLine)
    child.stderr?.on('data', (chunk) => {
      helperError = String(chunk).trim().slice(0, 300)
    })
    child.stdin?.on('error', () => {
      /* 子进程退出时写 stdin 会 EPIPE；exit 回调会统一收尾 */
    })
    child.on('error', (error) => {
      // 已经被替换掉的旧子进程，它的迟到事件不能影响新采样器的等待者。
      if (helper !== child) return
      helperError = error instanceof Error ? error.message : String(error)
      helperFailedUntil = Date.now() + HELPER_RETRY_MS
      log('warn', `进程采样器启动失败：${helperError}`)
      dropHelper()
      settleWaiters(unavailable('unavailable'))
    })
    child.on('exit', () => {
      if (helper !== child) return
      // 还没 READY 就退出，多半是路径/执行策略问题：冷却一分钟再试，
      // 否则每个悬停都会重新拉起一个必然失败的进程。
      if (!helperReady) helperFailedUntil = Date.now() + HELPER_RETRY_MS
      dropHelper()
      settleWaiters(unavailable('unavailable'))
    })
    return child
  }

  /** 空闲计时：连续 HELPER_IDLE_MS 没人要进程就杀掉采样器。 */
  function touchHelper() {
    if (helperKillTimer !== null) clearTimeout(helperKillTimer)
    helperKillTimer = setTimeout(() => {
      helperKillTimer = null
      if (helper !== null && !helperBusy) {
        log('info', '进程采样器空闲，已停止。')
        dropHelper()
      } else if (helper !== null) {
        // 正好在采样：等这一份回来再重新计时。
        touchHelper()
      }
    }, HELPER_IDLE_MS)
    if (typeof helperKillTimer === 'object' && helperKillTimer !== null && typeof helperKillTimer.unref === 'function') {
      helperKillTimer.unref()
    }
  }

  /** 页面加载时先暖一次采样器，让第一次悬停不必等冷启动。 */
  function warmHelper() {
    if (helperWarmed || platform() !== 'win32') return
    helperWarmed = true
    if (spawnHelper() !== null) touchHelper()
  }

  /** 发一次采样命令；已有采样在跑时直接复用。 */
  function requestSample() {
    touchHelper()
    if (helperBusy) return
    if (Date.now() < helperFailedUntil) {
      settleWaiters(unavailable('unavailable'))
      return
    }
    const child = spawnHelper()
    if (child === null) {
      settleWaiters(unavailable('unavailable'))
      return
    }
    if (child.stdin === null || child.stdin.destroyed) {
      helperFailedUntil = Date.now() + HELPER_RETRY_MS
      dropHelper()
      settleWaiters(unavailable('unavailable'))
      return
    }
    try {
      child.stdin.write('S\n')
      helperBusy = true
      if (helperWatchdog !== null) clearTimeout(helperWatchdog)
      helperWatchdog = setTimeout(() => {
        helperWatchdog = null
        if (!helperBusy) return
        helperError = 'sample timeout'
        helperFailedUntil = Date.now() + HELPER_RETRY_MS
        log('warn', '进程采样超时，已停止采样器并在下一轮重试。')
        dropHelper()
        settleWaiters(unavailable('timeout'))
      }, PROCESS_WAIT_MS + 6_000)
      if (typeof helperWatchdog === 'object' && helperWatchdog !== null && typeof helperWatchdog.unref === 'function') {
        helperWatchdog.unref()
      }
    } catch (error) {
      helperError = error instanceof Error ? error.message : String(error)
      helperFailedUntil = Date.now() + HELPER_RETRY_MS
      dropHelper()
      settleWaiters(unavailable('unavailable'))
    }
  }

  /**
   * 取进程榜：缓存够新就秒回，否则等下一份采样。
   * @returns 路由响应体。
   */
  function readWindowsProcesses() {
    if (processCache !== null && Date.now() - processCache.at < PROCESS_CACHE_MS) {
      return Promise.resolve(processPayload(processCache, true))
    }
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null }
      waiter.timer = setTimeout(() => {
        processWaiters = processWaiters.filter((entry) => entry !== waiter)
        // 超时也把上一份数据交出去，页面至少不会空着。
        resolve(processCache === null ? unavailable('timeout') : processPayload(processCache, true))
      }, PROCESS_WAIT_MS)
      processWaiters.push(waiter)
      requestSample()
    })
  }

  /**
   * 进程路由的入口：Windows 走常驻采样器，其它平台按需 ps。
   * @returns 路由响应体。
   */
  async function readProcesses() {
    if (platform() !== 'win32') {
      if (processCache !== null && Date.now() - processCache.at < PROCESS_CACHE_MS) {
        return processPayload(processCache, true)
      }
      processCache = await collectPosixProcesses()
      return processPayload(processCache, false)
    }
    return readWindowsProcesses()
  }

  // ---- 鉴权围栏：与 token-usage 同源同法 ----
  const reject = (req, res) => {
    const connection = ctx.get('connection')
    if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') return false
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: METRICS_PATH,
        handler: (req, res) => {
          if (reject(req, res)) return
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }
          warmHelper()
          readCpuPercent()
            .then((cpu) => {
              const memory = readMemory()
              sendJson(res, 200, {
                ok: true,
                ts: Date.now(),
                platform: platform(),
                uptimeSec: Math.round(uptime()),
                cpu: {
                  percent: Math.round(cpu.percent * 10) / 10,
                  windowMs: cpu.windowMs,
                  cores: cpus().length,
                  model: cpus()[0]?.model ?? '',
                },
                mem: {
                  total: memory.total,
                  free: memory.free,
                  used: memory.used,
                  percent: Math.round(memory.percent * 10) / 10,
                },
              })
            })
            .catch((error) => {
              log('warn', `CPU 采样失败：${error instanceof Error ? error.message : String(error)}`)
              sendJson(res, 500, { ok: false, reason: 'unavailable' })
            })
        },
      }),
    `sysmon: GET ${METRICS_PATH}`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PROCESSES_PATH,
        handler: (req, res) => {
          if (reject(req, res)) return
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }
          readProcesses()
            .then((payload) => sendJson(res, 200, payload))
            .catch((error) => {
              helperError = error instanceof Error ? error.message : String(error)
              log('warn', `读取进程榜失败：${helperError}`)
              sendJson(res, 200, unavailable('unavailable'))
            })
        },
      }),
    `sysmon: GET ${PROCESSES_PATH}`,
  )

  ctx.effect(
    () => () => {
      settleWaiters(unavailable('stopped'))
      dropHelper()
    },
    'sysmon: stop process sampler',
  )

  log('info', `已启用：GET ${METRICS_PATH}、${PROCESSES_PATH}`)
}
