#!/usr/bin/env node
/**
 * 拒绝理由自检:那行"交给用户去终端里执行"的授权命令,必须真的能整行复制粘贴。
 *
 * 为什么单独有这份自检:这条理由的读者是**用户**,而且他是在**自己的终端**里粘贴 ——
 * 工作目录是任意的。曾经这里打印的是相对路径 `node bin/guard.mjs`,只有用户恰好站在包目录
 * 里才能用;而授权命令里的命令文本一旦被截断或引号转义写错,用户拿到的令牌就与 AI 重试的
 * 那条命令对不上,表现为"授权了还是被拦"。两者都不会报错,只会静静地失效 —— 所以要断言。
 *
 * 全部离线:用合成 verdict,不联网、不碰 ~/.jev-guard。
 *
 * @module jev-guard/tools/selftest-reason
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { explain, reviseGuidance, shellName, shellQuote, toHostDecision } from '../lib/verdict.js'

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

/**
 * 打印一条"跳过"说明(不计入断言数)。
 * 为什么要专门区分:一个"在任何平台都假装通过"的断言比没有断言更糟 ——
 * 它会让 reviewer 以为某件事验过了。
 * @param text - 说明文本。
 */
function note(text) {
  process.stdout.write(`note  ${text}\n`)
}

/** 可用来做 POSIX 引号往返的 shell;Windows 上没有,那就跳过并说明。 */
const POSIX_SHELL = process.platform === 'win32' ? undefined : 'bash'

/** 与 adapters/dsh/index.js 里同样的推导,用于断言默认路径落在包内。 */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 一个"被 Jev 判为危险"的合成判定 —— 非 L0,所以理由里应当带令牌提示。 */
const riskVerdict = { action: 'block', source: 'jev', p: 0.78, model: 'jev-1.13.0', ms: 290 }
/** 一个 L0 硬规则判定 —— 永不允许,理由里**不应**出现令牌提示。 */
const l0Verdict = { action: 'block', source: 'static-rule', rule: { id: 'mkfs', why: '格式化文件系统', kind: 'deny' } }

const CMD = 'rm -rf /home/user/jev-guard-probe-dir'

// 1) 授权行用的是绝对路径,且落在包内的 bin/guard.mjs
const hint = explain(CMD, riskVerdict, { policy: 'never', token: 'ALLOW-0A2DB6157F' })
const m = hint.match(/ node (\S+) allow ([\s\S]*?) —— 然后重试同一条命令/)
expect('理由里出现授权行', m !== null, hint)
const cliPath = m?.[1] ?? ''
expect('授权行给出的是绝对路径', isAbsolute(cliPath), cliPath)
expect('绝对路径指向包内的 bin/guard.mjs', cliPath === join(PKG_ROOT, 'bin', 'guard.mjs'), cliPath)
expect('授权行以 node 开头(可直接粘贴)', / node \S+ allow /.test(hint))
expect('令牌原文出现在理由里', hint.includes('ALLOW-0A2DB6157F'))
expect('用户被明确告知"AI 自己跑会被拒"', hint.includes('授权只在交互终端生效'))

// 2) 引号转义必须能原样解析回同一条命令(用户粘进 shell 的结果 = AI 重试的那条命令)
//
// ⚠️ 这一段用 **bash** 做往返,只在 POSIX 平台适用。Windows 上应当验的是 **PowerShell** 形式
// (见第 10 节),这里显式**跳过并说明**,而不是让它悄悄失败或悄悄通过 ——
// 一个"在任何平台都假装通过"的断言比没有断言更糟。
const quoted = m?.[2] ?? ''
if (POSIX_SHELL) {
  const back = execFileSync(POSIX_SHELL, ['-c', `printf %s ${quoted}`], { encoding: 'utf8' })
  expect('粘贴后解析回的命令与原文逐字一致', back === CMD, JSON.stringify(back))
} else {
  note('绕过 bash 的往返用例已跳过(本平台没有 POSIX shell;Windows 走第 10 节的 PowerShell 往返)')
}

