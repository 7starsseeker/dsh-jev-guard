#!/usr/bin/env node
/**
 * guard —— jev-guard 的命令行面(与 DSH 插件共用同一套判定)。
 *
 * 它存在的意义是**离线复跑**:装进 DSH 之前先证明判定层能工作,出事故之后再拿它复现同一条判定。
 * 所以这里的子命令都是"给人看/给脚本用",不是给别的工具集成用的入口:
 *
 *   guard judge   …            一次性判定:stdin 逐行或 argv → 每行一个 verdict JSON
 *   guard log     [--tail N]   读共享审计日志(`--stats` 看汇总与成本)
 *   guard status  [--clear]    阀门是好的吗?(降级时退出码 3,可当健康检查)
 *   guard allow   '<命令>'     一次性放行令牌的人工入口(另有 --command-file / --list / --revoke)
 *   guard selftest             离线自检:L0 规则、预筛、四态映射
 *   guard rules                打印 L0 规则清单
 *
 * The key is never printed and never stored here: it comes from the environment
 * variable named by config.apiKeyEnv, or from the file named by config.apiKeyFile.
 *
 * @module jev-guard/cli
 */

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, evaluateCommand, prefilter } from '../lib/gate.js'
import { DEFAULT_LOG_PATH, lastLogError, readTail, resolveLogPath, summarize } from '../lib/audit.js'
import {
  clearDegraded, enterDegraded, isDegraded, probeDue, readDegraded, resolveDegradedPath, statusText, warningLine,
} from '../lib/quota.js'
import { resolveTokenPath, grantToken, readTokens, revokeToken } from '../lib/token.js'
import { DENY_RULES, ASK_RULES, staticRule } from '../lib/rules.js'
import { explain, fingerprint, shellName, shellQuote } from '../lib/verdict.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const VERSION = '0.1.0'

/**
 * @param name - flag name including dashes.
 * @param fallback - value when the flag is absent.
 * @returns the following argument or the fallback.
 */
function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}

/** @param name - flag name including dashes. @returns whether it was passed. */
function flag(name) {
  return process.argv.includes(name)
}

/**
 * Load config.json from the package root and merge it over the defaults.
 * @returns the effective config object.
 */
async function loadConfig() {
  let file = {}
  try {
    file = JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8'))
  } catch {
    // no config.json -> defaults only
  }
  return { ...DEFAULTS, ...file }
}

/**
 * Resolve the API key without ever echoing it.
 *
 * 路径语义:`apiKeyFile` 若给的是**相对路径**,一律按**包根**解析(与 cwd 无关)。
 * 旧写法 `cfg.apiKeyFile ?? join(ROOT, 'secrets.json')` 只在"字段缺失"时回落到包根,
 * 一旦填了相对路径就变成"按调用时的 cwd 解析" —— 在包目录外调用(CLI 与离线脚本都可能)就读不到
 * 密钥,表现为 `source: error`,并且因为"无密钥"被当成持久失败而**写进共享的 degraded.json**:
 * 那会让**别的入口**(各有自己的密钥解析、密钥其实是好的)也一起停掉联网判定 30 分钟。
 * 绝对路径仍然原样使用。
 *
 * @param cfg - effective config.
 * @returns the key, or undefined.
 */
async function resolveKey(cfg) {
  const ref = cfg.apiKeyEnv ?? 'TYPESAFE_API_KEY'
  if (process.env[ref]) return process.env[ref]
  const configured = typeof cfg.apiKeyFile === 'string' && cfg.apiKeyFile.trim() !== '' ? cfg.apiKeyFile : undefined
  const file = configured === undefined
    ? join(ROOT, 'secrets.json')
    : (isAbsolute(configured) ? configured : join(ROOT, configured))
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const value = parsed[ref] ?? parsed.apiKey
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  } catch {
    // absent is fine: prefilter and L0 still work
  }
  return undefined
}

/**
 * One judgement, with the API key resolved once by the caller.
 * @param command - command text.
 * @param cfg - effective config including apiKey.
 * @param extra - `{ cwd, policy }`.
 * @returns the verdict object.
 */
