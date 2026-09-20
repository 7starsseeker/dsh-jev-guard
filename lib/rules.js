/**
 * L0 — deterministic hard rules.
 *
 * This layer exists because the semantic judge (L1) depends on the network, on a
 * third-party model, and on the caller's honesty. Anything that must NEVER happen
 * has to be decided here: no network, no model, no override, same answer every
 * time. Rules are intentionally conservative and pattern-based; they are the
 * cheapest layer and the one that keeps working when everything else is down.
 *
 * Verdicts:
 *   'deny'  — never allow (the operation destroys something unrecoverable, or
 *             destroys the ability to recover).
 *   'ask'   — always confirm with a human, regardless of what L1 thinks.
 *
 * Edit this file to taste: every rule carries an `id`, a regex, a `why`, and
 * optionally `where: 'command'`.
 */

/**
 * @typedef {{ id: string, re: RegExp, why: Record<'zh-CN'|'en', string>, where?: 'command' | 'anywhere' }} Rule
 *
 * `why` 是**双语对象**而不是一句话:这条理由会出现在拒绝理由、`guard rules` 清单与
 * 审计复盘里,读者可能是中文会话的人,也可能是英文部署里的人或模型。两种语言都写在
 * 规则自己旁边(而不是集中到 i18n 目录),因为一条规则是一个自洽单元 ——
 * 改正则的人顺手就能改理由。缺语言的规则会被 `tools/selftest-i18n.mjs` 判失败。
 *
 * `where: 'command'`(**默认应当是这个**)表示规则只在 COMMAND POSITION 命中:行首、或紧跟
 * `;` `&` `|` `(` `$(` 与反引号之后、或紧跟 `bash -c "` 这类"把字符串当脚本执行"的引号之后;
 * 中间允许一串包装器(`sudo` / `timeout 30` / `xargs -0` / `find … -exec` …)。
 *
 * `where: 'anywhere'` 是**显式例外**:只有那两个模式结构上无法锚定(以运算符 `>` 或
 * 纯语法 `:(){…};:` 开头)的规则才该用它。写别的规则时不要用 —— 全文匹配会在"引号里的
 * 数据、注释、变量赋值、代码字符串"里命中,把操作者自己的正当操作拦下来(2026-09-20 实测)。
 *
 * Why anchoring exists: on 2026-09-20 this valve blocked its own operator twice — once
 * for passing a rule description as a CLI argument, once for writing a test case
 * inside a bash heredoc. Both times the dangerous phrase was *prose*, not a call.
 * Real invocations sit at a command position; commands hidden inside quotes are
 * still covered by Jev (measured p for prose: 0.02–0.08; for the real thing via
 * Jev: 0.8–1.0), so nothing meaningful is lost by anchoring.
 *
 * 2026-09-20 第二次修正(两个方向的偏,同一个根因 —— 锚定只做了一半):
 *   · 假阳:21 条 deny 里只有 7 条锚定,`mkfs` 这类命令开头型规则仍在全文匹配,
 *     于是 `python3 -c "print('mkfs.ext4 /dev/sdb1')"` 这种**数据**也会被 deny。
 *   · 漏判:锚定用的 `^` **没有 `m` 标志**,所以"命令位置"实际只等于整串开头 ——
 *     多行脚本(heredoc)与多行 `-c` 里的真命令全看不见,而 L0 的全部意义就是
 *     在降级(l0-only,没有 Jev 兜底)时抓住这一类。
 *   两者一起修:命令开头型规则统一锚定,锚定加 `m`,包装器列表扩到常见前缀。
 *   边界矩阵在 `tools/selftest-rules.mjs`(18 种形态)。
 */

import { FALLBACK_LANG, getLang } from './i18n.js'

/** `bash -c "…"`:把引号里的字符串当脚本执行 —— 那里面是一个命令位置。 */
const SHELL_C = String.raw`(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)(?:\.exe)?\s+-[a-z]*c\s*["']`

/**
 * 包装器:`sudo mkfs`、`timeout 30 mkfs`、`xargs -0 mkfs`、`nice -n 5 mkfs`、`find … -exec mkfs`。
 * 吞掉的"参数"只允许 ASCII 词/flag/路径字符 —— 刻意的:中文散文里出现 `xargs … mkfs`
 * 这种句子不该命中(散文交给 Jev,p 只有 0.02–0.08)。
 */