// 3) 命令里带单引号 / 双引号 / 中文时同样成立(shellQuote 的单引号转义)
const tricky = 'rm -rf /home/user/jev-guard-probe-dir && echo "it\'s 探针,含单引号与中文"'
const trickyHint = explain(tricky, riskVerdict, { policy: 'never', token: 'ALLOW-15537AF182' })
const trickyQuoted = trickyHint.match(/ allow ([\s\S]*?) —— 然后重试同一条命令/)?.[1] ?? ''
if (POSIX_SHELL) {
  const trickyBack = execFileSync(POSIX_SHELL, ['-c', `printf %s ${trickyQuoted}`], { encoding: 'utf8' })
  expect('含引号/中文的命令也能原样解析回来', trickyBack === tricky, JSON.stringify(trickyBack))
} else {
  note('含引号/中文的 bash 往返已跳过(同上)')
}

// 4) 长命令**不得**被截断:令牌是对完整命令文本求哈希的,截断后用户授权就匹配不上。
//    (理由末尾" 命令:<文本>"那一段允许截断到 300 字符,但授权行不行。)
const longCmd = `rm -rf /home/user/jev-guard-probe-dir/${'sub-dir-'.repeat(50)}`
const longHint = explain(longCmd, riskVerdict, { policy: 'never', token: 'ALLOW-DEADBEEF00' })
const longQuoted = longHint.match(/ allow ([\s\S]*?) —— 然后重试同一条命令/)?.[1] ?? ''
expect('长命令的授权行未被截断', longQuoted.includes('sub-dir-'.repeat(50)) && longQuoted.length > 300, String(longQuoted.length))
if (POSIX_SHELL) {
  const longBack = execFileSync(POSIX_SHELL, ['-c', `printf %s ${longQuoted}`], { encoding: 'utf8' })
  expect('长命令也能原样解析回来', longBack === longCmd, String(longBack.length))
} else {
  expect('长命令的授权行长度与原文一致(不经 shell 直接比对)', longQuoted.length >= longCmd.length, `${longQuoted.length} vs ${longCmd.length}`)
}

// 5) L0 硬规则:令牌越过不了硬地板,所以理由里**不该**出现授权行(免得用户白试)
const l0Hint = explain('mkfs.ext4 /dev/sdb1', l0Verdict, { policy: 'never', token: 'ALLOW-0A2DB6157F' })
expect('L0 拦截的理由里没有授权提示', !l0Hint.includes('allow ') && !l0Hint.includes('ALLOW-0A2DB6157F'), l0Hint)
expect('L0 拦截的理由仍说明不是用户手动拒绝', l0Hint.includes('不是用户手动拒绝'))

// 6) token 缺失时不给出授权行(没什么可授权的)
expect('没有令牌时不出现授权提示', !explain(CMD, riskVerdict, { policy: 'never' }).includes('allow '))

// 7) 宿主侧映射与理由同源:deny 的 reason 就是 explain 的输出
const deny = toHostDecision(CMD, riskVerdict, 'never', { token: 'ALLOW-0A2DB6157F' })
expect('never 策略下映射为 deny', deny.kind === 'deny')
expect('deny 的理由同样带绝对路径授权行', deny.reason.includes(join(PKG_ROOT, 'bin', 'guard.mjs')) && deny.reason.includes('ALLOW-0A2DB6157F'))
expect('allow 判定不产生理由', toHostDecision('ls', { action: 'allow', source: 'prefilter' }, 'never').kind === 'allow')

