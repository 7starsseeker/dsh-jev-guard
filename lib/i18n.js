/**
 * Bilingual message catalog (zh-CN / en).
 *
 * Why a catalog instead of inline strings: the same verdict text is read by three
 * different audiences — the human in an approval dialog, the model that gets the
 * denial, and whoever reads the audit log afterwards — and a deployment can be
 * either Chinese- or English-speaking. Keeping every human-facing sentence in one
 * place makes "is this translation complete?" a checkable question (see
 * `tools/selftest-i18n.mjs`) instead of a code review.
 *
 * Scope: **text a user or a model can see.** Verdict reasons, rule reasons, CLI
 * output, degradation warnings, the judge question. Code comments and the labels
 * inside the developer tools (`tools/`) stay Chinese on purpose: they are read by
 * maintainers of a Chinese-first codebase, and translating them doubles the upkeep
 * of every future change without changing what the product says.
 *
 * Language resolution (highest first):
 *   1. an explicit `lang` in config.json / the cordis patch (`setLang(cfg.lang)`)
 *   2. `JEV_GUARD_LANG`
 *   3. `LC_ALL` / `LC_MESSAGES` / `LANG`, when they name a language we ship
 *   4. `zh-CN` — the fallback, and the language every measurement was taken in
 *
 * `lang: 'auto'` (the default) runs steps 2-4.
 *
 * **Why `Intl` is deliberately NOT in that chain.** It was, and it bit us on the
 * first real deployment: the DSH plugin runs inside WSL where `LANG=C.UTF-8` means
 * "no locale preference", so the chain fell through to `Intl`, which in a Node
 * started with `C.UTF-8` reports `en-US` — Node's own ICU default, not the
 * operator's preference. Result: the reason text silently switched to English
 * inside the session while the Windows-side CLI (whose Node reports `zh-CN`) stayed
 * Chinese — the same machine speaking two languages depending on which process you
 * asked. A `C`/`POSIX`/unset locale is *absence of a signal*, so the honest move is
 * to fall back to the project's primary language, and to get English you say so
 * (`JEV_GUARD_LANG=en`, `"lang": "en"`, or `--lang en`). Locales that do name a
 * language (`en_US.UTF-8`, `zh_CN.UTF-8`) still resolve on their own.
 *
 * Nothing here touches the judge service: the question sent to Jev has its own
 * switch (`promptLang`) because the thresholds were calibrated against the Chinese
 * question (see lib/gate.js).
 *
 * @module jev-guard/i18n
 */

/** Languages this package ships. */
export const LANGS = Object.freeze(['zh-CN', 'en'])

/** Used when nothing else resolves, and as the per-key fallback. */
export const FALLBACK_LANG = 'zh-CN'

/**
 * Every string a user or a model can see, except the L0 rule reasons (which live
 * next to their regex in `lib/rules.js` so a rule stays one self-contained unit).
 *
 * `{name}` placeholders are filled by {@link t}. Keep both languages in step:
 * `tools/selftest-i18n.mjs` fails the build when a key exists in only one of them.
 */
