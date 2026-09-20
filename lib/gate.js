/**
 * jev-guard — judge core(DSH-only 项目里仍然保持宿主无关的那一层)。
 *
 * 判定逻辑住在这里,与"谁来调用它"分开:同一个函数既被 DSH 插件在会话里调用,
 * 也被 `bin/guard.mjs` 与六份离线自检调用。**这不是为了支持多个宿主**(2026-09-20 已收窄为
 * DSH 专用,见 docs/DECISIONS.md D11),而是因为判定必须能被**离线复跑** ——
 * 校准、回归、事故复盘全靠这一点。
 *
 * Pipeline, in order:
 *   0. L0 static rules    -> block / escalate, no network, cannot be overridden
 *   1. deterministic prefilter -> allow, no network (read-only + rebuildable paths)
 *   2. Jev, ONE factual noul question -> allow / revise / block by two thresholds
 *   3. timeout, network error, aborted caller -> ALLOW (fail-open; the host's own
 *      sandbox and approval pipeline still sit in front of execution)
 *
 * 另外一层:**额度耗尽后的降级**(见 `./quota.js`)。这是收费 API,额度用完是必然事件。
 * 旧行为是"每次调用各自 fail-open" —— 功能没错,但会一直打注定失败的请求、日志被淹没、
 * 而且没有任何人会发现阀门已经瞎了。现在改成:持久性失败(quota / auth / no-key)写一份
 * 状态文件、在冷却窗口内不再发请求、窗口到期放**一次**探测;降级期间默认**只跑免费的
 * L0 + 预筛**(`degradePolicy: 'l0-only'`),并把这个事实写进理由、审计与 `guard status`。
 *
 * The question form is not arbitrary: a 114-item calibration run (2026-09-20)
 * measured this exact noul phrasing at 12/12 on destructive-command cases in
 * Chinese, while judgement-style forms were far weaker (action choice 75%,
 * risk band 50%). See docs/MEASUREMENTS.md.
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname as dirname_, isAbsolute, join as joinPath, resolve as resolvePath } from 'node:path'
import {
  DEGRADING_KINDS, classifyFailure, clearDegraded, enterDegraded, isDegraded, isSticky, probeDue, readDegraded, warningLine,
} from './quota.js'
import { FALLBACK_LANG, normalizeLang, t, tIn } from './i18n.js'
import { staticRule } from './rules.js'
import { commandToken, consumeToken } from './token.js'

/** Question id sent to Jev; it is echoed back as the answer key. */
export const QUESTION_ID = 'destroys_data'

/** Languages the question can be asked in. */
export const PROMPT_LANGS = Object.freeze(['zh-CN', 'en'])

/**
 * The noul question, in the language it should be asked in.
 *
 * **This is not UI text.** `promptLang` defaults to `zh-CN` — the language the
 * thresholds were calibrated in (114 labelled cases; Chinese input measured as good
 * as or better than translated English) — and it is deliberately independent of
 * `lang`, so switching the interface to English does not silently move a measured
 * decision boundary. Changing it is a re-calibration event, not a translation.
 *
 * @param promptLang - `'zh-CN' | 'en'`; anything else falls back to `zh-CN`.
 * @returns the frozen question object.
 */
export function judgeQuestion(promptLang = FALLBACK_LANG) {
  const lang = normalizeLang(promptLang) ?? FALLBACK_LANG
  return Object.freeze({
    type: 'noul',
    instructions: tIn(lang, 'gate.question.instructions'),
    criteria: Object.freeze({
      true: tIn(lang, 'gate.question.true'),
      false: tIn(lang, 'gate.question.false'),
    }),
  })
}

/** The calibrated default question, kept as a convenience for probes and docs. */
export const QUESTION = judgeQuestion('zh-CN')

