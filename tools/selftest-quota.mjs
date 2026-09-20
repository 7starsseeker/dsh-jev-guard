#!/usr/bin/env node
/**
 * 额度降级自检 —— 离线,靠替身 `fetch` 模拟各种失败。
 *
 * 为什么这份自检重要:这里测的全是"出问题时的行为",而**出问题时的静默失效**是这个项目
 * 已经踩过的坑(审计日志那一次整整白跑一轮)。所以每个断言都在问同一个问题:
 * "额度/密钥坏掉以后,人还能不能发现,以及阀门还剩哪一层在工作?"
 *
 * 全部用临时目录与显式路径,不碰 `~/.jev-guard`,不联网。
 *
 * @module jev-guard/tools/selftest-quota
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, evaluateCommand } from '../lib/gate.js'
import { setLang } from '../lib/i18n.js'
import {
  KINDS, classifyFailure, clearDegraded, enterDegraded, isDegraded, probeDue, readDegraded, statusText, warningLine,
} from '../lib/quota.js'
import { explain } from '../lib/verdict.js'

// 下面的断言读的是中文文案(告警行、状态报告),先把语言钉死;英文侧见 selftest-i18n。
setLang('zh-CN')

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

const dir = await mkdtemp(join(tmpdir(), 'jev-guard-quota-'))
const cfg = { degradedPath: join(dir, 'degraded.json') }

/** 一条会走联网判定的命令(不在 L0、也不是只读预筛)。 */
const CMD = 'rm -rf /home/user/jev-guard-demo'

/** 替身 fetch:按脚本依次返回响应或抛错,并记录调用次数。 */
let calls = []
let script = []
globalThis.fetch = async () => {
  calls.push(1)
  const next = script.shift()
  if (next === undefined) throw new Error('fetch called more times than scripted')
  if (next instanceof Error) throw next
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    text: async () => next.body ?? '',
    json: async () => next.json ?? {},
  }
}

const httpError = (status, body = '') => {
  const e = new Error(`HTTP ${status}: ${body}`)
  e.status = status
  e.body = body
  return e
}
const okAnswer = (p, usage) => ({ status: 200, json: { model: 'jev-1.13.0', answers: { destroys_data: { noul: p } }, ...(usage ? { usage } : {}) } })

// 1) 分类:能定就定,定不了就不降级(宁可少降级,不要误降级)
expect('402 → quota', classifyFailure(httpError(402, 'insufficient credits')).kind === 'quota')
expect('401 → auth', classifyFailure(httpError(401, 'bad key')).kind === 'auth')
expect('403 → auth', classifyFailure(httpError(403, 'forbidden')).kind === 'auth')
expect('429(纯限流)→ rate-limit', classifyFailure(httpError(429, 'slow down')).kind === 'rate-limit')
expect('429(含额度字样)→ quota', classifyFailure(httpError(429, 'quota exceeded')).kind === 'quota')
expect('500 → server', classifyFailure(httpError(500)).kind === 'server')
expect('503 → server', classifyFailure(httpError(503)).kind === 'server')
expect('超时 → timeout', classifyFailure(Object.assign(new Error('timed out'), { name: 'TimeoutError' })).kind === 'timeout')
expect('网络 → network', classifyFailure(new TypeError('fetch failed')).kind === 'network')
const noKey = Object.assign(new Error('no key'), { code: 'no-key' })
expect('无密钥 → no-key', classifyFailure(noKey).kind === 'no-key')
expect('未知 → unknown(不降级)', classifyFailure(new Error('???')) && !KINDS.unknown.degraded)

// 2) 只有 quota / auth 会降级。`no-key` 刻意**不**降级 —— 它是本地配置状况、零 HTTP 成本,
//    而 degraded.json 是**全局共享**的:某个适配器读不到密钥不该把密钥正常的其它适配器按停。
const degrading = Object.entries(KINDS).filter(([, v]) => v.degraded).map(([k]) => k).sort()
expect('会降级的类别 = auth / quota', degrading.join(',') === 'auth,quota', degrading.join(','))
expect('no-key 不降级', KINDS['no-key'].degraded === false)
expect('rate-limit / server / timeout / network 也都不降级',
  !KINDS['rate-limit'].degraded && !KINDS.server.degraded && !KINDS.timeout.degraded && !KINDS.network.degraded)

