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

import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, evaluateCommand } from '../lib/gate.js'
import { setLang } from '../lib/i18n.js'
import {
  KINDS, classifyFailure, clearDegraded, cooldownMs, enterDegraded, isDegraded, isSticky, kindScope, probeDue,
  readDegraded, statusText, warningLine,
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
  // `before`:让用例在"请求进行中"制造真实的环境故障(例如把状态文件换成目录,使随后的
  // unlink 真的失败)。只读文件系统造不出来,但它的**后果**可以这样逐字复现。
  if (typeof next.before === 'function') await next.before()
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    // content-type 是分辨"应用层鉴权失败"与"边缘拦截"最干净的信号,所以替身也得给。
    headers: { get: name => next.headers?.[String(name).toLowerCase()] ?? null },
    text: async () => next.body ?? '',
    json: async () => next.json ?? {},
  }
}

const httpError = (status, body = '', contentType = undefined) => {
  const e = new Error(`HTTP ${status}: ${body}`)
  e.status = status
  e.body = body
  if (contentType) e.contentType = contentType
  return e
}

/**
 * 边缘拦下时的真实形状(2026-09-23 现场观测):Cloudflare 的通用错误页 —— 403 + **HTML**,
 * 请求在边缘就被挡了,服务端连密钥都没看过。与"应用层鉴权失败"(401 + JSON)是两回事。
 */
const CF_403 = '<!DOCTYPE html><html class="no-js ie6 oldie" lang="en-US"><head><title>Attention Required! | Cloudflare</title></head>'
  + `<body><h1>Error code: 1020</h1><p>Access denied. cf-ray: 8f2c1d0e4b7a9c11</p></body></html>`

/** 应用层鉴权失败的真实形状(2026-09-20 实测):401 + JSON。 */
const AUTH_JSON = '{"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}'
const okAnswer = (p, usage) => ({ status: 200, json: { model: 'jev-1.13.0', answers: { destroys_data: { noul: p } }, ...(usage ? { usage } : {}) } })

// 1) 分类:能定就定,定不了就不降级(宁可少降级,不要误降级)
expect('402 → quota', classifyFailure(httpError(402, 'insufficient credits')).kind === 'quota')
expect('401(JSON)→ auth', classifyFailure(httpError(401, AUTH_JSON, 'application/json')).kind === 'auth')
expect('403(非 HTML 正文)→ auth', classifyFailure(httpError(403, 'forbidden')).kind === 'auth')
expect('403(JSON 鉴权错误)→ auth:正文是 JSON 就一定是应用发的', classifyFailure(httpError(403, AUTH_JSON, 'application/json')).kind === 'auth')
// 边缘/WAF 拦下(2026-09-23):同一个 403,来源不同、处置相反 —— 这三种形状都必须归 edge。
expect('403(Cloudflare HTML)→ edge', classifyFailure(httpError(403, CF_403, 'text/html; charset=UTF-8')).kind === 'edge')
expect('403(content-type 是 HTML,正文不典型)→ edge', classifyFailure(httpError(403, 'Forbidden', 'text/html')).kind === 'edge')
expect('401(边缘 HTML)→ 同样是 edge', classifyFailure(httpError(401, CF_403, 'text/html')).kind === 'edge')
expect('edge 不降级(一次边缘抖动不该换来 30 分钟全局失能)', KINDS.edge.degraded === false)
expect('429(纯限流)→ rate-limit', classifyFailure(httpError(429, 'slow down')).kind === 'rate-limit')
expect('429(含额度字样)→ quota', classifyFailure(httpError(429, 'quota exceeded')).kind === 'quota')
expect('500 → server', classifyFailure(httpError(500)).kind === 'server')
expect('503 → server', classifyFailure(httpError(503)).kind === 'server')
expect('超时 → timeout', classifyFailure(Object.assign(new Error('timed out'), { name: 'TimeoutError' })).kind === 'timeout')
expect('网络 → network', classifyFailure(new TypeError('fetch failed')).kind === 'network')
const noKey = Object.assign(new Error('no key'), { code: 'no-key' })
expect('无密钥 → no-key', classifyFailure(noKey).kind === 'no-key')
expect('未知 → unknown(不降级)', classifyFailure(new Error('???')) && !KINDS.unknown.degraded)