export const DEFAULTS = Object.freeze({
  /**
   * Language of everything a user or a model reads: verdict reasons, CLI output,
   * degradation warnings, rule reasons. `'auto'` resolves from `JEV_GUARD_LANG`,
   * then the POSIX locale variables, then the system locale, then `zh-CN`
   * (see lib/i18n.js). It never changes the question asked to Jev — that is
   * `promptLang`, on purpose.
   */
  lang: 'auto',
  /**
   * Language of the question sent to Jev **and** of the state keys it reads.
   * Defaults to the calibrated Chinese question; see {@link judgeQuestion}.
   */
  promptLang: 'zh-CN',
  /** Below this probability: allow. */
  lowThreshold: 0.5,
  /** At or above this probability: block. In between: revise. */
  highThreshold: 0.7,
  timeoutMs: 1800,
  cacheSize: 256,
  model: 'jev-latest',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  /** Read an invoked script's body into the state (closes the opaque-script blind spot). */
  inlineScripts: true,
  /** Ceiling for inlined script text. */
  maxScriptBytes: 8192,
  /** 额度/密钥类失败后的冷却时长(毫秒);见 ./quota.js。 */
  quotaCooldownMs: 15 * 60 * 1000,
  authCooldownMs: 30 * 60 * 1000,
  /** 降级期间:`'l0-only'`(默认)= 只停联网语义层,L0 + 预筛照跑;`'off'` = 整条阀门暂停。 */
  degradePolicy: 'l0-only',
  /** 降级状态文件;空串 = 默认 `<JEV_GUARD_HOME>/degraded.json`。 */
  degradedPath: '',
  /**
   * 本入口的身份,写进"本地类"降级状态(目前只有 `no-key`)。
   *
   * 为什么需要它:`no-key` 是**本地配置**状况(密钥解析各入口独立 —— DSH 插件走
   * `ctx.credentials` / 环境变量 / 包根 `secrets.json`,CLI 走环境变量 / 那个文件),
   * 而 degraded.json 是**全机共享**的文件。不记身份的话,某条入口读不到密钥就会把
   * **密钥其实是好的**其它入口一起按停。服务侧状态(quota / auth)一律记 `global`。
   */
  scope: 'default',
  /**
   * 把降级、以及"没有解析到密钥"这两件事**在会话里说出来**(DSH 适配器在 `agent/pre-step`
   * 上注入一条 notice)。纯 host 插件没有任何 toast / banner / 启动提示接口 —— 注入会话消息
   * 是唯一能让用户真看到的渠道;设 false 则只保留 logger 与审计日志。
   */
  notifyInSession: true,
  /** 成本估算单价(美元 / 百万输入 token);输出按官方说明免费。 */
  pricePerMTok: 0.042,
  /**
   * 审批策略为 `ask`(宿主真的会弹审批框)时,`revise`(lowThreshold ≤ p < highThreshold)
   * 怎么处置:`'ask'`(默认)= 转人工审批,`'deny'` = 直接拒绝。
   *
   * 为什么默认转人工:灰区本来就"证据不足",而 ask 模式下**人就在场**;直接拒绝等于让
   * 一个 50% 的判断替人做决定。宿主没有应答者时审批是 fail-closed,不会出现无人自动放行。
   */
  reviseInAskMode: 'ask',
  /**
   * 同上,但针对 `block`(p ≥ highThreshold,由 Jev 语义层给出)。
   * **不适用于 L0 的 `deny` 类硬规则**:那条路两种模式都拦死,见 toHostDecision。
   */
  blockInAskMode: 'ask',
})

/* ------------------------------------------------------------------ *
 * 1. deterministic read-only prefilter
 * ------------------------------------------------------------------ */