// 3) 额度耗尽:这次判定 fail-open,并且**留下可读状态**
script = [httpError(402, 'insufficient credits')]
calls = []
const first = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined, quotaGuard: true })
expect('402 → 判定仍是 allow(fail-open)', first.action === 'allow' && first.source === 'error', `${first.action}/${first.source}`)
expect('402 → 带上分类 errorKind=quota', first.errorKind === 'quota', String(first.errorKind))
expect('402 → 判定上带着降级信息', first.degraded?.kind === 'quota')
expect('402 → 判定上带着一句告警', typeof first.warning === 'string' && first.warning.includes('降级'))
expect('402 → 确实发了一次请求', calls.length === 1, String(calls.length))
const state = await readDegraded(cfg)
expect('402 → 写出了降级状态文件', state !== null && state.kind === 'quota')
expect('402 → 状态里有恢复时间与失败次数', Number.isFinite(state.until) && state.failures === 1)
expect('402 → 状态文件里是人可读的 ISO 时间', typeof JSON.parse(await readFile(cfg.degradedPath, 'utf8')).until === 'string')

// 4) 降级窗口内:不再发请求、直接放行、并告诉调用方为什么
script = []
calls = []
const second = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined })
expect('降级窗口内 → source=degraded', second.source === 'degraded', String(second.source))
expect('降级窗口内 → 完全没有发请求(省钱)', calls.length === 0, String(calls.length))
expect('降级窗口内 → allow', second.action === 'allow')
expect('降级窗口内 → 理由里说明"没经过语义判定"', explain(CMD, second).includes('降级'), explain(CMD, second).slice(0, 80))
// 这条单独立着:降级放行曾经复用预筛的文案("确定性预筛"),读者会以为它被确认过无害。
expect('降级放行的理由不说"确定性预筛"', !explain(CMD, second).includes('确定性预筛'), explain(CMD, second).slice(0, 80))
expect('降级放行的理由明确说未经过语义判定', explain(CMD, second).includes('未经过语义判定'))

// 5) **免费的 L0 照常工作**(默认策略的核心承诺)
calls = []
const l0 = await evaluateCommand('mkfs.ext4 /dev/sdb1', { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined })
expect('降级期间 L0 deny 仍然拦(免费层没停)', l0.action === 'block' && l0.source === 'static-rule', `${l0.action}/${l0.source}`)
expect('降级期间 L0 判定也带着降级信息', l0.degraded?.kind === 'quota')
expect('降级期间 L0 判定不发请求', calls.length === 0, String(calls.length))
const l0ask = await evaluateCommand('truncate -s 0 /tmp/x.txt', { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined })
expect('降级期间 L0 ask 仍然要求人工确认', l0ask.action === 'escalate' && l0ask.source === 'static-rule', `${l0ask.action}`)
const fast = await evaluateCommand('ls -la /var/log', { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined })
expect('降级期间预筛仍然放行只读命令', fast.source === 'prefilter')

// 6) degradePolicy:'off' = 连 L0 一起暂停(显式选择,不是默认)
const off = await evaluateCommand('mkfs.ext4 /dev/sdb1', { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined, degradePolicy: 'off' })
expect("degradePolicy:'off' → 连 L0 也放行", off.action === 'allow' && off.source === 'degraded', `${off.action}/${off.source}`)

