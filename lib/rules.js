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
 * 2026-11-07 第三次修正(假阳来自"字面量正文"而不是命令位置):
 *   写文档时把 `dd … of=/dev/sda`、`mkfs.ext4 -F /dev/sdb1` 这类**字面量**放进 PowerShell here-string
 *   (`@'…'@`)或 heredoc 正文,整条 `Add-Content` 被 `block-device-write` 判 deny —— 而正文是数据,
 *   根本不会执行。锚定挡不住它:Markdown 的 `` `…` `` 在 bash 里正是命令替换符,`COMMAND_POSITION`
 *   把反引号当成了命令位置,于是表格里的 `` `mkfs.ext4 …` `` 看起来就像一条命令。
 *   修法不是改锚定(反引号确实是 bash 的命令位置),而是在匹配前把**确定不会执行**的正文挖空:
 *     · PowerShell here-string:`@'…'@` 完全字面;`@"…"@` 只保留 `$( … )` 子表达式;
 *     · 带**引号分隔符**的 heredoc(`<<'EOF'`):禁用展开,正文全字面 —— 但只在消费方是
 *       数据类命令(`cat` / `tee` / `git` / `Add-Content` …)时才挖。喂给解释器(`bash`、`psql`、
 *       `python` …)的正文是代码,照常扫描。
 *   方向是刻意的:**名单外一律照常扫描**。误判成数据 = 漏一条真命令;误判成代码 = 多拦一次文档。
 *   前者不可接受,后者只是烦。
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

/**
 * `bash -c "…"` / `pwsh -NoProfile -Command "…"` / `cmd /c "…"`:把引号里的字符串当脚本执行 ——
 * 那里面是一个命令位置。
 *
 * 2026-10-17:本 profile 的执行器翻成 pwsh 后补上两种常见写法 ——
 *   · PowerShell 的 `-Command`(不是 `-c`,原模式咬不到);
 *   · 参数在 `-Command` 之前的形态(`pwsh -NoProfile -Command …`);
 *   · cmd 的 `/c`。
 */
const SHELL_C = String.raw`(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)(?:\.exe)?(?:\s+(?:-{1,2}[\w-]+|/[\w-]+))*?\s+(?:-[a-z]*c|-command|/[a-z]*c)\s*["']`

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

// ── 字面量正文挖空(2026-11-07)───────────────────────────────────────────────────
// 见文件头的第三次修正。只挖"执行不到的正文",名单外一律照常扫描。

