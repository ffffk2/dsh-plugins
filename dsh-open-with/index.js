/**
 * 通用「用其他应用打开工作区」——Host 半。
 *
 * DSH 自带的「打开方式」是一张编译期写死的白名单（@deepseek-ai/dsh-host-open-in-app
 * 的 OPEN_IN_APP_CATALOG），部署方没法从 cordis.yml 往里加条目。本插件补上这个缺口：
 * 应用列表完全由配置声明，加一个新编辑器/IDE/终端只需要在 profile 的
 * cordis.patch.yml 里加一条 app，不用改代码、不用重新打包。
 *
 * 暴露三条路由（相对路径，浏览器直接 fetch 即可；跨源请求会被 connection 围栏挡掉）：
 *
 *   GET  /open-with/apps?path=<绝对路径>  本机实际可用、且在该工作区允许的应用 [{ id, label }]
 *   GET  /open-with/icon/<id>             该应用的真实图标（Windows 从 exe 提取，或配置的图标文件）
 *   POST /open-with/open                  用指定应用打开一个目录：{ app, path }
 *
 * 设计取舍：
 *   - 只有「能验证出可执行文件」的应用才会出现在列表里，绝不把裸的安装记录当成可启动项。
 *   - 解析结果每个进程只算一次；启动时发现 exe 已消失（ENOENT）就当场重解析该条目一次，
 *     所以卸载方向能自愈，装新应用则要重启 DSH 才会出现（和官方行为一致）。
 *   - 启动器一律用 argv 数组 spawn，绝不过 shell，目录里的空格引号无需转义。
 *   - 启动是 detached 的：DSH 退出后应用继续活着；看护窗口内非零退出才算失败。
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { stat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { platform as osPlatform } from 'node:os'

/** Cordis 插件名。 */
export const name = 'open-with'

/** 需要 webServer 承载路由；connection 可选（存在时用来做同源鉴权）。 */
export const inject = ['webServer']

/** 应用列表路由。 */
const APPS_PATH = '/open-with/apps'
/** 图标路由前缀。 */
const ICON_PREFIX_PATH = '/open-with/icon'
/** 启动路由。 */
const OPEN_PATH = '/open-with/open'

/** 请求体上限：只有两个短字符串，超过这个尺寸一律当成恶意请求。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 开箱即用的默认条目。
 *
 * 换成别的编辑器时，改 profile 里的 apps 即可；这里是「什么配置都没写」时的兜底，
 * 保证插件装上就能用（目标机器上装了 CodeBuddy 才会有这一项，没装就是空列表）。
 */
const DEFAULT_APPS = [
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    exe: [
      '${ProgramFiles}/CodeBuddy CN/CodeBuddy CN.exe',
      '${ProgramW6432}/CodeBuddy CN/CodeBuddy CN.exe',
      '${LOCALAPPDATA}/Programs/CodeBuddy CN/CodeBuddy CN.exe',
      '${ProgramFiles}/CodeBuddy/CodeBuddy.exe',
    ],
    registry: { displayNamePrefix: 'CodeBuddy CN', exe: ['CodeBuddy CN.exe', 'CodeBuddy.exe'] },
  },
  {
    id: 'cmd',
    label: '命令提示符',
    platforms: ['win32'],
    shell: true,
    // 起始目录由 start /d 负责，所以 /k 之后不需要再 cd；保留 /k 让窗口停住不关。
    exe: ['${SystemRoot}/System32/cmd.exe'],
    args: ['/k'],
    // 终端不是单实例应用：start 找不到目录/程序时会以非零码退出，不能像编辑器那样吞掉。
    tolerateExitCode: false,
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    platforms: ['win32'],
    shell: true,
    exe: ['${SystemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe'],
    // -NoExit：执行完 Set-Location 后保持窗口；-LiteralPath 避免路径里的 [ ] 被当通配符。
    // 这里再显式 Set-Location 一次，保证窗口里的位置和 start /d 一致（例如手滑改了配置时）。
    args: ['-NoExit', '-Command', "Set-Location -LiteralPath '{path}'"],
    tolerateExitCode: false,
  },
]

// ---------------------------------------------------------------------------
// 配置归一化
// ---------------------------------------------------------------------------

/**
 * 把 `{ VAR }` / `%VAR%` / 开头的 `~/` 展开成真实路径。
 * @param template - 候选路径模板。
 * @param env - 读取环境变量的载体（便于测试注入）。
 * @returns 展开后的路径；引用了未定义的变量时返回 null。
 */
