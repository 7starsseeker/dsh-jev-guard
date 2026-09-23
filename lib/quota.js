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
 * 5. **两种降级:有对象可探测的,和没有的**(2026-09-20,见 docs/DECISIONS.md D15)。
 *    · `quota` / `auth` 是**服务侧**状况 → 冷却式:到期放一次探测请求,成功即自动恢复。
 *    · `no-key` 是**本地配置**状况 → **粘性**:没密钥时一次 HTTP 都不发,没有"可探测对象",
 *      所以它不靠时间结束,而是靠"密钥出现了"结束(见 gate.js 里读到密钥即自动清除)。
 *    两者都受**作用域**约束:`scope: 'global'` 的服务侧状态压制所有入口;
 *    `scope: 'local'` 的本地状态**只压制写下它的那个入口**。这正是"局部问题不该造成全局
 *    失能"的解法 —— 旧版本的做法是干脆不降级,代价是没人看得见(见 KINDS 里的长注释)。
 *
 * 6. **`403` 不一定是"我们的密钥坏了"**(2026-09-23,见 docs/DECISIONS.md D16)。401/403 里有
 *    一类响应根本不是那个 JSON 应用发的:CDN/WAF(常见 Cloudflare)在**边缘**就把请求拦了,
 *    回一个 HTML 错误页 —— 密钥连被看过都没有。旧行为把 `401 || 403` 一并归成 `auth`,
 *    于是一次边缘抖动换来 30 分钟全局失能,外加一个误导人的标签"密钥无效或被撤销"。
 *    现在分类器先问"这份响应像不像那个 API 发的",不像就归 `edge`:与第 4 条同一条规矩
 *    (瞬态、逐次 fail-open、只留一条分类痕迹),因为它描述的是"路上的机器",不是服务对我们的态度。
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
  quota: Object.freeze({ degraded: true, scope: 'global', cooldownMs: 15 * 60 * 1000 }),
  auth: Object.freeze({ degraded: true, scope: 'global', cooldownMs: 30 * 60 * 1000 }),
  // 边缘/WAF 拦下(403 或 401 配一个 HTML 错误页,见 classifyFailure 与 D16)。它**不降级**:
  // 那个 HTML 不是判定服务发的,所以它既没告诉我们密钥坏了、也没告诉我们额度没了 —— 它只说明
  // "这一次请求没走到"。按 `auth` 处理会让一次边缘抖动造成 30 分钟全局失能,而且把原因写错。
  // 与 timeout/network 同类:逐次 fail-open,只在 `guard log --stats` 里留下 edge 计数。
  edge: Object.freeze({ degraded: false, cooldownMs: 0 }),
  // "没解析到密钥"是**本地配置**状况,不是服务状况。它**也要降级**(没有效密钥时必须像
  // 额度耗尽那样明说,而不是每条命令静默 fail-open),但降级方式与服务侧相反:
  //   · `sticky: true` —— 一次 HTTP 都不发,没有可探测对象,所以不靠冷却到期结束,
  //     而是靠"密钥出现了"结束(gate.js 读到密钥即自动清除,零请求)。
  //   · `scope: 'local'` —— 密钥解析各入口独立(DSH 插件走 ctx.credentials / 环境变量 /
  //     包根 secrets.json,CLI 走环境变量 / 那个文件),而 degraded.json 是**全局共享**的
  //     文件。若写成全局状态,某条入口读不到密钥就会把**密钥其实是好的**其它入口一起按停
  //     —— 那是"一个局部问题造成全局失能"。作用域把它的影响限制在写下它的入口内。
  'no-key': Object.freeze({ degraded: true, sticky: true, scope: 'local', cooldownMs: 0 }),
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
 * 一个分类的作用域:`'global'`(服务侧,压制所有入口)或 `'local'`(本地配置,只压制写它的入口)。
 * @param kind - 分类名。
 * @returns 作用域名;未知分类按 `global`(宁可多压制一个未知状态,也不要让它漏过)。
 */
export function kindScope(kind) {
  return KINDS[kind]?.scope === 'local' ? 'local' : 'global'
}

/**
 * 这个状态是不是"粘性"的(= 不靠时间结束,靠条件消失结束)。
 *
 * 同时看状态自身与分类表:老状态文件里没有 `sticky` 字段,按分类表认出来才不会误判成
 * "冷却已经过期了,可以再去问一次" —— 那会让没密钥的部署每个命令都重进一次判定。
 *
 * @param state - 降级状态。
 * @returns true = 忽略 `until`,永不探测。
 */
export function isSticky(state) {
  if (!state) return false
  return state.sticky === true || KINDS[state.kind]?.sticky === true
}

/**
 * 这个状态是否适用于某个入口(作用域匹配)。
 * `global` 状态压制所有入口;`local` 状态只压制写下它的入口。
 * @param state - 降级状态。
 * @param scope - 入口身份(如 `'dsh-adapter'` / `'cli'`);不传 = 只认服务侧状态。
 * @returns true = 该入口应当遵守这个状态。
 */
