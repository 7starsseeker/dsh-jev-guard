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
 * @typedef {{ id: string, re: RegExp, why: string, where?: 'command' }} Rule
 *
 * `where: 'command'` means the rule only matches its verb at a COMMAND POSITION
 * (start of line, or right after `;` `&` `|` `(` `$(` backtick, allowing
 * `sudo`/`env`/`command`/`nohup`/`time` wrappers).
 *
 * Why it exists: on 2026-09-20 this valve blocked its own operator twice — once
 * for passing a rule description as a CLI argument, once for writing a test case
 * inside a bash heredoc. Both times the dangerous phrase was *prose*, not a call.
 * Real invocations sit at a command position; commands hidden inside quotes are
 * still covered by Jev (measured p for prose: 0.02–0.08; for the real thing via
 * Jev: 0.8–1.0), so nothing meaningful is lost by anchoring.
 */

/** 命令位置前缀:行首、或紧跟 ; & | ( 与 $( 、反引号之后,允许 sudo/env 之类的包装。 */
const COMMAND_POSITION = String.raw`(?:^|[;&|(` + '`' + String.raw`]\s*|\$\(\s*)(?:sudo\s+|env\s+|command\s+|nohup\s+|time\s+)*`

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
    re = new RegExp(COMMAND_POSITION + rule.re.source, rule.re.flags)
    anchoredCache.set(rule, re)
  }
  return re
}

/** Operations with no legitimate "oops I meant that" story. */
export const DENY_RULES = /** @type {Rule[]} */ ([
  { id: 'block-device-write', re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|vd|hd|mmcblk)/i, why: '直接写块设备,会不可逆地覆盖磁盘内容' },
  { id: 'mkfs', re: /\bmkfs(\.\w+)?\b[^\n]*\/dev\//i, why: '格式化文件系统' },
  { id: 'redirect-to-device', re: />\s*\/dev\/(sd|nvme|vd|hd)/i, why: '把输出重定向进块设备' },
  { id: 'no-preserve-root', where: 'command', re: /rm\s+[^\n]*--no-preserve-root/i, why: '带 --no-preserve-root 的递归删除' },
  { id: 'rm-root', where: 'command', re: /rm\s+-[a-z]*\s*\/(\s|$)/i, why: '删除文件系统根目录' },
  { id: 'fork-bomb', re: /:\(\)\s*\{[^\n]*\}\s*;\s*:/, why: 'fork 炸弹,会耗死机器' },
  { id: 'drop-database', where: 'command', re: /\bDROP\s+(DATABASE|SCHEMA|TABLE)\b/i, why: '删除数据库/表' },
  { id: 'truncate-database', where: 'command', re: /\bTRUNCATE\s+TABLE\b/i, why: '清空表数据' },
  { id: 'git-force-push', where: 'command', re: /git\s+push[^\n]*(\s--force(?!-with-lease)\b|\s-f\b)/i, why: '强制推送到远端,会抹掉远端历史(此项远端不可恢复)' },
  { id: 'git-history-rewrite', where: 'command', re: /git\s+(filter-branch|filter-repo)\b/i, why: '重写 git 历史' },
  { id: 'shred-keys', re: /\bshred\b[^\n]*(\.ssh|\/dev\/)/i, why: '不可恢复地销毁私钥/设备' },
  { id: 'chmod-root', re: /chmod\s+-R\s+[0-7]{3,4}\s+\/(\s|$)/i, why: '递归改根目录权限' },
  { id: 'shadow-copy-delete', re: /\bvssadmin\b[^\n]*delete\s+shadows/i, why: '删除卷影副本,会毁掉还原点' },
  { id: 'backup-delete', re: /\bwbadmin\b[^\n]*delete\b/i, why: '删除系统备份' },
  { id: 'cipher-wipe', re: /\bcipher\s+\/w/i, why: '不可恢复地擦除磁盘空闲空间' },
  { id: 'diskpart', re: /^\s*diskpart\b/i, why: '磁盘分区操作,极易误伤整盘' },
  { id: 'wsl-unregister', re: /wsl(\.exe)?\s+--unregister/i, why: '注销 WSL 发行版,会删除整个发行版文件系统' },
  { id: 'kubectl-delete-ns', re: /kubectl\s+delete\s+(ns|namespace|pv|pvc)\b/i, why: '删除命名空间/持久卷,会连带删除其中的数据' },
  { id: 'ps-clear-disk', re: /\b(Clear-Disk|Format-Volume|Initialize-Disk)\b/i, why: 'PowerShell 磁盘级破坏操作' },
  { id: 'ps-remove-item-drive-root', re: /Remove-Item[^\n]*-Recurse[^\n]*\b[A-Za-z]:\\\s*($|[^*])/i, why: '递归删除整个盘符根目录' },
  { id: 'rm-rf-home-root', where: 'command', re: /rm\s+-[a-z]*r[a-z]*f?\s+~\/?(\s|$)/i, why: '删除整个家目录' },
])

