/**
 * Verdict composition — the four states, the reason text, and the host mapping.
 *
 * Four states rather than three, because "let the model try again" and "fetch a
 * human" are different control flows: the first closes in seconds, the second can
 * take hours. Collapsing them either drags the human into trivia or lets the model
 * keep rephrasing a destructive command until one phrasing slips through.
 *
 *   allow     — provably harmless, or the judge is confident it is.
 *   revise    — not confident enough to run, but the model can likely do better.
 *               Called with three deterministic downgrade templates.
 *   block     — the judge (or an L0 rule) says this destroys something
 *               unrecoverable; not worth retrying.
 *   escalate  — needs a human: L0 says "always confirm", or no safer form exists.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Absolute path of the CLI entry, derived from this module's own location.
 *
 * Why computed instead of passed in: the hint we print tells the **user** to paste a
 * line into their own terminal, whose cwd is arbitrary — a bare `node bin/guard.mjs`
 * only works if they happen to sit inside the package. Deriving it here keeps every
 * caller correct with no plumbing, and stays right if the package is moved to another
 * machine. 调用方仍可用 `opts.cliPath` 覆盖(见 `adapters/dsh/index.js`)。
 */
const DEFAULT_CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'guard.mjs')

/** The three deterministic downgrades offered on `revise` — no model needed. */
export const TEMPLATES = Object.freeze([
  { id: 'dry-run', text: '先跑只读/演练形态:' , examples: ['git diff <file> 代替 git checkout -- <file>', 'terraform plan 代替 terraform apply', 'npm publish --dry-run 代替 npm publish', 'rsync -n --delete 代替 rsync --delete'] },
  { id: 'narrow', text: '把作用域缩到你真正要动的那一部分:', examples: ['具体文件/子目录代替整个目录', '加 --exclude 排除掉不该动的', '限定 --resource / 单条 SQL 的 WHERE 条件'] },
  { id: 'backup-first', text: '先制造一个回退点再执行:', examples: ['git 仓库:先 commit 或 stash', '普通目录:先复制到磁盘上(不是 /tmp)', '数据库:先 dump 到磁盘'] },
])

/**
 * 把文本包成"可以在目标 shell 里整行复制粘贴"的形式。
 *
 * **必须按平台分叉。** POSIX 的 `'…'` 里用 `'\''` 转义单引号;PowerShell 的 `'…'` 里靠
 * **写两个单引号**转义。两者不通用 —— 在 PowerShell 里贴 POSIX 那种写法会直接解析失败
 * (而这段话是给用户照抄的,失败就等于授权入口不可用)。cmd.exe 则两种都不支持,
 * 所以另给了与 shell 无关的入口:`guard allow --command-file <文件>`。
 *
 * 默认用**本进程所在平台**:DSH 跑在 WSL 上时,用户能粘贴的终端通常也是 WSL/POSIX;
 * DSH 跑在 Windows 上时,那是 PowerShell。这与"宿主和终端在同一侧"的常见部署一致。
 *
 * @param value - 任意文本(命令原文里可能有引号、中文、换行)。
 * @param platform - `process.platform` 的取值;默认取当前进程。
 * @returns 可直接粘进目标 shell 的字符串。
 */
export function shellQuote(value, platform = process.platform) {
  const text = String(value)
  if (platform === 'win32') return `'${text.replace(/'/g, "''")}'`
  return `'${text.replace(/'/g, "'\\''")}'`
}

/**
 * 目标 shell 的名字,写进给人看的提示里(尤其是要让用户知道该开哪个终端)。
 * @param platform - `process.platform` 的取值。
 * @returns 名字。
 */
export function shellName(platform = process.platform) {
  return platform === 'win32' ? 'PowerShell' : 'POSIX shell(bash 等)'
}

/**
 * @typedef {{ action: 'allow'|'revise'|'block'|'escalate', source: string, p?: number,
 *   model?: string, ms?: number, rule?: {id: string, why: string}, reason?: string,
 *   templates?: typeof TEMPLATES, enriched?: string[], error?: string }} Verdict
 */

/**
 * One-line explanation for a verdict, safe to show to a human or a model.
 * @param command - the command under judgement.
 * @param verdict - the verdict to explain.
 * @param opts - `{ policy, token, cliPath, platform }`: `policy` decides what "escalate"
 *   means for this session (see below) and, with `never`, makes a non-allow reason state
 *   that this was an automatic decision so the model does not believe a human looked at it
 *   and said no. `cliPath` overrides the absolute CLI path used in the one-shot-token hint.
 *   `platform` overrides `process.platform` for the shell-quoting style of that hint.
 * @returns the reason text.
 */
