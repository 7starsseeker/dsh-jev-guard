#!/usr/bin/env node
/**
 * L0 规则自检:验证 `where: 'command'` 的锚定语义。
 *
 * 为什么单独一个文件:测试用例里必须出现危险命令的**字面量**,而把它们写进
 * bash 命令文本会被阀门自己拦下(2026-09-20 真发生过两次)。把字面量放进文件、
 * 用 `node tools/selftest-rules.mjs` 调用,就不会经过命令文本扫描。
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
  ['kubectl delete namespace production', 'kubectl-delete-ns', 'deny 规则仍全文匹配'],
  ['dd if=/dev/zero of=/dev/sda bs=1M', 'block-device-write', 'deny 规则仍全文匹配'],
  ['mkfs.ext4 /dev/sdb1', 'mkfs', 'deny 规则仍全文匹配'],
]

let failed = 0
process.stdout.write(`L0 规则:deny ${RULE_STATS.deny} / ask ${RULE_STATS.ask} / 其中锚定到命令位置 ${RULE_STATS.anchored}\n\n`)

for (const [command, wantId, note] of CASES) {
  const hit = staticRule(command)
  const gotId = hit ? hit.id : null
  const ok = gotId === wantId
  if (!ok) failed += 1
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${String(gotId ?? '—').padEnd(20)} ${command.slice(0, 62).padEnd(62)} ${note}\n`)
}

process.stdout.write(failed === 0 ? `\n全部通过(${CASES.length} 例)\n` : `\n${failed} 例失败 / 共 ${CASES.length} 例\n`)
process.exit(failed === 0 ? 0 : 1)