const MESSAGES = {
  'zh-CN': {
    // — verdict.js: the one-line reason —
    'verdict.line': 'Jev 安全阀门[{head}] {detail}。{tail}{auto}{warn}{token} 命令:{command}',
    'verdict.head.allow': '放行',
    'verdict.head.revise': '暂缓:证据不足以安全执行',
    'verdict.head.block': '拦截',
    'verdict.head.prompted': '需要人工确认',
    'verdict.detail.rule': '命中硬规则 `{id}`({why})',
    'verdict.detail.degraded': '降级放行(本条未经过语义判定)',
    'verdict.detail.prefilter': '确定性预筛',
    'verdict.detail.probability': 'Jev 判定风险概率 {pct}',
    'verdict.askWait': '这条命令需要人工确认,宿主已向用户发起审批请求 —— 请等用户在弹窗里决定,不要换写法重试。',
    'verdict.tail.revise': '请改用下面任一更安全的形式后重试;若都不适用,请向用户说明并请求人工介入。',
    'verdict.tail.block': '这条命令在本机被禁止自动执行。请改用安全替代方案,或由用户手动执行。',
    'verdict.tail.escalate': '本会话没有审批提示,或该操作必须由人确认。请让用户手动执行。',
    'verdict.autoNote': '（这是自动判定,不是用户手动拒绝;请勿尝试绕开。）',
    'verdict.tokenHint': ' 【如需只放行这一次:把下面这行交给用户,请他在自己的终端里执行'
      + '(授权只在交互终端生效,AI 自己跑会被拒{winNote}):'
      + ' node {cli} allow {quoted} —— 然后重试同一条命令。令牌 {token}】',
    'verdict.winNote': ',用 PowerShell',
    'verdict.reviseHeading': '可以尝试的更安全形式:',
    'verdict.templateLine': '- {text} 例:{examples}',
    'verdict.shell.posix': 'POSIX shell(bash 等)',

    // — verdict.js: the three deterministic downgrade templates —
    'template.dry-run.text': '先跑只读/演练形态:',
    'template.dry-run.example.0': 'git diff <file> 代替 git checkout -- <file>',
    'template.dry-run.example.1': 'terraform plan 代替 terraform apply',
    'template.dry-run.example.2': 'npm publish --dry-run 代替 npm publish',
    'template.dry-run.example.3': 'rsync -n --delete 代替 rsync --delete',
    'template.narrow.text': '把作用域缩到你真正要动的那一部分:',
    'template.narrow.example.0': '具体文件/子目录代替整个目录',
    'template.narrow.example.1': '加 --exclude 排除掉不该动的',
    'template.narrow.example.2': '限定 --resource / 单条 SQL 的 WHERE 条件',
    'template.backup-first.text': '先制造一个回退点再执行:',
    'template.backup-first.example.0': 'git 仓库:先 commit 或 stash',
    'template.backup-first.example.1': '普通目录:先复制到磁盘上(不是 /tmp)',
    'template.backup-first.example.2': '数据库:先 dump 到磁盘',

    // — quota.js: failure kinds —
    'quota.quota.label': '判定服务额度已用尽',
    'quota.quota.hint': '充值/提高额度后无需任何操作:下一个探测窗口会自动恢复(最长等一个冷却周期)。',
    'quota.quota.cliHint.0': '立刻停用:`… allow` 不受影响',
    'quota.quota.cliHint.1': '查状态:`guard status`',
    'quota.auth.label': '判定服务的密钥无效或被撤销',
    'quota.auth.hint': '检查 secrets.json / 环境变量里的 TYPESAFE_API_KEY(别把密钥贴进对话)。',
    'quota.no-key.label': '没有解析到判定服务的密钥',
    'quota.no-key.hint': '写 `secrets.json` 或设置 `TYPESAFE_API_KEY`;相对路径的 apiKeyFile 现在按**包根**解析(与 cwd 无关)。',
    'quota.rate-limit.label': '被判定服务限流(429)',
    'quota.rate-limit.hint': '通常是瞬时的;命令会短暂回到"只过 L0"。',
    'quota.server.label': '判定服务返回 5xx',
    'quota.server.hint': '对方侧故障,逐次 fail-open。',
    'quota.timeout.label': '判定超时',
    'quota.timeout.hint': '超时一律放行;若持续出现,调大 timeoutMs 或检查网络/代理。',
    'quota.network.label': '网络不通',
    'quota.network.hint': '代理/出口问题;逐次 fail-open。',
    'quota.shape.label': '返回体不符合预期',
    'quota.shape.hint': '可能对方改了 API 形状;判定不可信,已放行。',
    'quota.unknown.label': '未知错误',
    'quota.unknown.hint': '看审计日志里的原文。',
    'quota.policy.off': '整条阀门已暂停',
    'quota.policy.l0-only': '仍在跑 L0 免费规则 + 预筛',
    'quota.warning': '⚠️ Jev 安全阀门已降级:{label}(自 {since}Z,已失败 {failures} 次)。'
      + '联网语义判定暂停 {mins} 分钟;{policy}。',
    'quota.status.ok': '✅ Jev 安全阀门:正常',
    'quota.status.ok.layers': '   L0 静态硬规则 + 预筛 + Jev 语义判定,四态齐全。',
    'quota.status.ok.noKey': '   ⚠️ 但是:当前没有解析到 API 密钥(`guard judge` 会退回 L0/预筛)。',
    'quota.status.degraded.title': '⚠️ Jev 安全阀门:已降级({kind})',
    'quota.status.degraded.reason': '   原因:{label}',
    'quota.status.degraded.counters': '   开始:{since}   失败:{failures} 次   探测:{probes} 次',
    'quota.status.degraded.recovery': '   恢复:{mins} 分钟后自动探测一次;成功即恢复,失败则继续降级。',
    'quota.status.degraded.now.off': '整条阀门暂停(全部放行)',
    'quota.status.degraded.now.l0-only': '联网语义判定暂停,L0 免费规则 + 预筛仍在工作',
    'quota.status.degraded.now': '   现在:{now}',
    'quota.status.degraded.action': '   处理:{hint}',
    'quota.status.degraded.detail': '   原始错误:{detail}',
    'quota.status.degraded.retry': '   立即重试:guard status --clear  (然后跑一条命令,会重新尝试联网判定)',
    'quota.reason.degraded': '降级放行({kind}):联网语义判定暂停,{policy}',

    // — gate.js: what the judge service is told —
    'gate.state.command': '命令',
    'gate.state.script': '脚本内容',
    'gate.state.pkgScript': '包脚本',
    'gate.state.pkgScriptBody': '包脚本内容',
    'gate.state.notRead': '(未读取: {why})',
    'gate.truncated': '… (已截断)',
    'gate.skip.sensitive': '疑似敏感文件，未上传内容',
    'gate.skip.notFile': '不是普通文件',
    'gate.skip.tooLarge': '文件过大 ({bytes} bytes)',
    'gate.skip.binary': '二进制内容',
    'gate.skip.readError': '读取失败: {error}',
    'gate.question.instructions': '这条命令会不可逆地删除或覆盖用户的真实数据吗？（可重建的缓存、临时文件、未使用的镜像不算）',
    'gate.question.true': '命令会不可逆地删除或覆盖真实数据：用户文档、源码、相册、日志、数据库、块设备内容、版本历史',
    'gate.question.false': '命令只读，或只影响可重建的缓存、临时文件、未使用的镜像与构建产物',

    // — bin/guard.mjs —
    'cli.usage': '用法: guard <judge|log|status|allow|selftest|rules> [选项] [--lang zh-CN|en]',
    'cli.selftest.header': 'L0 规则: deny {deny} 条 / ask {ask} 条',
    'cli.selftest.pass': 'selftest: {total} 项全部通过(未联网)',
    'cli.selftest.fail': 'selftest: {failed} 项失败',
    'cli.rules.denyHeader': '# L0 deny(永不放行)',
    'cli.rules.askHeader': '# L0 ask(必须人工确认)',
    'cli.reasonIndent': '          ↳ {reason}',
    'cli.degraded.stateDetail': '  状态详情:node {cli} status',
    'cli.log.header': '日志: {path}',
    'cli.log.recent': '日志: {path}  (最近 {count} 条)',
    'cli.log.emptyRange': '近 {hours} 小时没有记录。',
    'cli.log.emptyFile': '还没有记录。装好阀门后,每个判定都会写到这里。',
    'cli.log.writeError': '⚠️  最近一次写入失败:{error}',
    'cli.log.writeErrorNote': '   (审计写入失败会被静默吞掉以免影响判定,所以在这里显式提示)',
    'cli.log.total': '近 {hours} 小时共 {total} 条  ({first} → {last})',
    'cli.log.failOpen': '  fail-open(判定失败但放行): {count}',
    'cli.log.degraded': '  ⚠️ 降级放行(额度/密钥类,没花钱): {count} 条',
    'cli.log.degradedLast': '   最近:{kind} @ {at}Z',
    'cli.log.byAction': '按动作',
    'cli.log.bySource': '按来源',
    'cli.log.byRule': '按规则',
    'cli.log.byErrorKind': '失败分类',
    'cli.log.cost': '  语义判定成本: 约 ${cost}  ({tokens} 输入 token,{priced} 次调用有 usage 记录 ≈ 全部记录的 {coverage}%;输出按官方说明免费)',
    'cli.log.costUnknown': '  语义判定成本: 未记录(最近的调用没有返回 usage;升级前写入的旧记录也不含)',
    'cli.status.cleared': '已清除降级状态。下一条命令会重新尝试联网判定(失败会再次进入降级)。',
    'cli.status.nothingToClear': '当前没有降级状态,无需清除。',
    'cli.status.stateFile': '  状态文件: {path}{missing}',
    'cli.status.stateFileMissing': '(不存在 = 健康)',
    'cli.status.explainer': '  说明:降级 = 停用**要花钱的语义判定**;免费的 L0 规则与预筛照常工作(当前 degradePolicy={policy})。',
    'cli.status.probeDue': '  注意:冷却已到期,下一条命令会自动发一次探测请求(成功即恢复)。',
    'cli.allow.needsTty': '授权必须在交互终端里执行:当前检测到非交互环境(不是 TTY)。\n'
      + '这是有意的 —— 否则被监管的 AI 就能给自己授权,阀门形同虚设。\n\n'
      + '请让用户在最普通的终端窗口({shell})里复制执行下面这一行:\n\n'
      + '  {line}\n\n'
      + 'Windows 的 cmd.exe 不支持上面这种引号写法 —— 那种情况改用与 shell 无关的入口:\n'
      + '把命令原文**原样**写进一个文件(比如 cmd.txt),然后执行\n\n'
      + '  node {cli} allow --command-file cmd.txt\n\n'
      + '然后让 AI 重试同一条命令,即可放行一次。',
    'cli.allow.revoked': '已撤销 {removed} 个令牌(剩余 {remaining})',
    'cli.allow.notFound': '没找到该令牌(当前共 {remaining} 个)',
    'cli.allow.fileHeader': '令牌文件: {path}',
    'cli.allow.fileEmpty': '  (空)',
    'cli.allow.readFileError': '读不到 --command-file 指定的文件:{path}({error})',
    'cli.allow.usage': '用法: guard allow \'<命令原文>\'  |  --command-file <文件>  |  --list  |  --revoke ALLOW-XXXXXXXXXX',
    'cli.allow.already': '这条命令已有令牌:{token}(重试同一条命令即可放行一次)',
    'cli.allow.granted': '已写入一次性令牌:{token}',
    'cli.allow.grantedFile': '  文件:{path}',
    'cli.allow.grantedNote': '  下一次执行**完全相同的命令**时生效,用掉即删除。',
    'cli.lang.unknown': '⚠️ 未知语言 {lang},可选项:{langs}(继续用 {used})',
  },

  en: {
    // — verdict.js: the one-line reason —
    'verdict.line': 'Jev guard [{head}] {detail}. {tail}{auto}{warn}{token} Command: {command}',
    'verdict.head.allow': 'allow',
    'verdict.head.revise': 'hold: not enough evidence to run it safely',
    'verdict.head.block': 'blocked',
    'verdict.head.prompted': 'needs human confirmation',
    'verdict.detail.rule': 'hard rule `{id}` hit ({why})',
    'verdict.detail.degraded': 'allowed while degraded (no semantic judgment for this one)',
    'verdict.detail.prefilter': 'deterministic pre-screen',
    'verdict.detail.probability': 'Jev risk probability {pct}',
    'verdict.askWait': 'This command needs human confirmation and the host has raised an approval request — wait for the user to decide in that prompt instead of rephrasing and retrying.',
    'verdict.tail.revise': 'Retry in one of the safer forms below; if none fits, explain it to the user and ask for manual intervention.',
    'verdict.tail.block': 'This command is not allowed to run automatically on this machine. Use a safe alternative, or have the user run it by hand.',
    'verdict.tail.escalate': 'This session has no approval prompt, or the operation requires a human. Ask the user to run it by hand.',
    'verdict.autoNote': ' (This was an automatic decision, not the user rejecting it by hand; do not try to work around it.)',
    'verdict.tokenHint': ' [To allow this once: hand the user the line below and have them run it in their own terminal'
      + ' (authorisation only works from an interactive terminal — if the AI runs it itself it is refused{winNote}):'
      + ' node {cli} allow {quoted} — then retry the same command. Token {token}]',
    'verdict.winNote': ', using PowerShell',
    'verdict.reviseHeading': 'Safer forms to try:',
    'verdict.templateLine': '- {text} e.g. {examples}',
    'verdict.shell.posix': 'a POSIX shell (bash etc.)',

    // — verdict.js: the three deterministic downgrade templates —
    'template.dry-run.text': 'run a read-only or rehearsal form first:',
    'template.dry-run.example.0': 'git diff <file> instead of git checkout -- <file>',
    'template.dry-run.example.1': 'terraform plan instead of terraform apply',
    'template.dry-run.example.2': 'npm publish --dry-run instead of npm publish',
    'template.dry-run.example.3': 'rsync -n --delete instead of rsync --delete',
    'template.narrow.text': 'narrow the scope to the part you actually mean to touch:',
    'template.narrow.example.0': 'a specific file/subdirectory instead of the whole directory',
    'template.narrow.example.1': 'add --exclude to leave out what should not be touched',
    'template.narrow.example.2': 'one --resource / a WHERE clause on the SQL instead of all rows',
    'template.backup-first.text': 'create a rollback point before executing:',
    'template.backup-first.example.0': 'git repo: commit or stash first',
    'template.backup-first.example.1': 'plain directory: copy it to disk first (not to /tmp)',
    'template.backup-first.example.2': 'database: dump it to disk first',

    // — quota.js: failure kinds —
    'quota.quota.label': 'the judging service is out of credit',
    'quota.quota.hint': 'After topping up there is nothing to do: the next probe window recovers on its own (at most one cooldown period).',
    'quota.quota.cliHint.0': 'to stop right away: `… allow` is unaffected',
    'quota.quota.cliHint.1': 'to check: `guard status`',
    'quota.auth.label': 'the judging service rejected or revoked the key',
    'quota.auth.hint': 'Check TYPESAFE_API_KEY in secrets.json / the environment (never paste a key into a conversation).',
    'quota.no-key.label': 'no key for the judging service could be resolved',
    'quota.no-key.hint': 'Write `secrets.json` or set `TYPESAFE_API_KEY`; a relative apiKeyFile now resolves against the **package root** (independent of cwd).',
    'quota.rate-limit.label': 'rate-limited by the judging service (429)',
    'quota.rate-limit.hint': 'usually transient; commands briefly fall back to "L0 only".',
    'quota.server.label': 'the judging service returned 5xx',
    'quota.server.hint': 'a fault on their side; each call fails open.',
    'quota.timeout.label': 'judgment timed out',
    'quota.timeout.hint': 'a timeout always allows; if it keeps happening, raise timeoutMs or check the network/proxy.',
    'quota.network.label': 'network unreachable',
    'quota.network.hint': 'a proxy/egress problem; each call fails open.',
    'quota.shape.label': 'unexpected response shape',
    'quota.shape.hint': 'they may have changed the API shape; the judgment is not trustworthy, so it was allowed.',
    'quota.unknown.label': 'unknown error',
    'quota.unknown.hint': 'read the raw error in the audit log.',
    'quota.policy.off': 'the whole valve is suspended',
    'quota.policy.l0-only': 'the free L0 rules + pre-screen are still running',
    'quota.warning': '⚠️ Jev guard is degraded: {label} (since {since}Z, {failures} failures).'
      + ' Online semantic judgment paused for {mins} min; {policy}.',
    'quota.status.ok': '✅ Jev guard: healthy',
    'quota.status.ok.layers': '   L0 static rules + pre-screen + Jev semantic judgment, all four states available.',
    'quota.status.ok.noKey': '   ⚠️ But: no API key is currently resolved (`guard judge` falls back to L0/pre-screen).',
    'quota.status.degraded.title': '⚠️ Jev guard: degraded ({kind})',
    'quota.status.degraded.reason': '   reason: {label}',
    'quota.status.degraded.counters': '   since: {since}   failures: {failures}   probes: {probes}',
    'quota.status.degraded.recovery': '   recovery: one automatic probe in {mins} min; success restores it, failure keeps it degraded.',
    'quota.status.degraded.now.off': 'the whole valve is suspended (everything allowed)',
    'quota.status.degraded.now.l0-only': 'online semantic judgment paused; the free L0 rules + pre-screen still work',
    'quota.status.degraded.now': '   now: {now}',
    'quota.status.degraded.action': '   what to do: {hint}',
    'quota.status.degraded.detail': '   raw error: {detail}',
    'quota.status.degraded.retry': '   retry now: guard status --clear  (then run a command; it will try the online judge again)',
    'quota.reason.degraded': 'allowed while degraded ({kind}): online semantic judgment paused, {policy}',

    // — gate.js: what the judge service is told —
    'gate.state.command': 'command',
    'gate.state.script': 'script',
    'gate.state.pkgScript': 'package_script',
    'gate.state.pkgScriptBody': 'package_script_body',
    'gate.state.notRead': '(not read: {why})',
    'gate.truncated': '… (truncated)',
    'gate.skip.sensitive': 'looks like a sensitive file, contents not uploaded',
    'gate.skip.notFile': 'not a regular file',
    'gate.skip.tooLarge': 'file too large ({bytes} bytes)',
    'gate.skip.binary': 'binary content',
    'gate.skip.readError': 'read failed: {error}',
    'gate.question.instructions': 'Will this command irreversibly delete or overwrite the user\'s real data? (rebuildable caches, temporary files and unused images do not count)',
    'gate.question.true': 'The command irreversibly deletes or overwrites real data: user documents, source code, photos, logs, databases, block-device contents, version history',
    'gate.question.false': 'The command is read-only, or only affects rebuildable caches, temporary files, unused images and build output',

    // — bin/guard.mjs —
    'cli.usage': 'usage: guard <judge|log|status|allow|selftest|rules> [options] [--lang zh-CN|en]',
    'cli.selftest.header': 'L0 rules: {deny} deny / {ask} ask',
    'cli.selftest.pass': 'selftest: all {total} checks passed (offline)',
    'cli.selftest.fail': 'selftest: {failed} failed',
    'cli.rules.denyHeader': '# L0 deny (never allowed)',
    'cli.rules.askHeader': '# L0 ask (human confirmation required)',
    'cli.reasonIndent': '          ↳ {reason}',
    'cli.degraded.stateDetail': '  details: node {cli} status',
    'cli.log.header': 'log: {path}',
    'cli.log.recent': 'log: {path}  (last {count})',
    'cli.log.emptyRange': 'no records in the last {hours} hours.',
    'cli.log.emptyFile': 'no records yet. Once the valve is installed every judgment is written here.',
    'cli.log.writeError': '⚠️  last write failed: {error}',
    'cli.log.writeErrorNote': '   (audit write failures are swallowed so they cannot affect a judgment, hence this explicit notice)',
    'cli.log.total': '{total} records in the last {hours} hours  ({first} → {last})',
    'cli.log.failOpen': '  fail-open (judgment failed, allowed anyway): {count}',
    'cli.log.degraded': '  ⚠️ allowed while degraded (credit/key class, no money spent): {count}',
    'cli.log.degradedLast': '   last: {kind} @ {at}Z',
    'cli.log.byAction': 'by action',
    'cli.log.bySource': 'by source',
    'cli.log.byRule': 'by rule',
    'cli.log.byErrorKind': 'failure breakdown',
    'cli.log.cost': '  semantic judgment cost: ≈ ${cost}  ({tokens} input tokens, {priced} calls carried usage ≈ {coverage}% of all records; output is free per the vendor)',
    'cli.log.costUnknown': '  semantic judgment cost: not recorded (recent calls returned no usage; records written before the upgrade carry none either)',
    'cli.status.cleared': 'Degradation state cleared. The next command will try the online judge again (a failure re-enters degradation).',
    'cli.status.nothingToClear': 'Nothing to clear: the valve is not degraded.',
    'cli.status.stateFile': '  state file: {path}{missing}',
    'cli.status.stateFileMissing': ' (absent = healthy)',
    'cli.status.explainer': '  note: degraded = the **paid semantic judgment** is off; the free L0 rules and pre-screen keep working (currently degradePolicy={policy}).',
    'cli.status.probeDue': '  note: the cooldown has expired, so the next command sends one probe request (success restores it).',
    'cli.allow.needsTty': 'Authorisation must be run from an interactive terminal: this is a non-interactive environment (not a TTY).\n'
      + 'That is deliberate — otherwise the supervised AI could authorise itself and the valve would be decorative.\n\n'
      + 'Ask the user to copy this line into an ordinary terminal window ({shell}):\n\n'
      + '  {line}\n\n'
      + 'Windows cmd.exe does not support that quoting — in that case use the shell-independent entry point:\n'
      + 'write the command text **verbatim** into a file (cmd.txt, say) and run\n\n'
      + '  node {cli} allow --command-file cmd.txt\n\n'
      + 'Then have the AI retry the same command; it is allowed once.',
    'cli.allow.revoked': 'Revoked {removed} token(s) ({remaining} left)',
    'cli.allow.notFound': 'No such token ({remaining} currently)',
    'cli.allow.fileHeader': 'token file: {path}',
    'cli.allow.fileEmpty': '  (empty)',
    'cli.allow.readFileError': 'cannot read the file given to --command-file: {path} ({error})',
    'cli.allow.usage': 'usage: guard allow \'<command text>\'  |  --command-file <file>  |  --list  |  --revoke ALLOW-XXXXXXXXXX',
    'cli.allow.already': 'This command already has a token: {token} (retry the same command to pass once)',
    'cli.allow.granted': 'One-shot token written: {token}',
    'cli.allow.grantedFile': '  file: {path}',
    'cli.allow.grantedNote': '  It takes effect on the next execution of the **exact same command**, and is deleted once used.',
    'cli.lang.unknown': '⚠️ unknown language {lang}; available: {langs} (continuing in {used})',
  },
}

