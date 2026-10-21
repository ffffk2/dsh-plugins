/**
 * open-with 路由级自检：用假的 ctx 把 apply() 挂起来，直接调用注册的 handler，
 * 覆盖「列应用 → 取图标 → 打开目录」这条链路，不需要起 webServer，
 * 也不需要浏览器登录态。
 *
 * 用法：node smoke-routes.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { apply } = await import(`file://${join(here, 'index.js').replaceAll('\\', '/')}`)

const pluginsRoot = join(here)
const workspace = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'open-with-routes-'))

let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}

/** 假 ctx：只提供 apply() 用到的那几项。 */
function makeCtx() {
  const routes = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: () => undefined,
    effect(factory) {
      disposers.push(factory())
    },
    webServer: {
      register(route) {
        routes.set(`${route.kind}:${route.path}`, route)
        return () => routes.delete(`${route.kind}:${route.path}`)
      },
    },
  }
  return { ctx, routes, disposers }
}

/** 假 res：记录状态码、头与正文。 */
function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    headersSent: false,
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      res.headersSent = true
      res.body = chunk === undefined ? null : chunk
    },
    resume() {},
  }
  return res
}

/** 假 req：一个可异步迭代的请求体。 */
function makeReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')]
  const req = {
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    resume() {},
  }
  return req
}

const readJson = (res) => JSON.parse(String(res.body))

// 配置里指向本机真实存在的 CodeBuddy（机器上没装就是空列表，仍然要能正常应答）。
const { ctx, routes, disposers } = makeCtx()
apply(ctx, {
  apps: [
    {
      id: 'codebuddy',
      label: 'CodeBuddy',
      exe: [
        '${ProgramFiles}/CodeBuddy CN/CodeBuddy CN.exe',
        '${ProgramFiles}/CodeBuddy/CodeBuddy.exe',
      ],
      registry: { displayNamePrefix: 'CodeBuddy CN', exe: ['CodeBuddy CN.exe'] },
    },
    { id: 'ghost', label: '不存在的应用', exe: ['${ProgramFiles}/definitely-not-here-xyz.exe'] },
    // 终端类：起始目录由 start /d 负责，args 里不带 {path}
    {
      id: 'cmd',
      label: '命令提示符',
      platforms: ['win32'],
      shell: true,
      exe: ['${SystemRoot}/System32/cmd.exe'],
      args: ['/k'],
      tolerateExitCode: false,
    },
    {
      id: 'powershell',
      label: 'PowerShell',
      platforms: ['win32'],
      shell: true,
      exe: ['${SystemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe'],
      args: ['-NoExit', '-Command', "Set-Location -LiteralPath '{path}'"],
      tolerateExitCode: false,
    },
  ],
})

await check('三条路由都注册上了', async () => {
  assert.ok(routes.has('exact:/open-with/apps'), '缺少 apps 路由')
  assert.ok(routes.has('prefix:/open-with/icon'), '缺少 icon 路由')
  assert.ok(routes.has('exact:/open-with/open'), '缺少 open 路由')
})

await check('GET /open-with/apps 返回 { apps: [...] } 且不含探测失败的应用', async () => {
  const res = makeRes()
  await routes.get('exact:/open-with/apps').handler(makeReq({ url: '/open-with/apps' }), res)
  assert.equal(res.statusCode, 200)
  const payload = readJson(res)
  assert.ok(Array.isArray(payload.apps))
  assert.ok(!payload.apps.some((app) => app.id === 'ghost'), '解析不到 exe 的条目不该出现')
  for (const app of payload.apps) {
    assert.equal(typeof app.id, 'string')
    assert.equal(typeof app.label, 'string')
  }
  console.log(`      本机可用应用：${payload.apps.map((app) => `${app.label}(${app.id})`).join(', ') || '（无）'}`)
})

await check('apps 路由拒绝非 GET', async () => {
  const res = makeRes()
  await routes.get('exact:/open-with/apps').handler(makeReq({ method: 'POST', url: '/open-with/apps' }), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'GET')
})

