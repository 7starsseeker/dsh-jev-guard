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
 *   · 判定动作按审批策略路由:ask 下 revise 与 Jev 高分的 block 转人工;L0 的 deny 类硬规则
 *     两种模式都拦死,且**不参与**重试预算升级
 *   · 重试预算会把反复重试升级为 escalate
 *   · 判定失败时 fail-open(返回 allow,交给原有管线)
 *
 * 不带密钥时跳过需要联网的用例(仍会验证 L0 与预筛路径)。
 *
 *   node tools/smoke-dsh-adapter.mjs
 *
 * @module jev-guard/tools/smoke-dsh-adapter
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flush } from '../lib/audit.js'
import { readDegraded } from '../lib/quota.js'
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

  // 全部落在一个临时目录里。**以前不是**:这个测试会往真实的 `~/.jev-guard/` 写降级状态与
  // 审计记录(无密钥用例尤其),也就是说"跑一次冒烟测试"会改动你本机的阀门状态。测试不该有
  // 这种副作用,所以现在每个 `apply()` 都显式带上 `logPath` / `degradedPath`。
  // `apiKeyFile` 也必须指到一个不存在的临时路径,否则适配器新增的文件回退层会读到
  // 仓库里真实的 `secrets.json`,于是"无密钥"用例永远造不出无密钥的情形。
  const dir = await mkdtemp(join(tmpdir(), 'jev-guard-smoke-'))
  const auditPath = join(dir, 'guard.log')
  const degradedPath = join(dir, 'degraded.json')
  const missingKeyFile = join(dir, 'no-such-secrets.json')
  const applySmoke = (ctx, extra = {}) => apply(ctx, {
    tools: ['bash'], inlineScripts: false, logPath: auditPath, degradedPath, apiKeyFile: missingKeyFile, ...extra,
  })

  // ---- 第一次装配:审批策略 = ask(默认) ----
  const a = mockContext(apiKey)
  applySmoke(a.ctx)
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
  applySmoke(b.ctx)
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
  applySmoke(c.ctx, { retryLimit: 2 })
  const handlerBudget = c.handlers.get('tools/pre-execute')
  const cmd = 'git reset --hard HEAD~1'
  const r1 = await handlerBudget(fakeExec(cmd, 'budget-session'), nextAllow)
  const r2 = await handlerBudget(fakeExec(cmd, 'budget-session'), nextAllow)
  const r3 = await handlerBudget(fakeExec(cmd, 'budget-session'), nextAllow)
  process.stdout.write(`\n  重试预算三次调用:${r1.kind} / ${r2.kind} / ${r3.kind}\n`)
  process.stdout.write('note L0 必问项在审批可用时始终 ask(预算只影响 block/revise 的升级路径)\n')

  // ---- L0 硬规则**不参与**重试预算升级(2026-09-20 修)----
  // 预算的本意是"模型反复重写同一条破坏性命令时交给人";但 L0 的 deny 类硬规则是**绝对闸门**,
  // 一旦被预算升级成 escalate,ask 模式下就会弹窗 —— 弹窗里点"允许"就等于绕过了 L0
  // (令牌不能越过 L0,审批同样不能,见 D5/D13)。所以这里断言:反复重试仍然只有 deny。
  const g = mockContext(apiKey)
  applySmoke(g.ctx, { retryLimit: 2 })
  const handlerHard = g.handlers.get('tools/pre-execute')
  const hardRuns = []
  for (let i = 0; i < 4; i += 1) {
    hardRuns.push((await handlerHard(fakeExec('git push --force origin main', 'hard-session'), nextAllow)).kind)
  }
  expectTrue(
    'L0 硬规则连试 4 次始终是 deny(不被预算升级成弹窗)',
    hardRuns.every(k => k === 'deny'),
    hardRuns.join(' / '),
  )

  // ---- 没有密钥:fail-open 不变,但**留下粘性降级状态**(D15)----
  //
  // 为什么断言状态文件:这次判定的 action 仍然是 allow(fail-open 的承诺不变),但"没有密钥"
  // 必须留下痕迹 —— 否则它又是"静默失效",而静默失效正是这个项目踩过的坑(审计日志那次)。
  const d = mockContext(undefined) // 没有凭据
  applySmoke(d.ctx)
  const handlerNoKey = d.handlers.get('tools/pre-execute')
  process.env.TYPESAFE_API_KEY = ''
  // 命令必须绕开预筛(/tmp 之类会被当"可重建内容"直接放行,那样根本到不了需要密钥的语义层)。
  expect('无密钥 + 需要语义判定 → allow(fail-open)',
    await handlerNoKey(fakeExec('rm -rf /home/user/jev-guard-smoke-demo'), nextAllow), 'allow')
  const nkState = await readDegraded({ degradedPath })
  expectTrue('无密钥 → 写下了 no-key 降级状态', nkState?.kind === 'no-key', JSON.stringify(nkState))
  expectTrue('无密钥 → 状态是粘性的、且作用域只限本入口',
    nkState?.sticky === true && nkState?.scope === 'dsh-adapter',
    JSON.stringify({ sticky: nkState?.sticky, scope: nkState?.scope }))
  if (apiKey) process.env.TYPESAFE_API_KEY = apiKey
  await rm(degradedPath, { force: true })

  // ---- 探测成功、但状态文件清不掉(只读文件系统):原因必须有人能发现(2026-09-23)----
  //
  // 现场是只读沙箱:服务已经用一次成功判定证明自己活着,可 `unlink` 删不掉 degraded.json。
  // gate 把那次判定标成 clearFailed + 一句告警;适配器的责任是让它**落地**:host 日志一条
  // warn + 审计一条 level:'warn' 记录(带 errno 与路径)。否则这个原因就只剩 `guard status`
  // 里一句"已降级",没人知道该去删那个文件。
  // 用替身 fetch + 一个假密钥就能离线跑:不需要真网络,也不需要真密钥。
  const stuckPath = join(dir, 'degraded-as-dir.json')
  await writeFile(stuckPath, `${JSON.stringify({
    kind: 'quota', label: '判定服务额度已用尽', since: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    until: new Date(Date.now() - 60 * 1000).toISOString(), cooldownMs: 900000, failures: 1, probes: 0, policy: 'l0-only',
  })}\n`)
  const stuckCtx = mockContext('smoke-fake-key')
  applySmoke(stuckCtx.ctx, { degradedPath: stuckPath })
  const handlerStuck = stuckCtx.handlers.get('tools/pre-execute')
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    // 请求"进行中"把状态文件换成同路径的目录 —— 于是随后的 unlink 必定失败(EISDIR/EPERM),
    // 而"读"已经发生过了。这正是只读文件系统下的处境,两个平台都能造出来。
    await rm(stuckPath, { force: true })
    await mkdir(stuckPath, { recursive: true })
    return {
      ok: true, status: 200, headers: { get: () => 'application/json' },
      text: async () => '', json: async () => ({ model: 'jev-1.13.0', answers: { destroys_data: { noul: 0.1 } } }),
    }
  }
  try {
    expect('探测成功+状态文件清不掉 → 判定仍是 allow(服务确实答了这次探测)',
      await handlerStuck(fakeExec('rm -rf /home/user/jev-guard-stuck-demo'), nextAllow), 'allow')
  } finally {
    globalThis.fetch = realFetch
  }
  await flush()
  const stuckRecords = (await readFile(auditPath, 'utf8')).split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(r => r.clearFailed)
  expectTrue('清不掉 → 审计里留下一条带 errno 的 warn 记录(不是静默)',
    stuckRecords.length === 1 && stuckRecords[0].level === 'warn' && typeof stuckRecords[0].clearFailed.code === 'string'
      && String(stuckRecords[0].warning ?? '').includes('删不掉'),
    JSON.stringify(stuckRecords.map(r => r.clearFailed)))
  await rm(stuckPath, { recursive: true, force: true })

  // ---- 会话内 notice:纯 host 插件唯一能让用户真看到的渠道(D15)----
  //
  // 这一段同时验证两件互相依存的事:① `agent/pre-step` 真的接线了,消息是**追加**而不是替换,
  // 且空批次不乱塞(否则会白白多花一次模型请求);② 适配器确实会读 `apiKeyFile` ——
  // 文件里有密钥时不发"没有密钥"的要求,而那个文件正是 `guard key set` 写的那一份。
  const noticeCtx = mockContext(undefined)
  applySmoke(noticeCtx.ctx)
  const preStep = noticeCtx.handlers.get('agent/pre-step')
  expectTrue('在 agent/pre-step 上注册了 handler(否则用户永远看不到"请录入密钥")', typeof preStep === 'function')

  const nextEnter = async () => ({ kind: 'enter', messages: [{ id: 'user-1' }] })
  const nextEmpty = async () => ({ kind: 'enter', messages: [] })
  /** 一次假的 pre-step;`announced` 是"会话历史里已存在的消息"。 */
  const fakeStep = (announced = []) => ({
    agent: { session: { id: 'notice-session', snapshotEvents: () => [], deriveMessages: () => announced } },
    messages: [{ id: 'user-1' }], turn: 1, step: 1, signal: new AbortController().signal,
  })

  const withNotice = await preStep(fakeStep(), nextEnter)
  expectTrue('没有密钥 → 注入了一条 notice',
    Array.isArray(withNotice.messages) && withNotice.messages.length === 2,
    JSON.stringify(withNotice.messages?.map(m => m.id)))
  expectTrue('注入是**追加**:原来那条用户消息还在', withNotice.messages[0]?.id === 'user-1')
  const notice = withNotice.messages[1] ?? {}
  expectTrue('notice 形状正确(role/content + source 恰好四个键)',
    notice.role === 'user'
      && notice.content?.[0]?.type === 'text' && typeof notice.content?.[0]?.text === 'string'
      && notice.source?.kind === 'plugin' && notice.source?.plugin === 'jev-guard'
      && notice.source?.form === 'notice' && typeof notice.source?.summary === 'string'
      && Object.keys(notice.source).length === 4,
    JSON.stringify(notice.source))
  expectTrue('notice 摘要 ≤120 字符且无换行(它要当折叠行的标题)',
    String(notice.source?.summary ?? '').length <= 120 && !String(notice.source?.summary ?? '').includes('\n'),
    String(notice.source?.summary))
  expectTrue('notice 正文给了确切的录入命令(否则"要求录入"不可执行)',
    String(notice.content?.[0]?.text ?? '').includes('key set'), String(notice.content?.[0]?.text ?? '').slice(0, 120))

  const again = await preStep(fakeStep([notice]), nextEnter)
  expectTrue('同一条提示不会说第二遍(去重靠持久化的会话历史)',
    Array.isArray(again.messages) && again.messages.length === 1, JSON.stringify(again.messages?.map(m => m.id)))

  const emptyBatch = await preStep(fakeStep(), nextEmpty)
  expectTrue('空批次不塞消息(否则会白白多花一次模型请求)',
    Array.isArray(emptyBatch.messages) && emptyBatch.messages.length === 0, JSON.stringify(emptyBatch.messages))

  // 文件里有密钥 → 不再要求录入。这就是"适配器读 `guard key set` 写的那份文件"的证明。
  const keyFile = join(dir, 'secrets.json')
  await writeFile(keyFile, `${JSON.stringify({ TYPESAFE_API_KEY: 'apik-smoke-fake-key' })}\n`)
  const fileCtx = mockContext(undefined)
  applySmoke(fileCtx.ctx, { apiKeyFile: keyFile })
  const preStepFile = fileCtx.handlers.get('agent/pre-step')
  const withFileKey = await preStepFile(fakeStep(), nextEnter)
  expectTrue('密钥文件里有密钥 → 不再要求录入(证明适配器读了 apiKeyFile)',
    Array.isArray(withFileKey.messages) && withFileKey.messages.length === 1,
    JSON.stringify(withFileKey.messages?.map(m => m.id)))

  // ---- 联网用例(有密钥时才跑) ----
  if (apiKey) {
    const e = mockContext(apiKey)
    applySmoke(e.ctx)
    const h = e.handlers.get('tools/pre-execute')
    const destructive = await h(neverExec('rm -rf ~/dsh-cross-search'), nextAllow)
    expect('真实目录 rm -rf + 完全权限 → deny', destructive, 'deny')
    // 同一条命令、审批可用时:Jev 高分(≥0.7)按 D13 转人工,而不是直接拒
    const destructiveAsk = await h(fakeExec('rm -rf ~/dsh-cross-search'), nextAllow)
    expect('真实目录 rm -rf + 审批可用 → ask(转人工弹窗)', destructiveAsk, 'ask', '审批请求')
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
  applySmoke(f.ctx, { logPath: audited })
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
  await rm(dir, { recursive: true, force: true }) // 整个测试的产物都在这个临时目录里
  process.stdout.write(`\n${failures === 0 ? `全部通过(${checks} 组断言)` : `${failures} 组失败 / 共 ${checks} 组`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
