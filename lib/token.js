/**
 * 一次性放行令牌 —— 给"硬拦"一个明确的人工出口。
 *
 * 为什么需要它:在完全权限(approval=never)模式里,`revise` 和 `block` 都会变成**硬拦**,
 * 没有审批弹窗可点。实测代价:连"删一个过期文件"这种正当清理(p≈0.62)也会被拦,
 * 而抬阈值会让真正的破坏(0.68–0.82)有一半漏过。与其在阈值上二选一,不如给一个**精确到
 * 单条命令**的人工出口:
 *
 *   1. 阀门拦下命令,并在理由里给出 `ALLOW-XXXXXXXXXX`;
 *   2. 人在终端跑 `guard allow '<原命令>'`(或把令牌写进 allow.txt);
 *   3. 调用方重试**同一条命令** → 阀门发现令牌 → **消费掉它** → 放行这一次。
 *
 * 三条安全性质:
 *   · **绑定具体命令** —— 令牌是规范化命令的哈希前 10 位,换一条命令就换成另一个令牌;
 *   · **一次性** —— 用掉即从文件删除,无法重放;
 *   · **不越过 L0** —— L0 的"永不允许"规则(dd 写盘、格式化、删库…)不受令牌影响,
 *     这是四层设计里 L0 的硬地板。
 *
 * @module jev-guard/token
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HOME_DIR } from './audit.js'

/** 令牌文件默认位置(一行一个令牌,`#` 后为注释)。 */
export const DEFAULT_TOKEN_PATH = process.env.JEV_GUARD_ALLOW_FILE ?? join(HOME_DIR, 'allow.txt')

/** 令牌前缀,便于在日志与对话里辨认。 */
export const TOKEN_PREFIX = 'ALLOW-'

/**
 * 解析令牌文件路径。
 *
 * 与 `audit.resolveLogPath` 同一条教训(实测踩过):配置里的空串/纯空白必须当作
 * "未配置",`??` 不够。
 *
 * @param options - `{ tokenPath }`。
 * @returns 实际使用的令牌文件路径。
 */
export function resolveTokenPath(options = {}) {
  const configured = options?.tokenPath
  return typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_TOKEN_PATH
}

/**
 * 把命令规范化后再哈希 —— 空白差异(多空格、换行)不应改变令牌。
 * @param command - 原始命令文本。
 * @returns 规范化后的命令。
 */
export function canonicalize(command) {
  return String(command ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 计算一条命令的放行令牌。
 * @param command - 原始命令文本。
 * @returns 形如 `ALLOW-3F9A2C7B14` 的令牌。
 */
export function commandToken(command) {
  const digest = createHash('sha256').update(canonicalize(command)).digest('hex')
  return `${TOKEN_PREFIX}${digest.slice(0, 10).toUpperCase()}`
}

/**
 * 读取令牌文件(不存在则视为空)。
 * @param path - 令牌文件路径。
 * @returns 令牌数组(已去注释与空白)。
 */
export async function readTokens(path = DEFAULT_TOKEN_PATH) {
  try {
    const text = await readFile(path, 'utf8')
    return text
      .split('\n')
      .map(l => l.split('#')[0].trim())
      .filter(l => l !== '')
  } catch {
    return []
  }
}

/** 串行化读改写,避免并发消费互相覆盖。 */
let chain = Promise.resolve()

/**
 * 尝试用令牌放行一条命令:命中则**消费**(从文件移除)并返回成功。
 *
 * @param command - 原始命令文本。
 * @param options - `{ tokenPath }`。
 * @returns `{ ok, token, reason? }` —— `reason` 说明为何没命中。
 */
export function consumeToken(command, options = {}) {
  const path = resolveTokenPath(options)
  const token = commandToken(command)
  const run = chain.then(async () => {
    const tokens = await readTokens(path)
    if (!tokens.includes(token)) {
      return { ok: false, token, reason: tokens.length === 0 ? '令牌文件为空' : '该命令没有对应令牌' }
    }
    const kept = tokens.filter(t => t !== token)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8')
    await rename(tmp, path) // 原子替换
    return { ok: true, token, remaining: kept.length }
  })
  chain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 为一条命令写入令牌(人工授权入口:`guard allow '<命令>'`)。
 * @param command - 原始命令文本。
 * @param options - `{ tokenPath, note }`。
 * @returns `{ token, path, already }`。
 */
export function grantToken(command, options = {}) {
  const path = resolveTokenPath(options)
  const token = commandToken(command)
  const run = chain.then(async () => {
    const tokens = await readTokens(path)
    if (tokens.includes(token)) return { token, path, already: true }
    await mkdir(dirname(path), { recursive: true })
    const note = options.note ? `  # ${options.note}` : `  # ${new Date().toISOString()}`
    await writeFile(path, `${[...tokens, `${token}${note}`].join('\n')}\n`, 'utf8')
    return { token, path, already: false }
  })
  chain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 撤销一个令牌。
 * @param token - 形如 `ALLOW-…` 的令牌(大小写不敏感,可省略前缀)。
 * @param options - `{ tokenPath }`。
 * @returns `{ removed }`。
 */
export function revokeToken(token, options = {}) {
  const path = resolveTokenPath(options)
  const wanted = String(token).trim().toUpperCase()
  const normalized = wanted.startsWith(TOKEN_PREFIX) ? wanted : `${TOKEN_PREFIX}${wanted}`
  const run = chain.then(async () => {
    const tokens = await readTokens(path)
    const kept = tokens.filter(t => t.toUpperCase() !== normalized)
    const removed = tokens.length - kept.length
    if (removed > 0) {
      await writeFile(path, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8')
    }
    return { removed, remaining: kept.length }
  })
  chain = run.then(() => undefined, () => undefined)
  return run
}