export function expandTemplate(template, env = process.env) {
  if (typeof template !== 'string' || template === '') return null
  let missing = false
  const replaced = template.replace(/\$\{([^}]+)\}/g, (_token, variableName) => {
    const value = env[variableName]
    if (value === undefined) {
      missing = true
      return ''
    }
    return value
  })
  if (missing) return null
  const percentExpanded = replaced.replace(/%([^%]+)%/g, (token, variableName) => {
    const value = env[variableName]
    if (value === undefined) {
      missing = true
      return token
    }
    return value
  })
  if (missing) return null
  if (percentExpanded.startsWith('~/')) {
    const home = env.USERPROFILE ?? env.HOME ?? ''
    return home === '' ? null : join(home, percentExpanded.slice(2))
  }
  return percentExpanded
}

/** 把配置里的数组字段归一化成字符串数组（容忍单个字符串）。 */
function toStringArray(value) {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item !== '')
}

/**
 * 同 {@link toStringArray}，但去掉首尾空白并丢弃空项。
 * 只用于 id / 路径模式这类「空白没有意义」的字段；`args` 不能这么处理。
 */
function toTrimmedArray(value) {
  return toStringArray(value)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * 归一化一条 app 配置。
 * @param raw - cordis.patch.yml 里的原始对象。
 * @param index - 在 apps 数组中的下标，用于生成兜底 id。
 * @returns 归一化后的条目，字段缺失时给安全默认值。
 */
export function normalizeApp(raw, index) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  const id = typeof source.id === 'string' && source.id.trim() !== '' ? source.id.trim() : `app-${index}`
  const registrySource = typeof source.registry === 'object' && source.registry !== null ? source.registry : undefined
  return {
    id,
    label: typeof source.label === 'string' && source.label.trim() !== '' ? source.label.trim() : id,
    platforms: toStringArray(source.platforms),
    exe: toStringArray(source.exe),
    registry: registrySource === undefined ? undefined : {
      displayNamePrefix: typeof registrySource.displayNamePrefix === 'string' ? registrySource.displayNamePrefix : '',
      exe: toStringArray(registrySource.exe),
    },
    args: toStringArray(source.args),
    // 应用自己的工作目录模板：终端类应用靠它实现「进到子模块再跑命令」，
    // 例如先 cd 到 web/ 再 npm run serve。支持 {path} 与环境变量；相对路径
    // 按工作区解析，不写则沿用工作区目录（终端类）。
    cwd: typeof source.cwd === 'string' && source.cwd.trim() !== '' ? source.cwd.trim() : undefined,
    env: typeof source.env === 'object' && source.env !== null ? { ...source.env } : undefined,
    iconPath: typeof source.iconPath === 'string' && source.iconPath !== '' ? source.iconPath : undefined,
    watchMs: typeof source.watchMs === 'number' && source.watchMs > 0 ? source.watchMs : undefined,
    // Electron 系编辑器（CodeBuddy、Cursor、VS Code…）已经开着时，新进程会把请求
    // 转交给已运行的实例再退出，退出码往往不是 0。这种「单实例接手」不是失败，
    // 所以默认容忍非零退出；要求严格判断的启动器可以设成 false。
    tolerateExitCode: source.tolerateExitCode !== false,
    // 终端类应用（cmd / powershell）必须由 shell 分配一个新的控制台窗口，
    // 直接 spawn 出来的子进程没有窗口站归属，用户看不到任何东西。
    shell: source.shell === true,
  }
}

/**
 * 归一化一条工作区规则。
 *
 * `match` 里的模式按声明顺序匹配会话的工作区目录；`apps` 是命中的工作区里
 * 允许展示的应用 id。`apps` 写成空数组是合法配置，表示这个工作区不显示按钮。
 *
 * @param raw - cordis.patch.yml 里的原始对象。
 * @param index - 在 workspaces 数组中的下标（仅用于错误提示）。
 * @returns 归一化后的规则。
 */
export function normalizeWorkspaceRule(raw, index) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  return {
    index,
    match: toTrimmedArray(source.match),
    apps: toTrimmedArray(source.apps),
  }
}

/**
 * 归一化整个插件配置。
 * @param raw - patch 行里的 config（可能为空）。
 * @returns 完整的运行期配置。
 */