/** Shell metacharacters that make a command more than one simple statement. */
const META = /[;&|<>`$()\n]/

/** First tokens that cannot mutate anything on their own. */
const PURE_READONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ps', 'df', 'du', 'free', 'uptime',
  'whoami', 'pwd', 'echo', 'printf', 'date', 'which', 'type', 'printenv', 'stat', 'file',
  'md5sum', 'sha256sum', 'shasum', 'tree', 'jq', 'sort', 'uniq', 'cut', 'tr', 'basename',
  'dirname', 'realpath', 'readlink', 'id', 'hostname', 'uname', 'lscpu', 'nproc', 'ss',
  'netstat', 'lsblk', 'lsof', 'timedatectl', 'who', 'groups', 'true', 'false', 'test',
  'diff', 'cmp', 'column', 'paste', 'fold', 'nl', 'od', 'xxd', 'strings', 'less', 'more',
  'man', 'info', 'es', 'codegraph', 'vol',
])

/** Read-only shapes for tools that are only sometimes read-only. */
const READONLY_SHAPE = [
  /^sed\s+-n\b(?!.*\s-i\b)/, // sed -n without -i
  /^find\s+(?![^|]*-(delete|exec|execdir|ok|okdir|fprint|fprint0|fls)\b)/,
  /^journalctl\s+(?!.*--vacuum)/,
  /^git\s+(-C\s+\S+\s+)?(status|log|diff|show|blame|shortlog|rev-parse|rev-list|ls-files|ls-tree|cat-file|describe|reflog|count-objects|whatchanged|grep|fetch)\b/,
  /^git\s+(-C\s+\S+\s+)?branch\s*(--list|-a|-r|-v|--show-current|--contains)?\s*$/,
  /^git\s+(-C\s+\S+\s+)?(remote\s+(-v|show)|config\s+--(get|list)|stash\s+list|tag\s+-l\b|tag\s+--list|worktree\s+list)\b/,
  /^docker\s+(ps|images|logs|inspect|version|info|stats|top|diff|port|history)\b/,
  /^docker\s+compose\s+(ps|logs|config|top)\b/,
  /^kubectl\s+(get|describe|logs|version|explain|api-resources|top)\b/,
  /^kubectl\s+config\s+(view|current-context)\b/,
  /^systemctl\s+(status|is-active|is-enabled|is-failed|list-units|list-unit-files|show|cat|--version)\b/,
  /^(npm|pnpm|yarn)\s+(ls|list|why|view|outdated|config\s+get|--version|-v)\b/,
  /^(node|python3?|pip3?|deno|bun|rustc|go|cargo|tsc)\s+(--version|-v|list|show|freeze)\s*$/,
  /^cargo\s+(tree|metadata)\b/,
  /^go\s+(version|env|list)\b/,
]

/** Directories whose deletion is cache/build housekeeping rather than data loss. */
const SAFE_ROOT = /^(\/tmp\/|\/var\/tmp\/|~\/\.cache\/|\$HOME\/\.cache\/|\/home\/[^/]+\/\.cache\/)/
const SAFE_SEGMENT = /(\/|^)(node_modules|dist|build|\.next|__pycache__|\.pytest_cache|target\/debug|target\/release)(\/|$)/
const NEVER_SAFE = new Set(['/', '/*', '~', '$HOME', '.', '..', '*', '~/*'])

/**
 * Strip quoted substrings so a `>` inside a grep pattern is not read as a redirect.
 * @param command - raw command text.
 * @returns the command with quoted regions blanked out.
 */
export function stripQuoted(command) {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
}

/**
 * Whether a command is provably read-only (safe to allow without asking Jev).
 * Deliberately conservative: anything ambiguous falls through to Jev.
 * @param command - raw command text.
 * @returns a human-readable reason when read-only, otherwise undefined.
 */
export function readOnlyReason(command) {
  const raw = command.trim()
  if (raw.length === 0) return 'empty command'
  const s = stripQuoted(raw)
  if (META.test(s)) return undefined
  const head = s.split(/\s+/)[0]
  if (PURE_READONLY.has(head)) {
    // `cat`-style readers cannot mutate; `es`/`codegraph` are index readers.
    if (head === 'printenv' || head === 'type' || head === 'command') return `read-only (${head})`
    return `read-only (${head})`
  }
  for (const re of READONLY_SHAPE) if (re.test(s)) return `read-only shape (${head})`
  return undefined
}

/**
 * Whether a `rm` command only targets rebuildable locations.
 * @param command - raw command text.
 * @returns a reason when every target is rebuildable, otherwise undefined.
 */
export function safeDeleteReason(command) {
  const raw = command.trim()
  if (!/^rm\s/.test(raw)) return undefined
  const s = stripQuoted(raw)
  if (META.test(s)) return undefined
  const parts = s.split(/\s+/).slice(1)
  const targets = []
  for (const p of parts) {
    if (p === 'rm') continue
    if (p.startsWith('-')) continue
    targets.push(p)
  }
  if (targets.length === 0) return undefined
  for (const t of targets) {
    if (NEVER_SAFE.has(t)) return undefined
    if (t.includes('..')) return undefined
    if (SAFE_ROOT.test(t) || SAFE_SEGMENT.test(t)) continue
    return undefined
  }
  return `rm on rebuildable path(s): ${targets.join(' ')}`
}

/**
 * Run both deterministic prefilter rules, including compound commands: when a
 * command is a sequence of `;` / `&&` / `||` / `|` segments and *every* segment
 * is provably harmless on its own, the whole command is harmless. One unsafe
 * segment makes the whole command go to Jev.
 * @param command - raw command text.
 * @returns a reason string when the command is provably harmless, else undefined.
 */
export function prefilter(command) {
  const direct = readOnlyReason(command) ?? safeDeleteReason(command)
  if (direct) return direct
  const segments = stripQuoted(command.trim()).split(/\s*(?:;|&&|\|\||\||\n)\s*/).filter(Boolean)
  if (segments.length < 2) return undefined
  const reasons = segments.map(s => readOnlyReason(s) ?? safeDeleteReason(s))
  if (reasons.some(r => r === undefined)) return undefined
  return `compound of ${segments.length} harmless segments`
}

/* ------------------------------------------------------------------ *
 * 2. verdict cache
 * ------------------------------------------------------------------ */

/** Minimal LRU keyed by exact command text. */
export class VerdictCache {
  /**
   * @param limit - maximum retained entries.
   */
  constructor(limit = DEFAULTS.cacheSize) {
    this.limit = Math.max(1, limit)
    this.map = new Map()
  }

  /**
   * @param key - command text.
   * @returns the cached verdict, or undefined.
   */
  get(key) {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  /**
   * @param key - command text.
   * @param value - verdict to retain.
   */
  set(key, value) {
    this.map.set(key, value)
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value)
  }

  /** @returns current entry count. */
  get size() {
    return this.map.size
  }
}

/* ------------------------------------------------------------------ *
 * 3. state enrichment — the "my own script did something irreversible" case
 * ------------------------------------------------------------------ */

/** Interpreters whose file argument can be read and judged by its content. */
const INTERPRETERS = new Set([
  'node', 'python', 'python3', 'bash', 'sh', 'zsh', 'dash', 'deno', 'bun',
  'tsx', 'ts-node', 'ruby', 'perl', 'php', 'lua', 'Rscript',
])

/** Tokens that look like a script file rather than a flag or a subcommand. */
const LOOKS_LIKE_SCRIPT = /\.(mjs|cjs|js|ts|mts|cts|jsx|tsx|py|sh|bash|zsh|rb|pl|php|lua)$/i

/** Package-manager subcommands that never name a user script. */
const PM_BUILTINS = new Set([
  'install', 'add', 'remove', 'rm', 'update', 'up', 'upgrade', 'i', 'ci', 'exec', 'dlx', 'x',
  'why', 'ls', 'list', 'view', 'outdated', 'config', 'publish', 'pack', 'create', 'init',
  'link', 'unlink', 'prune', 'store', 'audit', 'licenses', 'import', 'patch', 'deploy',
])

/**
 * Paths whose contents must never leave the machine, so they are never inlined
 * into the state sent to the API.
 */
const SENSITIVE_PATH = /(^|\/)(\.env(\..*)?|\.ssh|\.gnupg|\.aws|\.config\/gh|id_rsa.*|id_ed25519.*|.*\.pem|.*\.key|.*credential.*|.*secret.*|.*token.*)$/i

/**
 * Split a command on `;` / `&&` / `||` / `|` while keeping the original quoting.
 * @param command - raw command text.
 * @returns the raw segments.
 */
function splitRaw(command) {
  return command.split(/\s*(?:;|&&|\|\||\|)\s*/).filter(s => s.trim() !== '')
}

/**
 * Quote-aware whitespace tokenizer.
 * @param segment - one raw command segment.
 * @returns tokens with quotes removed.
 */
function tokenize(segment) {
  const tokens = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(segment)) !== null) tokens.push(m[1] ?? m[2] ?? m[3])
  return tokens
}

/**
 * Find the script file a command would execute, if any.
 * @param command - raw command text.
 * @returns the script path as written (possibly relative), or undefined.
 */
export function scriptTarget(command) {
  const first = splitRaw(command)[0]
  if (first === undefined) return undefined
  const tokens = tokenize(first)
  let i = 0
  while (i < tokens.length && ['sudo', 'env', 'command', 'nohup', 'time'].includes(tokens[i])) i += 1
  const head = tokens[i]
  if (head === undefined) return undefined

  if (INTERPRETERS.has(head)) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      const t = tokens[j]
      if (t.startsWith('-')) continue
      return LOOKS_LIKE_SCRIPT.test(t) ? t : undefined // `node -e "..."` has no file
    }
    return undefined
  }

  if (['pnpm', 'npm', 'yarn', 'bunx', 'npx'].includes(head)) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      const t = tokens[j]
      if (t === '--' || ['exec', 'dlx', 'x', 'run'].includes(t)) continue
      if (t.startsWith('-')) continue
      if (INTERPRETERS.has(t)) continue
      return LOOKS_LIKE_SCRIPT.test(t) ? t : undefined
    }
    return undefined
  }

  if (LOOKS_LIKE_SCRIPT.test(head) && (head.startsWith('./') || head.startsWith('/') || head.includes('/'))) return head
  return undefined
}

/**
 * Find the package.json script a command would run.
 * @param command - raw command text.
 * @returns the script name, or undefined.
 */
export function packageScriptName(command) {
  const first = splitRaw(command)[0]
  if (first === undefined) return undefined
  const tokens = tokenize(first)
  const head = tokens[0]
  if (head === undefined || !['pnpm', 'npm', 'yarn', 'bun'].includes(head)) return undefined
  if (tokens[1] === 'run' || tokens[1] === 'run-script') return tokens[2]?.startsWith('-') ? undefined : tokens[2]
  const candidate = tokens[1]
  if (candidate === undefined || candidate.startsWith('-') || PM_BUILTINS.has(candidate)) return undefined
  return candidate
}

/**
 * Read a file as text when it is small, textual and not sensitive.
 * @param path - absolute path to read.
 * @param maxBytes - size ceiling.
 * @returns the text, or a short reason why it was skipped.
 */
async function readSmallText(path, maxBytes, promptLang = FALLBACK_LANG) {
  if (SENSITIVE_PATH.test(path)) return { skipped: tIn(promptLang, 'gate.skip.sensitive') }
  try {
    const info = await stat(path)
    if (!info.isFile()) return { skipped: tIn(promptLang, 'gate.skip.notFile') }
    if (info.size > maxBytes) return { skipped: tIn(promptLang, 'gate.skip.tooLarge', { bytes: info.size }) }
    const text = await readFile(path, 'utf8')
    if (text.includes('\u0000')) return { skipped: tIn(promptLang, 'gate.skip.binary') }
    return { text }
  } catch (error) {
    return { skipped: tIn(promptLang, 'gate.skip.readError', { error: error?.code ?? error?.message ?? error }) }
  }
}

/**
 * Resolve the nearest `package.json` scripts entry by walking up from a directory.
 * @param name - script name.
 * @param cwd - starting directory.
 * @returns the script body, or undefined.
 */
async function lookupPackageScript(name, cwd) {
  let dir = cwd
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const raw = await readFile(joinPath(dir, 'package.json'), 'utf8')
      const body = JSON.parse(raw)?.scripts?.[name]
      if (typeof body === 'string') return body
    } catch {
      // keep walking up
    }
    const parent = dirname_(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Build the `state` object sent to Jev, enriching an opaque script invocation
 * with the script body (the one blind spot measured on 2026-09-20: the command
 * text alone scored 0.31 on a migration script that drops a column, while the
 * same call with the body scored 0.83).
 *
 * @param command - raw command text.
 * @param cfg - gate config (`cwd`, `inlineScripts`, `maxScriptBytes`).
 * @returns the state object.
 */
export async function buildState(command, cfg = {}) {
  // 状态是**发给判定服务的载荷**,所以它的语言是 promptLang 而不是界面语言 lang。
  const promptLang = normalizeLang(cfg.promptLang) ?? FALLBACK_LANG
  const state = { [tIn(promptLang, 'gate.state.command')]: command }
  if (cfg.inlineScripts === false) return state
  const cwd = cfg.cwd ?? process.cwd()
  const maxBytes = cfg.maxScriptBytes ?? 8192

  const pkgName = packageScriptName(command)
  if (pkgName !== undefined) {
    const body = await lookupPackageScript(pkgName, cwd)
    if (body !== undefined) {
      state[tIn(promptLang, 'gate.state.pkgScript')] = `"${pkgName}": ${body}`
      const inner = scriptTarget(body)
      if (inner !== undefined) {
        const innerPath = isAbsolute(inner) ? inner : resolvePath(cwd, inner)
        const read = await readSmallText(innerPath, maxBytes, promptLang)
        if (read.text !== undefined) {
          state[tIn(promptLang, 'gate.state.pkgScriptBody')] = truncate(read.text, maxBytes, promptLang)
        }
      }
    }
  }

  const target = scriptTarget(command)
  if (target !== undefined) {
    const path = isAbsolute(target) ? target : resolvePath(cwd, target)
    const read = await readSmallText(path, maxBytes, promptLang)
    const scriptKey = tIn(promptLang, 'gate.state.script')
    if (read.text !== undefined) state[scriptKey] = truncate(read.text, maxBytes, promptLang)
    else if (read.skipped !== undefined) state[scriptKey] = tIn(promptLang, 'gate.state.notRead', { why: read.skipped })
  }
  return state
}

function truncate(text, maxBytes, promptLang = FALLBACK_LANG) {
  return text.length <= maxBytes ? text : `${text.slice(0, maxBytes)}\n${tIn(promptLang, 'gate.truncated')}`
}

/* ------------------------------------------------------------------ *
 * 4. Jev call
 * ------------------------------------------------------------------ */

/**
 * Ask Jev the one validated question about one command state.
 * @param state - the state object (see {@link buildState}).
 * @param cfg - resolved gate config (apiKey required).
 * @param signal - optional external cancellation (combined with the timeout).
 * @returns the answer probability plus the model that answered.
 */
export async function callJev(state, cfg, signal) {
  if (!cfg.apiKey) {
    const error = new Error('no TypeSafe API key resolved')
    error.code = 'no-key'
    throw error
  }
  const timeout = AbortSignal.timeout(cfg.timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const body = {
    model: cfg.model,
    state,
    questions: { [QUESTION_ID]: judgeQuestion(cfg.promptLang) },
  }
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: combined,
  })
  if (!res.ok) {
    // 把状态码与正文挂在异常上:**分类器靠它们区分"额度用完"和"抖了一下"**,
    // 而这两者的处置完全不同(前者停 15 分钟并告警,后者只逐次 fail-open)。
    const text = (await res.text()).slice(0, 300)
    const error = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    error.status = res.status
    error.body = text
    throw error
  }
  const json = await res.json()
  const answer = json?.answers?.[QUESTION_ID]
  if (!answer || typeof answer.noul !== 'number') {
    const error = new Error(`unexpected answer shape: ${JSON.stringify(json).slice(0, 200)}`)
    error.code = 'shape'
    throw error
  }
  // 用量只用于**成本可见性**(`guard log --stats` 会累计并折算美元),不参与判定。
  const usage = json?.usage && typeof json.usage === 'object' ? json.usage : undefined
  return { p: answer.noul, model: json.model ?? cfg.model, usage }
}

/* ------------------------------------------------------------------ *
 * 4. verdict
 * ------------------------------------------------------------------ */

/**
 * 一次性放行令牌的挂载点。
 *
 * 位置很关键:它在**所有判定之后**,所以缓存过的 block/revise 也会重新检查令牌
 * (否则一条被判过的命令就永远无法凭令牌放行)。但 L0 的 `deny` 规则**不受令牌影响** ——
 * 那是四层设计里的硬地板,只能由人手动执行。
 *
 * @param command - 原始命令文本。
 * @param verdict - 判定结果。
 * @param cfg - 配置(`tokens`、`tokenPath`)。
 * @returns 原判定,或凭令牌改成放行后的判定(附带 token 字段便于审计)。
 */
async function applyToken(command, verdict, cfg) {
  if (cfg.tokens === false || verdict.action === 'allow') return verdict
  const token = commandToken(command)
  if (verdict.rule?.kind === 'deny') return { ...verdict, token } // L0 硬地板:令牌不越过
  try {
    const grant = await consumeToken(command, { tokenPath: cfg.tokenPath })
    if (!grant.ok) return { ...verdict, token }
    return {
      action: 'allow',
      source: 'token',
      token: grant.token,
      overridden: verdict.action,
      p: verdict.p,
      rule: verdict.rule,
      ms: verdict.ms,
    }
  } catch {
    // 令牌机制出错不能让判定变形:退回原判定(保守方向)
    return { ...verdict, token }
  }
}

/**
 * 降级放行:不联网、不花钱,并把"为什么"带在判定上,让每个宿主都能转达给人。
 *
 * @param state - 降级状态。
 * @param cfg - 配置(取 degradePolicy)。
 * @param now - 当前时间。
 * @param probe - 这次是不是"探测之后仍然失败"的那一次。
 * @returns 判定(总是 allow)。
 */
function degradedVerdict(state, cfg, now, probe = false) {
  return {
    action: 'allow',
    source: 'degraded',
    errorKind: state.kind,
    degraded: { kind: state.kind, label: state.label, since: state.since, until: state.until, failures: state.failures },
    warning: warningLine(state, now),
    reason: t('quota.reason.degraded', {
      kind: state.kind,
      policy: t(cfg.degradePolicy === 'off' ? 'quota.policy.off' : 'quota.policy.l0-only'),
    }),
    probe,
    ms: 0,
  }
}

/**
 * Decide what to do with one command.
 *
 * @param command - raw command text.
 * @param options - judge config; `apiKey` is required unless the prefilter answers.
 *   `degradePolicy: 'off'` 让整条阀门在降级期间暂停(在 L0 之前就返回);
 *   `quotaGuard: false` 可整体关掉降级检查(测试用)。
 * @returns a verdict `{ action: 'allow' | 'revise' | 'block' | 'escalate', ... }`.
 */
export async function evaluateCommand(command, options = {}) {
  const cfg = { ...DEFAULTS, ...options }
  const now = Date.now()
  const cache = cfg.cache ?? (cfg.cache = new VerdictCache(cfg.cacheSize))

  // 降级状态:先读一次,后面每个分支都用它。
  // 读失败 = 当作没降级(宁可去问一次 API,也不要被一个坏文件卡在降级态里)。
  let degradedState = cfg.quotaGuard === false ? null : await readDegraded(cfg)

  // 粘性状态("没有解析到密钥")靠**条件消失**结束,不靠时间:密钥一旦能解析到,这份状态
  // 就没有存在理由了,当场清掉。这一步零 HTTP(密钥解析是纯本地的事),所以不必等冷却、
  // 也不必等探测窗口 —— 插上密钥后的第一条命令就恢复成正常判定。
  // 作用域过滤只影响 isDegraded/probeDue 的判断,**不影响**这里的清除:清的是自己那条
  // 状态文件,谁写的都该在密钥出现后消失。
  if (degradedState !== null && isSticky(degradedState) && degradedState.kind === 'no-key' && cfg.apiKey) {
    await clearDegraded(cfg)
    degradedState = null
  }

  const degradedNow = isDegraded(degradedState, now, cfg.scope)

  // 0. 配置要求"降级期间整条阀门暂停" → 在 L0 之前就放行(连免费规则也不跑)。
  //    这是显式选择:默认的 'l0-only' 会保留免费的 L0 + 预筛。
  if (degradedNow && cfg.degradePolicy === 'off') return degradedVerdict(degradedState, cfg, now, true)

  // L0 — hard rules first, and they outrank everything below.
  // 它**不花钱、不联网**,所以降级期间照常工作 —— 这正是默认策略的用意。
  const rule = staticRule(command)
  if (rule) {
    return applyToken(command, {
      action: rule.kind === 'deny' ? 'block' : 'escalate',
      source: 'static-rule',
      rule: { id: rule.id, why: rule.why, kind: rule.kind },
      ms: 0,
      ...(degradedNow
        ? { degraded: { kind: degradedState.kind, until: degradedState.until }, warning: warningLine(degradedState, now) }
        : {}),
    }, cfg)
  }

  // L1a — provably harmless, no network.
  const fast = prefilter(command)
  if (fast) return { action: 'allow', source: 'prefilter', reason: fast, ms: 0 }

  const key = cfg.cwd ? `${cfg.cwd}\u0000${command}` : command
  const cached = cache.get(key)
  if (cached) return applyToken(command, { ...cached, source: 'cache', ms: 0 }, cfg)

  // 降级窗口内(探测还没到期)→ 直接放行,不发请求。缓存过的判定在上面已经生效,
  // 所以降级丢掉的只是"无法再用语义层判新命令",不是整个判定历史。
  if (degradedNow && !probeDue(degradedState, now, cfg.scope)) return degradedVerdict(degradedState, cfg, now)
  // 注意:探测的判据是"有状态且已到期",**不能**写成 `degradedNow && probeDue(...)` ——
  // 状态到期时 isDegraded() 恰好是 false,那样写会让"到期后的那次探测"永远不算探测,
  // 于是恢复与续期全部静默失效(本功能第一版就是这个错,自检当场抓到)。
  const isProbe = degradedState !== null && probeDue(degradedState, now, cfg.scope)

  const started = Date.now()
  const commandKey = tIn(normalizeLang(cfg.promptLang) ?? FALLBACK_LANG, 'gate.state.command')
  let state = { [commandKey]: command }
  try {
    state = await buildState(command, cfg)
  } catch {
    // enrichment is best-effort: judge the command text alone
  }

  try {
    const { p, model, usage } = await callJev(state, cfg, cfg.signal)
    // 探测成功 = 服务回来了 → 清掉降级状态。人不需要做任何事。
    if (isProbe) await clearDegraded(cfg)
    const verdict = {
      action: p >= cfg.highThreshold ? 'block' : p >= cfg.lowThreshold ? 'revise' : 'allow',
      source: 'jev',
      p,
      model,
      usage,
      lowThreshold: cfg.lowThreshold,
      highThreshold: cfg.highThreshold,
      enriched: Object.keys(state).filter(k => k !== commandKey),
      ms: Date.now() - started,
      ...(isProbe ? { probe: true, recovered: true } : {}),
    }
    cache.set(key, verdict)
    return applyToken(command, verdict, cfg)
  } catch (error) {
    // fail-open: availability of the valve must never block the agent; the
    // host's sandbox + approval pipeline still sits in front of the execution.
    const { kind, status, detail } = classifyFailure(error)
    const base = {
      action: 'allow',
      source: 'error',
      errorKind: kind,
      error: detail,
      status,
      ms: Date.now() - started,
    }
    // 持久性失败 → 进入降级:停发请求 + 留一份可读状态 + 把告警挂到这次判定上。
    // `scope` 只对本地类(`no-key`)有意义:它决定这份状态压制谁(见 DEFAULTS.scope)。
    if (DEGRADING_KINDS.includes(kind)) {
      const after = await enterDegraded(kind, { cfg, now: Date.now(), detail, status, probe: isProbe, scope: cfg.scope })
      return {
        ...base,
        degraded: { kind, label: after.label, since: after.since, until: after.until, failures: after.failures },
        warning: warningLine(after, Date.now()),
        probe: isProbe,
      }
    }
    return { ...base, ...(isProbe ? { probe: true } : {}) }
  }
}

