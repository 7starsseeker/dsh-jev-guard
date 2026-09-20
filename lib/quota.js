/**
 * 额度与降级 —— 付费判定 API 一定会用完,用完以后阀门必须**变安静,但不装死**。
 *
 * 背景与设计取舍:
 *
 * 1. **额度耗尽不是异常,是必然。** 这是一个收费 API,`HTTP 402` / 余额不足 / 密钥被撤销
 *    迟早会发生。旧行为是"每次调用各自 fail-open 并写一条 `source: error`" —— 功能上没错,
 *    但有三个问题:①每个命令都要打一次注定失败的请求(慢);②日志里堆满 error 记录,
 *    看不出"是偶发抖动还是已经彻底不可用";③**没有任何人会发现它在瞎**。
 *
 * 2. **所以状态是持久的、可读的、有失效时间的。** 一旦判定失败属于"持久性"类
 *    (`quota` / `auth` / `no-key`),就写一份 `<JEV_GUARD_HOME>/degraded.json`,
 *    在冷却窗口内**不再发请求**(省钱、省时间),窗口到期后放**一次**探测请求过去:
 *      · 探测成功 → 自动恢复(不需要人做任何事);
 *      · 探测失败 → 继续降级(失败一次只花一次请求,不会每命令都试)。
 *
 * 3. **降级不等于整条阀门失效。** 默认 `degradePolicy: 'l0-only'` —— 免费的 L0 静态规则
 *    与预筛照常工作,停的只是"要花钱联网"的 L1 语义层。这不是自作主张:那一层不花钱、
 *    不联网、确定性强,正好覆盖最坏的一类(`mkfs` / `dd of=/dev/*` / `git push --force`)。
 *    想连它一起停,设 `degradePolicy: 'off'`。
 *
 * 4. **瞬态失败不降级。** 超时 / 网络抖 / 5xx / 429 只是这一次不通,不该把阀门按下去 15 分钟;
 *    它们照旧逐次 fail-open,但**会被分类记录**,于是 `guard log --stats` 能回答
 *    "今天 fail-open 了几次、各是什么原因"。
 *
 * @module jev-guard/quota
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HOME_DIR } from './audit.js'
import { t } from './i18n.js'

/** 降级状态文件;`JEV_GUARD_DEGRADED_STATE` 可覆盖(测试/多实例用)。 */
export const DEFAULT_DEGRADED_PATH = process.env.JEV_GUARD_DEGRADED_STATE ?? join(HOME_DIR, 'degraded.json')

/**
 * 失败分类表 —— **只放判定用的东西**。
 *
 * `degraded: true` 的类别 = "这不是抖一下,是人得处理点什么" → 写状态、停联网判定。
 * `cooldownMs` 既是"停止发请求"的时长,也是"下次探测"的间隔。
 *
 * 给人看的 label / hint 不在这里,在 `lib/i18n.js` 的 `quota.<kind>.label|hint`
 * (以前这里还挂着一组 `cliHints`,从头到尾没有任何调用方读取 —— 2026-09-20 清掉,
 * 免得它成为一份不受 i18n 覆盖的隐藏文案)。
 */
export const KINDS = Object.freeze({
  quota: Object.freeze({ degraded: true, cooldownMs: 15 * 60 * 1000 }),
  auth: Object.freeze({ degraded: true, cooldownMs: 30 * 60 * 1000 }),
  // ⚠️ 刻意**不降级**(与 auth 相对):"没解析到密钥"是**本地配置**状况,不是服务状况。
  //   · 它一次 HTTP 都不发 → 降级省不下任何东西;
  //   · 它可能是**某一条入口**的问题(密钥解析各入口独立:DSH 插件走 ctx.credentials,
  //     CLI 与离线脚本走环境变量或文件),而 degraded.json 是**全局共享**的文件 —— 一旦某条
  //     入口因为 cwd 不对读不到密钥就写一份 no-key 降级,会把**密钥其实是好的**其它入口
  //     一起按停 30 分钟。那是"一个局部问题造成全局失能",比它想解决的问题更糟。
  //   所以:分类照记、告警照发(`guard status` 会直接说没解析到密钥),但不进降级态。
  'no-key': Object.freeze({ degraded: false, cooldownMs: 0 }),
  'rate-limit': Object.freeze({ degraded: false, cooldownMs: 60 * 1000 }),
  server: Object.freeze({ degraded: false, cooldownMs: 30 * 1000 }),
  timeout: Object.freeze({ degraded: false, cooldownMs: 0 }),
  network: Object.freeze({ degraded: false, cooldownMs: 0 }),
  shape: Object.freeze({ degraded: false, cooldownMs: 0 }),
  unknown: Object.freeze({ degraded: false, cooldownMs: 0 }),
})

/**
 * 一个类别的可读名字(当前语言)。
 * @param kind - 分类名。
 * @returns 给人看的一行;未知类别原样回显分类名。
 */
export function kindLabel(kind) {
  const key = `quota.${kind}.label`
  return t(key) === key ? String(kind ?? '') : t(key)
}

