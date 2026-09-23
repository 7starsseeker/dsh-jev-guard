/**
 * jev-guard — DSH adapter(native Cordis plugin)。
 *
 * A native hook in DSH is just an ordinary plugin subscribing to a canonical
 * lifecycle event, so this file is thin on purpose: 判定在 `lib/`(与调用方无关),
 * 这一半只做四件事:解析凭据、从工具调用里取出命令、应用重试预算、
 * 在 `tools/pre-execute` 上返回 typed PreToolDecision(allow / ask / deny 瀑布)。
 *
 * 它住在 `adapters/dsh/` 而不是 `lib/`,是**结构性声明**:判定不该知道谁在调用它 ——
 * 这样同一套判定才能被 CLI 与六份自检**离线复跑**(校准、回归、事故复盘全靠这一点)。
 * `lib/` 里没有任何 DSH 概念(没有 Cordis、没有 ctx、没有 PreToolDecision)。
 * 机制与映射见 docs/DSH-INTEGRATION.md。
 *
 * @module jev-guard/dsh
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flush, record } from '../../lib/audit.js'
import { DEFAULTS, evaluateCommand } from '../../lib/gate.js'
import { setLang, getLang, t } from '../../lib/i18n.js'
import { DEGRADING_KINDS, appliesTo, isSticky, kindLabel, readDegraded } from '../../lib/quota.js'
import { RetryBudget, fingerprint, reviseGuidance, toHostDecision } from '../../lib/verdict.js'

/** Package root (adapters/dsh/ → ../..), so every adapter reads the same config.json. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** CLI 入口绝对路径:写进拒绝理由里,让用户能直接复制粘贴授权命令(不用自己找路径)。 */
const CLI_PATH = join(ROOT, 'bin', 'guard.mjs')

/** 插件 id:同时是 cordis 的 `name` 与会话 notice 的 `source.plugin`(去重靠它认自己的话)。 */
const PLUGIN_ID = 'jev-guard'

/**
 * 本入口在降级状态里的身份(见 DEFAULTS.scope)。
 * 与 CLI 的 `'cli'` 必须不同:两边各自解析密钥,本地类状态(`no-key`)只该压制写下它的那条入口。
 */
const ADAPTER_SCOPE = 'dsh-adapter'

/** notice 摘要的字符上限;与 DSH 的 CONTEXT_SUMMARY_MAX_CHARS 一致(超出会被折叠行截断)。 */
const SUMMARY_MAX = 120

/**
 * Read config.json so there is ONE place to tune thresholds for every surface.
 * The cordis patch config still wins over it, and DEFAULTS lose to both.
 * @returns the file config, or an empty object.
 */
function loadConfigFile() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = PLUGIN_ID

/** The tool registry we gate and the credential seam we resolve the key from. */
export const inject = ['tools', 'credentials']

/** Tool names gated by default. */
const DEFAULT_TOOLS = ['bash', 'pwsh']

/**
 * Read the command out of a tool call, tolerating a string or object argument bag.
 * @param exec - the pre-execute pipeline view of the call.
 * @returns the command text, or undefined when this call carries none.
 */