// 2) 会降级的类别,以及**两种降级方式**(2026-09-20,D15):
//    · quota / auth = 服务侧状况 → 冷却式:到期放一次探测;
//    · no-key = 本地配置状况 → **粘性**:没密钥时零 HTTP、没有可探测对象,所以靠"密钥出现"结束,
//      而且带作用域 —— 只压制写下它的那条入口(密钥解析各入口独立,degraded.json 却是全机共享)。
const degrading = Object.entries(KINDS).filter(([, v]) => v.degraded).map(([k]) => k).sort()
expect('会降级的类别 = auth / no-key / quota', degrading.join(',') === 'auth,no-key,quota', degrading.join(','))
expect('no-key 降级(没有效密钥必须像额度耗尽那样明说,而不是静默 fail-open)', KINDS['no-key'].degraded === true)
expect('no-key 是粘性的(不靠时间结束)', KINDS['no-key'].sticky === true && cooldownMs('no-key', {}) === 0)
expect('no-key 的作用域是本地(只压制写下它的入口)', KINDS['no-key'].scope === 'local' && kindScope('no-key') === 'local')
expect('quota / auth 的作用域是全局(服务侧状况影响所有入口)',
  kindScope('quota') === 'global' && kindScope('auth') === 'global' && KINDS.quota.scope === 'global')
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

// 9b) **边缘拦截与鉴权失败必须分开**(2026-09-23)。现场故障:同一条命令、同一把密钥,
//     403 + Cloudflare HTML 被旧规则一刀切成 auth → 30 分钟全局冷却 + 一句"密钥无效或被撤销",
//     而请求根本没到应用层。真正的鉴权失败长什么样,上面 401 + JSON 已经复现过了。
await clearDegraded(cfg)
script = [httpError(403, CF_403, 'text/html; charset=UTF-8')]
calls = []
const edgeBlocked = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined })
expect('403+HTML → fail-open(allow)', edgeBlocked.action === 'allow' && edgeBlocked.source === 'error', `${edgeBlocked.action}/${edgeBlocked.source}`)
expect('403+HTML → errorKind=edge(标签不再指向密钥)', edgeBlocked.errorKind === 'edge', String(edgeBlocked.errorKind))
expect('403+HTML → 判定上**没有** degraded 字段', edgeBlocked.degraded === undefined, JSON.stringify(edgeBlocked.degraded))
expect('403+HTML → 没有写出降级状态(= 没有那次 30 分钟冷却)', (await readDegraded(cfg)) === null)
// "没有冷却"的可观测后果:下一条命令照常联网判定。旧行为下这一条会变成 source=degraded 且零请求。
script = [okAnswer(0.1)]
calls = []
const afterEdge = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined })
expect('403+HTML 之后下一条命令照常判定(没有被按停)', afterEdge.source === 'jev' && calls.length === 1, `${afterEdge.source}/${calls.length}`)

// 9c) 反向:同一个状态码配 JSON 正文 = 应用层鉴权失败,**照旧降级**。
//     修掉误判不能顺手把真问题也放过 —— 那才是"密钥无效或被撤销"该说的话。
await clearDegraded(cfg)
script = [httpError(403, AUTH_JSON, 'application/json')]
calls = []
const app403 = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined })
expect('403+JSON → 仍是 auth,而且降级', app403.errorKind === 'auth' && (await readDegraded(cfg))?.kind === 'auth',
  `${app403.errorKind}/${(await readDegraded(cfg))?.kind}`)
expect('403+JSON → 那条状态确实是 auth 的 30 分钟', cooldownMs('auth', {}) === 30 * 60 * 1000)

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

// 12b) 清除的三种结果必须分开报(2026-09-23):清掉了 / 本来就没有 / **清不掉**。
//      旧版把后两者都返回 false,于是"只读文件系统"这类真实故障被报成"当前没有降级状态",
//      状态文件还在,人却以为已经清了。这里用一个目录冒充状态文件 —— unlink 一个目录必定失败
//      (EISDIR / EPERM),与现场那个 EROFS 同类:非 ENOENT 的失败必须把 errno 交出来。
const nothing = await clearDegraded(cfg)
expect('本来就没有状态文件 → ok=true / removed=false(这是成功,不是故障)', nothing.ok === true && nothing.removed === false, JSON.stringify(nothing))
await enterDegraded('quota', { cfg })
const oneRemoved = await clearDegraded(cfg)
expect('确实删掉了一个 → ok=true / removed=true', oneRemoved.ok === true && oneRemoved.removed === true, JSON.stringify(oneRemoved))
const asDir = join(dir, 'degraded-as-dir')
await mkdir(asDir, { recursive: true })
const clearFailed = await clearDegraded({ degradedPath: asDir })
expect('清不掉 → ok=false 且报出 errno(不再谎报"无需清除")',
  clearFailed.ok === false && typeof clearFailed.code === 'string' && clearFailed.code !== 'ENOENT', JSON.stringify(clearFailed))

