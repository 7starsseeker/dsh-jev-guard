#!/usr/bin/env node
/**
 * 入口与导入自检 —— 证明"该跑的脚本真的会跑"、"该安静的模块真的安静"。
 *
 * 为什么单独有这一份(而不是靠 `node --check` 或别的自检):
 *
 * 入口守卫写错时的表现是**静默退出 0**。对 DSH 这类宿主来说,"什么都没发生"与"检查通过"
 * 长得一模一样 —— 而 DSH 这边最坏的情况是插件一声不响地没挂上。而:
 *   · `node --check` 只查语法,查不出这个;
 *   · 别的自检都 `import` 模块(不走入口路径),同样查不出;
 *   · 只有在"以入口身份真的跑一次、看有没有可观察副作用"时才暴露。
 *
 * 本包真实发生过**三层**同类事故(2026-09-20),所以这里的断言都是照着实事写的:
 *   1. `import.meta.url === \`file://${process.argv[1]}\`` 在 Windows 上恒为 false
 *      (argv1 是 `T:\…`、url 是 `file:///T:/…`)→ 脚本加载完直接退出 0。
 *   2. 修它时把守卫抽进 `lib/entry.js` 想 DRY —— `import.meta.url` 是每个模块各自的,
 *      于是比较对象变成了那个文件自己 → **连 WSL 上也静默失效**。
 *   3. 动态 `import(join(ROOT, …))` 在 Windows 上抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`
 *      (绝对路径不是合法 ESM 说明符)→ "能运行、有日志、但判定全失败"。
 * 完整复盘见 docs/MEASUREMENTS.md §10;规则见 docs/DECISIONS.md D10。
 *
 * 跨平台:断言与平台无关。**Windows 与 WSL 各跑一遍**才算验过 —— 第 1 层只有 Windows 能暴露。
 *
 * @module jev-guard/tools/selftest-entry
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let failed = 0
let checks = 0

/**
 * @param label - 用例名。
 * @param ok - 断言结果。
 * @param detail - 失败细节。
 */