function extractCommand(exec) {
  const args = exec?.arguments
  const pick = bag => (typeof bag?.command === 'string' ? bag.command : undefined)
  if (args && typeof args === 'object') return pick(args)
  if (typeof args === 'string') {
    try {
      return pick(JSON.parse(args))
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Resolve the TypeSafe key, highest precedence first:
 *
 *   1. `ctx.credentials.resolve(ref)` — DSH 自己的凭据存储(轮换后无需重启);
 *   2. the process environment;
 *   3. `apiKeyFile`(默认包根 `secrets.json`)—— `guard key set` 写的就是这一份。
 *
 * 第三层是必须的:适配器原先是**纯凭据层 + 环境变量**,而 `guard key set` 写的是文件 ——
 * 少了这一层,"用 CLI 录入密钥"对 DSH 用户就是一句空话。现在 CLI、适配器、文档三处
 * 共用同一条路径规则:相对路径按**包根**解析,与 cwd 无关。
 *
 * 值永不打印、永不进日志;下面只记"哪一层命中"。
 *
 * @param ctx - plugin context carrying the credential seam.
 * @param ref - environment-variable-style reference name.
 * @param cfg - effective config (`apiKeyFile` 决定第三层读哪个文件)。
 * @returns the secret value, or undefined when unconfigured.
 */
async function resolveKey(ctx, ref, cfg = {}) {
  try {
    const resolved = await ctx.credentials?.resolve?.(ref)
    if (resolved?.value) return resolved.value
  } catch (error) {
    ctx.logger?.debug?.('jev-guard: credential resolution failed for %s: %s', ref, String(error?.message ?? error))
  }
  if (process.env[ref]) return process.env[ref]
  try {
    const configured = typeof cfg.apiKeyFile === 'string' && cfg.apiKeyFile.trim() !== '' ? cfg.apiKeyFile : undefined
    const file = configured === undefined
      ? join(ROOT, 'secrets.json')
      : (isAbsolute(configured) ? configured : join(ROOT, configured))
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const value = parsed[ref] ?? parsed.apiKey
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  } catch {
    // 读不到就算了:预筛与 L0 仍然工作,语义层会因为 no-key 进入降级并在会话里说出来。
  }
  return undefined
}

/**
 * The session's effective approval policy.
 *
 * `danger-full-access` is `{ sandbox: 'danger-full-access', approval: 'never' }`,
 * and under `'never'` the approval service resolves EVERY ask to `rejected` — so
 * an `ask` there becomes a denial whose reason claims "the user rejected tool
 * bash". With `'never'` we therefore deny directly and explain why.
 *
 * @param ctx - plugin context.
 * @param agent - the agent on whose behalf the call runs.
 * @returns `'ask'` or `'never'`.
 */
function effectivePolicy(ctx, agent) {
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type === 'approval/policy' && event?.data?.policy) return event.data.policy
    }
  } catch {
    // fall through to the deployment default
  }
  return ctx.get?.('approval')?.config?.policy ?? 'ask'
}

/**
 * 会话当前的**权限 preset**(沙箱档位),例如 `workspace-write` / `danger-full-access`。
 *
 * 为什么要记它:DSH 的 preset 决定"阀门后面还有没有别的兜底"。`danger-full-access` 意味着
 * 没有文件沙箱、审批策略也是 `never` —— 那时**这条阀门就是唯一一层**,一条判错的代价最大。
 * 判定逻辑不需要它(阈值不该随档位偷偷变),但审计里必须有:事后回看一条高危决策时,
 * 第一个要问的问题就是"当时后面还有没有沙箱"。这也是 DSH 专用之后才拿得到的信息。
 *
 * @param ctx - plugin context.
 * @param agent - the agent on whose behalf the call runs.
 * @returns preset 名,或 undefined(读不到就不记,不编一个)。
 */
function effectivePreset(ctx, agent) {
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type === 'permission/preset' && event?.data?.preset) return event.data.preset
    }
  } catch {
    // 读不到就算了:preset 只是审计字段,不能因为它影响判定
  }
  return undefined
}

/**
 * 造一条 DSH 会话消息(`notice` 形态)。
 *
 * 形状必须与 DSH 的 `UserMessage` 严格一致,而且 `source` **只带这四个键**:
 *   · 多一个键会在**下次恢复会话**时被旧格式校验判成损坏(`SessionPersistenceCorruptionError`)
 *     —— 也就是说这里写错能让用户的会话打不开;
 *   · 值为 `undefined` 的键不该出现(会破坏快照的"可移植原样"性质)—— 这是防御性规则,
 *     本插件的四个键永远都被填上。
 * 这两条都是**实测过**的:`tools/smoke-dsh-pipeline.mjs` 会把本函数的产物交给 DSH 自己的
 * `snapshotJsonValue`(真实 `Session.append` 之前跑的那一步)校验一遍。
 *
 * `id` 用 Node 自带的 `randomUUID`:DSH 的 id 是编译期 branded string,运行时就是一个普通字符串,
 * 所以我们不必为了这个字段去依赖它的包(本插件保持零依赖)。
 *
 * @param text - 正文(给模型看的完整内容)。
 * @param summary - 折叠行的标题(≤{@link SUMMARY_MAX} 字符)。
 * @returns 可直接追加进 pre-step 决策的消息对象。
 *
 * 导出是**刻意的**:形状是本插件与 DSH 之间最容易出错的一份契约(写错能让会话打不开),
 * 所以它必须能被一个"在 DSH 自己的模块里跑"的测试直接拿去校验。
 */