export function normalizeConfig(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  const rawApps = Array.isArray(source.apps) && source.apps.length > 0 ? source.apps : DEFAULT_APPS
  const seen = new Set()
  const apps = []
  for (const [index, entry] of rawApps.entries()) {
    const app = normalizeApp(entry, index)
    // 重复 id 会让图标与启动路由指向歧义条目，直接跳过后来者。
    if (seen.has(app.id)) continue
    seen.add(app.id)
    apps.push(app)
  }
  // 单个对象也当一条规则，省得只配一条时多写一对数组括号。
  const rawWorkspaces = Array.isArray(source.workspaces)
    ? source.workspaces
    : source.workspaces === undefined || source.workspaces === null
      ? []
      : [source.workspaces]
  const workspaces = rawWorkspaces
    .map((rule, index) => normalizeWorkspaceRule(rule, index))
    // 没有 match 的规则没有意义，留着反而会让「空规则」意外接管全部工作区。
    .filter((rule) => rule.match.length > 0)
  const positive = (value, fallback) => (typeof value === 'number' && value > 0 ? value : fallback)
  return {
    apps,
    // 有规则才按工作区筛选；没有规则 = 保持旧行为（每个工作区看到同一份清单）。
    workspaces,
    // null 表示「未命中规则时不做限制」，空数组表示「未命中时一个都不展示」。
    // YAML 里写了键但没给值（null）按「没配」处理，避免手滑隐藏全部按钮。
    defaultApps:
      source.defaultApps === undefined || source.defaultApps === null ? null : toTrimmedArray(source.defaultApps),
    probeTimeoutMs: positive(source.probeTimeoutMs, 8000),
    iconTimeoutMs: positive(source.iconTimeoutMs, 8000),
    launchWatchMs: positive(source.launchWatchMs, 1200),
  }
}

// ---------------------------------------------------------------------------
// 工作区匹配
// ---------------------------------------------------------------------------

/**
 * 把路径归一化成比较用的键：反斜杠统一成正斜杠、去掉尾部分隔符、
 * Windows 下转小写（NTFS 默认大小写不敏感）。
 *
 * 不做 `//` 折叠：UNC 路径（`\\server\share`）折叠后会和本地根路径混淆。
 *
 * @param value - 工作区目录或配置里的匹配模式。
 * @param platform - process.platform 的值。
 * @returns 归一化后的字符串；非字符串或空串返回 ''。
 */
export function workspaceKey(value, platform) {
  if (typeof value !== 'string' || value === '') return ''
  const slashed = value.replace(/\\/g, '/')
  const trimmed = slashed.replace(/\/+$/, '')
  if (trimmed === '') return slashed === '' ? '' : '/'
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** 转义正则元字符（逐字符处理，便于和通配符分支放在一起）。 */
function escapeRegExpSymbol(character) {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character
}

/**
 * 把通配模式转成正则。
 *
 * 支持的通配符刻意只有三个（不做完整 glob）：
 *   `*`  任意个非 `/` 字符（不跨目录）
 *   `**` 任意个字符（跨目录）
 *   `?`  单个非 `/` 字符
 *
 * 另外把结尾的 `/**` 处理成「目录本身与它的所有子目录」——
 * 写 `D:/code/**` 的人通常不想漏掉 `D:/code` 自己。
 *
 * @param pattern - 已归一化的模式（见 {@link workspaceKey}）。
 * @returns 用于整串匹配的正则。
 */
export function globToRegExp(pattern) {
  let body = pattern
  let includeSelf = false
  if (body.endsWith('/**')) {
    body = body.slice(0, -3)
    includeSelf = true
  }
  let source = ''
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character === '*') {
      if (body[index + 1] === '*') {
        if (body[index - 1] === '/' && body[index + 2] === '/') {
          // `a/**/b`：中间允许零层或多层目录。
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    source += escapeRegExpSymbol(character)
  }
  return new RegExp(`^${source}${includeSelf ? '(?:/.*)?' : ''}$`)
}

/**
 * 判断一个工作区目录是否命中某条匹配模式。
 *
 * 不含通配符的模式按「目录前缀」解释（命中自身与所有子目录），这样最常用的
 * `match: 'D:/code/my-project'` 不必写成 `D:/code/my-project/**`。
 *
 * @param path - 会话的工作区目录。
 * @param pattern - 配置里的匹配模式。
 * @param platform - process.platform 的值。
 * @returns 是否命中。
 */
export function matchesWorkspace(path, pattern, platform) {
  const target = workspaceKey(path, platform)
  const rule = workspaceKey(pattern, platform)
  if (target === '' || rule === '') return false
  if (!/[*?]/.test(rule)) {
    // 根目录（`/`、`C:`）避免拼出 `//` 或 `C://`。
    const prefix = rule.endsWith('/') ? rule : `${rule}/`
    return target === rule || target.startsWith(prefix)
  }
  return globToRegExp(rule).test(target)
}

/**
 * 计算某个工作区允许展示的应用 id 集合。
 *
 * @param config - {@link normalizeConfig} 的结果。
 * @param path - 会话的工作区目录。
 * @param platform - process.platform 的值。
 * @returns 允许的 id 集合；`null` 表示不按工作区限制（配置里没有规则）。
 */
export function allowedAppIds(config, path, platform) {
  const rules = Array.isArray(config?.workspaces) ? config.workspaces : []
  if (rules.length === 0) return null
  if (typeof path === 'string' && path !== '') {
    // 声明顺序即优先级：第一条命中的规则生效，后面的不再看。
    for (const rule of rules) {
      if (rule.match.some((pattern) => matchesWorkspace(path, pattern, platform))) {
        return new Set(rule.apps)
      }
    }
  }
  // 没命中任何规则（或客户端没给路径）：回落到 defaultApps。
  // defaultApps 缺省是 null = 不限制，保持「不配置就不变」的直觉。
  return config.defaultApps === null || config.defaultApps === undefined ? null : new Set(config.defaultApps)
}

// ---------------------------------------------------------------------------
// 宿主探测：注册表 / 文件系统
// ---------------------------------------------------------------------------

/** Windows 卸载记录所在的三个根：用户 hive、64 位机器、32 位视图。 */
const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

/** 跑一条命令拿 stdout；失败（spawn 失败/非零退出/超时）一律返回 null。 */
function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        // reg.exe 在中文控制台按区域码页输出；应用名都是 ASCII，按 utf8 解足够，
        // 中文 DisplayName 即便变成乱码也不影响 ASCII 前缀匹配。
        resolve(Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout))
      },
    )
  })
}