/**
 * 一个类别的处置建议(当前语言)。
 * @param kind - 分类名。
 * @returns 一行建议;未知类别退回 `unknown` 的建议。
 */
export function kindHint(kind) {
  const key = `quota.${kind}.hint`
  return t(key) === key ? t('quota.unknown.hint') : t(key)
}

/** 会触发"降级状态"的分类。 */
export const DEGRADING_KINDS = Object.freeze(Object.keys(KINDS).filter(k => KINDS[k].degraded))

/**
 * 按失败类别返回冷却时长(可被配置覆盖)。
 * @param kind - 分类名。
 * @param cfg - 可选 `{ quotaCooldownMs, authCooldownMs }`。
 * @returns 毫秒。
 */
export function cooldownMs(kind, cfg = {}) {
  if (kind === 'quota') return Number(cfg.quotaCooldownMs ?? KINDS.quota.cooldownMs)
  if (kind === 'auth' || kind === 'no-key') return Number(cfg.authCooldownMs ?? KINDS.auth.cooldownMs)
  return Number(KINDS[kind]?.cooldownMs ?? 0)
}

/**
 * 把人话/异常翻译成分类。
 *
 * 为什么用关键词兜底:额度耗尽的 HTTP 形状各家不同(有 402,也有 429 + "insufficient credits"),
 * 我们**不能假设**自己猜对了。所以规则是:状态码能定就定;定不了就看正文关键词;
 * 还定不了就是 `unknown`(不降级,只逐次放行并留痕)。宁可少降级,不要误降级 —— 误降级会让
 * 阀门在额度充足时也停止防护。
 *
 * @param error - 抛出的异常(带 `status` / `code` / `name` / `message`)。
 * @returns `{ kind, status?, detail }`。
 */
export function classifyFailure(error) {
  const status = Number(error?.status) || undefined
  const code = typeof error?.code === 'string' ? error.code : undefined
  const name = String(error?.name ?? '')
  const text = `${code ?? ''} ${error?.body ?? ''} ${error?.message ?? ''}`.toLowerCase()
  const detail = String(error?.message ?? error).slice(0, 300)

  if (code === 'no-key') return { kind: 'no-key', detail }
  if (code === 'shape') return { kind: 'shape', detail }
  if (status === 402) return { kind: 'quota', status, detail }
  if (status === 401 || status === 403) return { kind: 'auth', status, detail }
  if (status === 429) {
    // 429 有两种含义:限流(等一下就好)与额度耗尽(得充钱)。正文能区分才降级。
    return { kind: /quota|credit|insufficient|balance|payment|billing|exceed/.test(text) ? 'quota' : 'rate-limit', status, detail }
  }
  if (status !== undefined && status >= 500) return { kind: 'server', status, detail }
  if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout', detail }
  if (/quota|credit|insufficient|balance|payment|billing/.test(text)) return { kind: 'quota', status, detail }
  if (/enotfound|econnrefused|econnreset|etimedout|fetch failed|network|socket/.test(text)) return { kind: 'network', detail }
  return { kind: 'unknown', status, detail }
}

/**
 * 解析降级状态文件路径(空串/纯空白 = 未配置 → 默认路径,与 audit 的教训一致)。
 * @param options - `{ degradedPath }`。
 * @returns 实际路径。
 */
export function resolveDegradedPath(options = {}) {
  const configured = options?.degradedPath
  return typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_DEGRADED_PATH
}

/**
 * 读降级状态。**任何异常都当作"没有降级"**(读不出来时宁可去问一次 API,也不要卡在降级态)。
 *
 * 校验必须走 `untilMs()` 而不是 `Number(until)`:`until` 存的是 ISO 字符串,`Number()` 对它
 * 恒为 NaN,于是"写进去了却永远读不出来"。本模块第一版就是这样 —— 不抛异常、不报错,
 * 只是整个降级机制静默失效(冒烟测试当场抓到)。
 *
 * @param options - `{ degradedPath }`。
 * @returns 状态对象,或 null。
 */
export async function readDegraded(options = {}) {
  const path = resolveDegradedPath(options)
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string') return null
    const until = untilMs(raw)
    if (!Number.isFinite(until)) return null
    // 归一成毫秒数,调用方不必再关心存的是字符串还是数字。
    return { ...raw, until, path }
  } catch {
    return null
  }
}

/**
 * 进入(或续期)降级状态。
 * @param kind - 失败分类。
 * @param options - `{ error, detail, status, cfg, now }`。
 * @returns 写入后的状态对象(即使写盘失败也返回,调用方照常降级)。
 */