export function noticeMessage(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_ID,
      form: 'notice',
      summary: summary.length <= SUMMARY_MAX ? summary : `${summary.slice(0, SUMMARY_MAX - 1)}…`,
    },
  }
}

/**
 * 这条会话里我们已经说过哪些 notice(摘要集合)。
 *
 * 为什么不只在内存里记一个 `Set`:DSH 重启或会话恢复之后插件是一个全新实例,内存标记归零,
 * 于是已经写在会话历史里的提示会被**再说一遍**。会话历史是持久的,真相在那儿 ——
 * 扫自己发过的 notice 才是跨重启可靠的去重依据。
 *
 * @param agent - the agent proposing the step.
 * @returns 已出现过的摘要集合。
 */
function announcedSummaries(agent) {
  const seen = new Set()
  try {
    for (const message of agent?.session?.deriveMessages?.() ?? []) {
      const source = message?.source
      if (source?.kind === 'plugin' && source.plugin === PLUGIN_ID && typeof source.summary === 'string') {
        seen.add(source.summary)
      }
    }
  } catch {
    // 读不到历史就当"没说过":宁可再说一遍,也不能漏掉"没有密钥"这条要求。
  }
  return seen
}

/**
 * 现在该不该说点什么(且还没说过)。
 *
 * 四种情形:① 本地可见的降级态是"没有密钥" → 要求录入;② 其它降级态 → 说明降级;
 * ③ 会话第一步且解析不到密钥(状态文件还没写) → 同样要求录入;④ 说过降级而现在已经恢复 → 宣布恢复。
 * 每种情形一句话、每个会话一次;成对出现(降级 → 恢复),不刷屏。
 *
 * @param ctx - plugin context.
 * @param cfg - effective config.
 * @param payload - the `agent/pre-step` payload.
 * @returns `{ text, summary }`,或 null(无话可说 / 已经说过)。
 */
async function pendingNotice(ctx, cfg, payload) {
  const seen = announcedSummaries(payload?.agent)
  const policy = t(cfg.degradePolicy === 'off' ? 'quota.policy.off' : 'quota.policy.l0-only')
  const noKeySummary = t('notice.no-key.summary')
  const recoveredSummary = t('notice.recovered.summary')
  // 可枚举的降级摘要:只有这样才不用往消息里塞"机器标记"就能认出自己说过哪种状态。
  const degradedSummaries = new Set(
    DEGRADING_KINDS.map(kind => t('notice.degraded.summary', { label: kindLabel(kind), policy })),
  )

  const state = await readDegraded(cfg)
  // 只认**本入口**该遵守的状态:CLI 写下的 no-key 不该在 DSH 会话里喊(反之亦然)。
  const active = state !== null && appliesTo(state, cfg.scope) ? state : null

  // 状态文件还没写时的"首次没有密钥":只在会话第一步解析一次密钥,免得每一步都去问凭据层。
  // 会话中途失去密钥走另一条路 —— 那次受管命令判成 no-key 会写下状态,下一步就有人说话了。
  let missingKey = false
  if (active === null && payload?.turn === 1 && payload?.step === 1) {
    missingKey = (await resolveKey(ctx, cfg.apiKeyEnv, cfg)) === undefined
  }

  let summary = null
  if (active !== null && active.kind === 'no-key') summary = noKeySummary
  else if (active !== null) summary = t('notice.degraded.summary', { label: kindLabel(active.kind), policy })
  else if (missingKey) summary = noKeySummary
  else if (!seen.has(recoveredSummary) && [...seen].some(s => s === noKeySummary || degradedSummaries.has(s))) {
    // 只有这条会话确实说过"降级 / 没有密钥"才宣布恢复,否则每个健康会话开场都要多一句废话。
    summary = recoveredSummary
  }
  if (summary === null || seen.has(summary)) return null

  if (summary === noKeySummary) {
    return { summary, text: `${summary}\n\n${t('notice.no-key.body', { cli: CLI_PATH })}` }
  }
  if (summary === recoveredSummary) {
    return { summary, text: `${summary}\n\n${t('notice.recovered.body')}` }
  }
  // 恢复方式这句话与 `guard status` 共用同一条文案(粘性态没有倒计时,见 lib/quota.js)。
  const recovery = active !== null && isSticky(active)
    ? t('quota.status.degraded.sticky').trim()
    : t('quota.status.degraded.recovery', {
      mins: Math.round(Math.max(0, Number(active?.until ?? 0) - Date.now()) / 60000),
    })
  return {
    summary,
    text: `${summary}\n\n${t('notice.degraded.body', { label: kindLabel(active.kind), recovery, policy, cli: CLI_PATH })}`,
  }
}