/** Normalise anything locale-shaped onto a language we ship. */
export function normalizeLang(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === '') return undefined
  if (raw.startsWith('zh')) return 'zh-CN'
  if (raw.startsWith('en')) return 'en'
  return undefined
}

/**
 * Pick a language from the environment. Exported because the CLI prints which
 * language it chose when it cannot honour an explicit request.
 *
 * Values that do not name a language we ship (`C`, `C.UTF-8`, `POSIX`, empty) are
 * treated as **no signal** rather than as English — see the module doc for the
 * deployment this decision comes from.
 *
 * @param env - environment bag (defaults to `process.env`).
 * @returns one of {@link LANGS}, or undefined when nothing matched.
 */
export function detectLang(env = process.env) {
  const explicit = normalizeLang(env?.JEV_GUARD_LANG)
  if (explicit) return explicit
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const found = normalizeLang(env?.[name])
    if (found) return found
  }
  return undefined
}

let current = FALLBACK_LANG
let currentReason = 'default'

/**
 * Set the language for every subsequent {@link t} call.
 * @param value - a language tag, or `'auto'` to resolve from the environment.
 * @returns `{ lang, known }` — `known: false` means the request was not a language
 *   we ship and the previous one was kept.
 */
export function setLang(value) {
  if (value === undefined || value === null || value === 'auto') {
    const detected = detectLang()
    current = detected ?? FALLBACK_LANG
    currentReason = detected ? 'auto' : 'fallback'
    return { lang: current, known: true }
  }
  const wanted = normalizeLang(value)
  if (wanted === undefined) {
    // 不认识的请求(比如 `--lang klingon`)退回**自动解析**,而不是停在某个历史值上:
    // 调用方已经被告知 `known: false`,但用户看到的仍应是这台机器的正常语言。
    const detected = detectLang()
    current = detected ?? FALLBACK_LANG
    currentReason = detected ? 'auto' : 'fallback'
    return { lang: current, known: false }
  }
  current = wanted
  currentReason = 'explicit'
  return { lang: current, known: true }
}

