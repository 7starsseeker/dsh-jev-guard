#!/usr/bin/env node
/**
 * L0 规则自检:验证 `where: 'command'` 的锚定语义。
 *
 * 为什么单独一个文件:测试用例里必须出现危险命令的**字面量**,而把它们写进
 * bash 命令文本会被阀门自己拦下(2026-09-20 真发生过两次)。把字面量放进文件、
 * 用 `node tools/selftest-rules.mjs` 调用,就不会经过命令文本扫描。
 *
 * 2026-09-20 第二次修正后,这里同时钉住两个**方向相反**的偏差(同一个根因:锚定只做了一半):
 *   · 假阳:命令开头型规则原来全是全文匹配 → "引号里的数据 / 注释 / 赋值 / 代码字符串"也命中。
 *   · 漏判:锚定的 `^` 没有 `m` 标志 → 多行脚本(heredoc)与多行 `-c` 里的真命令看不见;
 *     包装器列表也只有 sudo/env/command/nohup/time → `| xargs …`、`timeout 30 …` 全漏。
 *   A 组防假阳,B 组防漏判,C 组防"包装器把散文也当成命令",D 组防灾难性回溯。
 *
 * @module jev-guard/tools/selftest-rules
 */

import { staticRule, RULE_STATS } from '../lib/rules.js'

/** `[命令, 期望命中的规则 id 或不命中(null), 说明]` */
const CASES = [
  ['git push --force origin main', 'git-force-push', '命令位置:行首'],
  ['cd /tmp && git push --force origin main', 'git-force-push', '命令位置:&& 之后'],
  ['sudo git push -f origin main', 'git-force-push', '命令位置:sudo 包装'],
  ['git push --force-with-lease origin main', null, '--force-with-lease 是安全形式,不该命中'],
  ['echo "git push --force origin main" > /tmp/x', null, '散文:把命令当文本写进参数 → 交给 Jev'],
  ['node tools/report-result.mjs --evidence "远端强推被拦"', null, '散文:中文描述,不该命中'],

  ['rm -rf /', 'rm-root', '命令位置:行首的根目录删除'],
  ['cd / && rm -rf /', 'rm-root', '命令位置:&& 之后'],
  ['echo "rm -rf / 会毁掉机器" > notes.txt', null, '散文:文档里提到它 → 交给 Jev'],

  ['find / -name "*.log" -delete', 'find-delete', '命令位置'],
  ['df -h && rm -rf ~', 'rm-rf-home-root', '命令位置:&& 之后(整个家目录)'],
  ['rm -rf ~/Photos', null, '普通子目录:规则只锚"整个家目录",这里交给 Jev 判'],
  ['ls -la', null, '无关命令'],
  ['df -h', null, '无关命令'],
  // 2026-09-20 实拦案例:原先的 `>\s*[^\s|]+\s*$` 分支会把「以重定向结尾」的正常命令
  // 误判成"把文件截断为空",例如下面这几条。现在只认显式的空写形态。
  ['node bin/guard.mjs selftest 2>/dev/null', null, '普通重定向:不该命中'],
  ['echo hello > /tmp/out.txt', null, '普通重定向:不该命中'],
  ['cat log.txt > /tmp/copy.txt', null, '普通重定向:不该命中'],
  ['echo "" > start.sh', 'truncate-file', '显式空写:命中'],
  ['truncate -s 0 /home/user/notes.md', 'truncate-file', '显式截断:命中'],
  ['DROP TABLE users', 'drop-database', '命令位置'],
  ['psql -c "DROP TABLE users"', null, '藏在引号里 → 交给 Jev(实测 p 很高)'],
  ['git reset --hard HEAD~1', 'git-reset-hard', '命令位置'],
  ['kubectl delete namespace production', 'kubectl-delete-ns', '命令位置'],
  ['dd if=/dev/zero of=/dev/sda bs=1M', 'block-device-write', '命令位置'],
  ['mkfs.ext4 /dev/sdb1', 'mkfs', '命令位置'],

  // ── A 组:数据位不该命中(2026-09-20 第二次修正前,这里全是假阳)────────────────
  ['echo "mkfs.ext4 /dev/sdb1"', null, 'A 数据:双引号参数里提到 → 交给 Jev'],
  ["printf '%s\\n' 'mkfs.ext4 /dev/sdb1'", null, 'A 数据:单引号参数'],
  ['python3 -c "print(\'mkfs.ext4 /dev/sdb1\')"', null, 'A 数据:python -c 里的字符串'],
  ["python3 - <<'PY'\nprint('mkfs.ext4 /dev/sdb1')\nPY", null, 'A 数据:python heredoc 里的字符串(实测假阳原形)'],
  ['c.startswith(\'mkfs.ext4 /dev/sdb1\')', null, 'A 数据:代码里的字符串比较(实测假阳原形)'],
  ['# mkfs.ext4 /dev/sdb1', null, 'A 数据:注释'],
  ["X='mkfs.ext4 /dev/sdb1'", null, 'A 数据:变量赋值'],
  ['grep -rn mkfs.ext4 /dev/sdb1 README.md', null, 'A 数据:grep 参数里提到'],
  ['echo "dd if=/dev/zero of=/dev/sda bs=1M"', null, 'A 数据:引号里的块设备写入'],

  // ── B 组:真执行必须命中,尤其是多行与包装器(这些在修正前会漏)──────────────────
  ["bash - <<'SH'\ngit push --force origin main\nSH", 'git-force-push', 'B 真执行:多行 heredoc(缺 m 标志时漏)'],
  ['bash -c "\ngit push --force origin main\n"', 'git-force-push', 'B 真执行:多行 bash -c'],
  ["bash - <<'SH'\nrm -rf /\nSH", 'rm-root', 'B 真执行:多行 heredoc'],
  ["bash - <<'SH'\nmkfs.ext4 /dev/sdb1\nSH", 'mkfs', 'B 真执行:多行 heredoc'],
  ["psql - <<'SQL'\nDROP DATABASE prod;\nSQL", 'drop-database', 'B 真执行:多行 heredoc(缺 m 标志时漏)'],
  ['echo x | xargs git push --force origin main', 'git-force-push', 'B 真执行:| xargs 包装'],
  ['echo x | xargs -0 mkfs.ext4 /dev/sdb1', 'mkfs', 'B 真执行:xargs 带选项'],
  ['timeout 30 rm -rf /', 'rm-root', 'B 真执行:timeout 包装'],
  ['nice -n 5 git push --force origin main', 'git-force-push', 'B 真执行:nice 带选项'],
  ['find . -type f -exec mkfs.ext4 /dev/sdb1 {} \\;', 'mkfs', 'B 真执行:find -exec'],
  ['sudo timeout 60 xargs -0 mkfs.ext4 /dev/sdb1', 'mkfs', 'B 真执行:多级包装'],

  // ── C 组:包装器吞参数只认 ASCII 词/flag/路径,中文散文不该被顺带命中 ─────────────
  ['xargs 删除 mkfs.ext4 /dev/sdb1', null, 'C 散文:包装器后面是中文 → 交给 Jev'],
  ['用 mkfs.ext4 /dev/sdb1 格式化会丢数据', null, 'C 散文:行首不是命令'],
]