/**
 * 解析 `reg query <root> /s /v DisplayName` 的输出。
 * @param dump - reg.exe 的原始 stdout。
 * @returns 每个子键路径及其 DisplayName。
 */
export function parseDisplayNames(dump) {
  const rows = []
  let currentKey = null
  for (const line of dump.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      currentKey = line.trim()
      continue
    }
    const value = /^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line)
    if (value === null || currentKey === null) continue
    if (value[1].toLowerCase() === 'displayname') rows.push({ key: currentKey, displayName: value[3].trim() })
  }
  return rows
}

/**
 * 解析 `reg query <key>` 的单键输出，取 InstallLocation / DisplayIcon。
 * @param dump - reg.exe 的原始 stdout。
 * @returns 两个字段（缺省为 undefined）。
 */
export function parseInstallValues(dump) {
  const values = {}
  for (const line of dump.split(/\r?\n/)) {
    const value = /^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line)
    if (value === null) continue
    values[value[1].toLowerCase()] = value[3].trim().replace(/^"|"$/g, '')
  }
  return { installLocation: values.installlocation, displayIcon: values.displayicon }
}

/**
 * 按卸载记录找可执行文件：InstallLocation 拼相对路径优先，DisplayIcon 兜底。
 * @param prefix - DisplayName 前缀。
 * @param exeNames - InstallLocation 下的候选相对路径。
 * @param timeoutMs - 每条命令的期限。
 * @param isFile - 判断路径是否为普通文件的钩子（便于测试）。
 * @returns 可执行文件绝对路径，找不到返回 null。
 */
export async function findByRegistry(prefix, exeNames, timeoutMs, isFile = defaultIsFile) {
  if (prefix === '') return null
  for (const root of UNINSTALL_ROOTS) {
    const dump = await runCommand('reg.exe', ['query', root, '/s', '/v', 'DisplayName'], timeoutMs)
    if (dump === null) continue
    for (const row of parseDisplayNames(dump)) {
      if (!row.displayName.startsWith(prefix)) continue
      const values = await runCommand('reg.exe', ['query', row.key], timeoutMs)
      if (values === null) continue
      const { installLocation, displayIcon } = parseInstallValues(values)
      if (installLocation) {
        const base = expandTemplate(installLocation)
        if (base !== null) {
          for (const relative of exeNames) {
            const candidate = join(base, relative)
            if (await isFile(candidate)) return candidate
          }
        }
      }
      if (displayIcon) {
        const bare = displayIcon.replace(/,-?\d+$/, '').trim()
        const expanded = expandTemplate(bare)
        if (expanded !== null && expanded.toLowerCase().endsWith('.exe') && (await isFile(expanded))) return expanded
      }
    }
  }
  return null
}

/** 默认的文件判据。 */
async function defaultIsFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    // ENOENT / EACCES：不可读的候选就不算数。
    return false
  }
}

/**
 * 解析一条 app 在本机是否可用。
 * @param app - 归一化后的条目。
 * @param options - 平台、期限与判据钩子。
 * @returns `{ exe }` 或 null。
 */
export async function resolveApp(app, options) {
  const { platform, probeTimeoutMs, isFile = defaultIsFile } = options
  if (app.platforms.length > 0 && !app.platforms.includes(platform)) return null
  for (const template of app.exe) {
    const expanded = expandTemplate(template)
    if (expanded === null) continue
    if (await isFile(expanded)) return { exe: expanded }
  }
  if (platform === 'win32' && app.registry !== undefined && app.registry.displayNamePrefix !== '') {
    const found = await findByRegistry(app.registry.displayNamePrefix, app.registry.exe, probeTimeoutMs, isFile)
    if (found !== null) return { exe: found }
  }
  return null
}

// ---------------------------------------------------------------------------
// 图标提取
// ---------------------------------------------------------------------------