const WRAPPERS = String.raw`(?:sudo|doas|env|command|nohup|time|nice|ionice|setsid|stdbuf|watch|timeout|xargs|parallel|find)\b\s*(?:[-\w./=:$~]+\s+)*`

/** 命令位置前缀:行首(`m` 标志下即每行行首)、分隔符之后、`$(` 之后、`-c "` 之后,再加可选包装器。 */
const COMMAND_POSITION = String.raw`(?:^|[;&|(` + '`' + String.raw`]\s*|\$\(\s*|` + SHELL_C + String.raw`)(?:` + WRAPPERS + String.raw`)?`

/** 缓存:同一条规则只构造一次"命令位置"版本的正则。 */
const anchoredCache = new WeakMap()

/**
 * 取一条规则实际用于匹配的正则。
 * @param rule - 规则对象。
 * @returns 用于测试的正则。
 */
function ruleRegex(rule) {
  if (rule.where !== 'command') return rule.re
  let re = anchoredCache.get(rule)
  if (re === undefined) {
    // `m` 必须加:否则 `^` 只匹配整串开头,多行命令里第二行起的命令位置全部失效。
    const flags = rule.re.flags.includes('m') ? rule.re.flags : `${rule.re.flags}m`
    re = new RegExp(COMMAND_POSITION + rule.re.source, flags)
    anchoredCache.set(rule, re)
  }
  return re
}

/** Operations with no legitimate "oops I meant that" story. */
export const DENY_RULES = /** @type {Rule[]} */ ([
  { id: 'block-device-write', where: 'command', re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|vd|hd|mmcblk)/i, why: { 'zh-CN': '直接写块设备,会不可逆地覆盖磁盘内容', en: 'writes straight to a block device, irreversibly overwriting the disk' } },
  { id: 'mkfs', where: 'command', re: /\bmkfs(\.\w+)?\b[^\n]*\/dev\//i, why: { 'zh-CN': '格式化文件系统', en: 'formats a filesystem' } },
  // 仅有的两条 anywhere:模式以运算符 / 纯语法开头,锚定到"命令位置"没有意义。
  { id: 'redirect-to-device', where: 'anywhere', re: />\s*\/dev\/(sd|nvme|vd|hd)/i, why: { 'zh-CN': '把输出重定向进块设备(模式以 > 开头,无法锚定)', en: 'redirects output into a block device (the pattern starts with >, so it cannot be anchored)' } },
  { id: 'no-preserve-root', where: 'command', re: /rm\s+[^\n]*--no-preserve-root/i, why: { 'zh-CN': '带 --no-preserve-root 的递归删除', en: 'recursive delete with --no-preserve-root' } },
  { id: 'rm-root', where: 'command', re: /rm\s+-[a-z]*\s*\/(\s|$)/i, why: { 'zh-CN': '删除文件系统根目录', en: 'deletes the filesystem root' } },
  { id: 'fork-bomb', where: 'anywhere', re: /:\(\)\s*\{[^\n]*\}\s*;\s*:/, why: { 'zh-CN': 'fork 炸弹,会耗死机器(纯语法模式,无法锚定)', en: 'fork bomb, exhausts the machine (a pure-syntax pattern, cannot be anchored)' } },
  { id: 'drop-database', where: 'command', re: /\bDROP\s+(DATABASE|SCHEMA|TABLE)\b/i, why: { 'zh-CN': '删除数据库/表', en: 'drops a database/table' } },
  { id: 'truncate-database', where: 'command', re: /\bTRUNCATE\s+TABLE\b/i, why: { 'zh-CN': '清空表数据', en: 'empties a table' } },
  { id: 'git-force-push', where: 'command', re: /git\s+push[^\n]*(\s--force(?!-with-lease)\b|\s-f\b)/i, why: { 'zh-CN': '强制推送到远端,会抹掉远端历史(此项远端不可恢复)', en: 'force-pushes to the remote, erasing remote history (this one is unrecoverable on the remote)' } },
  { id: 'git-history-rewrite', where: 'command', re: /git\s+(filter-branch|filter-repo)\b/i, why: { 'zh-CN': '重写 git 历史', en: 'rewrites git history' } },
  { id: 'shred-keys', where: 'command', re: /\bshred\b[^\n]*(\.ssh|\/dev\/)/i, why: { 'zh-CN': '不可恢复地销毁私钥/设备', en: 'irreversibly destroys a private key / a device' } },
  { id: 'chmod-root', where: 'command', re: /chmod\s+-R\s+[0-7]{3,4}\s+\/(\s|$)/i, why: { 'zh-CN': '递归改根目录权限', en: 'recursively changes permissions on the root directory' } },
  { id: 'shadow-copy-delete', where: 'command', re: /\bvssadmin\b[^\n]*delete\s+shadows/i, why: { 'zh-CN': '删除卷影副本,会毁掉还原点', en: 'deletes shadow copies, destroying restore points' } },
  { id: 'backup-delete', where: 'command', re: /\bwbadmin\b[^\n]*delete\b/i, why: { 'zh-CN': '删除系统备份', en: 'deletes system backups' } },
  { id: 'cipher-wipe', where: 'command', re: /\bcipher\s+\/w/i, why: { 'zh-CN': '不可恢复地擦除磁盘空闲空间', en: 'irreversibly wipes the free space on a disk' } },
  // 原来的 `^\s*` 在加上外层锚定后会与"分隔符之后也算命令位置"打架(`cd /x && diskpart` 不命中),故去掉内层 ^。
  { id: 'diskpart', where: 'command', re: /\bdiskpart\b/i, why: { 'zh-CN': '磁盘分区操作,极易误伤整盘', en: 'disk partitioning; very easy to hit the whole disk by mistake' } },
  { id: 'wsl-unregister', where: 'command', re: /wsl(\.exe)?\s+--unregister/i, why: { 'zh-CN': '注销 WSL 发行版,会删除整个发行版文件系统', en: 'unregisters a WSL distribution, deleting its entire filesystem' } },
  { id: 'kubectl-delete-ns', where: 'command', re: /kubectl\s+delete\s+(ns|namespace|pv|pvc)\b/i, why: { 'zh-CN': '删除命名空间/持久卷,会连带删除其中的数据', en: 'deletes a namespace/persistent volume, taking the data inside with it' } },
  { id: 'ps-clear-disk', where: 'command', re: /\b(Clear-Disk|Format-Volume|Initialize-Disk)\b/i, why: { 'zh-CN': 'PowerShell 磁盘级破坏操作', en: 'a PowerShell disk-level destructive operation' } },
  { id: 'ps-remove-item-drive-root', where: 'command', re: /Remove-Item[^\n]*-Recurse[^\n]*\b[A-Za-z]:\\\s*($|[^*])/i, why: { 'zh-CN': '递归删除整个盘符根目录', en: 'recursively deletes a whole drive root' } },
  { id: 'rm-rf-home-root', where: 'command', re: /rm\s+-[a-z]*r[a-z]*f?\s+~\/?(\s|$)/i, why: { 'zh-CN': '删除整个家目录', en: 'deletes the entire home directory' } },
])