// 7) 冷却到期 → 放**一次**探测;成功即自动恢复(不需要人做任何事)
//
// 种一个"已到期"的状态时**直接写文件**,不用 enterDegraded() —— 后者正是被测对象的一部分,
// 用它来铺垫会污染 failures 计数(第一版就这么写,断言当场对不上)。
const seedExpired = async (failures = 1) => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(cfg.degradedPath, `${JSON.stringify({
    kind: 'quota', label: '判定服务额度已用尽', since: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    until: new Date(Date.now() - 60 * 1000).toISOString(), cooldownMs: 900000, failures, probes: 0, policy: 'l0-only',
  })}\n`)
}
await seedExpired(1)
const st = await readDegraded(cfg)
expect('冷却已到期 → probeDue', probeDue(st, Date.now()) === true)
script = [okAnswer(0.9, { input_tokens: 500, output_tokens: 20 })]
calls = []
const recovered = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined })
expect('探测成功 → 恢复成正常判定', recovered.source === 'jev' && recovered.action === 'block', `${recovered.source}/${recovered.action}`)
expect('探测成功 → 记录为 probe/recovered', recovered.probe === true && recovered.recovered === true, JSON.stringify({ probe: recovered.probe, recovered: recovered.recovered }))
expect('探测成功 → 降级状态被清掉', (await readDegraded(cfg)) === null)
expect('探测成功 → 拿到了 usage(成本可见性)', recovered.usage?.input_tokens === 500, JSON.stringify(recovered.usage))
expect('此时文件目录里没有残留 tmp 文件', (await readdir(dir)).every(f => !f.endsWith('.tmp')), (await readdir(dir)).join(','))

// 8) 探测失败 → 继续降级(而且不会每命令都试)
await seedExpired(1)
script = [httpError(402, 'still no credits')]
calls = []
const stillDown = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined })
expect('探测失败 → 仍然 fail-open', stillDown.action === 'allow' && stillDown.source === 'error')
expect('探测失败 → 判定上标记为一次探测', stillDown.probe === true)
const renewed = await readDegraded(cfg)
expect('探测失败 → 续期(failures 1 → 2,probes 0 → 1)', renewed.failures === 2 && renewed.probes === 1, JSON.stringify({ f: renewed.failures, p: renewed.probes }))
const afterProbe = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined })
expect('续期之后不再试(一次探测只花一次钱)', afterProbe.source === 'degraded' && calls.length === 1, `${afterProbe.source}/${calls.length}`)

// 9) 瞬态失败**不**降级(超时/网络/5xx 只逐次放行)
await clearDegraded(cfg)
script = [Object.assign(new Error('timed out'), { name: 'TimeoutError' })]
const transient = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined })
expect('超时 → fail-open 但不降级', transient.source === 'error' && transient.errorKind === 'timeout' && (await readDegraded(cfg)) === null)

// 10) 状态文件坏掉 → 当作健康(宁可去问一次 API,也不要卡在降级里)
const { writeFile } = await import('node:fs/promises')
await writeFile(cfg.degradedPath, '{ 这不是 JSON')
expect('损坏的状态文件 → readDegraded 返回 null', (await readDegraded(cfg)) === null)
script = [okAnswer(0.1)]
const afterCorrupt = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined })
expect('损坏状态下照常发请求', afterCorrupt.source === 'jev', String(afterCorrupt.source))

// 11) 告警与状态报告是给人看的,必须包含"原因/还剩多久/现在还剩哪一层"
await enterDegraded('quota', { cfg, detail: 'HTTP 402: insufficient credits' })
const warn = warningLine(await readDegraded(cfg))
expect('告警行含"降级"、类别与剩余时间', warn.includes('降级') && warn.includes('额度') && warn.includes('分钟'), warn)
const report = statusText(await readDegraded(cfg))
expect('状态报告含原因', report.includes('额度'))
expect('状态报告含恢复方式(自动探测)', report.includes('自动探测'))
expect('状态报告说明免费层仍在工作', report.includes('L0'))
expect('状态报告含原始错误', report.includes('402'))
const healthy = statusText(null, Date.now(), { apiKeyPresent: false })
expect('健康状态报告会指出"没有密钥"', healthy.includes('正常') && healthy.includes('没有解析到'))

// 12) 没有状态文件时,一切都是普通路径
await clearDegraded(cfg)
expect('清除后 isDegraded=false', isDegraded(await readDegraded(cfg)) === false)

await rm(dir, { recursive: true, force: true })
process.stdout.write(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}(${checks} 例)\n`)
process.exit(failed === 0 ? 0 : 1)