export async function enterDegraded(kind, options = {}) {
  const now = Number(options.now ?? Date.now())
  const cfg = options.cfg ?? {}
  const path = resolveDegradedPath(cfg)
  const cooldown = cooldownMs(kind, cfg)
  const previous = await readDegraded(cfg)
  const sameKind = previous?.kind === kind
  const state = {
    kind,
    // 落盘的 label 只是给"人肉读 degraded.json"用的快照;**显示**一律现查 kindLabel(),
    // 否则语言一换,旧文件里另一种语言的标签会被原样打印出来。
    label: kindLabel(kind) || kind,
    since: sameKind ? previous.since : new Date(now).toISOString(),
    until: new Date(now + cooldown).toISOString(),
    cooldownMs: cooldown,
    failures: (sameKind ? Number(previous.failures ?? 0) : 0) + 1,
    probes: Number(previous?.probes ?? 0) + (options.probe ? 1 : 0),
    status: options.status,
    detail: String(options.detail ?? options.error ?? '').slice(0, 300),
    policy: cfg.degradePolicy ?? 'l0-only',
    at: new Date(now).toISOString(),
  }
  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
    await rename(tmp, path)
  } catch {
    // 写不进去也要降级(内存里这次仍然按降级处理),只是下次可能会再试一次 API。
  }
  // 与 readDegraded 保持同一形状:`until` 对外一律是毫秒数(存储里是 ISO,便于人肉阅读)。
  return { ...state, until: now + cooldown, path }
}

/**
 * 清除降级状态(探测成功后自动调用;也可由 `guard status --clear` 手动调用)。
 * @param options - `{ degradedPath }`。
 * @returns true = 确实清掉了一个状态文件。
 */
export async function clearDegraded(options = {}) {
  const path = resolveDegradedPath(options)
  try {
    const { unlink } = await import('node:fs/promises')
    await unlink(path)
    return true
  } catch {
    return false
  }
}

/**
 * `until` 的毫秒表示(ISO 字符串;兼容直接存数字的老状态文件)。
 * @param state - 降级状态。
 * @returns 毫秒时间戳,或 NaN。
 */
function untilMs(state) {
  const raw = state?.until
  if (typeof raw === 'number') return raw
  return Date.parse(String(raw ?? ''))
}

/**
 * 现在是否处于降级窗口内。
 * @param state - readDegraded() 的结果。
 * @param now - 当前毫秒时间戳。
 * @returns true = 应当跳过联网判定。
 */
export function isDegraded(state, now = Date.now()) {
  if (!state) return false
  const until = untilMs(state)
  return Number.isFinite(until) ? until > now : false
}

/**
 * 降级窗口是否已到期(= 下一次调用可以作为探测请求)。
 * @param state - readDegraded() 的结果。
 * @param now - 当前毫秒时间戳。
 * @returns true = 放一次探测请求。
 */
export function probeDue(state, now = Date.now()) {
  if (!state) return false
  const until = untilMs(state)
  return Number.isFinite(until) ? until <= now : true
}

/**
 * 距离自动探测还有多少毫秒。
 * @param state - 降级状态。
 * @param now - 当前时间。
 * @returns 毫秒(最小 0)。
 */
export function retryInMs(state, now = Date.now()) {
  const until = untilMs(state)
  return Number.isFinite(until) ? Math.max(0, until - now) : 0
}

/**
 * 一行告警文本(会出现在拒绝理由、CLI 输出、审计记录里)。
 * @param state - 降级状态。
 * @param now - 当前时间。
 * @returns 单行文本。
 */
export function warningLine(state, now = Date.now()) {
  if (!state) return ''
  const mins = Math.round(retryInMs(state, now) / 60000)
  return t('quota.warning', {
    label: kindLabel(state.kind) || state.label,
    since: String(state.since ?? '').slice(11, 19),
    failures: state.failures,
    mins,
    policy: t(state.policy === 'off' ? 'quota.policy.off' : 'quota.policy.l0-only'),
  })
}

/**
 * 多行状态报告(`guard status` 与适配器的日志都用它)。
 * @param state - 降级状态,或 null(健康)。
 * @param now - 当前时间。
 * @param extra - `{ judgeUrl, apiKeyPresent }` 之类的补充信息。
 * @returns 可直接打印的文本。
 */
export function statusText(state, now = Date.now(), extra = {}) {
  if (!state) {
    return [
      t('quota.status.ok'),
      t('quota.status.ok.layers'),
      extra.apiKeyPresent === false ? t('quota.status.ok.noKey') : '',
    ].filter(Boolean).join('\n')
  }
  const mins = Math.round(retryInMs(state, now) / 60000)
  return [
    t('quota.status.degraded.title', { kind: state.kind }),
    t('quota.status.degraded.reason', { label: kindLabel(state.kind) || state.label }),
    t('quota.status.degraded.counters', { since: state.since, failures: state.failures, probes: state.probes ?? 0 }),
    t('quota.status.degraded.recovery', { mins }),
    t('quota.status.degraded.now', {
      now: t(state.policy === 'off' ? 'quota.status.degraded.now.off' : 'quota.status.degraded.now.l0-only'),
    }),
    t('quota.status.degraded.action', { hint: kindHint(state.kind) }),
    state.detail ? t('quota.status.degraded.detail', { detail: state.detail }) : '',
    t('quota.status.degraded.retry'),
  ].filter(Boolean).join('\n')
}
