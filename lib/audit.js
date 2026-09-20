/**
 * 决策审计日志 —— 让"阀门到底做了什么"可以被看见。
 *
 * 背景(2026-09-20 实测):DSH 的 logger 阈值把插件的 info 级日志过滤掉了,
 * `dsh-web.log` 里一条 `jev-guard` 都没有。结果运行期只能靠"命令被拦"这种间接
 * 现象判断它还活着,想回答"今天它拦了什么/放行了什么/有没有 fail-open"完全做不到。
 *
 * 这个模块把**每一个判定**追加写到 `<JEV_GUARD_HOME>/guard.log`(默认
 * `~/.jev-guard/guard.log`),JSONL 格式,写它的有:
 *
 *   DSH 插件(会话里每次工具调用)· CLI(`guard judge` / 离线复核脚本)
 *
 * 一份文件而不是"每个入口一份",是为了让"它到底做了什么"只有一个答案 ——
 * 尤其是离线复核与真实会话混在一起看的时候。
 * 三条设计约束:
 *   1. **绝不抛错、绝不阻塞判定** —— 日志写失败不能影响安全决策(串行队列 + 全 catch)。
 *   2. **写入前掩码** —— 命令文本可能内联密钥(实测你的历史里有这种写法),所以
 *      任何像 `sk-…`/`ghp_…`/`tvly-…` 的片段都会被改写成 `sk-****尾4`。
 *   3. **有上限** —— 超过 `logMaxBytes` 就轮转到 `guard.log.1`,不会无限增长。
 *
 * 查看方式:`node bin/guard.mjs log --tail 20` / `--stats`。
 *
 * @module jev-guard/audit
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 日志目录;可用环境变量覆盖(测试/多实例用)。 */
export const HOME_DIR = process.env.JEV_GUARD_HOME ?? join(homedir(), '.jev-guard')

/** 默认日志路径;`JEV_GUARD_AUDIT_LOG` 可覆盖。 */
export const DEFAULT_LOG_PATH = process.env.JEV_GUARD_AUDIT_LOG ?? join(HOME_DIR, 'guard.log')

/** 默认单文件上限(4 MiB)。 */
export const DEFAULT_LOG_MAX_BYTES = Number(process.env.JEV_GUARD_LOG_MAX_BYTES ?? 4 * 1024 * 1024)

/** 看起来像密钥的片段(与报告掩码器保持同一套形态)。 */
const SECRET_RE = /\b(?:sk|ghp|gho|glpat|tvly|xoxb|as_sk|apikey)[-_A-Za-z0-9]{10,}/gi

/**
 * 把密钥形态的片段改写为 `sk-****尾4`,其余原样。
 * @param value - 任意文本。
 * @returns 掩码后的文本。
 */
export function maskSecrets(value) {
  return String(value ?? '').replace(SECRET_RE, m => `${m.slice(0, 3)}****${m.slice(-4)}`)
}

/** 串行队列:保证并发判定时写入不交错,也避免每次都重新 stat。 */
let queue = Promise.resolve()

/** 最近一次写入失败的原因(供 `guard log` 解释"为什么一条记录都没有")。 */
let lastError = null

/**
 * 把配置里的 logPath 解析成实际路径。
 *
 * 注意:**空串 / 纯空白必须当作"未配置"**。这是实测踩过的坑:`??` 只对 null/undefined
 * 生效,于是配置模板里表示"用默认"的 `logPath: ''` 会变成一个空路径,写入全部失败、
 * 又被 catch 静默吞掉 —— 表面现象是"阀门在工作,但日志一条都没有"(2026-09-20 实拦)。
 *
 * @param options - `{ logPath }`。
 * @returns 实际使用的日志路径。
 */
export function resolveLogPath(options = {}) {
  const configured = options?.logPath
  return typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_LOG_PATH
}

/** @returns 最近一次写入失败的原因,或 null。 */
export function lastLogError() {
  return lastError
}

/**
 * 追加一条审计记录。绝不抛错、绝不阻塞判定。
 *
 * @param entry - 记录内容,常用字段:tool / action / source / p / rule / model / ms /
 *   enriched / cwd / decision / command / error。
 * @param cfg - 可选 `{ logPath, logMaxBytes }`(空 logPath 视为未配置)。
 * @returns 一个在写入(或失败)后 resolve 的 promise —— 调用方不需要 await。
 */