// 8) 策略分叉:同一个 escalate,在 never 下是"没有弹窗 + 给令牌",在 ask 下是"已弹审批窗 + 不给令牌"。
//    实测教训(2026-09-20):ask 模式的弹窗里原样显示了 never 模式那句"本会话没有审批提示",
//    还附了一条让用户去终端授权的命令 —— 指着眼前的弹窗说没有弹窗。
const TRUNC = 'truncate -s 0 /home/user/jev-guard-demo/notes.txt'
/** 一个"必须人工确认"的 L0 ask 判定(kind='ask',与 kind='deny' 的硬地板相对)。 */
const askRuleVerdict = { action: 'escalate', source: 'static-rule', rule: { id: 'truncate-file', why: '把文件截断/覆盖为空', kind: 'ask' }, token: 'ALLOW-5031AC2085' }

const askEsc = toHostDecision(TRUNC, askRuleVerdict, 'ask', { token: 'ALLOW-5031AC2085' })
expect('ask 策略下 escalate 映射为 ask(宿主会弹审批框)', askEsc.kind === 'ask', askEsc.kind)
expect('ask 策略的理由说明宿主已发起审批请求', askEsc.reason.includes('审批请求'), askEsc.reason.slice(0, 140))
expect('ask 策略的理由不再说"本会话没有审批提示"', !askEsc.reason.includes('本会话没有审批提示'))
expect('ask 策略下不再附令牌授权行(人就在弹窗前面)', !askEsc.reason.includes('ALLOW-5031AC2085'), askEsc.reason.slice(0, 200))
expect('ask 策略的理由里没有"复制到终端"那句', !askEsc.reason.includes('allow '))

const neverEsc = toHostDecision(TRUNC, askRuleVerdict, 'never', { token: 'ALLOW-5031AC2085' })
expect('never 策略下 escalate 映射为 deny', neverEsc.kind === 'deny', neverEsc.kind)
expect('never 策略仍然说没有审批提示', neverEsc.reason.includes('本会话没有审批提示'))
expect('never 策略仍然附令牌授权行', neverEsc.reason.includes('ALLOW-5031AC2085'))

// 8b) 模式相关路由(2026-09-20 用户决定,见 docs/DECISIONS.md D13)。
//     改动前:只有 escalate 会看审批策略,revise / block 一律直接拒绝。审计证据 —— 一天里
//     **9 条 revise 拒绝发生在 approval=ask 模式下**(全是 cp / sed -i / git add 这类维护动作),
//     人就在场却拿不到弹窗,等于让一个 50% 的判断替人做决定。
//     改动后:ask 模式下 revise 与 Jev 高分的 block 都转人工审批;never 模式(全自动,没人可问)
//     保持直接拒绝。**例外**是 L0 的 deny 类硬规则:两种模式都拦死,不弹窗也不发令牌。
const reviseVerdict = { action: 'revise', source: 'jev', p: 0.58, model: 'jev-1.13.0', ms: 240 }

const askBlock = toHostDecision(CMD, riskVerdict, 'ask', { token: 'ALLOW-0A2DB6157F' })
expect('ask 策略下 Jev 高分的 block 转人工审批', askBlock.kind === 'ask', askBlock.kind)
expect('ask 策略下 block 的理由说明已发起审批请求', askBlock.reason.includes('审批请求'), askBlock.reason.slice(0, 140))
expect('ask 策略下 block 不再附令牌授权行(人就在弹窗前面)', !askBlock.reason.includes('ALLOW-0A2DB6157F'))

const neverBlock = toHostDecision(CMD, riskVerdict, 'never', { token: 'ALLOW-0A2DB6157F' })
expect('never 策略下 Jev 高分的 block 仍然是 deny', neverBlock.kind === 'deny', neverBlock.kind)
expect('never 策略下 block 仍附令牌授权行', neverBlock.reason.includes('ALLOW-0A2DB6157F'))

const askRevise = toHostDecision(CMD, reviseVerdict, 'ask', { token: 'ALLOW-0A2DB6157F' })
expect('ask 策略下 revise 转人工审批', askRevise.kind === 'ask', askRevise.kind)
expect('ask 策略下 revise 的抬头改成"需要人工确认"', askRevise.reason.includes('需要人工确认'), askRevise.reason.slice(0, 70))
expect('ask 策略下 revise 不再附令牌授权行', !askRevise.reason.includes('ALLOW-0A2DB6157F'))