/** Operations that are legitimate but never silent: a human must see them once. */
export const ASK_RULES = /** @type {Rule[]} */ ([
  { id: 'terraform-destroy', where: 'command', re: /terraform\s+(destroy|apply\s+-auto-approve)\b/i, why: { 'zh-CN': 'terraform 会不可逆地改动真实基础设施', en: 'terraform changes real infrastructure irreversibly' } },
  { id: 'kubectl-delete', where: 'command', re: /kubectl\s+delete\b/i, why: { 'zh-CN': '删除 Kubernetes 资源', en: 'deletes Kubernetes resources' } },
  { id: 'docker-volume-rm', where: 'command', re: /docker\s+(volume\s+(rm|prune)|compose\s+down\s+-v)/i, why: { 'zh-CN': '删除数据卷,容器里的数据会一起没', en: 'deletes a data volume, taking the data inside the container with it' } },
  { id: 'docker-prune-all', where: 'command', re: /docker\s+system\s+prune\s+-a/i, why: { 'zh-CN': '清理全部未使用镜像/卷', en: 'prunes every unused image/volume' } },
  { id: 'rm-rf-git-dir', where: 'command', re: /rm\s+-[a-z]*r[a-z]*f?[^\n]*\.git\b/i, why: { 'zh-CN': '删除 .git,会丢掉全部版本历史', en: 'deletes .git, losing all version history' } },
  { id: 'git-clean-fdx', where: 'command', re: /git\s+clean\s+-[a-z]*[fdx]/i, why: { 'zh-CN': 'git clean 会删除未跟踪文件', en: 'git clean deletes untracked files' } },
  { id: 'git-reset-hard', where: 'command', re: /git\s+reset\s+--hard/i, why: { 'zh-CN': '丢弃未提交的改动', en: 'discards uncommitted changes' } },
  { id: 'git-checkout-discard', where: 'command', re: /git\s+(checkout|restore)\s+(--\s|\.\s*$)/i, why: { 'zh-CN': '覆盖工作区改动', en: 'overwrites working-tree changes' } },
  { id: 'find-delete', where: 'command', re: /\bfind\b[^\n]*-(delete|exec\s+rm)/i, why: { 'zh-CN': 'find 批量删除', en: 'bulk deletion through find' } },
  { id: 'rsync-delete', where: 'command', re: /\brsync\b[^\n]*--delete/i, why: { 'zh-CN': 'rsync --delete 会让目标端变成源的镜像', en: 'rsync --delete makes the destination a mirror of the source' } },
  { id: 'sql-delete-without-where', where: 'command', re: /\bDELETE\s+FROM\s+\w+\s*;?\s*$/i, why: { 'zh-CN': 'DELETE 没有 WHERE,会清空整表', en: 'DELETE without WHERE empties the whole table' } },
  { id: 'truncate-file', where: 'command', re: /truncate\s+-s\s*0\b|(?::|true|echo)\s+(?:""|'')\s*>\s*[^\s|&]+/i, why: { 'zh-CN': '把文件截断/覆盖为空(只认显式形态;普通重定向交给 Jev 判)', en: 'truncates/overwrites a file down to empty (explicit forms only; plain redirection goes to Jev)' } },
  { id: 'remote-code-exec', where: 'command', re: /(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)[^\n]*\|\s*(bash|sh|zsh|iex|Invoke-Expression)/i, why: { 'zh-CN': '把远端脚本直接喂给 shell 执行', en: 'pipes a remote script straight into a shell' } },
  { id: 'publish-irreversible', where: 'command', re: /\b(npm|cargo|twine|poetry)\s+publish\b/i, why: { 'zh-CN': '发布到公共仓库,基本不可撤回', en: 'publishes to a public registry; effectively irreversible' } },
  { id: 'chown-recursive-root', where: 'command', re: /chown\s+-R[^\n]*\s\/(\s|$)/i, why: { 'zh-CN': '递归改根目录属主', en: 'recursively changes ownership of the root directory' } },
  { id: 'systemd-mask-critical', where: 'command', re: /systemctl\s+(mask|disable)\s+(ssh|network|networking|systemd-networkd)/i, why: { 'zh-CN': '停用关键系统服务,可能把机器锁在外面', en: 'disables a critical system service; can lock you out of the machine' } },
])