/**
 * Register the guard.
 * @param ctx - plugin context.
 * @param config - optional overrides; every field falls back to {@link DEFAULTS}.
 */
export function apply(ctx, config = {}) {
  const cfg = {
    ...DEFAULTS,
    tools: DEFAULT_TOOLS,
    apiKeyEnv: 'TYPESAFE_API_KEY',
    retryLimit: 2,
    ...loadConfigFile(),
    ...config,
    // 入口身份由代码定死:配置文件把它改乱,作用域隔离就失效了(见 ADAPTER_SCOPE)。
    scope: ADAPTER_SCOPE,
  }
  // 语言在这里定一次:拒绝理由 / 弹窗正文 / 一次性令牌提示都是人读的文案。
  // `lang: 'auto'`(默认)按 JEV_GUARD_LANG → locale 环境变量 → 系统 locale → zh-CN 解析。
  // 注意它**不影响**发给 Jev 的那句问话 —— 那是 promptLang,默认仍是标定用的中文。
  setLang(cfg.lang)

  const cache = new (class {
    constructor(limit) {
      this.limit = limit
      this.map = new Map()
    }

    get(k) {
      const v = this.map.get(k)
      if (v === undefined) return undefined
      this.map.delete(k)
      this.map.set(k, v)
      return v
    }

    set(k, v) {
      this.map.set(k, v)
      while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value)
    }
  })(cfg.cacheSize)
  const budget = new RetryBudget(cfg.retryLimit)
  const stats = { allowed: 0, revised: 0, blocked: 0, escalated: 0, prefilters: 0, cacheHits: 0, ruleHits: 0, errors: 0, degraded: 0 }
  /** 已吼过的降级窗口(= kind + until),避免每个命令刷一遍屏。 */
  let lastDegradedKey = ''
  /** 已吼过的"清不掉的状态文件"(= 路径 + errno),同上。 */
  let lastStuckClearKey = ''

  ctx.logger?.info?.(
    'jev-guard: gating %s (low=%s high=%s timeout=%sms key=%s lang=%s promptLang=%s)',
    cfg.tools.join(','), cfg.lowThreshold, cfg.highThreshold, cfg.timeoutMs, cfg.apiKeyEnv,
    getLang(), cfg.promptLang,
  )

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (!cfg.tools.includes(exec.name)) return next()
      const command = extractCommand(exec)
      if (command === undefined) return next()

      const apiKey = await resolveKey(ctx, cfg.apiKeyEnv, cfg)
      const policy = effectivePolicy(ctx, exec.agent)
      // 沙箱档位:只进审计,不参与判定(阈值不随档位偷偷变;见 effectivePreset 的说明)。
      const preset = effectivePreset(ctx, exec.agent)
      const cwd = typeof exec.arguments?.workdir === 'string'
        ? exec.arguments.workdir
        : (exec.agent?.session?.cwd ?? process.cwd())
      const verdict = await evaluateCommand(command, { ...cfg, cwd, cache, apiKey, signal: exec.signal })

      if (verdict.source === 'prefilter') stats.prefilters += 1
      if (verdict.source === 'cache') stats.cacheHits += 1
      if (verdict.source === 'static-rule') stats.ruleHits += 1
      if (verdict.source === 'degraded') stats.degraded += 1
      if (verdict.source === 'error') {
        stats.errors += 1
        ctx.logger?.warn?.('jev-guard: fail-open after %s (%sms): %s', verdict.error, verdict.ms, command.slice(0, 160))
      }
      // 降级告警:额度/密钥出问题时**必须有人能发现**。旧行为是静默 fail-open,
      // 日志里一堆 error 但没人看得出"它已经不在防护了"。这里三件事一起做:
      //   ① host 日志一条 warn(尽力而为);② 审计里留一条 level:'warn' 的记录(可靠);
      //   ③ 非 allow 判定的理由里已经带了同一句(见 lib/verdict.js 的 warn)。
      // 每个降级窗口最多吼一次,免得刷屏;人可以用 `guard status` 看全貌。
      const degradedKey = verdict.degraded ? `${verdict.degraded.kind}:${verdict.degraded.until}` : ''
      if (degradedKey && degradedKey !== lastDegradedKey) {
        lastDegradedKey = degradedKey
        ctx.logger?.warn?.('jev-guard: DEGRADED %s', verdict.warning)
        void record({
          level: 'warn', tool: exec.name, source: verdict.source, errorKind: verdict.errorKind,
          degraded: verdict.degraded, warning: verdict.warning, cwd, command,
          session: exec.agent?.session?.id,
        }, cfg)
      }

      // 探测成功后状态文件却删不掉(只读文件系统 / 权限不足):服务确实回来了,但那份文件会
      // 被每一次读取继续显示成"已降级"。它是人的环境问题,不是阀门的问题,所以走同一条
      // "有人能发现"的路:host 日志一条 warn + 审计一条 level:'warn'(带上 errno 与路径)。
      // 同一个(路径, errno)只吼一次 —— 否则每条命令都会重报同一件陈年旧事。
      const stuckKey = verdict.clearFailed ? `${verdict.clearFailed.path}:${verdict.clearFailed.code ?? ''}` : ''
      if (stuckKey && stuckKey !== lastStuckClearKey) {
        lastStuckClearKey = stuckKey
        ctx.logger?.warn?.('jev-guard: %s', verdict.warning)
        void record({
          level: 'warn', tool: exec.name, source: verdict.source, clearFailed: verdict.clearFailed,
          warning: verdict.warning, cwd, command, session: exec.agent?.session?.id,
        }, cfg)
      }

      const sessionKey = `${exec.agent?.session?.id ?? 'no-session'}:${fingerprint(command)}`
      let effective = verdict

      if (verdict.action === 'allow') {
        stats.allowed += 1
        budget.clear(sessionKey)
        ctx.logger?.debug?.('jev-guard: allow via %s (p=%s, %sms)', verdict.source, verdict.p, verdict.ms)
        // 审计:DSH 的 logger 会过滤 info 级,所以真实凭据落在 guard.log 里。
        void record({
          tool: exec.name, action: 'allow', decision: 'allow', source: verdict.source,
          p: verdict.p, model: verdict.model, ms: verdict.ms, rule: verdict.rule?.id,
          enriched: verdict.enriched, cwd, error: verdict.error, errorKind: verdict.errorKind,
          policy, preset,
          degraded: verdict.degraded, usage: verdict.usage, probe: verdict.probe,
          recovered: verdict.recovered, command,
          overridden: verdict.overridden, token: verdict.token,
          session: exec.agent?.session?.id,
        }, cfg)
        return next()
      }

      // Blocked or merely uncertain: count attempts so a model that keeps
      // rephrasing the same destruction eventually reaches a human instead of
      // looping forever.
      const { attempts, exhausted } = budget.hit(sessionKey)
      // 例外:带 L0 `deny` 规则的硬命中**不能**借重试预算转人工 —— 那会让弹窗里的"允许"
      // 越过硬地板(令牌不能越过 L0,审批同样不能,见 D5/D13)。硬命中照旧记 attempts 供审计。
      const hardRule = verdict.rule?.kind === 'deny'
      if (exhausted && verdict.action !== 'escalate' && hardRule !== true) {
        effective = { ...verdict, action: 'escalate', source: `${verdict.source}+retry-budget` }
      }
      if (effective.action === 'revise') stats.revised += 1
      else if (effective.action === 'block') stats.blocked += 1
      else stats.escalated += 1

      ctx.logger?.info?.(
        'jev-guard: %s command (policy=%s, p=%s, attempts=%d, %sms, enriched=%s) %s',
        effective.action, policy, verdict.p, attempts, verdict.ms,
        (verdict.enriched ?? []).join('+') || 'none', command.slice(0, 160),
      )

      const decision = toHostDecision(command, effective, policy, {
        token: verdict.token,
        cliPath: CLI_PATH,
        reviseInAskMode: cfg.reviseInAskMode,
        blockInAskMode: cfg.blockInAskMode,
      })
      // 审计:被拦/被问/升级都要留痕(含命中规则与重试次数)。decision.kind 已经能区分
      // "转人工(ask)"与"直接拒(deny)" —— 同一条 revise 在两种审批模式下会写在这里不同的值。
      void record({
        tool: exec.name, action: effective.action, decision: decision.kind, source: effective.source,
        p: verdict.p, model: verdict.model, ms: verdict.ms, rule: verdict.rule?.id,
        enriched: verdict.enriched, attempts, policy, preset, cwd, command,
        errorKind: verdict.errorKind, degraded: verdict.degraded, warning: verdict.warning,
        usage: verdict.usage, probe: verdict.probe,
        overridden: verdict.overridden, token: verdict.token,
        session: exec.agent?.session?.id,
      }, cfg)
      // revise 的两条出路都带上三种降级模板:转人工时它是**弹窗正文**(让做决定的人看清
      // 还能怎么改),被直接拒时它是给模型的教案。routedToHuman 决定开头那几句怎么说。
      if (effective.action === 'revise') {
        return {
          ...decision,
          reason: reviseGuidance(command, effective, {
            policy, token: verdict.token, cliPath: CLI_PATH, routedToHuman: decision.kind === 'ask',
          }),
        }
      }
      return decision
    } catch (error) {
      // Never let the valve break a turn: an unexpected failure delegates to the
      // normal pipeline, where the sandbox and approval policy still apply.
      stats.errors += 1
      ctx.logger?.warn?.('jev-guard: unexpected failure, delegating: %s', String(error?.stack ?? error))
      void record({ action: 'allow', decision: 'allow', source: 'adapter-error', error: String(error?.message ?? error), cwd: process.cwd() }, cfg)
      return next()
    }
  })

  // ── 会话内提示(纯 host 插件唯一能让用户真看到的渠道;见 docs/DECISIONS.md D15)──────────
  //
  // 为什么用 `agent/pre-step`:DSH 的 Settings / Plugins 页都由浏览器侧(`dsh.client`)注册占位,
  // 纯 host 插件**没有任何** toast / banner / 启动提示接口;而注入一条 `notice` 消息会渲染成对话
  // 里的一行(折叠标题 = summary,展开是正文)、**写进会话历史**、并且进入模型上下文 —— 于是
  // "这个阀门现在是瞎的"既被人看见,也被模型知道。先例是同为 host-only 的
  // `packages/guard/repeat-tool-reminder` 与 `packages/core/agent/src/model-selection.ts`。
  if (cfg.notifyInSession !== false) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        // 两条纪律,违反任何一条都会伤害宿主:
        //  · 必须 `await next()` 之后再**追加** —— 决策里的 `messages` 是**替换**整个批次,
        //    直接返回自己的数组会把用户这条消息吞掉;
        //  · 空批次不要塞消息 —— 那会让循环白白多跑一次模型请求(DSH 自己的 model-selection
        //    用的就是这条守卫)。
        if (decision?.kind !== 'enter' || payload?.signal?.aborted) return decision
        if (decision.messages.length === 0 && (payload.step === 1 || payload.messages?.length > 0)) return decision
        const notice = await pendingNotice(ctx, cfg, payload)
        if (notice === null) return decision
        ctx.logger?.debug?.('jev-guard: in-session notice (%s)', notice.summary)
        return { ...decision, messages: [...decision.messages, noticeMessage(notice.text, notice.summary)] }
      } catch (error) {
        // 这个监听器抛错会让**整次提案失败**(DSH 的行为),所以必须自己兜住:
        // 说不上话是小事,把用户的一次对话搞坏是大事。
        ctx.logger?.debug?.('jev-guard: notice skipped: %s', String(error?.message ?? error))
        return decision
      }
    })
  }

  ctx.on('dispose', () => {
    ctx.logger?.info?.('jev-guard: stopped (%j)', stats)
    // 退出路径上等一次审计写入,避免进程结束时丢尾部记录。
    void flush()
  })
}