/** PowerShell 提取 exe 关联图标并转成 base64 PNG 的脚本。 */
function iconScript(exePath) {
  // 单引号字符串里只需把单引号自身翻倍即可安全嵌入路径。
  const quoted = exePath.replace(/'/g, "''")
  return [
    'Add-Type -AssemblyName System.Drawing -ErrorAction Stop;',
    `$icon = [System.Drawing.Icon]::ExtractAssociatedIcon('${quoted}');`,
    'if ($icon -ne $null) {',
    '  $bitmap = $icon.ToBitmap();',
    '  $memory = New-Object System.IO.MemoryStream;',
    '  $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png);',
    '  [Convert]::ToBase64String($memory.ToArray())',
    '}',
  ].join(' ')
}

/**
 * 取一个应用图标的 PNG 字节。
 * @param app - 归一化后的条目。
 * @param exe - 已解析的可执行文件。
 * @param options - 平台、期限、命令执行钩子。
 * @returns PNG 字节，或 null。
 */
export async function loadIcon(app, exe, options) {
  const { platform, iconTimeoutMs, run = runCommand } = options
  if (app.iconPath !== undefined) {
    const path = expandTemplate(app.iconPath)
    if (path !== null) {
      try {
        return await readFile(path)
      } catch {
        // 回落到从 exe 提取。
      }
    }
  }
  if (platform !== 'win32') return null
  const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', iconScript(exe)], iconTimeoutMs)
  if (output === null) return null
  const base64 = output.trim()
  if (base64 === '') return null
  try {
    return Buffer.from(base64, 'base64')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

/**
 * 不该传给 GUI 编辑器的环境变量。
 *
 * 最关键的是 `ELECTRON_RUN_AS_NODE`：DSH 桌面版自己是 Electron 应用，进程环境里
 * 带着这个变量，一旦原样传给被启动的编辑器，那个 Electron 应用就会以「纯 Node」
 * 模式运行——于是它把命令行里的目录当成脚本路径去 require，报
 * `Cannot find module '<目录>'` 然后静默退出，用户看到的就是「点了没反应」。
 *
 * 其余几个是 Electron/Chromium 的内部调试开关，同样不该外泄：
 * 子进程会继承 `--inspect`/`--remote-debugging-port` 之类的行为，甚至抢占端口。
 */
const EDITOR_ENV_BLOCKLIST = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_FORCE_IS_PACKAGED',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'NODE_OPTIONS',
  'NODE_ENV',
  'NODE_EXTRA_CA_CERTS',
]

/**
 * 生成给被启动应用的环境：父进程环境减去 Electron/Node 内部变量，
 * 再叠加调用方显式声明的变量。
 *
 * 「凭据类变量不隐式外泄」这件事 DSH 已经在 subprocess 层做过一遍，这里
 * 只补它没覆盖的 Electron 运行时开关，避免重复定义一套太激进的黑名单。
 *
 * @param extra - 配置里显式声明的环境变量。
 * @param parent - 父进程环境（便于测试注入）。
 * @returns 可直接交给 spawn 的环境对象。
 */
export function launchEnvironment(extra, parent = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    // Windows 环境变量名大小写不敏感，所以按大写比较。
    if (EDITOR_ENV_BLOCKLIST.includes(key.toUpperCase())) continue
    env[key] = value
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) continue
      // 显式声明的值优先，且不受黑名单限制：调用方明确要传就传。
      env[key] = String(value)
    }
  }
  return env
}

/** 启动失败里「可执行文件不见了」这一类，用于触发一次重解析。 */
function isMissingExecutable(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT'
}

/**
 * 把目录 token 塞进 argv；没有 token 就追加到末尾。
 *
 * `appendPath: false` 用于终端类应用：它们的起始目录已经由 `start /d` 指定，
 * 再把目录当普通参数追加进去会变成 `cmd /k <目录>`——cmd 会把它当成一条命令去执行，
 * 结果是窗口一闪而过或者干脆不开。
 *
 * @param args - 配置里的参数模板。
 * @param path - 目标目录。
 * @param options - `appendPath`（默认 true）控制无 token 时是否追加目录。
 * @returns 实际 argv。
 */
export function launchArgs(args, path, options = {}) {
  if (args.some((arg) => arg.includes('{path}'))) {
    return args.map((arg) => arg.replaceAll('{path}', path))
  }
  return options.appendPath === false ? [...args] : [...args, path]
}

/**
 * 解析应用启动时的工作目录。
 *
 * 模板先代入 `{path}`（工作区目录），再展开 `${VAR}` / `%VAR%` / `~/`；
 * 结果不是绝对路径时按工作区拼接。这样配置里写 `call-center-web` 或
 * `{path}/call-center-web` 都能用。
 *
 * @param app - 归一化后的应用条目。
 * @param workspacePath - 会话的工作区目录。
 * @returns 绝对路径；没配 `cwd` 时原样返回工作区目录，模板无法解析时返回 null。
 */