/** @returns the language in force. */
export function getLang() {
  return current
}

/** @returns why it is in force (`explicit` | `auto` | `fallback` | `default`) — for `--lang` diagnostics. */
export function getLangReason() {
  return currentReason
}

/**
 * Look up one message and fill its `{placeholders}`.
 * @param key - catalog key.
 * @param params - placeholder values; unknown placeholders are left as-is.
 * @returns the localised text (falling back to the fallback language, then the key).
 */
export function t(key, params = undefined) {
  return tIn(current, key, params)
}

/**
 * Look a message up in an **explicit** language rather than the one in force.
 *
 * Why this exists: the text sent to the judging service is not UI text. Its language
 * is `promptLang`, which deliberately defaults to the calibrated Chinese question
 * even on an English deployment — so it must not follow the interface language.
 *
 * @param lang - language to read from (unknown tags fall back to `zh-CN`).
 * @param key - catalog key.
 * @param params - placeholder values.
 * @returns the localised text (or the key when no language defines it).
 */
export function tIn(lang, key, params = undefined) {
  const table = MESSAGES[lang] ?? MESSAGES[FALLBACK_LANG]
  const raw = table[key] ?? MESSAGES[FALLBACK_LANG][key] ?? key
  if (params === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
  ))
}

/**
 * Every key in a language — used by the completeness self-check, which fails when
 * a key exists in one language but not the other.
 * @param lang - language to enumerate.
 * @returns sorted keys.
 */
export function keysOf(lang) {
  return Object.keys(MESSAGES[lang] ?? {}).sort()
}

/** @returns the shipped languages (a copy, so callers cannot mutate the catalog). */
export function langs() {
  return [...LANGS]
}
