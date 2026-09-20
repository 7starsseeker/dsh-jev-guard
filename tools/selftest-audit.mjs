#!/usr/bin/env node
/**
 * 审计日志自检:掩码、追加、轮转、读回、汇总。
 *
 * 全部在临时目录里做,不碰 ~/.jev-guard。用显式 `logPath` 传参,因此不依赖
 * 环境变量在 import 之前设置。
 *
 * @module jev-guard/tools/selftest-audit
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LOG_PATH, maskSecrets, readTail, record, resolveLogPath, summarize } from '../lib/audit.js'

let failed = 0
let checks = 0

/**
 * @param label - 用例名。
 * @param condition  - 断言结果。
 * @param detail - 失败时打印的细节。
 */
function expect(label, condition, detail = '') {
  checks += 1
  if (!condition) failed += 1
  process.stdout.write(`${condition ? 'ok  ' : 'FAIL'}  ${label}${condition ? '' : `   ${detail}`}\n`)
}

const dir = await mkdtemp(join(tmpdir(), 'jev-guard-audit-'))
const logPath = join(dir, 'guard.log')

// 0) logPath 解析:空串 / 纯空白必须当作"未配置"(实测踩过的坑:写入全部静默失败)
expect('logPath 为空串 → 回落默认路径', resolveLogPath({ logPath: '' }) === DEFAULT_LOG_PATH)
expect('logPath 为纯空白 → 回落默认路径', resolveLogPath({ logPath: '   ' }) === DEFAULT_LOG_PATH)
expect('logPath 未提供 → 默认路径', resolveLogPath({}) === DEFAULT_LOG_PATH)
expect('显式 logPath 被采用', resolveLogPath({ logPath: '/tmp/x.log' }) === '/tmp/x.log')

// 1) 掩码
//
// ⚠️ 这里的所有"密钥"都是**合成夹具**(形状对、值无意义):掩码测试只需要形态,
// 而真实密钥一旦被写进测试文件,就等于随仓库一起被备份/发布出去 —— 2026-09-20 审计时
// 真的抓到过三个真实密钥(两个 API key、一个 GitHub token),已全部替换成下面的假值。
expect('普通文本不被改动', maskSecrets('ls -la /tmp') === 'ls -la /tmp')
expect('长密钥被掩码', maskSecrets('EXAMPLE_API_KEY=sk-EXAMPLE0000000000000000000000abcd node x.mjs').includes('sk-****abcd'),
  maskSecrets('EXAMPLE_API_KEY=sk-EXAMPLE0000000000000000000000abcd node x.mjs'))
expect('TypeSafe 形态也被掩码', maskSecrets('apikey_EXAMPLE0000000000000000000000_example000000000000').includes('api****0000'),
  maskSecrets('apikey_EXAMPLE0000000000000000000000_example000000000000'))
expect('token 类前缀被掩码', maskSecrets('ghp_EXAMPLE0000000000000000000000000000').includes('ghp_') === false, maskSecrets('ghp_EXAMPLE0000000000000000000000000000'))

// 2) 追加 + 读回
await record({ tool: 'bash', action: 'allow', source: 'prefilter', ms: 0, command: 'ls -la' }, { logPath })
await record({ tool: 'bash', action: 'block', decision: 'deny', source: 'static-rule', rule: 'git-force-push', command: 'git push -f origin main' }, { logPath })
await record({ tool: 'bash', action: 'revise', source: 'jev', p: 0.67, ms: 715, command: 'rm -rf ~/x', enriched: ['脚本内容'] }, { logPath })
const tail = await readTail({ logPath, tail: 10 })
expect('三条记录都写进去了', tail.length === 3, `实得 ${tail.length}`)
expect('顺序保持(allow → block → revise)', tail.map(r => r.action).join(',') === 'allow,block,revise', tail.map(r => r.action).join(','))
expect('字段完整(rule/p/ms)', tail[1].rule === 'git-force-push' && tail[2].p === 0.67 && tail[2].ms === 715)
expect('每行都有时间戳', tail.every(r => typeof r.at === 'string' && r.at.includes('T')))
expect('enriched 数组保留', Array.isArray(tail[2].enriched) && tail[2].enriched[0] === '脚本内容')

// 3) 命令里的密钥在落盘前被掩码
await record({ tool: 'bash', action: 'allow', source: 'jev', command: 'EXAMPLE_API_KEY=sk-EXAMPLE00000000000000000000f47a node x.mjs' }, { logPath })
const raw = await readFile(logPath, 'utf8')
expect('磁盘上没有完整密钥', !raw.includes('sk-EXAMPLE00000000000000000000f47a'))
expect('磁盘上是掩码形态', raw.includes('sk-****f47a'))

// 4) 汇总
const summary = await summarize({ logPath, since: 0 })
expect('汇总条数正确', summary.total === 4, `实得 ${summary.total}`)
expect('按动作计数正确', summary.byAction.allow === 2 && summary.byAction.block === 1 && summary.byAction.revise === 1, JSON.stringify(summary.byAction))
expect('按来源计数正确', summary.bySource['static-rule'] === 1 && summary.bySource.jev === 2, JSON.stringify(summary.bySource))
expect('fail-open 计数为 0', summary.failOpen === 0)

// 5) 轮转:上限设成 10 字节,再写一条就应该把旧文件转成 .1
await record({ tool: 'bash', action: 'allow', source: 'jev', command: 'echo hi' }, { logPath, logMaxBytes: 10 })
const rotated = await stat(`${logPath}.1`).then(() => true).catch(() => false)
expect('超上限时轮转到 guard.log.1', rotated)

await rm(dir, { recursive: true, force: true })

// 6) 端到端:空白 logPath 真能落盘(仅在隔离环境里做,免得污染 ~/.jev-guard)
if (DEFAULT_LOG_PATH.startsWith(tmpdir())) {
  await record({ tool: 'test', action: 'allow', source: 'blank-path-probe', command: 'echo hi' }, { logPath: '   ' })
  const back = await readTail({ logPath: '', tail: 50 })
  expect('空白 logPath 端到端仍落盘', back.some(r => r.source === 'blank-path-probe'))
} else {
  process.stdout.write(`note  未在隔离环境运行(DEFAULT_LOG_PATH=${DEFAULT_LOG_PATH}),跳过空白路径端到端用例;` +
    ' 想覆盖请用 JEV_GUARD_HOME=$(mktemp -d) 运行本自检\n')
}

process.stdout.write(failed === 0 ? `\n全部通过(${checks} 例)\n` : `\n${failed} 例失败 / 共 ${checks} 例\n`)
process.exit(failed === 0 ? 0 : 1)