export function resolveWorkingDirectory(app, workspacePath) {
  if (app.cwd === undefined) return workspacePath
  const expanded = expandTemplate(app.cwd.replaceAll('{path}', workspacePath))
  if (expanded === null || expanded === '') return null
  return isAbsolute(expanded) ? expanded : join(workspacePath, expanded)
}

/**
 * 规范化成 Windows 反斜杠路径。
 *
 * 配置模板里常写 `${SystemRoot}/System32/cmd.exe`，展开后是 `C:\WINDOWS/System32/cmd.exe`
 * 这种混合斜杠。ShellExecute（`start` 走的正是它）对正斜杠很敏感：路径里混了 `/`
 * 时它认不出这是可执行文件，于是什么都不启动——实测表现为「点了没反应，也没有窗口」。
 *
 * 普通 spawn 能容忍混合斜杠（Win32 API 两者都认），所以只有经 `start` 的
 * 终端类应用需要这步。
 *
 * @param value - 可能含正斜杠的路径。
 * @returns 反斜杠形式的路径。
 */
export function toWindowsPath(value) {
  return value.replaceAll('/', '\\')
}

/**
 * 终端类应用的启动 argv。
 *
 * 为什么不能直接 spawn `cmd.exe`：DSH 宿主是无控制台的 GUI 进程，直接派生的
 * 控制台子进程拿不到可见窗口（实测 MainWindowHandle 始终为 0）。唯一可靠的做法
 * 是让 shell 自己分配新控制台：`cmd /c start /d <目录> "" <程序> <参数...>`。
 *
 * 三个实测踩出来的细节：
 *
 * 1. **起始目录必须用 `start` 自己的 `/d`**，不能靠 `cmd /k cd /d <目录>`。
 *    后者在参数被合并成一条命令行时会被截断，窗口根本不出现。
 * 2. **程序名与参数要保持分开的 argv**，不要拼成一个字符串塞进去。
 * 3. **程序路径必须是反斜杠**（见 {@link toWindowsPath}），否则 `start` 找不到它。
 *
 * 还有一条很容易踩的：**argv 里不要再手工加引号**。Node 的 spawn 在 Windows 上
 * 会按自己的规则给含空格的参数加引号，而且会把参数内部已有的 `"` 转义成 `\"`。
 * 这里如果先包一层引号，`start /d "C:\..."` 最终就变成 `start /d "\"C:\...\""`，
 * 目录名里带上了反斜杠和引号，`start` 找不到目录、窗口不出现，路由却照样返回 200。
 * 所以这里只做斜杠规范化，引号交给 spawn。
 *
 * `start` 的第一个引号参数是窗口标题，必须留一个空串占位，否则它会拿程序名当标题，
 * 后面的参数就全乱了。
 *
 * @param exe - 要启动的终端程序。
 * @param args - 已代入目录的参数。
 * @param directory - 作为新窗口起始目录的绝对路径。
 * @returns `{ command, argv }`，交给 launchDetached。
 */
export function shellLaunchCommand(exe, args, directory) {
  return {
    command: 'cmd.exe',
    argv: [
      '/c',
      'start',
      '/d',
      toWindowsPath(directory),
      '',
      toWindowsPath(exe),
      ...args,
    ],
  }
}

/**
 * 启动一个应用并看护早期失败。
 *
 * 成功与否和「进程是否退出」解耦：编辑器会一直活着，所以看护窗口只用来抓
 * 「刚起来就崩」这一类，窗口关闭时仍在跑的进程按启动成功算，且不杀掉。
 *
 * @param exe - 可执行文件。
 * @param args - argv。
 * @param options - 看护窗口、附加环境、工作目录、是否隐藏控制台、是否容忍非零退出码。
 * @returns 启动成功时 resolve；早期失败 reject。
 */
export function launchDetached(exe, args, options) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(exe, [...args], {
        detached: true,
        stdio: 'ignore',
        // 不配 cwd 时不要传（传 undefined 与不传等价，但显式写出来便于对照）。
        cwd: options.cwd,
        windowsHide: options.windowsHide === true,
        // 必须清洗环境：父进程是 Electron（DSH 桌面版），ELECTRON_RUN_AS_NODE
        // 会把这个变量传给同样是 Electron 的编辑器，让它退化成纯 Node 进程。
        env: launchEnvironment(options.env),
      })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    const settle = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(watch)
      child.unref()
      callback()
    }
    const watch = setTimeout(() => {
      settle(resolve)
    }, options.watchMs)
    child.on('error', (error) => {
      settle(() => {
        reject(error)
      })
    })
    child.on('exit', (code, signal) => {
      // 退出码 0 自然是成功；单实例应用把请求交给已运行实例后退出也算成功
      // （见 normalizeApp 的 tolerateExitCode）。真正的 spawn 失败走上面的
      // 'error' 分支，不会到这里。
      if (code === 0 || options.tolerateExitCode !== false) {
        settle(resolve)
        return
      }
      settle(() => {
        reject(new Error(`launcher exited with code ${String(code)}, signal ${String(signal)}`))
      })
    })
  })
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