await check('未知 id 的图标返回 404', async () => {
  const res = makeRes()
  await routes.get('prefix:/open-with/icon').handler(makeReq({ url: '/open-with/icon/nope' }), res)
  assert.equal(res.statusCode, 404)
})

await check('已解析应用的图标返回 PNG 或 404（取决于平台能否提取）', async () => {
  const appsRes = makeRes()
  await routes.get('exact:/open-with/apps').handler(makeReq({ url: '/open-with/apps' }), appsRes)
  const { apps } = readJson(appsRes)
  if (apps.length === 0) {
    console.log('      本机没有可用应用，跳过')
    return
  }
  const res = makeRes()
  await routes.get('prefix:/open-with/icon').handler(makeReq({ url: `/open-with/icon/${apps[0].id}` }), res)
  assert.ok(res.statusCode === 200 || res.statusCode === 404, `意外状态码 ${res.statusCode}`)
  if (res.statusCode === 200) {
    assert.match(String(res.headers['content-type']), /^image\/(png|svg\+xml)$/)
    assert.ok(Buffer.isBuffer(res.body) && res.body.length > 0)
    console.log(`      图标 ${apps[0].id}: ${res.headers['content-type']} ${res.body.length} 字节`)
  } else {
    console.log(`      图标 ${apps[0].id}: 该平台提取不到，回落占位图`)
  }
})

await check('open 路由拒绝非 POST', async () => {
  const res = makeRes()
  await routes.get('exact:/open-with/open').handler(makeReq({ url: '/open-with/open' }), res)
  assert.equal(res.statusCode, 405)
})