function expect(label, ok, detail = '') {
  checks += 1
  if (!ok) failed += 1
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `   ${detail}`}\n`)
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = await mkdtemp(join(tmpdir(), 'jev-guard-entry-'))
const CLI = join(ROOT, 'bin', 'guard.mjs')
const EXTRACTOR = join(ROOT, 'tools', 'extract-commands.mjs')
const DSH_ADAPTER = join(ROOT, 'adapters', 'dsh', 'index.js')

const env = {
  ...process.env,
  JEV_GUARD_HOME: HOME,
  JEV_GUARD_AUDIT_LOG: join(HOME, 'guard.log'),
  // 语言钉死:下面几条断言读的是中文输出,不该随运行机器的 locale 变色。
  JEV_GUARD_LANG: 'zh-CN',
}

/** 以入口身份运行一个脚本。 */
const run = (script, { input = '', extraEnv = {}, args = [] } = {}) =>
  spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', env: { ...env, ...extraEnv } })

// ── 1. CLI:作为入口被执行时必须真的干活 ───────────────────────────────────────
const cli = run(CLI, { args: ['selftest'] })
expect('guard selftest 作为入口被执行 → 退出码 0', cli.status === 0, `status=${cli.status} stderr=${cli.stderr.slice(0, 160)}`)
expect('guard selftest 输出 12 项结论(不是"什么都不做地成功退出")', /12 项全部通过/.test(cli.stdout), cli.stdout.slice(0, 120))
const status = run(CLI, { args: ['status'] })
expect('guard status 作为入口被执行 → 有输出', /Jev 安全阀门/.test(status.stdout), status.stdout.slice(0, 120))
expect('guard status 在健康时退出码 0', status.status === 0, `status=${status.status}`)

// ── 1b. 语言:入口必须能切换文案,而**不动判定** ────────────────────────────────
// 三个入口都要看:`--lang`(显式)、`JEV_GUARD_LANG`(环境)、以及"开关的值不是位置参数"。
const enStatus = run(CLI, { args: ['status', '--lang', 'en'] })
expect('guard status --lang en → 英文输出', /Jev guard: healthy/.test(enStatus.stdout), enStatus.stdout.slice(0, 120))
const enByEnv = run(CLI, { args: ['status'], extraEnv: { JEV_GUARD_LANG: 'en' } })
expect('JEV_GUARD_LANG=en 生效(不需要改配置)', /Jev guard: healthy/.test(enByEnv.stdout), enByEnv.stdout.slice(0, 120))
const enSelftest = run(CLI, { args: ['selftest', '--lang', 'en'] })
expect('guard selftest --lang en → 英文结论', /all 12 checks passed/.test(enSelftest.stdout), enSelftest.stdout.slice(0, 120))
const judgeLang = run(CLI, { args: ['judge', 'ls -la', '--lang', 'en'] })
// 判定行 + 理由行 = 2 行。若 `--lang` 的**值**被当成了一条命令,这里会多出两行
// (而且会真的去问一次 API)—— 那种错法必须在这里被抓住。
expect('--lang 的值不会被当成待判定的命令', judgeLang.stdout.trim().split('\n').length === 2, judgeLang.stdout.slice(0, 200))
const badLang = run(CLI, { args: ['status', '--lang', 'klingon'] })
expect('无法识别的语言 → 退回原语言并在 stderr 说明', /klingon/.test(badLang.stderr) && badLang.status === 0, badLang.stderr.slice(0, 160))

// ── 1c. 密钥录入:只从标准输入读、写 0600、永不回显 ─────────────────────────────
//
// 这条链路决定"首次部署能不能装上就用":市场里的新用户既没有 DSH 凭据层也没有环境变量,
// 唯一能自己完成的动作就是 `guard key set`。所以它必须被**真的执行一遍**验证,而不是只读代码。
const keyDir = await mkdtemp(join(tmpdir(), 'jev-guard-entry-key-'))
const keyFile = join(keyDir, 'secrets.json')
const KEY = 'apik-entry-selftest-0123456789'

// ① 非交互式 stdin(= agent 的调用形态)必须被拒 —— 密钥只能由人在键盘上敲。
const piped = run(CLI, { args: ['key', 'set', '--key-file', keyFile], input: `${KEY}\n` })
expect('key set 在非交互 stdin 下被拒(退出码 3)', piped.status === 3, `status=${piped.status}`)
expect('key set 被拒时不写任何文件', !existsSync(keyFile))

// ② 交互式终端形态:用一个把 isTTY 伪装成 true 的包装脚本喂密钥进去。
//    这是自动化里唯一能走通"人在键盘上输入"这条路的办法(readSecretLine 在没有 setRawMode 的
//    管道上会退化成普通 data 读取,所以管道喂得进去)。
const wrapper = join(keyDir, 'fake-tty.mjs')
await writeFile(wrapper, [
  "Object.defineProperty(process.stdin, 'isTTY', { value: true })",
  `process.argv = ['node', 'guard.mjs', 'key', 'set', '--key-file', ${JSON.stringify(keyFile)}]`,
  `await import(${JSON.stringify(pathToFileURL(CLI).href)})`,
  '',
].join('\n'))
const typed = spawnSync(process.execPath, [wrapper], { input: `${KEY}\n`, encoding: 'utf8', env })
expect('key set(交互终端)→ 退出码 0', typed.status === 0, `status=${typed.status} stderr=${typed.stderr.slice(0, 200)}`)
expect('key set 的输出里**没有**密钥本身', !typed.stdout.includes(KEY) && !typed.stderr.includes(KEY), typed.stdout.slice(0, 200))
const written = JSON.parse(await readFile(keyFile, 'utf8'))
expect('key set 写出的内容可用于解析(键名 = apiKeyEnv)', written.TYPESAFE_API_KEY === KEY, JSON.stringify(Object.keys(written)))
expect('key set 只打印长度,不打印值', /长度 \d+|length \d+/.test(typed.stdout), typed.stdout.slice(0, 200))
if (process.platform !== 'win32') {
  expect('key set 落盘权限 0600', (statSync(keyFile).mode & 0o777) === 0o600, (statSync(keyFile).mode & 0o777).toString(8))
}

// ③ `key status` 要能说出"哪个来源在生效",并且同样不回显。
const fromFile = run(CLI, { args: ['key', 'status', '--key-file', keyFile], extraEnv: { TYPESAFE_API_KEY: '' } })
expect('key status → 报告来源为文件、退出码 0', fromFile.status === 0 && /secrets\.json/.test(fromFile.stdout), fromFile.stdout.slice(0, 160))
expect('key status 不回显密钥', !fromFile.stdout.includes(KEY))
const fromEnv = run(CLI, { args: ['key', 'status', '--key-file', join(keyDir, 'missing.json')], extraEnv: { TYPESAFE_API_KEY: KEY } })
expect('key status → 环境变量优先(与适配器同序)', fromEnv.status === 0 && /环境变量|environment/.test(fromEnv.stdout), fromEnv.stdout.slice(0, 160))
const noKey = run(CLI, { args: ['key', 'status', '--key-file', join(keyDir, 'missing.json')], extraEnv: { TYPESAFE_API_KEY: '' } })
expect('key status → 没有密钥时退出码 3(可当健康检查)', noKey.status === 3, `status=${noKey.status}`)
await rm(keyDir, { recursive: true, force: true })

// ── 2. 工具脚本:作为入口被执行时要有产出 ─────────────────────────────────────
const extract = run(EXTRACTOR, { args: ['--limit', '1'], extraEnv: { DSH_HOME: join(HOME, 'no-such-dsh') } })
expect('extract-commands 作为入口被执行 → 退出码 0', extract.status === 0, `status=${extract.status} stderr=${extract.stderr.slice(0, 160)}`)
let toolOut = null
try {
  toolOut = JSON.parse(extract.stdout)
} catch {
  toolOut = null
}
expect('extract-commands 输出合法 JSON', Array.isArray(toolOut), extract.stdout.slice(0, 120))

// ── 3. DSH 适配器:**被 import 时不得注册任何东西** ─────────────────────────────
// 它是 Cordis 插件:没有 ctx 的时候 import 只能导出符号,不能有副作用。
// (这是"该安静的模块真的安静"那一半,与入口守卫相对。)
const asImport = spawnSync(process.execPath, [
  '-e', `import(${JSON.stringify(pathToFileURL(DSH_ADAPTER).href)}).then(m => console.log('EXPORTS:' + ['name', 'inject', 'apply'].filter(k => m[k] !== undefined).join(',')))`,
], { encoding: 'utf8', env, input: '' })
expect('DSH 适配器被 import 时干净退出(无副作用)', asImport.status === 0, `status=${asImport.status} stderr=${asImport.stderr.slice(0, 200)}`)
expect('DSH 适配器导出 name/inject/apply', asImport.stdout.includes('EXPORTS:name,inject,apply'), asImport.stdout.slice(0, 120))

// ── 4. lib/ 里的模块:import 不得有副作用(它们只提供函数) ────────────────────
const libImport = spawnSync(process.execPath, [
  '-e', `Promise.all(['gate','verdict','quota','token','audit','rules'].map(n => import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib')).href + '/')} + n + '.js'))).then(() => console.log('LIBS_OK'))`,
], { encoding: 'utf8', env, input: '' })
expect('lib/ 六个模块都能被安静地 import', libImport.stdout.includes('LIBS_OK') && libImport.status === 0, `status=${libImport.status} stderr=${libImport.stderr.slice(0, 200)}`)