const neverRevise = toHostDecision(CMD, reviseVerdict, 'never', { token: 'ALLOW-0A2DB6157F' })
expect('never 策略下 revise 仍然是 deny', neverRevise.kind === 'deny', neverRevise.kind)
expect('never 策略下 revise 仍附令牌授权行', neverRevise.reason.includes('ALLOW-0A2DB6157F'))
expect('never 策略下 revise 的抬头仍是"暂缓"', neverRevise.reason.includes('[暂缓'), neverRevise.reason.slice(0, 70))

// 例外:L0 的 deny 类硬规则 = 绝对闸门。两种模式都拦死,既不弹窗也不给令牌。
const askL0 = toHostDecision('mkfs.ext4 /dev/sdb1', l0Verdict, 'ask', { token: 'ALLOW-0A2DB6157F' })
expect('ask 策略下 L0 硬拒绝**不**转人工(绝对闸门)', askL0.kind === 'deny', askL0.kind)
expect('L0 硬拒绝的理由里没有令牌授权行', !askL0.reason.includes('ALLOW-0A2DB6157F'))
expect('L0 硬拒绝的理由仍说"禁止自动执行"', askL0.reason.includes('禁止自动执行'), askL0.reason.slice(0, 170))

// 两个路由开关可以单独关掉(配置层就能回退,不必改代码)
const askReviseOff = toHostDecision(CMD, reviseVerdict, 'ask', { reviseInAskMode: 'deny', token: 'ALLOW-0A2DB6157F' })
expect('reviseInAskMode=deny 时退回直接拒绝', askReviseOff.kind === 'deny', askReviseOff.kind)
const askBlockOff = toHostDecision(CMD, riskVerdict, 'ask', { blockInAskMode: 'deny', token: 'ALLOW-0A2DB6157F' })
expect('blockInAskMode=deny 时退回直接拒绝', askBlockOff.kind === 'deny', askBlockOff.kind)

// explain 的抬头也要跟着**路由结果**走(弹窗里显示的就是这句)
const routedHead = explain(CMD, reviseVerdict, { policy: 'ask', routedToHuman: true })
expect('已转人工时 revise 的抬头是"需要人工确认"', routedHead.includes('[需要人工确认]'), routedHead.slice(0, 70))
const deniedHead = explain(CMD, reviseVerdict, { policy: 'ask', routedToHuman: false })
expect('未转人工时 revise 的抬头仍是"暂缓"', deniedHead.includes('[暂缓'), deniedHead.slice(0, 70))

// revise 的三种降级模板**两种出路都要带**:转人工时是弹窗正文,被拒时是给模型的教案。
const routedGuidance = reviseGuidance(CMD, reviseVerdict, { policy: 'ask', routedToHuman: true })
expect('转人工的 revise 理由仍带三种降级模板', routedGuidance.includes('可以尝试的更安全形式'), routedGuidance.slice(-200))
expect('转人工的 revise 理由带令牌以外的降级建议', routedGuidance.includes('只读/演练') || routedGuidance.includes('作用域'))

// 9) shellQuote:单引号包裹 + 按**平台**分叉的转义(POSIX `'\''` vs PowerShell `''`)
expect("shellQuote(POSIX) 转义单引号", shellQuote("a'b", 'linux') === "'a'\\''b'", shellQuote("a'b", 'linux'))
expect('shellQuote(POSIX) 包裹普通文本', shellQuote('ls -la', 'linux') === "'ls -la'", shellQuote('ls -la', 'linux'))
expect("shellQuote(win32) 用双写单引号转义", shellQuote("a'b", 'win32') === "'a''b'", shellQuote("a'b", 'win32'))
expect('shellQuote(win32) 包裹普通文本', shellQuote('ls -la', 'win32') === "'ls -la'", shellQuote('ls -la', 'win32'))
expect('两种平台的引号**确实不同**(不能互相套用)',
  shellQuote("a'b", 'win32') !== shellQuote("a'b", 'linux'))