// 12c) 冷却已过期时的那句告警**不能说"暂停 0 分钟"**(2026-09-23)—— 它既自相矛盾,
//      又会在"状态文件删不掉"那种永远过期的处境下被每条 CLI 命令念一遍。
const expiredState = {
  kind: 'quota', label: '判定服务额度已用尽', since: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  until: Date.now() - 1000, cooldownMs: 900000, failures: 1, probes: 0, policy: 'l0-only', path: cfg.degradedPath,
}
const expiredWarn = warningLine(expiredState)
expect('冷却已过期的告警不再说"暂停 0 分钟"', !expiredWarn.includes('暂停 0 分钟'), expiredWarn)
expect('冷却已过期的告警改说"下一条命令会放一次探测"',
  expiredWarn.includes('下一条命令') && expiredWarn.includes('探测'), expiredWarn)
// 仍在窗口内的一侧不能被顺手改坏:它还该报剩余分钟数。
const inWindowWarn = warningLine({ ...expiredState, until: Date.now() + 12 * 60 * 1000 })
expect('仍在冷却窗口内 → 照旧报剩余分钟数', inWindowWarn.includes('暂停 12 分钟'), inWindowWarn)

// 13) **没有密钥 → 粘性降级**(D15):一次 HTTP 都不发,而且不靠时间结束
script = []
calls = []
await clearDegraded(cfg)
const noKeyVerdict = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: undefined, cache: undefined, scope: 'cli' })
expect('没有密钥 → 仍然 fail-open(allow)但带着分类', noKeyVerdict.action === 'allow' && noKeyVerdict.errorKind === 'no-key',
  `${noKeyVerdict.action}/${noKeyVerdict.errorKind}`)
expect('没有密钥 → 一次请求都没发(没有可花钱的东西)', calls.length === 0, String(calls.length))
expect('没有密钥 → 判定上带着粘性告警', String(noKeyVerdict.warning ?? '').includes('条件消失'), String(noKeyVerdict.warning))
const nk = await readDegraded(cfg)
expect('没有密钥 → 写出了降级状态', nk !== null && nk.kind === 'no-key', String(nk?.kind))
expect('没有密钥 → 状态里记了粘性与入口身份', isSticky(nk) === true && nk.scope === 'cli', JSON.stringify({ sticky: nk?.sticky, scope: nk?.scope }))
const farFuture = nk.until + 24 * 3600 * 1000
expect('粘性不靠时间:一天之后仍然是降级', isDegraded(nk, farFuture, 'cli') === true)
expect('粘性永不探测(没有可探测对象)', probeDue(nk, farFuture, 'cli') === false)
expect('粘性告警不说"等 N 分钟"(它不等时间)', !warningLine(nk).includes('分钟'), warningLine(nk))
expect('粘性状态报告写明"当场自动恢复"', statusText(nk).includes('当场自动恢复'), statusText(nk).split('\n')[3] ?? '')
expect('粘性状态报告说明影响范围仅本入口', statusText(nk).includes('cli'), statusText(nk))
calls = []
const stillNoKey = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: undefined, cache: undefined, scope: 'cli' })
expect('粘性窗口内 → 直接放行,不再去撞密钥', stillNoKey.source === 'degraded' && calls.length === 0, `${stillNoKey.source}/${calls.length}`)