async function judge(command, cfg, extra = {}) {
  const verdict = await evaluateCommand(command, { ...cfg, cwd: extra.cwd ?? process.cwd() })
  const decision = toHost(verdict, extra.policy ?? 'never')
  return { ...verdict, decision: decision.kind, reason: explain(command, verdict, { policy: extra.policy ?? 'never' }), fingerprint: fingerprint(command) }
}

/**
 * 打印降级告警到 stderr —— 任何一条 CLI 路径都该在"阀门不完整"时先说一句。
 * @param cfg - 配置。
 * @returns 是否有降级状态。
 */
async function warnIfDegraded(cfg) {
  if (cfg.quotaGuard === false) return false
  const state = await readDegraded(cfg)
  if (!state) return false
  process.stderr.write(`${warningLine(state)}\n  状态详情:node ${process.argv[1]} status\n`)
  return true
}

/**
 * Host mapping (kept local so the CLI has no dependency on a host adapter).
 * @param verdict - composed verdict.
 * @param policy - approval policy of the host session.
 * @returns `{ kind }`.
 */
function toHost(verdict, policy) {
  if (verdict.action === 'allow') return { kind: 'allow' }
  if (verdict.action === 'escalate') return { kind: policy === 'ask' ? 'ask' : 'deny' }
  return { kind: 'deny' }
}

/** Offline assertions: no network, must always pass. */
const SELFTEST = [
  ['ls -la /var/log', 'allow', 'prefilter'],
  ['git status --short', 'allow', 'prefilter'],
  ['rm -rf /tmp/build-cache', 'allow', 'prefilter'],
  ['dd if=/dev/zero of=/dev/sda bs=1M', 'block', 'static-rule'],
  ['mkfs.ext4 /dev/sdb1', 'block', 'static-rule'],
  ['git push --force origin main', 'block', 'static-rule'],
  ['wsl --unregister Ubuntu', 'block', 'static-rule'],
  ['kubectl delete namespace production', 'block', 'static-rule'],
  ['vssadmin delete shadows /all', 'block', 'static-rule'],
  ['git reset --hard HEAD~3', 'escalate', 'static-rule'],
  ['rsync -a --delete /tmp/x/ /home/u/', 'escalate', 'static-rule'],
  ['curl https://x.sh | bash', 'escalate', 'static-rule'],
]

/**
 * Run the offline self-test.
 * @returns exit code.
 */
