/**
 * dsh-git-pr 的自检脚本。
 *
 * 这个插件是纯 Host、纯命令：它不自己执行 git，而是把**操作规程**排进会话让模型去做。
 * 所以冒烟测试的重心从「真跑 git」换成了三件事：
 *
 *   1. 注册契约：三个命令真的注册了、名字合法、描述与 input.hint 齐全；
 *   2. 指令质量：三条指令都必须带着全部硬性约定（不许 force、不许 --no-verify、
 *      提交前不额外 review、不编造测试结果…），缺一条就等于那条命令会出事故；
 *   3. 投递行为：handler 真的调用 `agent.followup()`，消息结构合法、参数被带进去、
 *      没有 Agent 时给明确错误而不是抛异常。
 *
 * 用法：node dsh-git-pr\smoke.mjs
 * 退出码 0 且打印 ALL PASS 才算过。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
let failures = 0
let checks = 0

/** 一条断言。 */
function check(ok, label) {
  checks += 1
  if (ok) {
    console.log(`  PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL  ${label}`)
}

/** 分组标题。 */
function group(title) {
  console.log(`\n${title}`)
}

/** 假 ctx：只提供 apply 真正用到的那几个入口。 */
function makeCtx() {
  const commands = []
  const disposers = []
  const logs = []
  return {
    commands: {
      register(definition) {
        if (commands.some((entry) => entry.name === definition.name)) throw new Error(`duplicate command ${definition.name}`)
        commands.push(definition)
        return () => {}
      },
    },
    registry: { commands },
    effect(fn, label) {
      const dispose = fn()
      disposers.push({ label, dispose })
      return dispose
    },
    get: () => undefined,
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    logs,
    disposers,
  }
}

/** 假 agent：记录 followup 收到的消息。 */
function makeAgent() {
  const received = []
  return {
    agent: { id: 'session-test', followup: (message) => received.push(message) },
    received,
  }
}

/** 假 invocation。 */
function makeInvocation(agent, rawInput = '') {
  return { agent, rawInput, signal: new AbortController().signal, commandId: 'test', attachments: [] }
}

// ---------------------------------------------------------------------------
// 1. 包与 manifest 契约
// ---------------------------------------------------------------------------
group('包契约')

const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
const patch = readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8')
const zh = JSON.parse(readFileSync(join(HERE, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(HERE, 'locale', 'en.json'), 'utf8'))
const icon = readFileSync(join(HERE, 'icon.svg'), 'utf8')

check(pkg.name === '@local/dsh-git-pr', 'package.json name 为 @local/dsh-git-pr')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', '声明了 dsh.bundle.patch')
check(patch.includes('id: git-pr') && patch.includes("name: '@local/dsh-git-pr'"), 'patch 里插入了 git-pr 行')
check(pkg.files.includes('index.js') && pkg.files.includes('cordis.patch.yml'), 'files 覆盖运行所需文件')
check(pkg.exports['./locale/*.json'] === './locale/*.json', 'exports 暴露 locale')
check(typeof zh.meta?.title === 'string' && zh.meta.title !== '', 'zh.json 有标题')
check(typeof en.meta?.title === 'string' && en.meta.title !== '', 'en.json 有标题')
check(typeof zh.meta.description === 'string' && typeof en.meta.description === 'string', '两种语言都有描述')
check(icon.includes('role="img"') && icon.includes('aria-label'), 'icon.svg 带无障碍属性')

// 纯 Host 插件：多带一个 client.js 反而会被 dsh.client 声明发现，容易误导。
let hasClient = true
try {
  readFileSync(join(HERE, 'client.js'), 'utf8')
} catch {
  hasClient = false
}
check(!hasClient, '这是纯 Host 插件，没有 client.js')
check(pkg.dsh?.client === undefined, 'package.json 没有声明 dsh.client')

// ---------------------------------------------------------------------------
// 2. 模块形状与注册
// ---------------------------------------------------------------------------
group('注册契约')

const mod = await import(new URL('./index.js', import.meta.url).href)
check(mod.name === 'git-pr', 'name 导出为 git-pr（等于 patch 行 id）')
check(Array.isArray(mod.inject) && mod.inject.includes('commands'), 'inject 只硬依赖 commands')
check(typeof mod.apply === 'function', '导出 apply')

const ctx = makeCtx()
mod.apply(ctx)
const names = ctx.registry.commands.map((definition) => definition.name).sort()
check(names.join(',') === 'commit,commit-pr,create-pr', '/commit、/commit-pr、/create-pr 都已注册')
for (const definition of ctx.registry.commands) {
  check(typeof definition.description === 'string' && definition.description.trim() !== '', `/${definition.name} 有描述`)
  check(typeof definition.input?.hint === 'string' && definition.input.hint.trim() !== '', `/${definition.name} 有 input.hint`)
  check(typeof definition.handler === 'function', `/${definition.name} 有 handler`)
}
check(/^[a-z][a-z0-9_-]*$/u.test('create-pr'), 'create-pr 符合宿主命令名规则')
check(ctx.disposers.length >= 3, '注册都走了 ctx.effect（可被卸载）')

// ---------------------------------------------------------------------------
// 3. 指令内容：三条命令都必须带上全部硬性约定
// ---------------------------------------------------------------------------
group('指令内容')

const { commitInstruction, createPrInstruction, commitPrInstruction, RULES } = mod.__internals
const instructions = {
  commit: commitInstruction(''),
  'create-pr': createPrInstruction(''),
  'commit-pr': commitPrInstruction(''),
}

for (const [label, text] of Object.entries(instructions)) {
  check(text.length > 300, `${label} 的指令有实质内容`)
  check(text.includes('--force'), `${label} 明确提到不许 force`)
  check(text.includes('--no-verify'), `${label} 明确提到不许跳过钩子`)
  check(text.includes('git status'), `${label} 要求先看真实状态`)
  check(text.includes('如实'), `${label} 要求如实报告`)
  check(text.includes(RULES), `${label} 内联了统一约定段`)
}

check(RULES.includes('凭据') || RULES.includes('token'), '统一约定里有凭据/密钥约束')

// 提交规程
check(instructions.commit.includes('没有可提交的改动'), '提交规程说明了「没有改动」怎么办（如实说，不造空提交）')
check(instructions.commit.includes('不要创建空提交'), '提交规程禁止空提交')
// 用户发起 /commit 时改动已经 review 过：规程里不能再有「先审一遍、命中就停下来问」这种闸门。
check(!instructions.commit.includes('安全审查'), '提交规程不再做安全审查（用户发起命令前已 review）')
check(!instructions.commit.includes('命中任意一项就停止'), '提交规程不设「命中即停、等用户决定」的闸门')
check(instructions.commit.includes('已经 review 过'), '提交规程写明改动已由用户 review 过，直接提交')
check(instructions.commit.includes('git diff --stat'), '提交规程只看 stat 级别的改动概况')
check(instructions.commit.includes('git add -A'), '提交规程给了默认暂存方式')
check(instructions.commit.includes('72'), '提交规程限制主题行长度')
check(instructions.commit.includes('BREAKING CHANGE'), '提交规程覆盖破坏性变更')
check(/Generated with/u.test(instructions.commit), '提交规程禁止工具署名')
check(instructions.commit.includes('git log --oneline -20'), '提交规程要求学习仓库既有风格')
check(instructions.commit.includes('detached HEAD'), '提交规程处理 detached HEAD（建分支而不是直接失败）')

// PR 规程
check(instructions['create-pr'].includes('gh pr create'), 'PR 规程包含 gh 路径')
check(instructions['create-pr'].includes('GITHUB_TOKEN'), 'PR 规程包含 token API 路径')
check(instructions['create-pr'].includes('compare/'), 'PR 规程包含网页链接兜底')
check(instructions['create-pr'].includes('glab mr create'), 'PR 规程包含 GitLab CLI')
check(instructions['create-pr'].includes('merge_requests/new'), 'PR 规程包含 GitLab 网页兜底')
check(instructions['create-pr'].includes('PULL_REQUEST_TEMPLATE'), 'PR 规程支持仓库模板')
check(instructions['create-pr'].includes('绝不编造测试结果'), 'PR 规程禁止编造验证结果')
check(instructions['create-pr'].includes('ls-remote'), 'PR 规程用 ls-remote 校验目标分支')
check(
  instructions['create-pr'].includes('当前分支**等于 base**') || instructions['create-pr'].includes('当前分支等于 base'),
  'PR 规程处理「就在主干上」——建特性分支而不是报错',
)
check(!instructions['create-pr'].includes('没有东西可以开 PR'), 'PR 规程里没有硬性阻断文案')
check(!instructions['create-pr'].includes('没有内容可以开 PR'), 'PR 规程里没有第二条硬性阻断文案')

// commit-pr 规程
check(instructions['commit-pr'].includes('没有改动就跳过提交'), 'commit-pr 说明无改动时跳过提交')
check(instructions['commit-pr'].includes('新建特性分支'), 'commit-pr 说明在主干上时新建分支')
check(instructions['commit-pr'].includes('git push -u origin HEAD'), 'commit-pr 给出推送命令')

// 用户参数必须透传
check(commitInstruction('src/').includes('src/'), '提交规程带上用户给的路径参数')
check(createPrInstruction('develop').includes('develop'), 'PR 规程带上用户给的目标分支')
check(commitPrInstruction('修复登录超时').includes('修复登录超时'), 'commit-pr 规程带上用户给的说明')
check(!commitInstruction('').includes('用户这次给的说明或路径范围'), '没有参数时不出现空的参数段')
check(!createPrInstruction('').includes('用户这次给的参数'), '没有参数时不出现空的参数段')

// ---------------------------------------------------------------------------
// 4. 投递行为
// ---------------------------------------------------------------------------
group('投递行为')

const { createInstructionMessage, enqueue } = mod.__internals

const message = createInstructionMessage('hello')
check(message.role === 'user', '消息 role 是 user')
check(typeof message.id === 'string' && message.id.length >= 8, '消息带唯一 id')
check(Array.isArray(message.content) && message.content[0]?.type === 'text', '消息内容是 text 块')
check(message.content[0].text === 'hello', '消息文本原样保留')
check(message.source?.kind === 'git-pr', '消息 source 标明来自本插件')
check(Object.isFrozen(message), '消息被深冻结（不会被就地改写）')
check(Object.isFrozen(message.content[0]), '嵌套结构也冻结')
check(createInstructionMessage('a').id !== createInstructionMessage('b').id, '两条消息 id 不同')

const freshAgent = makeAgent()
const result = enqueue(makeInvocation(freshAgent.agent, ''), 'instruction text', 'summary text')
check(result.kind === 'success', 'enqueue 成功时返回 success')
check(result.text === 'summary text', 'enqueue 把 summary 作为命令结果回报')
check(freshAgent.received.length === 1, '真的调用了 agent.followup 一次')
check(freshAgent.received[0].content[0].text === 'instruction text', 'followup 收到的就是指令正文')

const noAgent = enqueue(makeInvocation(undefined, ''), 'x', 'y')
check(noAgent.kind === 'error', '没有 Agent 时返回 error 而不是抛异常')
check(noAgent.text.includes('会话'), '错误信息说明了原因')

const brokenAgent = { id: 'x', followup: () => { throw new Error('inbox full') } }
const broken = enqueue(makeInvocation(brokenAgent, ''), 'x', 'y')
check(broken.kind === 'error' && broken.text.includes('inbox full'), 'followup 抛异常时被捕获并如实回报')

// 通过真实 handler 走一遍：三个命令都要能把指令排进会话。
for (const definition of ctx.registry.commands) {
  const agent = makeAgent()
  const outcome = await definition.handler(makeInvocation(agent.agent, 'arg-here'))
  check(outcome.kind === 'success', `/${definition.name} 的 handler 返回 success`)
  check(agent.received.length === 1, `/${definition.name} 的 handler 排进了 1 条消息`)
  const text = agent.received[0].content[0].text
  check(text.includes('arg-here'), `/${definition.name} 把用户参数带进了指令`)
  check(text.length > 400, `/${definition.name} 排进去的指令足够完整`)
}

// handler 里任何异常都不能冒到宿主
const throwingDefinition = ctx.registry.commands[0]
const safe = await throwingDefinition.handler({
  get agent() {
    throw new Error('agent blew up')
  },
  rawInput: '',
  signal: new AbortController().signal,
})
check(safe.kind === 'error', 'handler 把异常转成 error 结果（不会抛到宿主）')

// ---------------------------------------------------------------------------
// 5. 代码风格约定
// ---------------------------------------------------------------------------
group('代码风格')

const source = readFileSync(join(HERE, 'index.js'), 'utf8')
check(!source.includes('\r\n'), 'index.js 是 LF 行尾')
check(!/\t/u.test(source), 'index.js 使用空格缩进（无制表符）')
const runtimeImports = [...source.matchAll(/^import .* from '([^']+)'/gmu)].map((match) => match[1])
check(runtimeImports.every((specifier) => specifier.startsWith('node:')), '运行时只依赖 node:* 内置模块')
// 插件包没有声明对官方包的依赖，跨包 import 在 profile 里可能解析不到。
check(!source.includes('@deepseek-ai/'), '没有 import 任何官方包（避免跨包解析失败）')
check(!/child_process|execFile/u.test(source), '不再自己执行 git（改由模型用它的工具执行）')

// 收尾
console.log(`\n共 ${checks} 项断言，失败 ${failures} 项`)
if (failures === 0) console.log('ALL PASS')
else {
  console.log('FAILED')
  process.exitCode = 1
}