/** Operations that are legitimate but never silent: a human must see them once. */
export const ASK_RULES = /** @type {Rule[]} */ ([
  { id: 'terraform-destroy', where: 'command', re: /terraform\s+(destroy|apply\s+-auto-approve)\b/i, why: 'terraform 会不可逆地改动真实基础设施' },
  { id: 'kubectl-delete', where: 'command', re: /kubectl\s+delete\b/i, why: '删除 Kubernetes 资源' },
  { id: 'docker-volume-rm', where: 'command', re: /docker\s+(volume\s+(rm|prune)|compose\s+down\s+-v)/i, why: '删除数据卷,容器里的数据会一起没' },
  { id: 'docker-prune-all', where: 'command', re: /docker\s+system\s+prune\s+-a/i, why: '清理全部未使用镜像/卷' },
  { id: 'rm-rf-git-dir', where: 'command', re: /rm\s+-[a-z]*r[a-z]*f?[^\n]*\.git\b/i, why: '删除 .git,会丢掉全部版本历史' },
  { id: 'git-clean-fdx', where: 'command', re: /git\s+clean\s+-[a-z]*[fdx]/i, why: 'git clean 会删除未跟踪文件' },
  { id: 'git-reset-hard', where: 'command', re: /git\s+reset\s+--hard/i, why: '丢弃未提交的改动' },
  { id: 'git-checkout-discard', where: 'command', re: /git\s+(checkout|restore)\s+(--\s|\.\s*$)/i, why: '覆盖工作区改动' },
  { id: 'find-delete', where: 'command', re: /\bfind\b[^\n]*-(delete|exec\s+rm)/i, why: 'find 批量删除' },
  { id: 'rsync-delete', where: 'command', re: /\brsync\b[^\n]*--delete/i, why: 'rsync --delete 会让目标端变成源的镜像' },
  { id: 'sql-delete-without-where', where: 'command', re: /\bDELETE\s+FROM\s+\w+\s*;?\s*$/i, why: 'DELETE 没有 WHERE,会清空整表' },
  { id: 'truncate-file', where: 'command', re: /truncate\s+-s\s*0\b|(?::|true|echo)\s+(?:""|'')\s*>\s*[^\s|&]+/i, why: '把文件截断/覆盖为空(只认显式形态;普通重定向交给 Jev 判)' },
  { id: 'remote-code-exec', where: 'command', re: /(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)[^\n]*\|\s*(bash|sh|zsh|iex|Invoke-Expression)/i, why: '把远端脚本直接喂给 shell 执行' },
  { id: 'publish-irreversible', where: 'command', re: /\b(npm|cargo|twine|poetry)\s+publish\b/i, why: '发布到公共仓库,基本不可撤回' },
  { id: 'chown-recursive-root', where: 'command', re: /chown\s+-R[^\n]*\s\/(\s|$)/i, why: '递归改根目录属主' },
  { id: 'systemd-mask-critical', where: 'command', re: /systemctl\s+(mask|disable)\s+(ssh|network|networking|systemd-networkd)/i, why: '停用关键系统服务,可能把机器锁在外面' },
])

/**
 * Evaluate L0 for one command.
 * @param command - raw command text.
 * @returns the matching rule verdict, or undefined when L0 has no opinion.
 */
export function staticRule(command) {
  const text = String(command ?? '')
  for (const rule of DENY_RULES) {
    if (ruleRegex(rule).test(text)) return { kind: 'deny', id: rule.id, why: rule.why }
  }
  for (const rule of ASK_RULES) {
    if (ruleRegex(rule).test(text)) return { kind: 'ask', id: rule.id, why: rule.why }
  }
  return undefined
}

/** Rule counts, for diagnostics. */
export const RULE_STATS = Object.freeze({
  deny: DENY_RULES.length,
  ask: ASK_RULES.length,
  anchored: [...DENY_RULES, ...ASK_RULES].filter(r => r.where === 'command').length,
})