/** PowerShell here-string:`@'` … `'@`(全字面)/ `@"` … `"@`(只展开 `$( … )`)。 */
const PS_HERE_STRING = /(@(['"]))[ \t]*\r?\n([\s\S]*?)\r?\n\2@/g

/** 带引号分隔符的 heredoc:`<<'EOF'` / `<<"EOF"`(展开被禁用)。 */
const QUOTED_HEREDOC = /<<(-?)[ \t]*(['"])([A-Za-z_][\w.-]*)\2/g

/** 这一行里出现解释器 ⇒ 同一行的 heredoc 正文会被当脚本执行,不能挖。 */
const SHELL_INTERPRETER = /\b(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|python[\d.]*|node|perl|ruby|php|psql|mysql|sqlite3|mongo|redis-cli)(?:\.exe)?\b/i

/**
 * 消费方是"把 stdin 写成文件"的命令 ⇒ heredoc 正文是数据。
 * **白名单**:不在这里的命令一律照常扫描(`awk` / `sed` / `jq` 之类也能执行,不冒险)。
 */
const DATA_CONSUMERS = /\b(?:cat|tee|git|Add-Content|Set-Content|Out-File)\b/i

/**
 * 把 [from, to) 区间里的非换行字符替换成空格。
 * 保留换行:锚定用 `m`,行号与行首位置必须和原文一致。
 * @param text - 原文。
 * @param ranges - 要挖空的区间。
 * @returns 挖空后的文本。
 */
function blankOut(text, ranges) {
  if (ranges.length === 0) return text
  const chars = text.split('')
  for (const [from, to] of ranges) {
    for (let i = from; i < to; i += 1) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' '
    }
  }
  return chars.join('')
}

/**
 * 取出一段 PowerShell 正文里所有 `$( … )` 的内容(括号配平)。
 * `@"…"@` 被挖掉后,这些子表达式仍会执行,必须留在扫描文本里。
 * @param body - here-string 正文。
 * @returns 每个子表达式内部的源码。
 */
function psSubExpressions(body) {
  const found = []
  for (let at = body.indexOf('$('); at >= 0; at = body.indexOf('$(', at + 1)) {
    let depth = 0
    let end = at + 1
    for (; end < body.length; end += 1) {
      if (body[end] === '(') depth += 1
      else if (body[end] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    found.push(body.slice(at + 2, end))
  }
  return found
}

/**
 * 找出"不会执行"的正文区间并挖空,返回用于规则匹配的文本。
 * @param text - 原始命令文本。
 * @returns 挖空后的文本(没有任何字面量正文时原样返回)。
 */
export function maskLiteralBodies(text) {
  const ranges = []
  const rescan = []

  PS_HERE_STRING.lastIndex = 0
  let here
  while ((here = PS_HERE_STRING.exec(text)) !== null) {
    const bodyStart = here.index + here[0].indexOf('\n') + 1
    ranges.push([bodyStart, bodyStart + here[3].length])
    if (here[2] === '"') rescan.push(...psSubExpressions(here[3]))
  }

  QUOTED_HEREDOC.lastIndex = 0
  let doc
  while ((doc = QUOTED_HEREDOC.exec(text)) !== null) {
    const lineStart = text.lastIndexOf('\n', doc.index) + 1
    let lineEnd = text.indexOf('\n', doc.index)
    if (lineEnd < 0) lineEnd = text.length
    const head = text.slice(lineStart, doc.index) + text.slice(doc.index + doc[0].length, lineEnd)
    // 喂给解释器 / 或根本没有数据类消费方 ⇒ 正文可能是代码,不挖。
    if (SHELL_INTERPRETER.test(head) || !DATA_CONSUMERS.test(head)) continue

    const stripTabs = doc[1] === '-'
    const bodyStart = lineEnd + 1
    let pos = bodyStart
    let bodyEnd = -1
    let afterTerm = text.length
    while (pos <= text.length) {
      const nl = text.indexOf('\n', pos)
      const end = nl < 0 ? text.length : nl
      const line = text.slice(pos, end)
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === doc[3]) {
        bodyEnd = pos
        afterTerm = nl < 0 ? text.length : nl + 1
        break
      }
      if (nl < 0) break
      pos = nl + 1
    }
    if (bodyEnd < 0) continue
    ranges.push([bodyStart, bodyEnd])
    QUOTED_HEREDOC.lastIndex = afterTerm
  }

  if (ranges.length === 0 && rescan.length === 0) return text
  const masked = blankOut(text, ranges)
  return rescan.length === 0 ? masked : `${masked}\n${rescan.join('\n')}`
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
  // ── Windows / PowerShell 删除类(2026-10-17,执行器翻成 pwsh 后补齐)───────────────
  // 旧模式 `Remove-Item[^\n]*-Recurse[^\n]*[A-Za-z]:\\\s*($|[^*])` 会把**任何** `C:` 下的
  // 递归删除都判 deny(因为 `[^*]` 连路径首字母都算),`Remove-Item -Recurse C:\Users\me\build`
  // 这种正常清理也被拦。现在只认"根目标":盘符根、Windows、用户目录根。
  // 另外 `-Path C:\ -Recurse` 把 flag 写在目标后面的写法,旧模式(先 -Recurse 后路径)也漏,
  // 所以 flag 用 lookahead 判"同行出现过",目标再单独锚边界。
  { id: 'ps-remove-item-drive-root', where: 'command', re: /\b(?:Remove-Item|ri|rm|del|erase|rd|rmdir)\b(?=[^\n]*(?:\/s\b|-Recurse))[^\n]*(?:["'][A-Za-z]:\\["']?|[A-Za-z]:\\|%SystemDrive%\\?|\$env:SystemDrive\\?)(?=\s|$|["']|[;&|)]|\*)/i, why: { 'zh-CN': '递归删除整个盘符根目录', en: 'recursively deletes a whole drive root' } },
  { id: 'ps-remove-item-windows-dir', where: 'command', re: /\b(?:Remove-Item|del|erase|rd|rmdir)\b(?=[^\n]*(?:\/s\b|-Recurse))[^\n]*(?:\$env:(?:SystemRoot|Windir)\b|%SystemRoot%|%windir%|[A-Za-z]:\\Windows(?=\\|\s|["']|$))/i, why: { 'zh-CN': '递归删除 Windows 系统目录', en: 'recursively deletes the Windows system directory' } },
  { id: 'ps-remove-item-user-profile', where: 'command', re: /\b(?:Remove-Item|ri|rm|del|erase|rd|rmdir)\b(?=[^\n]*(?:\/s\b|-Recurse))[^\n]*(?:\$env:USERPROFILE(?![\w\\])|\$HOME(?![\w\\])|%USERPROFILE%(?!\\)|["']?[A-Za-z]:\\Users\\[^\\\s"']+\\?["']?(?=\s|$|[;&|)])|~\\?(?=\s|$|[;&|)]))/i, why: { 'zh-CN': '递归删除整个用户目录根', en: 'recursively deletes a whole user-profile root' } },
  { id: 'format-drive', where: 'command', re: /\bformat(?:\.com)?\s+(?:[/-][a-z]+\s+)*["']?[A-Za-z]:["']?(?=\s|$)/i, why: { 'zh-CN': '格式化盘符(cmd 的 format)', en: 'formats a drive (cmd format)' } },
  { id: 'boot-config-edit', where: 'command', re: /\bbcdedit(?:\.exe)?\b[^\n]*\/(?:set|setvalue|delete|deletevalue|create|import)\b/i, why: { 'zh-CN': '改写启动配置,写坏了机器起不来', en: 'edits the boot configuration; a bad write leaves the machine unbootable' } },
  { id: 'disable-system-restore', where: 'command', re: /\bDisable-ComputerRestore\b/i, why: { 'zh-CN': '关掉系统还原,会毁掉以后的回滚能力', en: 'disables System Restore, destroying the ability to roll back later' } },
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
  // ── PowerShell / Windows 语义层的显式确认项(2026-10-17)─────────────────────────
  // 这些不一定是"永不允许"(有正当用途),但被动态生成 / 隐蔽执行 / 删账号注册表时,
  // 语义层在 1800ms 超时下会 fail-open —— 所以放进 L0 让人看一眼。
  { id: 'ps-invoke-expression', where: 'command', re: /\b(?:Invoke-Expression|iex)\b/i, why: { 'zh-CN': '执行动态生成的代码(iex),调用方看不到真正要跑什么', en: 'executes dynamically generated code (iex); the real payload is invisible to the reader' } },
  { id: 'ps-encoded-command', where: 'command', re: /\b(?:pwsh|powershell)(?:\.exe)?\b[^\n]*\s-(?:e|ec|enc|encodedcommand)\b/i, why: { 'zh-CN': '用 -EncodedCommand 执行 Base64 代码,内容不可读', en: 'runs Base64 code via -EncodedCommand; the content is unreadable' } },
  { id: 'ps-clear-content', where: 'command', re: /\bClear-Content\b/i, why: { 'zh-CN': '清空文件内容(保留文件本身)', en: 'empties file contents (the files themselves stay)' } },
  { id: 'ps-registry-delete', where: 'command', re: /\breg(?:\.exe)?\s+delete\b/i, why: { 'zh-CN': '删除注册表项', en: 'deletes registry keys' } },
  { id: 'ps-remove-item-registry', where: 'command', re: /Remove-Item[^\n]*(?:HKLM:|HKCU:|HKCR:|HKU:|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKEY_CLASSES_ROOT)/i, why: { 'zh-CN': '通过 Remove-Item 删除注册表项', en: 'deletes registry keys through Remove-Item' } },
  { id: 'net-account-delete', where: 'command', re: /\bnet(?:\.exe)?\s+(?:user|localgroup)\b[^\n]*\/delete\b/i, why: { 'zh-CN': '删除本地账号/组,可能把人锁在系统外', en: 'deletes a local account/group; can lock a person out of the machine' } },
  { id: 'ps-takeown-icacls-root', where: 'command', re: /\btakeown(?:\.exe)?\b[^\n]*\/[fs]\s+["']?[A-Za-z]:\\["']?(?=\s|\/|$)|\bicacls\b[^\n]*["']?[A-Za-z]:\\["']?\s*\/reset\b/i, why: { 'zh-CN': '夺取/重置盘符根的 ACL,会把权限结构整个翻掉', en: 'takes ownership of / resets ACLs on a drive root, flipping the whole permission structure' } },
  { id: 'clear-recyclebin', where: 'command', re: /\bClear-RecycleBin\b/i, why: { 'zh-CN': '清空回收站,删掉最后的恢复副本', en: 'empties the Recycle Bin, removing the last recoverable copy' } },
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
  // 先挖空"执行不到"的字面量正文,再交给锚定规则 —— 顺序不能反:锚定本身是对的,
  // 错的是把 Markdown 里的反引号当成了命令位置。
  const text = maskLiteralBodies(String(command ?? ''))
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