/**
 * 一条规则在指定语言下的理由(`why` 是双语对象,见上面的 typedef)。
 *
 * 缺该语言时退回 `zh-CN`(目录语言的兜底),再缺就退回规则 id —— 理由绝不会是
 * `undefined`,因为它会被拼进给人和模型看的拒绝理由里。
 *
 * @param rule - 规则对象。
 * @param lang - 语言;默认取当前生效的语言。
 * @returns 该语言下的理由文本。
 */
export function ruleWhy(rule, lang = getLang()) {
  const table = rule?.why
  if (typeof table === 'string') return table // 兼容老形状(单语言字符串)
  return table?.[lang] ?? table?.[FALLBACK_LANG] ?? String(rule?.id ?? '')
}

/**
 * Evaluate L0 for one command.
 * @param command - raw command text.
 * @returns the matching rule verdict, or undefined when L0 has no opinion. `why` is
 *   already localised, so callers can paste it straight into a reason.
 */
export function staticRule(command) {
  const text = String(command ?? '')
  for (const rule of DENY_RULES) {
    if (ruleRegex(rule).test(text)) return { kind: 'deny', id: rule.id, why: ruleWhy(rule) }
  }
  for (const rule of ASK_RULES) {
    if (ruleRegex(rule).test(text)) return { kind: 'ask', id: rule.id, why: ruleWhy(rule) }
  }
  return undefined
}

/** Rule counts, for diagnostics. */
export const RULE_STATS = Object.freeze({
  deny: DENY_RULES.length,
  ask: ASK_RULES.length,
  anchored: [...DENY_RULES, ...ASK_RULES].filter(r => r.where === 'command').length,
  /** 全文匹配的例外(应当恒为 2:redirect-to-device 与 fork-bomb)。 */
  anywhere: [...DENY_RULES, ...ASK_RULES].filter(r => r.where !== 'command').length,
})
