#!/usr/bin/env node
/**
 * 一次性放行令牌自检:绑定命令、一次性、不越过 L0、与 gate 的接线。
 *
 * 全部在临时目录里做(显式 tokenPath),不碰 ~/.jev-guard。
 *
 * @module jev-guard/tools/selftest-token
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateCommand } from '../lib/gate.js'
import { explain } from '../lib/verdict.js'
import { canonicalize, commandToken, consumeToken, grantToken, readTokens, resolveTokenPath, revokeToken } from '../lib/token.js'

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

const dir = await mkdtemp(join(tmpdir(), 'jev-guard-token-'))
const tokenPath = join(dir, 'allow.txt')

const CMD = 'rm -f /home/user/notes.md'
const OTHER = 'rm -f /home/user/other.md'

// 1) 令牌与命令绑定
expect('同一命令得到同一令牌', commandToken(CMD) === commandToken(CMD))
expect('空白差异不影响令牌', commandToken('rm  -f   /x') === commandToken('rm -f /x'))
expect('不同命令令牌不同', commandToken(CMD) !== commandToken(OTHER))
expect('令牌形态正确', /^ALLOW-[0-9A-F]{10}$/.test(commandToken(CMD)), commandToken(CMD))
expect('规范化折叠空白', canonicalize(' a \n  b ') === 'a b')

// 2) 路径解析:空串回落默认(与 audit 同一教训)
expect('空 tokenPath → 默认路径', resolveTokenPath({ tokenPath: '' }).endsWith('allow.txt'))
expect('显式 tokenPath 生效', resolveTokenPath({ tokenPath }) === tokenPath)

// 3) 写令牌 → 消费一次 → 第二次失败
await grantToken(CMD, { tokenPath, note: '自检' })
expect('令牌已写入', (await readTokens(tokenPath)).includes(commandToken(CMD)))
const first = await consumeToken(CMD, { tokenPath })
expect('第一次消费成功', first.ok === true)
const second = await consumeToken(CMD, { tokenPath })
expect('第二次消费失败(一次性)', second.ok === false)
expect('消费后文件里已无该令牌', !(await readTokens(tokenPath)).includes(commandToken(CMD)))
const persisted = await readFile(tokenPath, 'utf8')
expect('文件里留有注释便于人工核对', persisted.includes('#') || persisted === '')

// 4) 撤销
await grantToken(CMD, { tokenPath })
const revoked = await revokeToken(commandToken(CMD), { tokenPath })
expect('撤销成功', revoked.removed === 1)
expect('撤销后无令牌', (await readTokens(tokenPath)).length === 0)

// 5) 与 gate 接线:L0 硬规则不受令牌影响;可放行的判定可被令牌放行
const cfg = { apiKey: process.env.TYPESAFE_API_KEY, tokenPath, tokens: true }

const l0 = await evaluateCommand('mkfs.ext4 /dev/sdb1', cfg)
expect('L0 deny 仍然拦截(令牌不越过硬地板)', l0.action === 'block' && l0.source === 'static-rule')
await grantToken('mkfs.ext4 /dev/sdb1', { tokenPath })
const l0After = await evaluateCommand('mkfs.ext4 /dev/sdb1', cfg)
expect('即使给了令牌,L0 deny 依旧拦截', l0After.action === 'block', `实得 ${l0After.action}/${l0After.source}`)
// L0 deny 连"令牌提示"都不该出现在理由里 —— 给了也放行不了,别误导调用方。
const l0Reason = explain('mkfs.ext4 /dev/sdb1', l0After, { policy: 'never', token: l0After.token })
expect('L0 deny 的理由里不出现令牌提示', !l0Reason.includes('ALLOW-'), l0Reason.slice(0, 120))

if (process.env.TYPESAFE_API_KEY) {
  // 需要联网的路径:确保同一条命令先被判为 revise/block,再凭令牌放行
  const offline = { ...cfg, timeoutMs: 5000 }
  const probe = 'rm -rf /home/user/jev-guard-token-probe-dir'
  const judged = await evaluateCommand(probe, offline)
  if (judged.action !== 'allow') {
    await grantToken(probe, { tokenPath })
    const withToken = await evaluateCommand(probe, offline)
    expect('令牌把 revise/block 改成放行', withToken.action === 'allow' && withToken.source === 'token',
      `判定=${judged.action} 实得=${withToken.action}/${withToken.source}`)
    expect('放行记录里带被覆盖的原动作', withToken.overridden === judged.action, String(withToken.overridden))
    const replay = await evaluateCommand(probe, offline)
    expect('令牌用掉后不能重放', replay.action !== 'allow' || replay.source !== 'token',
      `实得 ${replay.action}/${replay.source}`)
  } else {
    process.stdout.write(`note  探针命令被判为 allow(p=${judged.p}),跳过"令牌覆盖判定"用例\n`)
  }
} else {
  process.stdout.write('note  没有 TYPESAFE_API_KEY,跳过联网用例\n')
}

await rm(dir, { recursive: true, force: true })
process.stdout.write(failed === 0 ? `\n全部通过(${checks} 例)\n` : `\n${failed} 例失败 / 共 ${checks} 例\n`)
process.exit(failed === 0 ? 0 : 1)