let failed = 0
process.stdout.write(
  `L0 规则:deny ${RULE_STATS.deny} / ask ${RULE_STATS.ask} / 锚定到命令位置 ${RULE_STATS.anchored}`
  + ` / 全文匹配例外 ${RULE_STATS.anywhere}(应为 2:redirect-to-device 与 fork-bomb)\n\n`,
)

for (const [command, wantId, note] of CASES) {
  const hit = staticRule(command)
  const gotId = hit ? hit.id : null
  const ok = gotId === wantId
  if (!ok) failed += 1
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${String(gotId ?? '—').padEnd(20)} ${command.replace(/\n/g, '⏎').slice(0, 62).padEnd(62)} ${note}\n`)
}

// ── D 组:包装器允许"吞一串参数",必须保证不会灾难性回溯 ──────────────────────────
// 4KB 的纯包装器前缀(没有规则命中)是最坏输入:正则要尝试各种切分。
const longInput = `xargs ${'-0 a/b=c '.repeat(400)}ls -la`
const started = performance.now()
staticRule(longInput)
const elapsed = performance.now() - started
const perfOk = elapsed < 50
if (!perfOk) failed += 1
process.stdout.write(`\n${perfOk ? 'ok  ' : 'FAIL'}  长输入无灾难性回溯(4KB 包装器前缀,${elapsed.toFixed(1)}ms < 50ms)\n`)

const total = CASES.length + 1
process.stdout.write(failed === 0 ? `\n全部通过(${total} 例,含 1 例性能)\n` : `\n${failed} 例失败 / 共 ${total} 例\n`)
process.exit(failed === 0 ? 0 : 1)