// 14) **作用域隔离**:某条入口读不到密钥,不该把密钥正常的其它入口按停
await clearDegraded(cfg)
await enterDegraded('no-key', { cfg, scope: 'cli' })
const scoped = await readDegraded(cfg)
expect('CLI 的 no-key 状态对自己生效', isDegraded(scoped, Date.now(), 'cli') === true)
expect('CLI 的 no-key 状态**不**压制 DSH 侧', isDegraded(scoped, Date.now(), 'dsh-adapter') === false)
expect('CLI 的 no-key 状态对 DSH 侧也不算探测到期', probeDue(scoped, Date.now(), 'dsh-adapter') === false)
script = [okAnswer(0.9)]
calls = []
const otherEntry = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined, scope: 'dsh-adapter' })
expect('别的入口照常判定(没有被按停)', otherEntry.source === 'jev' && calls.length === 1, `${otherEntry.source}/${calls.length}`)
// 服务侧状态相反:quota 描述的是"服务坏了",它对每条入口都成立,所以是全局的。
await clearDegraded(cfg)
await enterDegraded('quota', { cfg })
const globalState = await readDegraded(cfg)
expect('服务侧(quota)状态压制所有入口',
  isDegraded(globalState, Date.now(), 'cli') === true && isDegraded(globalState, Date.now(), 'dsh-adapter') === true)
expect('服务侧状态的作用域记为 global', globalState.scope === 'global', String(globalState.scope))

// 15) **密钥一出现 → 粘性状态当场清除**(不重启、不等冷却)
await clearDegraded(cfg)
await enterDegraded('no-key', { cfg, scope: 'cli' })
expect('铺垫:粘性 no-key 状态在位', (await readDegraded(cfg))?.kind === 'no-key')
script = [okAnswer(0.9)]
calls = []
const revived = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: undefined, scope: 'cli' })
expect('密钥出现 → 恢复成正常判定', revived.source === 'jev' && revived.action === 'block', `${revived.source}/${revived.action}`)
expect('密钥出现 → 状态文件当场清掉', (await readDegraded(cfg)) === null)
expect('密钥出现 → 只花了一次请求(没有多余探测)', calls.length === 1, String(calls.length))

// 16) **探测成功、但状态文件删不掉**(只读文件系统 / 权限不足)—— 2026-09-23。
//     这是"状态文件是唯一持久记忆"的另一面:删不掉的时候谁也改不动它,于是每条命令重读它都会
//     得到"探测到期" → 每条命令都被当成一次新探测,审计里反复写 probe/recovered。现在要求:
//     ① 那次判定带着 clearFailed(含 errno)与一句告警;② 本进程内不再据这份过期状态判断;
//     ③ 而**新落盘的**状态照常生效 —— 记忆不许吃掉一次真实的降级。
const stuckDir = join(dir, 'stuck')
await mkdir(stuckDir, { recursive: true })
const stuckCfg = { degradedPath: join(stuckDir, 'degraded.json') }
// 只读文件系统下这份文件是**逐字节不变**的,所以两次写入用同一个字符串(也正因此 `until` 相同,
// 才能测出"同一份状态"被认出来)。
const STUCK_STATE = `${JSON.stringify({
  kind: 'quota', label: '判定服务额度已用尽', since: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  until: new Date(Date.now() - 60 * 1000).toISOString(), cooldownMs: 900000, failures: 1, probes: 0, policy: 'l0-only',
})}\n`
await writeFile(stuckCfg.degradedPath, STUCK_STATE)
// 在探测请求"进行中"把状态文件换成一个目录:随后的 unlink 必定失败(EISDIR / EPERM),
// 而"读"已经发生过了 —— 这正是只读文件系统下的处境,且两个平台都能造出来。
script = [{
  ...okAnswer(0.2),
  before: async () => {
    await rm(stuckCfg.degradedPath, { force: true })
    await mkdir(stuckCfg.degradedPath, { recursive: true })
  },
}]
calls = []
const stuckProbe = await evaluateCommand(CMD, { ...DEFAULTS, ...stuckCfg, apiKey: 'x', cache: undefined })
expect('探测成功+文件清不掉 → 判定照旧成立(服务确实回来了)',
  stuckProbe.source === 'jev' && stuckProbe.probe === true, `${stuckProbe.source}/${stuckProbe.probe}`)
expect('探测成功+文件清不掉 → 判定上带 clearFailed 与 errno',
  typeof stuckProbe.clearFailed?.code === 'string' && stuckProbe.clearFailed.code !== 'ENOENT', JSON.stringify(stuckProbe.clearFailed))