export function appliesTo(state, scope = undefined) {
  if (!state) return false
  const written = typeof state.scope === 'string' && state.scope !== ''
    ? state.scope
    : (kindScope(state.kind) === 'local' ? 'local' : 'global')
  return written === 'global' || written === scope
}

/**
 * 按失败类别返回冷却时长(可被配置覆盖)。
 * @param kind - 分类名。
 * @param cfg - 可选 `{ quotaCooldownMs, authCooldownMs }`。
 * @returns 毫秒。
 */
export function cooldownMs(kind, cfg = {}) {
  if (kind === 'quota') return Number(cfg.quotaCooldownMs ?? KINDS.quota.cooldownMs)
  if (kind === 'auth') return Number(cfg.authCooldownMs ?? KINDS.auth.cooldownMs)
  // 粘性分类靠"条件消失"结束,不靠时间 —— 冷却时长对它没有意义。
  if (KINDS[kind]?.sticky === true) return 0
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
 * 唯一的"一个状态码对应两个来源"是 401/403(应用层鉴权失败 vs 边缘/WAF 拦截),它靠
 * `looksLikeEdgeBlock()` 分辨 —— 判不准时归 `auth`,因为"提醒人去查密钥"比"静默地少降级"更该发生。
 *
 * @param error - 抛出的异常(带 `status` / `contentType` / `body` / `code` / `name` / `message`)。
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
  // 401/403 这两种码有两个来源,处置完全相反,所以先分辨来源再分类(2026-09-23,D16):
  //   · 应用层鉴权失败 —— 密钥无效/被撤销 → `auth`,持久,冷却 30 分钟并提示去换密钥;
  //   · 边缘/WAF 把我们挡在门外 —— 请求没到应用层,密钥都没被看过 → `edge`,瞬态,逐次 fail-open。
  // 分辨不了时按 `auth`(宁可多提醒人查钥匙,不要把真正的密钥失效放过)。
  if ((status === 401 || status === 403) && looksLikeEdgeBlock(error, text)) return { kind: 'edge', status, detail }
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
 * @param options - `{ error, detail, status, cfg, now, scope, probe }`;`scope` 是入口身份,
 *   只对 `local` 分类有意义(它决定这份状态会压制谁)。
 * @returns 写入后的状态对象(即使写盘失败也返回,调用方照常降级)。
 */
export async function enterDegraded(kind, options = {}) {
  const now = Number(options.now ?? Date.now())
  const cfg = options.cfg ?? {}
  const path = resolveDegradedPath(cfg)
  const cooldown = cooldownMs(kind, cfg)
  const sticky = KINDS[kind]?.sticky === true
  // 服务侧状态一律 global(它是整个服务的事);本地状态记下"谁写的",作用域过滤据此
  // 把它限制在那条入口内。调用方没给身份时记 'local' —— 那个值压制不了任何入口,
  // 也就是"宁可少压制,不要误压制"。
  const scope = kindScope(kind) === 'local' ? String(options.scope ?? 'local') : 'global'
  const previous = await readDegraded(cfg)
  // 计数只在"同类别 + 同入口"时延续,否则两份无关的失败会被累加成一条假历史。
  const sameKind = previous?.kind === kind && (previous.scope ?? 'global') === scope
  const state = {
    kind,
    scope,
    sticky,
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
 *
 * 返回值刻意把三件事分开(2026-09-23):**清掉了** / **本来就没有** / **清不掉**。
 * 第一版只有 true/false,于是只读文件系统(`EROFS`)、权限不足这类真实故障被报成
 * "当前没有降级状态,无需清除" —— 状态文件还在,人却以为已经清了,真正的原因被吞掉。
 *
 * @param options - `{ degradedPath }`。
 * @returns `{ removed, ok, code?, error? }`:`removed` = 这次真的删掉了一个文件;
 *   `ok` = "现在没有状态文件了"(删掉了,或本来就没有 —— 后者是成功,不是故障);
 *   失败时 `code` 是 errno 名(`EROFS` / `EACCES` / …),`error` 是原始消息。
 */
export async function clearDegraded(options = {}) {
  const path = resolveDegradedPath(options)
  try {
    const { unlink } = await import('node:fs/promises')
    await unlink(path)
    return { removed: true, ok: true }
  } catch (error) {
    // ENOENT = 状态文件本来就不存在,想要的结果已经成立 —— 报失败会误导人。
    if (error?.code === 'ENOENT') return { removed: false, ok: true }
    return {
      removed: false,
      ok: false,
      code: typeof error?.code === 'string' ? error.code : undefined,
      error: String(error?.message ?? error).slice(0, 200),
    }
  }
}

/**
 * 这个 401/403 是**边缘/WAF 拦的**,还是应用层鉴权失败?
 *
 * 依据只有一个问题:"这份响应像不像那个 JSON 应用发的?"API 只讲 JSON,所以下面任一条成立
 * 就说明拦截发生在应用之前 —— 密钥根本没被检查过:
 *
 *   ① `content-type` 明确是 HTML(`text/html`、`application/xhtml+xml`)—— nginx/apache 与
 *      Cloudflare 的默认错误页都在这一类;
 *   ② 正文里有 HTML 结构(`<!doctype html` / `<html` / `<head` / `<body>`)—— 应用即使
 *      返回 403 也只会给 JSON,给 HTML 的一定不是它;
 *   ③ 正文里有边缘厂商的指纹(Cloudflare 的 `cf-ray` / `Attention Required` / `Error code: 102x`,
 *      以及 Sucuri / Akamai / Imperva 的错误页措辞)。
 *
 * 反过来:**正文是 JSON 就一律不算边缘**,照旧按应用层鉴权失败(`auth`)处理 —— 那才是真正的
 * "密钥无效或被撤销",必须让人去换密钥,不能当成路过的抖动。宁可在少见的自定义错误页上多降级
 * 一次(标签会指向"密钥"),也不要漏掉一次真正的密钥失效。
 *
 * @param error - 抛出的异常(带 `contentType` / `body` / `message`)。
 * @param text - 已小写化的 `code + body + message` 拼接串(调用方已算好,避免重复拼)。
 * @returns true = 判为边缘拦截(不降级)。
 */
function looksLikeEdgeBlock(error, text) {
  if (/html/.test(String(error?.contentType ?? '').toLowerCase())) return true
  if (/<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/.test(text)) return true
  if (/cloudflare|cf-ray|cf-error|attention required|you have been blocked|error code:\s*1\d{3}|sucuri|akamai|incapsula|imperva/.test(text)) return true
  return false
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
 * @param scope - 本入口的身份;本地状态只压制写下它的入口(不传 = 只认服务侧状态)。
 * @returns true = 应当跳过联网判定。
 */
export function isDegraded(state, now = Date.now(), scope = undefined) {
  if (!state) return false
  if (!appliesTo(state, scope)) return false
  // 粘性状态没有"窗口"这回事:它一直有效,直到它描述的条件消失(见 isSticky)。
  if (isSticky(state)) return true
  const until = untilMs(state)
  return Number.isFinite(until) ? until > now : false
}

/**
 * 降级窗口是否已到期(= 下一次调用可以作为探测请求)。
 * @param state - readDegraded() 的结果。
 * @param now - 当前毫秒时间戳。
 * @param scope - 本入口的身份(同 isDegraded)。
 * @returns true = 放一次探测请求。
 */
export function probeDue(state, now = Date.now(), scope = undefined) {
  if (!state) return false
  if (!appliesTo(state, scope)) return false
  // 粘性状态**永不探测**:没密钥时一次 HTTP 都不发,没有"可探测对象"可放。
  // 放它过去只会让每条命令都重新撞一次 no-key,把降级变成刷屏。
  if (isSticky(state)) return false
  const until = untilMs(state)
  return Number.isFinite(until) ? until <= now : true
}

/**
 * 距离自动探测还有多少毫秒(粘性状态恒为 0:它不等时间)。
 * @param state - 降级状态。
 * @param now - 当前时间。
 * @returns 毫秒(最小 0)。
 */
export function retryInMs(state, now = Date.now()) {
  if (isSticky(state)) return 0
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
  const common = {
    label: kindLabel(state.kind) || state.label,
    since: String(state.since ?? '').slice(11, 19),
    failures: state.failures,
    policy: t(state.policy === 'off' ? 'quota.policy.off' : 'quota.policy.l0-only'),
  }
  // 粘性状态没有"多少分钟后自动恢复"这句话 —— 对它说"等 0 分钟"等于骗人,所以换一条文案。
  if (isSticky(state)) return t('quota.warning.sticky', common)
  // 冷却已到期 = 现在等的就是"下一条命令那一次探测"。这时说"暂停 0 分钟"是自相矛盾的:
  // 它既会进每条非 allow 判定的理由,也会被 `guard log` / `guard allow` 打印出来 —— 而
  // 在只读文件系统那种"永远到期"的状态下,那两位会被反复念(2026-09-23)。
  if (retryInMs(state, now) <= 0) return t('quota.warning.expired', common)
  return t('quota.warning', { ...common, mins: Math.round(retryInMs(state, now) / 60000) })
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
  const sticky = isSticky(state)
  return [
    t('quota.status.degraded.title', { kind: state.kind }),
    t('quota.status.degraded.reason', { label: kindLabel(state.kind) || state.label }),
    t('quota.status.degraded.counters', { since: state.since, failures: state.failures, probes: state.probes ?? 0 }),
    // 粘性状态不是在"等一个窗口",所以不打印倒计时,直接说清它什么时候结束。
    sticky ? t('quota.status.degraded.sticky') : t('quota.status.degraded.recovery', { mins }),
    t('quota.status.degraded.now', {
      now: t(state.policy === 'off' ? 'quota.status.degraded.now.off' : 'quota.status.degraded.now.l0-only'),
    }),
    t('quota.status.degraded.action', { hint: kindHint(state.kind) }),
    // 本地状态只影响写下它的那条入口 —— 不说清楚,别的入口会以为自己也坏了。
    state.scope && state.scope !== 'global' ? t('quota.status.degraded.scope', { scope: state.scope }) : '',
    state.detail ? t('quota.status.degraded.detail', { detail: state.detail }) : '',
    t('quota.status.degraded.retry'),
  ].filter(Boolean).join('\n')
}