export function explain(command, verdict, opts = {}) {
  const pct = verdict.p === undefined ? undefined : `${(verdict.p * 100).toFixed(1)}%`
  const detail = verdict.rule
    ? `命中硬规则 \`${verdict.rule.id}\`(${verdict.rule.why})`
    // 降级放行**不是**预筛判定出来的,不能复用那句文案 —— 否则读者会以为这条被确认过无害。
    : verdict.source === 'degraded' ? '降级放行(本条未经过语义判定)'
      : verdict.p === undefined ? '确定性预筛' : `Jev 判定风险概率 ${pct}`
  // 宿主真的会弹审批框吗?这个状态**由调用方显式告知**(`opts.routedToHuman`,见 toHostDecision):
  // 因为同一动作在不同的审批策略下会走到不同的出口(revise/block 在 ask 模式下转人工,在
  // never 模式下仍是拒绝)。缺省推导保持旧行为(仅 escalate + ask),供 CLI / selftest 这类
  // 不经过路由的调用使用。
  // 读者是**弹窗**里的人和后面可能看到拒绝的模型 —— 不能说"本会话没有审批提示"。
  // 实测(2026-09-20,ask 模式)弹窗里原样显示的就是那句旧文案,指着眼前的弹窗说没有弹窗,
  // 还让用户复制一条终端命令 —— 所以这里按路由结果分叉。
  const prompted = opts.routedToHuman ?? (opts.policy === 'ask' && verdict.action === 'escalate')
  const askWait = '这条命令需要人工确认,宿主已向用户发起审批请求 —— 请等用户在弹窗里决定,不要换写法重试。'
  const head = {
    allow: '放行',
    revise: prompted ? '需要人工确认' : '暂缓:证据不足以安全执行',
    block: prompted ? '需要人工确认' : '拦截',
    escalate: '需要人工确认',
  }[verdict.action] ?? verdict.action
  const tail = {
    allow: '',
    revise: prompted
      ? askWait
      : '请改用下面任一更安全的形式后重试;若都不适用,请向用户说明并请求人工介入。',
    // 带 L0 `deny` 规则的 block 永远不会转人工,所以这里再挡一层:万一调用方传错,
    // 也不能对着一条不可逆的硬规则说"等用户在弹窗里决定"。
    block: prompted && verdict.rule?.kind !== 'deny'
      ? askWait
      : '这条命令在本机被禁止自动执行。请改用安全替代方案,或由用户手动执行。',
    escalate: prompted
      ? askWait
      : '本会话没有审批提示,或该操作必须由人确认。请让用户手动执行。',
  }[verdict.action] ?? ''
  const auto = opts.policy === 'never' && verdict.action !== 'allow'
    ? '（这是自动判定,不是用户手动拒绝;请勿尝试绕开。）'
    : ''
  // 降级告警:额度/密钥出问题时,理由必须自己说明"这一条没经过语义判定"。
  // 否则读者会把"L0 拦下的一条"误当成"完整判定下的一条",也会把放行当成"判定过是安全的"。
  const warn = verdict.warning ? ` ${verdict.warning}` : ''
  // 一次性放行令牌:只在"非 allow、不是 L0 硬规则、且宿主不会真的弹审批框"时附上
  // (见 token.js 的设计说明)。
  // 为什么排除 prompted:那时人就在弹窗前面,再给一条"复制到终端授权"的路只会互相打架
  // —— 实测弹窗里两条路同时出现,读者不知道该走哪条。
  // 提示里的命令**不能截断** —— 令牌是对完整命令文本求哈希的,截断后用户授予的令牌就匹配不上。
  // 引号按**平台**分叉(POSIX 的 `'\''` 与 PowerShell 的 `''` 不通用);Windows 上额外点明
  // 该开哪个终端,因为 cmd.exe 两种写法都不认 —— 那种情况走 `allow --command-file`。
  const platform = opts.platform ?? process.platform
  const token = opts.token && verdict.action !== 'allow' && verdict.rule?.kind !== 'deny' && !prompted
    ? ' 【如需只放行这一次:把下面这行交给用户,请他在自己的终端里执行'
      + `(授权只在交互终端生效,AI 自己跑会被拒${platform === 'win32' ? ',用 PowerShell' : ''}):`
      + ` node ${opts.cliPath || DEFAULT_CLI_PATH} allow ${shellQuote(command, platform)}`
      + ` —— 然后重试同一条命令。令牌 ${opts.token}】`
    : ''
  return `Jev 安全阀门[${head}] ${detail}。${tail}${auto}${warn}${token} 命令:${command.length > 300 ? `${command.slice(0, 300)}…` : command}`
}