expect('探测成功+文件清不掉 → 告警直说清不掉,而不是沉默',
  String(stuckProbe.warning ?? '').includes('删不掉'), String(stuckProbe.warning).slice(0, 50))
// 把文件恢复成同一份"已过期"状态:文件还在、窗口过期,而下一条命令不该再被当成一次探测。
await rm(stuckCfg.degradedPath, { recursive: true, force: true })
await writeFile(stuckCfg.degradedPath, STUCK_STATE)
script = [okAnswer(0.1)]
calls = []
const afterStuck = await evaluateCommand(CMD, { ...DEFAULTS, ...stuckCfg, apiKey: 'x', cache: undefined })
expect('清不掉之后 → 下一条命令不再被当成一次新探测(这是这次的修复点)',
  afterStuck.source === 'jev' && afterStuck.probe === undefined, `${afterStuck.source}/${afterStuck.probe}`)
expect('清不掉之后 → 不再反复记 recovered', afterStuck.recovered === undefined, String(afterStuck.recovered))
expect('清不掉之后 → 该花的那次请求照花(命令仍被完整判定)', calls.length === 1, String(calls.length))
// ③ 记忆只压制"同一份或更老"的窗口:真有一份新状态落盘(只读可能只是暂时的),它照常生效。
await writeFile(stuckCfg.degradedPath, `${JSON.stringify({
  kind: 'quota', label: '判定服务额度已用尽', since: new Date().toISOString(),
  until: new Date(Date.now() + 15 * 60 * 1000).toISOString(), cooldownMs: 900000, failures: 1, probes: 0, policy: 'l0-only',
})}\n`)
script = []
calls = []
const newerState = await evaluateCommand(CMD, { ...DEFAULTS, ...stuckCfg, apiKey: 'x', cache: undefined })
expect('有更新的状态落盘 → 照常降级(记忆不吃掉真实的降级)',
  newerState.source === 'degraded' && calls.length === 0, `${newerState.source}/${calls.length}`)
await rm(stuckDir, { recursive: true, force: true })

// 17) **缓存里放的是判定本身,不是那一次调用的附带信息**(2026-09-23)。
//     回放 `usage` 的代价是实测出来的:一次真实调用(700 input tokens)会被 `guard log --stats`
//     按缓存命中的次数重复计价(实测 1 次调用 → 2 条计价记录、1400 tokens、成本翻倍);
//     回放 `probe`/`recovered` 则会让一条 `source: cache` 的记录自称"这次是一次探测"。
const cache = new Map() // VerdictCache 的接口就是 get/set,自检用普通 Map 即可
await clearDegraded(cfg)
script = [okAnswer(0.9, { input_tokens: 700, output_tokens: 20 })]
calls = []
const judged = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache })
const reused = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache })
expect('同一进程内第二次 → 缓存命中,不再发请求', reused.source === 'cache' && calls.length === 1, `${reused.source}/${calls.length}`)
expect('首次判定带着真实用量(不能被抹掉)', judged.usage?.input_tokens === 700, JSON.stringify(judged.usage))
expect('缓存命中不带 usage(否则成本被重复计价)', reused.usage === undefined, JSON.stringify(reused.usage))
expect('缓存命中仍带着判定本身(p / action / 模型)',
  reused.p === 0.9 && reused.action === 'block' && reused.model === 'jev-1.13.0', `${reused.p}/${reused.action}`)
// 探测的标记同样不该被回放:同一条命令再来一次,它只是缓存命中,不是探测。
await seedExpired(1)
script = [okAnswer(0.9)]
calls = []
const probeCache = new Map()
const probed = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: probeCache })
const probeReused = await evaluateCommand(CMD, { ...DEFAULTS, ...cfg, apiKey: 'x', cache: probeCache })
expect('铺垫:第一次确实是探测', probed.probe === true && probed.recovered === true,
  JSON.stringify({ probe: probed.probe, recovered: probed.recovered }))
expect('缓存命中不再自称探测(记录不能写没发生的事)',
  probeReused.source === 'cache' && probeReused.probe === undefined && probeReused.recovered === undefined,
  `${probeReused.source}/${probeReused.probe}/${probeReused.recovered}`)

await rm(dir, { recursive: true, force: true })
process.stdout.write(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}(${checks} 例)\n`)
process.exit(failed === 0 ? 0 : 1)
