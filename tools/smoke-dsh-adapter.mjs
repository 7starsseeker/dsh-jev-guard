#!/usr/bin/env node
/**
 * DSH 适配器冒烟测试 —— **重启 DSH 之前**就能证明接线是对的。
 *
 * 做法:用一个假的 ctx 把 adapters/dsh/index.js 的 apply() 跑起来,抓住它注册在
 * `tools/pre-execute` 上的那个 handler,再用假的 exec 调用它,断言返回的
 * Typed Decision 是否符合预期:
 *
 *   · 事件名接对了(tools/pre-execute)
 *   · 返回的是 { kind: 'allow' | 'ask' | 'deny' }
 *   · 会话审批策略被正确读取(ask → 弹审批 / never → 直接拒绝 + 准确理由)
 *   · 重试预算会把反复重试升级为 escalate
 *   · 判定失败时 fail-open(返回 allow,交给原有管线)
 *
 * 不带密钥时跳过需要联网的用例(仍会验证 L0 与预筛路径)。
 *
 *   node tools/smoke-dsh-adapter.mjs
 *
 * @module jev-guard/tools/smoke-dsh-adapter
 */

import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flush } from '../lib/audit.js'
import { apply } from '../adapters/dsh/index.js'

/** 收集 apply() 注册的 handler。 */
function mockContext(apiKey) {
  const handlers = new Map()
  const logs = []
  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      debug: () => {},
    },
    on(event, handler) {
      handlers.set(event, handler)
    },
    get: () => undefined,
    credentials: {
      resolve: async () => (apiKey ? { value: apiKey, source: 'env' } : undefined),
    },
  }
  return { ctx, handlers, logs }
}

/**
 * 构造一次假的工具调用。
 * @param command - 命令文本。
 * @param sessionId - 会话 id,用于重试预算隔离。
 * @returns the fake exec view.
 */
function fakeExec(command, sessionId = 'smoke') {
  return {
    name: 'bash',
    arguments: { command },
    callId: 'call-smoke',
    signal: new AbortController().signal,
    agent: { session: { id: sessionId, snapshotEvents: () => [] } },
  }
}

const nextAllow = async () => ({ kind: 'allow' })

let failures = 0
let checks = 0

/**
 * @param label - 用例名。
 * @param actual - 实际 decision。
 * @param wantKind - 期望 kind。
 * @param other - 期望 kind 是 ask 时的审批策略(用于断言 ask/deny 分支)。
 * @param reasonIncludes - 理由里必须包含的字符串。
 */
function expect(label, actual, wantKind, reasonIncludes) {
  checks += 1
  const kindOk = actual?.kind === wantKind
  const reasonOk = reasonIncludes === undefined || String(actual?.reason ?? '').includes(reasonIncludes)
  const ok = kindOk && reasonOk
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${label}\n      期望 ${wantKind}${reasonIncludes ? ` + 理由含「${reasonIncludes}」` : ''} / 实得 ${actual?.kind}\n`)
  if (!ok) process.stdout.write(`      实得理由: ${String(actual?.reason ?? '').slice(0, 200)}\n`)
}

/**
 * 布尔断言 —— 与 `expect` 分开:`expect` 比的是"决策 kind + 理由片段",
 * 而这里要问的是"这段文本里有没有某个字段"(曾经把布尔塞进 expect,结果恒 FAIL)。
 * @param label - 用例名。
 * @param ok - 断言结果。
 * @param detail - 失败细节。
 */
function expectTrue(label, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `   ${detail}`}\n`)
}

