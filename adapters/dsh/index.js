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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flush, record } from '../../lib/audit.js'
import { DEFAULTS, evaluateCommand } from '../../lib/gate.js'
import { RetryBudget, fingerprint, reviseGuidance, toHostDecision } from '../../lib/verdict.js'

/** Package root (adapters/dsh/ → ../..), so every adapter reads the same config.json. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** CLI 入口绝对路径:写进拒绝理由里,让用户能直接复制粘贴授权命令(不用自己找路径)。 */
const CLI_PATH = join(ROOT, 'bin', 'guard.mjs')

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
export const name = 'jev-guard'

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
 * Resolve the TypeSafe key: the credential seam first (so a rotated key reaches
 * the next call without a restart), then the process environment.
 * @param ctx - plugin context carrying the credential seam.
 * @param ref - environment-variable-style reference name.
 * @returns the secret value, or undefined when unconfigured.
 */
async function resolveKey(ctx, ref) {
  try {
    const resolved = await ctx.credentials?.resolve?.(ref)
    if (resolved?.value) return resolved.value
  } catch (error) {
    ctx.logger?.debug?.('jev-guard: credential resolution failed for %s: %s', ref, String(error?.message ?? error))
  }
  return process.env[ref]
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
  }
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

  ctx.logger?.info?.(
    'jev-guard: gating %s (low=%s high=%s timeout=%sms key=%s)',
    cfg.tools.join(','), cfg.lowThreshold, cfg.highThreshold, cfg.timeoutMs, cfg.apiKeyEnv,
  )

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (!cfg.tools.includes(exec.name)) return next()
      const command = extractCommand(exec)
      if (command === undefined) return next()

      const apiKey = await resolveKey(ctx, cfg.apiKeyEnv)
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

  ctx.on('dispose', () => {
    ctx.logger?.info?.('jev-guard: stopped (%j)', stats)
    // 退出路径上等一次审计写入,避免进程结束时丢尾部记录。
    void flush()
  })
}