export function record(entry, cfg = {}) {
  const path = resolveLogPath(cfg)
  const maxBytes = Number(cfg.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES)
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    ...entry,
    ...(entry?.command === undefined ? {} : { command: maskSecrets(entry.command).slice(0, 500) }),
  })}\n`

  queue = queue
    .then(async () => {
      await mkdir(dirname(path), { recursive: true })
      try {
        const info = await stat(path)
        if (info.size > maxBytes) await rename(path, `${path}.1`)
      } catch {
        // 文件不存在(或轮转失败)时直接追加即可
      }
      await appendFile(path, line)
      lastError = null
    })
    .catch(error => {
      // 静默是有代价的:这次就是被静默掩盖了整整一轮。留下线索给 `guard log` 显示。
      lastError = `${path}: ${String(error?.code ?? error?.message ?? error)}`
    })
  return queue
}

/**
 * 等待所有已排队的写入落盘。
 *
 * 为什么需要它:`record()` 是 fire-and-forget(不能阻塞判定),但进程若在写入完成前
 * 退出,末尾几条记录就会丢 —— 本包的冒烟测试里实测发生过。所以**宿主退出路径**
 * (DSH 的 `dispose`、CLI 结束、包装器退出前)应当 await 一次。
 *
 * @returns 队列尾部的 promise(写入失败也 resolve,不抛)。
 */
export function flush() {
  return queue
}

/**
 * 读取日志尾部若干条。
 * @param options - `{ logPath, tail }`。
 * @returns 解析后的记录数组(最新的在最后;无法解析的行被跳过)。
 */
export async function readTail(options = {}) {
  const path = resolveLogPath(options)
  const tail = options.tail ?? 20
  const { readFile } = await import('node:fs/promises')
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n').filter(l => l.trim() !== '')
  const out = []
  for (const line of lines.slice(-tail)) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // 跳过损坏行
    }
  }
  return out
}

/**
 * 汇总日志统计。
 * @param options - `{ logPath, since, pricePerMTok }}`,since 为毫秒时间戳(默认 24 小时前)。
 * @returns `{ total, byAction, bySource, byRule, byErrorKind, failOpen, degraded, probes, tokens,
 *   inputTokens, costUsd, priced, warnings, firstAt, lastAt, lastDegraded }`。
 */
export async function summarize(options = {}) {
  const path = resolveLogPath(options)
  const since = options.since ?? Date.now() - 24 * 3600 * 1000
  const pricePerMTok = Number(options.pricePerMTok ?? 0.042)
  const { readFile } = await import('node:fs/promises')
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return {
      total: 0, byAction: {}, bySource: {}, byRule: {}, byErrorKind: {}, failOpen: 0,
      degraded: 0, probes: 0, tokens: 0, inputTokens: 0, costUsd: 0, priced: 0,
      warnings: 0, firstAt: null, lastAt: null, lastDegraded: null,
    }
  }
  const byAction = {}
  const bySource = {}
  const byRule = {}
  const byErrorKind = {}
  let total = 0
  let failOpen = 0
  let degraded = 0
  let probes = 0
  let tokens = 0
  let inputTokens = 0
  let priced = 0
  let warnings = 0
  let firstAt = null
  let lastAt = null
  let lastDegraded = null
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(r.at ?? '')
    if (Number.isFinite(at) && at < since) continue
    total += 1
    // level:'warn' 的记录是"给状态留的痕迹",不参与动作/来源计数,单独统计。
    if (r.level === 'warn') warnings += 1
    else {
      byAction[r.action ?? '?'] = (byAction[r.action ?? '?'] ?? 0) + 1
      bySource[r.source ?? '?'] = (bySource[r.source ?? '?'] ?? 0) + 1
    }
    if (r.rule) byRule[r.rule] = (byRule[r.rule] ?? 0) + 1
    if (r.source === 'error') failOpen += 1
    if (r.source === 'degraded') degraded += 1
    if (r.errorKind) byErrorKind[r.errorKind] = (byErrorKind[r.errorKind] ?? 0) + 1
    if (r.probe) probes += 1
    if (r.source === 'token') tokens += 1
    if (r.degraded?.kind) lastDegraded = { kind: r.degraded.kind, at: r.at }
    const usage = r.usage
    if (usage && Number.isFinite(Number(usage.input_tokens))) {
      inputTokens += Number(usage.input_tokens)
      priced += 1
    }
    if (r.at) {
      if (firstAt === null) firstAt = r.at
      lastAt = r.at
    }
  }
  return {
    total, byAction, bySource, byRule, byErrorKind, failOpen, degraded, probes, tokens,
    inputTokens, costUsd: (inputTokens / 1_000_000) * pricePerMTok, priced, warnings,
    firstAt, lastAt, lastDegraded,
  }
}