await check('open 路由拒绝坏 JSON', async () => {
  const res = makeRes()
  await routes.get('exact:/open-with/open').handler(makeReq({ method: 'POST', url: '/open-with/open', body: '{oops' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(readJson(res).error, 'bad-json')
})

await check('open 路由要求 app / path 都是字符串', async () => {
  const res = makeRes()
  await routes.get('exact:/open-with/open').handler(makeReq({ method: 'POST', url: '/open-with/open', body: '{"app":1}' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(readJson(res).error, 'bad-body')
})

await check('open 路由要求绝对路径', async () => {
  const res = makeRes()
  await routes.get('exact:/open-with/open').handler(makeReq({ method: 'POST', url: '/open-with/open', body: '{"app":"codebuddy","path":"relative/x"}' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(readJson(res).error, 'bad-path')
})

await check('open 路由要求目录真实存在', async () => {
  const res = makeRes()
  const body = JSON.stringify({ app: 'codebuddy', path: join(workspace, 'not-here') })
  await routes.get('exact:/open-with/open').handler(makeReq({ method: 'POST', url: '/open-with/open', body }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(readJson(res).error, 'not-a-directory')
})

await check('open 路由对未知 app 返回 404', async () => {
  const res = makeRes()
  const body = JSON.stringify({ app: 'no-such-app', path: workspace })
  await routes.get('exact:/open-with/open').handler(makeReq({ method: 'POST', url: '/open-with/open', body }), res)
  assert.equal(res.statusCode, 404)
  assert.equal(readJson(res).error, 'unknown-app')
})

await check('open 路由对真实目录 + 真实应用能真正启动（CodeBuddy 已开着时靠 tolerateExitCode 判成功）', async () => {
  const appsRes = makeRes()
  await routes.get('exact:/open-with/apps').handler(makeReq({ url: '/open-with/apps' }), appsRes)
  const { apps } = readJson(appsRes)
  if (apps.length === 0) {
    console.log('      本机没有可用应用，跳过真实启动')
    return
  }
  const res = makeRes()
  const body = JSON.stringify({ app: apps[0].id, path: workspace })
  await routes.get('exact:/open-with/open').handler(makeReq({ method: 'POST', url: '/open-with/open', body }), res)
  assert.equal(res.statusCode, 200, `启动失败：${String(res.body)}`)
  assert.equal(readJson(res).ok, true)
  console.log(`      已用 ${apps[0].label} 打开 ${workspace}`)
})

// 工作区规则：同一个 Host 进程里，不同 cwd 必须拿到不同清单。
// 用 node 自己的可执行文件当被测应用，结果不依赖本机装了哪些编辑器。
const cwdFile = join(workspace, 'cwd.txt')
const filtered = makeCtx()
apply(filtered.ctx, {
  apps: [
    { id: 'node', label: 'Node', exe: [process.execPath], args: ['-e', ''] },
    { id: 'node-alt', label: 'Node Alt', exe: [process.execPath], args: ['-e', ''] },
    {
      id: 'node-cwd',
      label: 'Node cwd',
      exe: [process.execPath],
      args: ['-e', 'require("fs").writeFileSync(process.env.SMOKE_OUT, process.cwd())'],
      cwd: '{path}',
      env: { SMOKE_OUT: cwdFile },
    },
  ],
  workspaces: [
    { match: ['**/blocked'], apps: [] },
    { match: [workspace], apps: ['node', 'node-cwd'] },
  ],
  defaultApps: ['node-alt'],
})

const appsFor = async (target, path) => {
  const res = makeRes()
  const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`
  await target.routes.get('exact:/open-with/apps').handler(makeReq({ url: `/open-with/apps${query}` }), res)
  return { res, payload: res.body === null ? null : readJson(res) }
}

await check('GET /open-with/apps 按工作区过滤', async () => {
  const { res, payload } = await appsFor(filtered, workspace)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(payload.apps.map((app) => app.id), ['node', 'node-cwd'])
})

await check('命中 apps: [] 的规则时清单为空', async () => {
  const { res, payload } = await appsFor(filtered, join(workspace, 'blocked'))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(payload.apps, [])
})

await check('未命中规则时回落到 defaultApps', async () => {
  const { payload } = await appsFor(filtered, join(workspace, '..', 'outside-any-rule'))
  assert.deepEqual(payload.apps.map((app) => app.id), ['node-alt'])
})

await check('GET /open-with/apps 拒绝相对路径', async () => {
  const { res, payload } = await appsFor(filtered, 'relative/workspace')
  assert.equal(res.statusCode, 400)
  assert.equal(payload.error, 'bad-path')
})

await check('open 路由拒绝被工作区规则过滤掉的 app', async () => {
  const res = makeRes()
  const body = JSON.stringify({ app: 'node-alt', path: workspace })
  await filtered.routes.get('exact:/open-with/open').handler(makeReq({ method: 'POST', url: '/open-with/open', body }), res)
  assert.equal(res.statusCode, 403)
  assert.equal(readJson(res).error, 'app-not-allowed')
})

await check('open 路由放行规则内的 app（真实启动 node -e ""）', async () => {
  const res = makeRes()
  const body = JSON.stringify({ app: 'node', path: workspace })
  await filtered.routes.get('exact:/open-with/open').handler(makeReq({ method: 'POST', url: '/open-with/open', body }), res)
  assert.equal(res.statusCode, 200, `启动失败：${String(res.body)}`)
})

await check('open 路由按 cwd 启动（子进程确实落在目标目录）', async () => {
  rmSync(cwdFile, { force: true })
  const res = makeRes()
  const body = JSON.stringify({ app: 'node-cwd', path: workspace })
  await filtered.routes.get('exact:/open-with/open').handler(makeReq({ method: 'POST', url: '/open-with/open', body }), res)
  assert.equal(res.statusCode, 200, `启动失败：${String(res.body)}`)
  let actual = null
  for (let attempt = 0; attempt < 20 && actual === null; attempt += 1) {
    try {
      actual = readFileSync(cwdFile, 'utf8').trim()
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  assert.equal(normalize(actual ?? ''), normalize(workspace))
})

await check('disposer 能摘掉路由', async () => {
  for (const dispose of [...disposers, ...filtered.disposers]) dispose()
  assert.equal(routes.size, 0)
  assert.equal(filtered.routes.size, 0)
})

rmSync(workspace, { recursive: true, force: true })
console.log(`\n${passed} 项全部通过（插件根目录 ${pluginsRoot}）`)