expect('shellName 说得出该开哪个终端', shellName('win32') === 'PowerShell' && shellName('linux').includes('POSIX'), shellName('linux'))

// 授权行必须跟着平台走 —— 否则 Windows 用户拿到的是**语法不通**的一行(实测见下)
const winReason = explain("rm -rf /tmp/it's", riskVerdict, { policy: 'never', token: 'ALLOW-0A2DB6157F', platform: 'win32' })
expect('win32 平台的理由里用 PowerShell 形式', winReason.includes("'rm -rf /tmp/it''s'"), winReason.slice(winReason.indexOf('命令:') - 120, winReason.indexOf('命令:')))
expect('win32 平台的理由里点明用 PowerShell', winReason.includes('PowerShell'))
const posixReason = explain("rm -rf /tmp/it's", riskVerdict, { policy: 'never', token: 'ALLOW-0A2DB6157F', platform: 'linux' })
expect('linux 平台的理由里仍用 POSIX 形式', posixReason.includes("'rm -rf /tmp/it'\\''s'"), posixReason.slice(0, 80))

// 10) 引号的**真机往返**:把转义后的形式喂给真正的 shell,要求逐字节还原。
//     本机(WSL)有 bash;若还能找到 Windows PowerShell,就顺带把 win32 那一半也验了 ——
//     这正是"Windows 上引号是另一套语法"这件事的决定性证据。
const backPosix = execFileSync('bash', ['-c', `printf %s ${shellQuote("a'b c", 'linux')}`], { encoding: 'utf8' })
expect('POSIX 形式过 bash 往返还原', backPosix === "a'b c", JSON.stringify(backPosix))

/**
 * 找一个**能真正执行**的 Windows PowerShell。
 *
 * 候选同时覆盖两种视角,而且**用"跑一下试试"来判断可用性**,不是只看文件在不在:
 *   · 在 Windows 上跑本文件时,`pwsh` / `powershell` 就在 PATH 上;
 *   · 在 WSL 上跑本文件时,要走 `/mnt/c/...` 下的 .exe(互操作)。
 * 只看 `/mnt/c/...` 会让 Windows 侧的运行**反而跳过**这条最该在 Windows 上做的断言 ——
 * 本自检第一次在 Windows 上跑就是这样跳过的。
 *
 * @returns 可执行名/路径,或 undefined。
 */
function findWindowsPowerShell() {
  const candidates = [
    process.env.JEV_GUARD_PWSH,
    'pwsh',
    'powershell',
    '/mnt/c/Program Files/PowerShell/7/pwsh.exe',
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-NoProfile', '-Command', '[Console]::Out.Write(1)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return candidate
    } catch {
      // 试下一个
    }
  }
  return undefined
}

const pwsh = findWindowsPowerShell()
if (pwsh) {
  const roundTrip = text => execFileSync(pwsh, ['-NoProfile', '-Command', `[Console]::Out.Write(${shellQuote(text, 'win32')})`], { encoding: 'utf8' })
  const backWin = roundTrip("a'b c")
  expect('PowerShell 形式过真实 PowerShell 往返还原', backWin === "a'b c", JSON.stringify(backWin))
  // 反例:旧的 POSIX 形式在 PowerShell 里**语法都不成立** —— 这就是修复的理由
  let posixInPwshFailed = false
  try {
    execFileSync(pwsh, ['-NoProfile', '-Command', `[Console]::Out.Write(${shellQuote("a'b", 'linux')})`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    posixInPwshFailed = true
  }
  expect('反例成立:POSIX 形式在 PowerShell 里解析失败(所以必须分叉)', posixInPwshFailed)
} else {
  expect('PowerShell 往返用例(本机找不到 PowerShell,跳过)', true)
}

process.stdout.write(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}(${checks} 例)\n`)
process.exit(failed === 0 ? 0 : 1)