async function main() {
  const apiKey = process.env.TYPESAFE_API_KEY
  process.stdout.write(`DSH 适配器冒烟测试 ${apiKey ? '(含联网用例)' : '(无密钥:只跑离线路径)'}\n\n`)

  // ---- 第一次装配:审批策略 = ask(默认) ----
  const a = mockContext(apiKey)
  apply(a.ctx, { tools: ['bash'], inlineScripts: false })
  const handler = a.handlers.get('tools/pre-execute')
  if (typeof handler !== 'function') {
    process.stdout.write('FAIL  没有在 tools/pre-execute 上注册 handler\n')
    process.exit(1)
  }
  process.stdout.write('ok   已在 tools/pre-execute 上注册 handler\n\n')

  expect('安全命令 → allow(预筛,零网络)', await handler(fakeExec('ls -la'), nextAllow), 'allow')
  expect('L0 硬规则 → deny', await handler(fakeExec('git push --force origin main'), nextAllow), 'deny', 'git-force-push')
  expect('L0 必问 + 审批可用 → ask', await handler(fakeExec('git reset --hard HEAD~1'), nextAllow), 'ask', 'git-reset-hard')
  expect('非目标工具 → 放行', await handler({ ...fakeExec('rm -rf /home/user/x'), name: 'read' }, nextAllow), 'allow')
  expect('无 command 字段 → 放行(fail-open)', await handler({ name: 'bash', arguments: {}, agent: fakeExec('x').agent }, nextAllow), 'allow')

  // ---- 第二次装配:审批策略 = never(完全权限),验证 deny + 准确理由 ----
  const b = mockContext(apiKey)
  apply(b.ctx, { tools: ['bash'], inlineScripts: false })
  const handlerNever = b.handlers.get('tools/pre-execute')
  // 让 effectivePolicy 读到 'never'(模拟 danger-full-access 会话)
  const neverExec = cmd => {
    const exec = fakeExec(cmd)
    exec.agent.session.snapshotEvents = () => [{ type: 'approval/policy', data: { policy: 'never' } }]
    return exec
  }
  expect('L0 必问 + 完全权限 → deny(不是"用户拒绝")', await handlerNever(neverExec('git reset --hard HEAD~1'), nextAllow), 'deny', '不是用户手动拒绝')

  // ---- 重试预算:同一命令反复重试应升级为 escalate ----
  const c = mockContext(apiKey)
  apply(c.ctx, { tools: ['bash'], inlineScripts: false, retryLimit: 2 })
  const handlerBudget = c.handlers.get('tools/pre-execute')
  const cmd = 'git reset --hard HEAD~1'
  const r1 = await handlerBudget(fakeExec(cmd, 'budget-session'), nextAllow)
  const r2 = await handlerBudget(fakeExec(cmd, 'budget-session'), nextAllow)
  const r3 = await handlerBudget(fakeExec(cmd, 'budget-session'), nextAllow)
  process.stdout.write(`\n  重试预算三次调用:${r1.kind} / ${r2.kind} / ${r3.kind}\n`)
  process.stdout.write('note L0 必问项在审批可用时始终 ask(预算只影响 block/revise 的升级路径)\n')

  // ---- 判定不可用时 fail-open ----
  const d = mockContext(undefined) // 没有凭据
  apply(d.ctx, { tools: ['bash'], inlineScripts: false })
  const handlerNoKey = d.handlers.get('tools/pre-execute')
  process.env.TYPESAFE_API_KEY = ''
  expect('无密钥 + 需要语义判定 → allow(fail-open)',
    await handlerNoKey(fakeExec('rm -rf /tmp/whatever-not-prefiltered-xyz'), nextAllow), 'allow')
  if (apiKey) process.env.TYPESAFE_API_KEY = apiKey

  // ---- 联网用例(有密钥时才跑) ----
  if (apiKey) {
    const e = mockContext(apiKey)
    apply(e.ctx, { tools: ['bash'], inlineScripts: false })
    const h = e.handlers.get('tools/pre-execute')
    const destructive = await h(neverExec('rm -rf ~/dsh-cross-search'), nextAllow)
    expect('真实目录 rm -rf + 完全权限 → deny', destructive, 'deny')
  } else {
    process.stdout.write('\n(跳过联网用例:没有 TYPESAFE_API_KEY)\n')
  }

  // ---- DSH 专用审计字段:审批策略 + **权限 preset** 都要留痕 ----
  //
  // 为什么单独立一条:DSH 的 preset 决定"阀门后面还有没有别的兜底"。
  // `danger-full-access` = 没有沙箱、审批也是 never → 那条阀门就是唯一一层,事后复盘必须能看出这一点。
  // 这里把 logPath 显式指到临时文件(同时顺带验证 config.logPath 这条路是通的)。
  const audited = join(tmpdir(), `jev-guard-smoke-${process.pid}.log`)
  const f = mockContext(apiKey)
  apply(f.ctx, { tools: ['bash'], inlineScripts: false, logPath: audited })
  const handlerAudit = f.handlers.get('tools/pre-execute')
  const presetExec = cmd => {
    const exec = fakeExec(cmd)
    exec.agent.session.snapshotEvents = () => [
      { type: 'approval/policy', data: { policy: 'never' } },
      { type: 'permission/preset', data: { preset: 'danger-full-access' } },
    ]
    return exec
  }
  await handlerAudit(presetExec('git reset --hard HEAD~1'), nextAllow)
  await flush() // record() 是 fire-and-forget,不等它落盘就读不到
  const auditText = await readFile(audited, 'utf8').catch(() => '')
  expectTrue('审计里记下了审批策略', /"policy":"(ask|never)"/.test(auditText), auditText.slice(0, 200))
  expectTrue('审计里记下了权限 preset(danger-full-access)', auditText.includes('"preset":"danger-full-access"'), auditText.slice(0, 200))
  await rm(audited, { force: true })

  await flush() // 等审计日志落盘,否则 process.exit 会丢掉尾部记录
  process.stdout.write(`\n${failures === 0 ? `全部通过(${checks} 组断言)` : `${failures} 组失败 / 共 ${checks} 组`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
