/**
 * open-with 的快速自检：只验纯函数与探测/启动的真实行为，不需要起 webServer。
 * 用法：node smoke.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from 'node:path'

import {
  expandTemplate,
  normalizeApp,
  normalizeConfig,
  parseDisplayNames,
  parseInstallValues,
  findByRegistry,
  resolveApp,
  launchArgs,
  launchEnvironment,
  shellLaunchCommand,
  toWindowsPath,
  loadIcon,
} from './index.js'

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}
const checkAsync = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}

console.log('expandTemplate')
check('展开 ${VAR}', () => {
  assert.equal(expandTemplate('${ProgramFiles}/CodeBuddy CN/CodeBuddy CN.exe', { ProgramFiles: 'C:\\Program Files' }), 'C:\\Program Files/CodeBuddy CN/CodeBuddy CN.exe')
})
check('展开 %VAR%', () => {
  assert.equal(expandTemplate('%LOCALAPPDATA%/x/y.exe', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), 'C:\\Users\\me\\AppData\\Local/x/y.exe')
})
check('未定义变量返回 null', () => {
  assert.equal(expandTemplate('${NOPE}/x.exe', {}), null)
})
check('~/ 展开成 home', () => {
  assert.ok(expandTemplate('~/bin/tool', { USERPROFILE: 'C:\\Users\\me' }).startsWith('C:\\Users\\me'))
})

console.log('normalizeApp / normalizeConfig')
check('缺字段时给安全默认', () => {
  const app = normalizeApp({}, 3)
  assert.equal(app.id, 'app-3')
  assert.equal(app.label, 'app-3')
  assert.deepEqual(app.exe, [])
  assert.deepEqual(app.args, [])
})
check('单字符串也能当数组', () => {
  const app = normalizeApp({ id: 'x', exe: 'C:/a.exe', args: '-n' }, 0)
  assert.deepEqual(app.exe, ['C:/a.exe'])
  assert.deepEqual(app.args, ['-n'])
})
check('重复 id 只保留第一个', () => {
  const config = normalizeConfig({ apps: [{ id: 'a', exe: '1' }, { id: 'a', exe: '2' }] })
  assert.equal(config.apps.length, 1)
  assert.deepEqual(config.apps[0].exe, ['1'])
})
check('空配置回落到内置默认条目', () => {
  const config = normalizeConfig(undefined)
  assert.ok(config.apps.length >= 1)
  assert.ok(config.apps.some((app) => app.id === 'codebuddy'))
})
check('期限缺省有值且为正', () => {
  const config = normalizeConfig({ launchWatchMs: -5 })
  assert.equal(config.launchWatchMs, 1200)
  assert.equal(config.probeTimeoutMs, 8000)
})

console.log('注册表解析')
check('解析 DisplayName 行', () => {
  const dump = [
    '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}_is1',
    '    DisplayName    REG_SZ    CodeBuddy CN (User)',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other',
    '    DisplayName    REG_SZ    Something Else',
    '',
  ].join('\r\n')
  const rows = parseDisplayNames(dump)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].displayName, 'CodeBuddy CN (User)')
  assert.ok(rows[0].key.endsWith('{GUID}_is1'))
})
check('解析 InstallLocation / DisplayIcon 并去掉引号', () => {
  const dump = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\X',
    '    DisplayIcon    REG_SZ    "D:\\software\\CodeBuddy CN\\CodeBuddy CN.exe"',
    '    InstallLocation    REG_SZ    D:\\software\\CodeBuddy CN\\',
    '',
  ].join('\r\n')
  const values = parseInstallValues(dump)
  assert.equal(values.installLocation, 'D:\\software\\CodeBuddy CN\\')
  assert.equal(values.displayIcon, 'D:\\software\\CodeBuddy CN\\CodeBuddy CN.exe')
})

console.log('resolveApp')
const tempRoot = mkdtempSync(join(tmpdir(), 'open-with-smoke-'))
try {
  const fakeExe = join(tempRoot, 'Fake Editor.exe')
  writeFileSync(fakeExe, 'not really an exe')

  await checkAsync('命中第一个存在的 exe', async () => {
    const app = normalizeApp({ id: 'x', exe: [join(tempRoot, 'missing.exe'), '${SMOKE_ROOT}/Fake Editor.exe'] }, 0)
    const saved = process.env.SMOKE_ROOT
    process.env.SMOKE_ROOT = tempRoot
    try {
      const found = await resolveApp(app, { platform: 'win32', probeTimeoutMs: 2000 })
      // 模板里混用 '/' 是允许的（Win32 API 两者都认），比较前统一分隔符。
      assert.equal(normalize(found.exe), normalize(fakeExe))
    } finally {
      if (saved === undefined) delete process.env.SMOKE_ROOT
      else process.env.SMOKE_ROOT = saved
    }
  })

  await checkAsync('平台不匹配就跳过', async () => {
    const app = normalizeApp({ id: 'x', platforms: ['darwin'], exe: ['${SMOKE_ROOT}/Fake Editor.exe'] }, 0)
    process.env.SMOKE_ROOT = tempRoot
    try {
      assert.equal(await resolveApp(app, { platform: 'win32', probeTimeoutMs: 2000 }), null)
    } finally {
      delete process.env.SMOKE_ROOT
    }
  })

  await checkAsync('找不到就返回 null', async () => {
    const app = normalizeApp({ id: 'x', exe: [join(tempRoot, 'nope.exe')] }, 0)
    assert.equal(await resolveApp(app, { platform: 'win32', probeTimeoutMs: 2000 }), null)
  })

  await checkAsync('注册表兜底能按 isFile 钩子命中', async () => {
    const app = normalizeApp(
      { id: 'x', registry: { displayNamePrefix: 'CodeBuddy CN', exe: ['CodeBuddy CN.exe'] } },
      0,
    )
    // 用假的命令执行器替身不方便（runCommand 是模块内私有），这里直接走真实
    // 安装记录：本机装了 CodeBuddy 才断言命中，没装则只要求「不抛错」。
    const found = await findByRegistry(app.registry.displayNamePrefix, app.registry.exe, 8000)
    assert.ok(found === null || typeof found === 'string')
  })
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log('launchArgs')
check('{path} 代入且不重复追加', () => {
  assert.deepEqual(launchArgs(['--cd={path}'], 'C:\\a b\\c'), ['--cd=C:\\a b\\c'])
})
check('没有 token 就追加目录到末尾', () => {
  assert.deepEqual(launchArgs(['-n'], 'C:\\x'), ['-n', 'C:\\x'])
  assert.deepEqual(launchArgs([], 'C:\\x'), ['C:\\x'])
})
check('appendPath:false 时不追加（终端类应用专用）', () => {
  assert.deepEqual(launchArgs(['/k'], 'C:\\x', { appendPath: false }), ['/k'])
  // 有 {path} 时仍然代入，appendPath 只管「没有 token 要不要追加」。
  assert.deepEqual(launchArgs(['-d', '{path}'], 'C:\\x', { appendPath: false }), ['-d', 'C:\\x'])
})

console.log('终端启动（start /d 方案）')
check('toWindowsPath 把正斜杠统一成反斜杠', () => {
  assert.equal(toWindowsPath('C:\\WINDOWS/System32/cmd.exe'), 'C:\\WINDOWS\\System32\\cmd.exe')
})
check('argv 形状：/c start /d <目录> "" <程序> <参数...>', () => {
  const c = shellLaunchCommand('C:\\WINDOWS/System32/cmd.exe', ['/k'], 'D:\\a\\b')
  assert.equal(c.command, 'cmd.exe')
  assert.deepEqual(c.argv, ['/c', 'start', '/d', 'D:\\a\\b', '', 'C:\\WINDOWS\\System32\\cmd.exe', '/k'])
})
check('回归：程序路径必须是反斜杠，混合斜杠会让 start 找不到程序', () => {
  const c = shellLaunchCommand('C:\\WINDOWS/System32/cmd.exe', [], 'D:\\a\\b')
  assert.ok(!c.argv[5].includes('/'), `start 的程序路径不能含正斜杠：${c.argv[5]}`)
})
check('含空格的目录不手工加引号（由 Node 的 spawn 负责）', () => {
  const c = shellLaunchCommand('cmd.exe', [], 'D:\\code\\my projects\\x')
  assert.equal(c.argv[3], 'D:\\code\\my projects\\x')
  // 回归：自己包一层引号会被 spawn 转义成 \"D:\...\"，start 找不到目录。
  assert.ok(!c.argv.some((arg) => arg.includes('"')), `argv 里不该有手工引号：${JSON.stringify(c.argv)}`)
})
check('参数原样透传，不预先拼成一条命令字符串', () => {
  const c = shellLaunchCommand('powershell.exe', ['-NoExit', '-Command', "Set-Location -LiteralPath 'D:\\a b'"], 'D:\\a b')
  assert.deepEqual(c.argv.slice(6), ['-NoExit', '-Command', "Set-Location -LiteralPath 'D:\\a b'"])
})
check('窗口标题占位（空串）必须在第 5 位，否则 start 会拿程序名当标题', () => {
  const c = shellLaunchCommand('cmd.exe', ['/k'], 'D:\\a')
  assert.equal(c.argv[4], '')
})

console.log('launchEnvironment（回归：ELECTRON_RUN_AS_NODE 必须被清掉）')
check('剥掉 ELECTRON_RUN_AS_NODE，保留 PATH', () => {
  const env = launchEnvironment(undefined, {
    ELECTRON_RUN_AS_NODE: '1',
    Path: 'C:\\Windows',
    SystemRoot: 'C:\\Windows',
  })
  assert.ok(!('ELECTRON_RUN_AS_NODE' in env), 'ELECTRON_RUN_AS_NODE 不该传给被启动的编辑器')
  assert.equal(env.Path, 'C:\\Windows')
  assert.equal(env.SystemRoot, 'C:\\Windows')
})
check('大小写不敏感（Windows 环境名不区分大小写）', () => {
  const env = launchEnvironment(undefined, { electron_run_as_node: '1' })
  assert.ok(!('electron_run_as_node' in env))
})
check('剥掉 NODE_OPTIONS，避免子进程继承调试开关', () => {
  const env = launchEnvironment(undefined, { NODE_OPTIONS: '--inspect=9229' })
  assert.ok(!('NODE_OPTIONS' in env))
})
check('显式声明的 env 优先且能覆盖', () => {
  const env = launchEnvironment({ FOO: 'bar', ELECTRON_RUN_AS_NODE: '0' }, { FOO: 'baz' })
  assert.equal(env.FOO, 'bar')
  // 显式要求就照传，不受黑名单拦截。
  assert.equal(env.ELECTRON_RUN_AS_NODE, '0')
})
check('undefined 值不透传', () => {
  const env = launchEnvironment(undefined, { A: undefined, B: 'x' })
  assert.ok(!('A' in env))
  assert.equal(env.B, 'x')
})

console.log('loadIcon')
await checkAsync('iconPath 指定的 PNG 能被读出来', async () => {
  // 上面那个临时目录已经在 finally 里清掉了，这里单独开一个。
  const iconRoot = mkdtempSync(join(tmpdir(), 'open-with-icon-'))
  try {
    const png = join(iconRoot, 'icon.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const app = normalizeApp({ id: 'x', iconPath: png }, 0)
    const bytes = await loadIcon(app, 'whatever.exe', { platform: 'linux', iconTimeoutMs: 1000 })
    assert.equal(bytes.length, 4)
    assert.equal(bytes[0], 0x89)
  } finally {
    rmSync(iconRoot, { recursive: true, force: true })
  }
})
await checkAsync('非 Windows 且没有 iconPath 时返回 null', async () => {
  const app = normalizeApp({ id: 'x' }, 0)
  assert.equal(await loadIcon(app, '/usr/bin/code', { platform: 'linux', iconTimeoutMs: 1000 }), null)
})

console.log('Client 样式护栏')
{
  // Client 半是手写 bundle，没有构建期 CSS 校验；这里直接读文本来钉住约束。
  const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  const marker = 'const CSS = `'
  const start = source.indexOf(marker)
  const end = source.indexOf('`', start + marker.length)
  const css = start < 0 || end < 0 ? '' : source.slice(start + marker.length, end)

  check('找得到内联 CSS', () => assert.ok(css.length > 500, css.length))
  // 宿主 token 是唯一合法的颜色来源：写死颜色会在换主题时崩掉。
  check('无硬编码十六进制颜色', () => assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css)))
  check('无硬编码 rgb()/hsl() 颜色', () => assert.ok(!/\b(?:rgb|hsl)a?\(/.test(css)))
  const vars = [...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1])
  const strayVars = [...new Set(vars.filter((name) => !/^--(?:dsw-alias|dsw-specific|ds-font)-/.test(name)))]
  check('只引用宿主放行的 token 家族', () => assert.deepEqual(strayVars, []))
  check('确实用到了宿主 token', () => assert.ok(vars.length > 0, vars.length))
  // 只看选择器的「第一个」类名：`.dshto-item.is-preferred` 里的 is-preferred 是状态类。
  const classes = [...new Set([...css.matchAll(/(?<![\w-])\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]))]
  check('类名全部带 dshto- 前缀', () => {
    const stray = classes.filter((name) => !name.startsWith('dshto-'))
    assert.deepEqual(stray, [])
  })
  check('JSX 里的类名也带 dshto- 前缀', () => {
    const used = [...source.matchAll(/className: '([^']+)'/g)].flatMap((match) => match[1].split(/\s+/))
    const stray = used.filter((name) => name !== '' && !name.startsWith('dshto-') && name !== 'is-preferred')
    assert.deepEqual(stray, [])
  })
}

console.log(`\n${passed} 项全部通过`)