/** 统一的 JSON 应答（不缓存：可用性与启动结果都是实时事实）。 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 收一个有上限的请求体；超限时排空并返回 null。 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * 挂载路由。
 * @param ctx - 插件上下文（需带 webServer）。
 * @param rawConfig - patch 行里的 config。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const platform = osPlatform()

  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[open-with] ${message}`)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  /** connection 围栏：非本机同源请求直接拒掉。 */
  const reject = (req, res) => {
    const connection = ctx.get('connection')
    if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') return false
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** 惰性一次的解析结果：id → { app, exe }，只包含本机真的能启动的条目。 */
  let resolutions = null
  const resolveAll = async () => {
    const map = new Map()
    await Promise.all(
      config.apps.map(async (app) => {
        const resolved = await resolveApp(app, {
          platform,
          probeTimeoutMs: config.probeTimeoutMs,
        })
        if (resolved !== null) map.set(app.id, { app, exe: resolved.exe })
      }),
    )
    // config.apps 的顺序就是菜单顺序：Map 按插入序迭代，这里按声明序重建一次。
    const ordered = new Map()
    for (const app of config.apps) {
      const entry = map.get(app.id)
      if (entry !== undefined) ordered.set(app.id, entry)
    }
    return ordered
  }
  const availability = () => {
    resolutions ??= resolveAll()
    return resolutions
  }

  /** 图标缓存：id → Promise<Buffer|null>。 */
  const icons = new Map()
  const iconOf = (app, exe) => {
    let cached = icons.get(app.id)
    if (cached === undefined) {
      cached = loadIcon(app, exe, { platform, iconTimeoutMs: config.iconTimeoutMs })
      icons.set(app.id, cached)
    }
    return cached
  }

  /** 统一的路由外壳：围栏、方法、异常兜底。 */
  const route = (kind, path, handler, allow) =>
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind,
          path,
          handler: async (req, res) => {
            if (reject(req, res)) return
            if (req.method !== allow) {
              res.statusCode = 405
              res.setHeader('allow', allow)
              res.end()
              return
            }
            try {
              await handler(req, res)
            } catch (error) {
              log('warn', `${path} 处理失败：${error instanceof Error ? error.message : String(error)}`)
              if (!res.headersSent) {
                sendJson(res, 500, { error: 'internal', message: error instanceof Error ? error.message : String(error) })
              }
            }
          },
        }),
      `open-with: ${path}`,
    )

  route('exact', APPS_PATH, async (req, res) => {
    // 工作区目录由调用方用查询参数带上来：同一个 DSH 里不同会话的 cwd 不同，
    // 菜单要跟着变，不能像以前那样只回一份全局清单。
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const requestedPath = url.searchParams.get('path')
    if (requestedPath !== null && !isAbsolute(requestedPath)) {
      sendJson(res, 400, { error: 'bad-path', message: 'path must be absolute.' })
      return
    }
    const allowed = allowedAppIds(config, requestedPath ?? '', platform)
    const resolved = await availability()
    const apps = []
    for (const [id, entry] of resolved) {
      if (allowed !== null && !allowed.has(id)) continue
      apps.push({ id, label: entry.app.label })
    }
    sendJson(res, 200, { apps })
  }, 'GET')

  // webserver 的 exact 路由不解析路径参数，图标按前缀注册，自己从路径尾巴取 id。
  route('prefix', ICON_PREFIX_PATH, async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const id = decodeURIComponent(pathname.slice(ICON_PREFIX_PATH.length).replace(/^\//, ''))
    const resolved = await availability()
    const entry = resolved.get(id)
    if (entry === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    const bytes = await iconOf(entry.app, entry.exe)
    if (bytes === null) {
      res.statusCode = 404
      res.end()
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', bytes.subarray(0, 4).toString('ascii') === '<svg' ? 'image/svg+xml' : 'image/png')
    res.setHeader('cache-control', 'private, max-age=3600')
    res.end(bytes)
  }, 'GET')

  route('exact', OPEN_PATH, async (req, res) => {
    const text = await readBoundedBody(req)
    if (text === null) {
      sendJson(res, 413, { error: 'too-large' })
      return
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      sendJson(res, 400, { error: 'bad-json' })
      return
    }
    if (typeof body !== 'object' || body === null || typeof body.app !== 'string' || typeof body.path !== 'string') {
      sendJson(res, 400, { error: 'bad-body', message: 'app and path must be strings.' })
      return
    }
    if (!isAbsolute(body.path)) {
      sendJson(res, 400, { error: 'bad-path', message: 'path must be absolute.' })
      return
    }
    let directory = false
    try {
      directory = (await stat(body.path)).isDirectory()
    } catch {
      directory = false
    }
    if (!directory) {
      sendJson(res, 400, { error: 'not-a-directory', message: 'path is not an existing directory.' })
      return
    }

    const resolved = await availability()
    let entry = resolved.get(body.app)
    if (entry === undefined) {
      sendJson(res, 404, { error: 'unknown-app', message: `no available application with id ${JSON.stringify(body.app)}` })
      return
    }

    // 服务端也要按工作区规则再验一次：列表只是 UI 提示，不能让手工构造的
    // POST 绕过它去启动一个本工作区不该出现的应用。
    const allowed = allowedAppIds(config, body.path, platform)
    if (allowed !== null && !allowed.has(body.app)) {
      sendJson(res, 403, {
        error: 'app-not-allowed',
        message: `${JSON.stringify(body.app)} is not available for this workspace.`,
      })
      return
    }

    // 工作目录模板可能引用环境变量；解析不出来就明确报错，别让命令在错误目录里跑。
    const workingDirectory = resolveWorkingDirectory(entry.app, body.path)
    if (workingDirectory === null) {
      sendJson(res, 400, {
        error: 'bad-cwd',
        message: `cannot resolve the working directory of ${JSON.stringify(body.app)}.`,
      })
      return
    }

    /**
     * 拼出真正要 spawn 的命令。
     * 终端类应用走 `cmd /c start`（否则拿不到可见控制台窗口），其余直接 argv 启动。
     */
    const commandFor = (target) => {
      // 终端类应用不追加目录参数：起始目录已经交给 start /d 了。
      const argv = launchArgs(target.app.args, body.path, { appendPath: target.app.shell !== true })
      if (target.app.shell) return shellLaunchCommand(target.exe, argv, workingDirectory)
      // GUI 类应用只有在显式配了 cwd 时才改工作目录，避免无意中影响编辑器的相对路径行为。
      return { command: target.exe, argv, cwd: target.app.cwd === undefined ? undefined : workingDirectory }
    }

    const run = async (target) => {
      const { command, argv, cwd } = commandFor(target)
      return launchDetached(command, argv, {
        watchMs: target.app.watchMs ?? config.launchWatchMs,
        env: target.app.env,
        cwd,
        tolerateExitCode: target.app.tolerateExitCode,
        // GUI 编辑器的控制台窗口该保持隐藏（由它自己管）；终端类应用正相反，
        // 我们要的就是那个可见的控制台窗口。
        windowsHide: target.app.shell !== true ? false : true,
      })
    }

    try {
      await run(entry)
      sendJson(res, 200, { ok: true })
    } catch (error) {
      if (!isMissingExecutable(error)) {
        log('warn', `启动 ${entry.app.label} 失败：${error instanceof Error ? error.message : String(error)}`)
        sendJson(res, 500, { error: 'launch-failed', message: error instanceof Error ? error.message : String(error) })
        return
      }
      // exe 没了：这个条目已经过期，重解析一次再试，成功就顺手更新列表。
      log('info', `${entry.app.label} 的可执行文件已消失，重新探测一次`)
      const again = await resolveApp(entry.app, { platform, probeTimeoutMs: config.probeTimeoutMs })
      if (again === null) {
        const next = await resolveAll()
        resolutions = Promise.resolve(next)
        sendJson(res, 404, { error: 'app-gone', message: `${entry.app.label} is no longer installed.` })
        return
      }
      entry = { app: entry.app, exe: again.exe }
      icons.delete(entry.app.id)
      try {
        await run(entry)
        sendJson(res, 200, { ok: true })
      } catch (retryError) {
        sendJson(res, 500, { error: 'launch-failed', message: retryError instanceof Error ? retryError.message : String(retryError) })
      }
    }
  }, 'POST')

  log('info', `已挂载 ${String(config.apps.length)} 个候选应用：${config.apps.map((app) => app.label).join(', ')}`)
  if (config.workspaces.length > 0) {
    // 规则里引用不存在的 id 会让整个工作区静默少一个应用，提示一下更好排查。
    const known = new Set(config.apps.map((app) => app.id))
    for (const rule of config.workspaces) {
      const unknown = rule.apps.filter((id) => !known.has(id))
      if (unknown.length > 0) {
        log('warn', `工作区规则 #${String(rule.index + 1)} 引用了未定义的应用：${unknown.join(', ')}`)
      }
    }
    log('info', `已启用 ${String(config.workspaces.length)} 条工作区规则`)
  }
}