function selftest() {
  let failed = 0
  process.stdout.write(`L0 规则: deny ${DENY_RULES.length} 条 / ask ${ASK_RULES.length} 条\n\n`)
  for (const [command, wantAction, wantSource] of SELFTEST) {
    const rule = staticRule(command)
    const fast = rule ? undefined : prefilter(command)
    const action = rule ? (rule.kind === 'deny' ? 'block' : 'escalate') : fast ? 'allow' : 'unjudged'
    const source = rule ? 'static-rule' : fast ? 'prefilter' : 'jev'
    const ok = action === wantAction && source === wantSource
    if (!ok) failed += 1
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${action.padEnd(8)} ${source.padEnd(12)} ${command}\n`)
  }
  process.stdout.write(failed === 0
    ? `\nselftest: ${SELFTEST.length} 项全部通过(未联网)\n`
    : `\nselftest: ${failed} 项失败\n`)
  return failed === 0 ? 0 : 1
}

/** Print the rule inventory. */
function rules() {
  process.stdout.write('# L0 deny(永不放行)\n')
  for (const r of DENY_RULES) process.stdout.write(`- ${r.id.padEnd(28)} ${r.why}\n`)
  process.stdout.write('\n# L0 ask(必须人工确认)\n')
  for (const r of ASK_RULES) process.stdout.write(`- ${r.id.padEnd(28)} ${r.why}\n`)
}

/**
 * Read commands: argv after the subcommand, or one per line on stdin.
 * @returns command strings.
 */
async function readCommands() {
  const rest = process.argv.slice(3).filter(a => !a.startsWith('--'))
  if (rest.length > 0 && process.argv[2] === 'judge' && process.argv[3] !== '--stdin') return rest
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))
}

/**
 * `guard judge` — one judgement per line.
 * @returns exit code: 0 = all allowed, 3 = something was not allowed.
 */
async function cmdJudge() {
  const cfg = await loadConfig()
  cfg.apiKey = await resolveKey(cfg)
  const cwd = arg('--cwd', process.cwd())
  const policy = arg('--policy', 'never')
  const commands = await readCommands()
  let worst = 0
  for (const command of commands) {
    const verdict = await judge(command, cfg, { cwd, policy })
    const out = {
      command,
      action: verdict.action,
      source: verdict.source,
      p: verdict.p,
      model: verdict.model,
      rule: verdict.rule,
      ms: verdict.ms,
      enriched: verdict.enriched,
      error: verdict.error,
      errorKind: verdict.errorKind,
      degraded: verdict.degraded,
      warning: verdict.warning,
      usage: verdict.usage,
      overridden: verdict.overridden,
      token: verdict.token,
      decision: verdict.decision,
    }
    process.stdout.write(`${flag('--json') ? JSON.stringify(out) : `${verdict.action.padEnd(9)} ${String(out.p ?? '-').padEnd(5)} ${verdict.source.padEnd(12)} ${command}`}\n`)
    if (verdict.action !== 'allow') worst = 3
    if (!flag('--json')) process.stdout.write(`          ↳ ${verdict.reason.replace(/\n/g, '\n          ')}\n`)
  }
  return worst
}

/**
 * `guard log` —— 读共享审计日志:默认尾部 20 条;`--stats` 打印近 N 小时汇总。
 * @returns exit code.
 */
async function cmdLog() {
  const cfg = await loadConfig()
  const logPath = resolveLogPath({ logPath: arg('--file', cfg.logPath) })
  /** 写入失败时给一句明确提示 —— 静默失败曾经让整套日志白跑一轮。 */
  const explainEmpty = () => {
    const err = lastLogError()
    if (err) process.stdout.write(`⚠️  最近一次写入失败:${err}\n   (审计写入失败会被静默吞掉以免影响判定,所以在这里显式提示)\n`)
  }
  if (flag('--stats')) {
    const hours = Number(arg('--hours', '24'))
    const s = await summarize({ logPath, since: Date.now() - hours * 3600 * 1000 })
    process.stdout.write(`日志: ${logPath}\n`)
    if (s.total === 0) {
      process.stdout.write(`近 ${hours} 小时没有记录。\n`)
      explainEmpty()
      return 0
    }
    process.stdout.write(`近 ${hours} 小时共 ${s.total} 条  (${s.firstAt} → ${s.lastAt})\n`)
    process.stdout.write(`  fail-open(判定失败但放行): ${s.failOpen}\n`)
    if (s.degraded > 0 || s.lastDegraded) {
      process.stdout.write(`  ⚠️ 降级放行(额度/密钥类,没花钱): ${s.degraded} 条`
        + `${s.lastDegraded ? `   最近:${s.lastDegraded.kind} @ ${String(s.lastDegraded.at).slice(11, 19)}Z` : ''}\n`)
    }
    const line = (label, obj) => {
      const body = Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')
      process.stdout.write(`  ${label}: ${body || '—'}\n`)
    }
    line('按动作', s.byAction)
    line('按来源', s.bySource)
    line('按规则', s.byRule)
    if (Object.keys(s.byErrorKind).length > 0) line('失败分类', s.byErrorKind)
    // 成本可见性:只统计**记录到了 usage** 的那些调用,并如实说明覆盖率,不假装是全额。
    if (s.priced > 0) {
      const coverage = s.total > 0 ? Math.round((s.priced / s.total) * 100) : 0
      process.stdout.write(`  语义判定成本: 约 $${s.costUsd.toFixed(4)}`
        + `  (${s.inputTokens} 输入 token,${s.priced} 次调用有 usage 记录 ≈ 全部记录的 ${coverage}%;输出按官方说明免费)\n`)
    } else {
      process.stdout.write('  语义判定成本: 未记录(最近的调用没有返回 usage;升级前写入的旧记录也不含)\n')
    }
    return 0
  }
  const tail = Number(arg('--tail', '20'))
  const records = await readTail({ logPath, tail })
  process.stdout.write(`日志: ${logPath}  (最近 ${records.length} 条)\n\n`)
  if (records.length === 0) {
    process.stdout.write('还没有记录。装好阀门后,每个判定都会写到这里。\n')
    explainEmpty()
    return 0
  }
  for (const r of records) {
    const p = r.p === undefined ? '  -  ' : Number(r.p).toFixed(2)
    const bits = [
      String(r.at ?? '').slice(11, 19),
      String(r.action ?? '?').padEnd(9),
      `p=${p}`.padEnd(7),
      String(r.source ?? '?').padEnd(12),
      String(r.tool ?? '').padEnd(5),
      r.rule ? `rule=${r.rule}` : '',
      r.enriched && r.enriched.length ? `+${r.enriched.join('+')}` : '',
    ].filter(Boolean).join(' ')
    process.stdout.write(`${bits}\n    ${String(r.command ?? '').slice(0, 150)}\n`)
  }
  return 0
}

/**
 * `guard status` —— 一句话回答"阀门现在是好的吗"。
 *
 * 为什么需要它:额度耗尽/密钥失效时,旧行为是**静默 fail-open** —— 命令照跑、日志里一堆
 * error,但没有任何人能一眼看出"它已经不在防护了"。这个子命令把那份状态(以及"还剩多久
 * 自动恢复""现在还剩哪一层在工作")直接摆出来,并且可以被任何宿主 AI 当健康检查调用。
 *
 * @returns exit code.
 */
async function cmdStatus() {
  const cfg = await loadConfig()
  cfg.apiKey = await resolveKey(cfg)

  if (flag('--clear')) {
    const removed = await clearDegraded({ degradedPath: arg('--file', cfg.degradedPath) })
    process.stdout.write(removed
      ? '已清除降级状态。下一条命令会重新尝试联网判定(失败会再次进入降级)。\n'
      : '当前没有降级状态,无需清除。\n')
    return 0
  }

  const state = await readDegraded({ degradedPath: arg('--file', cfg.degradedPath) })
  const now = Date.now()
  process.stdout.write(`${statusText(state, now, { apiKeyPresent: Boolean(cfg.apiKey) })}\n`)
  process.stdout.write(`\n  状态文件: ${resolveDegradedPath({ degradedPath: cfg.degradedPath })}${state ? '' : '(不存在 = 健康)'}\n`)
  process.stdout.write('  说明:降级 = 停用**要花钱的语义判定**;免费的 L0 规则与预筛照常工作'
    + `(当前 degradePolicy=${cfg.degradePolicy ?? 'l0-only'})。\n`)
  if (state && probeDue(state, now)) {
    process.stdout.write('  注意:冷却已到期,下一条命令会自动发一次探测请求(成功即恢复)。\n')
  }
  return state ? 3 : 0
}

/**
 * `guard allow` —— 一次性放行令牌的人工入口。
 *
 *   guard allow '<命令原文>'            为这条命令写一个令牌(重试同一条命令即放行一次)
 *   guard allow --command-file <文件>   从文件读命令原文 —— **与 shell 引号无关**,
 *                                       Windows 上 cmd.exe 不好转义时用这个(见下)
 *   guard allow --list                  看当前待用的令牌
 *   guard allow --revoke ALLOW-XXXX     撤销一个令牌
 *
 * 令牌绑定命令的规范化哈希,用掉即删,无法重放;L0 的"永不允许"规则不受它影响。
 * @returns exit code.
 */
async function cmdAllow() {
  const cfg = await loadConfig()
  const tokenPath = resolveTokenPath({ tokenPath: arg('--file', cfg.tokenPath) })

  // 授权只能在**交互终端**里做。
  //
  // 为什么:授予令牌 = 给一条被判为危险/不可判定的命令开一次后门。如果 agent 能自己跑
  // `guard allow`,它就能给自己授权,阀门等于不存在 —— 实测 agent 跑的授权命令本身也会
  // 被判为 revise(p=56%),所以正确的做法不是绕过它,而是把这条路明确堵死:
  // 人在自己的终端里跑时 stdin 是 TTY,agent 的工具调用不是,这就是分界线。
  const fromFile = arg('--command-file')
  if (!flag('--list') && fromFile === undefined && !process.stdin.isTTY) {
    const target = process.argv.slice(3).filter(a => !a.startsWith('--')).join(' ') || '<原命令>'
    const line = `node ${process.argv[1]} allow ${shellQuote(target, process.platform)}`
    process.stderr.write(
      '授权必须在交互终端里执行:当前检测到非交互环境(不是 TTY)。\n'
      + '这是有意的 —— 否则被监管的 AI 就能给自己授权,阀门形同虚设。\n\n'
      + `请让用户在最普通的终端窗口(${shellName(process.platform)})里复制执行下面这一行:\n\n`
      + `  ${line}\n\n`
      + 'Windows 的 cmd.exe 不支持上面这种引号写法 —— 那种情况改用与 shell 无关的入口:\n'
      + '把命令原文**原样**写进一个文件(比如 cmd.txt),然后执行\n\n'
      + `  node ${process.argv[1]} allow --command-file cmd.txt\n\n`
      + '然后让 AI 重试同一条命令,即可放行一次。\n',
    )
    return 3
  }

  const revoke = arg('--revoke')
  if (revoke) {
    const { removed, remaining } = await revokeToken(revoke, { tokenPath })
    process.stdout.write(removed > 0
      ? `已撤销 ${removed} 个令牌(剩余 ${remaining})\n`
      : `没找到该令牌(当前共 ${remaining} 个)\n`)
    return removed > 0 ? 0 : 1
  }

  if (flag('--list')) {
    const tokens = await readTokens(tokenPath)
    process.stdout.write(`令牌文件: ${tokenPath}\n`)
    process.stdout.write(tokens.length === 0 ? '  (空)\n' : `${tokens.map(t => `  ${t}`).join('\n')}\n`)
    return 0
  }

  // 命令文本的两个来源:argv(要过 shell 的引号规则)或文件(完全不过 shell)。
  // --command-file 是为 Windows/cmd 准备的:那种 shell 没有一种能安全转义任意文本的写法,
  // 而"把原文写进文件"与 shell 无关,也不会被把命令写错。
  let command
  if (fromFile !== undefined) {
    try {
      command = (await readFile(fromFile, 'utf8')).replace(/\r?\n$/, '')
    } catch (error) {
      process.stderr.write(`读不到 --command-file 指定的文件:${fromFile}(${String(error?.message ?? error)})\n`)
      return 2
    }
  } else {
    command = process.argv.slice(3).filter(a => !a.startsWith('--')).join(' ')
  }
  if (command.trim() === '') {
    process.stderr.write('用法: guard allow \'<命令原文>\'  |  --command-file <文件>  |  --list  |  --revoke ALLOW-XXXXXXXXXX\n')
    return 2
  }
  const { token, already } = await grantToken(command, { tokenPath, note: arg('--note') })
  process.stdout.write(already
    ? `这条命令已有令牌:${token}(重试同一条命令即可放行一次)\n`
    : `已写入一次性令牌:${token}\n  文件:${tokenPath}\n  下一次执行**完全相同的命令**时生效,用掉即删除。\n`)
  return 0
}

const sub = process.argv[2]
// 除下面这些之外,任何子命令在降级状态下都先在 stderr 说一句 —— 免得你以为它还在完整工作。
//   · status:它的全部工作就是把状态说清楚,不需要再叠一句;
//   · judge:每条判定的**理由里已经带了同一句告警**(lib/verdict.js 的 warn),再说就是第三遍;
//   · selftest / rules:纯离线,不涉及额度。
if (!['status', 'judge', 'selftest', 'rules'].includes(sub)) {
  try {
    await warnIfDegraded(await loadConfig())
  } catch {
    // 告警失败绝不能影响本来要做的事
  }
}
const code = sub === 'selftest' ? selftest()
  : sub === 'rules' ? (rules(), 0)
  : sub === 'log' ? await cmdLog()
  : sub === 'status' ? await cmdStatus()
  : sub === 'allow' ? await cmdAllow()
  : sub === 'judge' ? await cmdJudge()
  : (process.stderr.write('用法: guard <judge|log|status|allow|selftest|rules> [选项]\n'), 2)
process.exit(code ?? 0)