// ── 5. 静态守卫:有入口守卫的文件必须**自己定义**,不许抽共享模块 ────────────────
// 这是第 2 层事故的直接护栏:`import.meta.url` 跟着模块走,抽出去就恒为 false。
const sourceFiles = ['bin/guard.mjs', 'tools/extract-commands.mjs', 'tools/selftest-entry.mjs', 'tools/report-result.mjs']
let inlinedGuards = 0
for (const rel of sourceFiles) {
  const src = await readFile(join(ROOT, rel), 'utf8')
  const sharedImport = /import\s*\{[^}]*isMainModule[^}]*\}/.test(src)
  expect(`${rel}:没有从共享模块导入入口守卫`, !sharedImport, '出现了 isMainModule 的共享导入(抽出去会恒为 false)')
  if (/function isMainModule\s*\(/.test(src)) inlinedGuards += 1
}
expect('带入口守卫的脚本,守卫是内联的(至少一个)', inlinedGuards >= 1, `找到 ${inlinedGuards} 个内联守卫`)
const extractorSrc = await readFile(EXTRACTOR, 'utf8')
expect('extract-commands 的守卫内联在本文件里', extractorSrc.includes('function isMainModule'))

await rm(HOME, { recursive: true, force: true })
process.stdout.write(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}(${checks} 例)  平台=${process.platform}\n`)
if (process.platform !== 'win32') {
  process.stdout.write('注意:Windows 专属的那半边(盘符 + 反斜杠的 argv[1])只有在 Windows 上运行本文件时才被覆盖。\n')
}
process.exit(failed === 0 ? 0 : 1)