/**
 * Map a verdict onto the DSH-shaped typed decision.
 *
 * DSH's `ask` resolves through `ctx.approval`; under the `danger-full-access`
 * preset the approval policy is `never`, where every ask becomes a *rejection*
 * carrying the misleading reason "the user rejected tool bash". So when approvals
 * are off we deny directly, with an accurate reason the model can act on.
 *
 * **路由随审批策略分叉**(2026-09-20 用户决定):`never`(= 全自动,没人可问)下
 * `revise`/`block` 一律拒绝;`ask`(人就在场)下两者都转人工审批 —— 灰区本来就"证据不足",
 * 让一个 50% 的判断替人做决定没有道理。宿主无应答者时审批是 fail-closed,所以转人工
 * **不会**在无人值守时变成自动放行。
 *
 * **唯一例外**是带 L0 `deny` 规则的硬命中(`rm -rf /`、`mkfs`、`git push --force` 这类
 * 零误报的不可逆操作):两种模式都直接拒绝,既不转人工也不发一次性令牌(见 D5/D13)。
 *
 * @param command - the command under judgement.
 * @param verdict - the composed verdict.
 * @param approvalPolicy - `'ask' | 'never'` for this session.
 * @param opts - `{ token, cliPath, reviseInAskMode, blockInAskMode }`:一次性放行令牌会被写进
 *   理由里(见 token.js);`cliPath` 透传给 {@link explain};后两个是 `'ask' | 'deny'` 的路由开关。
 * @returns `{ kind: 'allow' } | { kind: 'ask', reason } | { kind: 'deny', reason }`.
 */
export function toHostDecision(command, verdict, approvalPolicy = 'ask', opts = {}) {
  const reviseInAskMode = opts.reviseInAskMode ?? 'ask'
  const blockInAskMode = opts.blockInAskMode ?? 'ask'
  const hardRule = verdict.rule?.kind === 'deny'
  const toHuman = approvalPolicy === 'ask' && hardRule !== true
    && (verdict.action === 'escalate'
      || (verdict.action === 'revise' && reviseInAskMode === 'ask')
      || (verdict.action === 'block' && blockInAskMode === 'ask'))
  const reason = explain(command, verdict, {
    policy: approvalPolicy,
    token: opts.token ?? verdict.token,
    cliPath: opts.cliPath,
    routedToHuman: toHuman,
  })
  if (verdict.action === 'allow') return { kind: 'allow' }
  // revise and block are model-facing denials when nobody can be asked; revise additionally teaches.
  return toHuman ? { kind: 'ask', reason } : { kind: 'deny', reason }
}

/**
 * The full text handed to a model on `revise`, including the templates.
 * @param command - the command under judgement.
 * @param verdict - a `revise` verdict.
 * @param opts - `{ policy }`, forwarded to {@link explain}.
 * @returns multi-line guidance.
 */
export function reviseGuidance(command, verdict, opts = {}) {
  const lines = [explain(command, verdict, opts), '', '可以尝试的更安全形式:']
  for (const t of TEMPLATES) {
    lines.push(`- ${t.text} 例:${t.examples.join(' / ')}`)
  }
  return lines.join('\n')
}

/**
 * A coarse fingerprint of a command: whitespace collapsed, `sudo` dropped, digits
 * masked. Good enough to notice "the model is trying the same thing again" across
 * cosmetic rewrites, without pretending to be a semantic comparison.
 * @param command - raw command text.
 * @returns the fingerprint string.
 */
export function fingerprint(command) {
  return String(command)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(sudo|env|command|nohup)\s+/, '')
    .replace(/\d+/g, '#')
    .slice(0, 400)
}

/**
 * Bounded per-key attempt counter.
 *
 * Why it exists: denying a destructive command is not the end of the story — with
 * no human in the loop the model simply rephrases and tries again (`rm -rf` ->
 * `find -delete` -> `python -c shutil.rmtree`). After a couple of attempts the
 * right move is to stop the loop and surface it to a human instead of playing
 * whack-a-mole forever.
 */
export class RetryBudget {
  /**
   * @param limit - attempts allowed before the caller should escalate.
   * @param maxKeys - bound on tracked keys, so a long session cannot grow forever.
   */
  constructor(limit = 2, maxKeys = 512) {
    this.limit = limit
    this.maxKeys = maxKeys
    this.map = new Map()
  }

  /**
   * Record one attempt and report whether the budget is spent.
   * @param key - session-scoped key (see {@link fingerprint}).
   * @returns `{ attempts, exhausted }`.
   */
  hit(key) {
    const attempts = (this.map.get(key) ?? 0) + 1
    this.map.delete(key)
    this.map.set(key, attempts)
    while (this.map.size > this.maxKeys) this.map.delete(this.map.keys().next().value)
    return { attempts, exhausted: attempts > this.limit }
  }

  /**
   * Forget a key (call it when the command was allowed, so a later repeat starts fresh).
   * @param key - session-scoped key.
   */
  clear(key) {
    this.map.delete(key)
  }

  /** @returns the number of tracked keys. */
  get size() {
    return this.map.size
  }
}
