#!/usr/bin/env node
/**
 * Harvest real shell commands for offline gate validation.
 *
 * Two sources:
 *   - DSH session logs: every `tool/call` event with name=bash carries the exact
 *     command the agent asked to run — this is the traffic the valve will see.
 *     Only `session.jsonl.zstd.dec` (decompressed) copies are readable without a
 *     zstd dependency, so those are what we scan.
 *   - ~/.bash_history: the human's own interactive commands.
 *
 * @module dsh-jev-guard/tools/extract-commands
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * Recursively collect `session.jsonl.zstd.dec` files.
 * @param dir - directory to walk.
 * @param out - accumulator.
 * @returns the accumulated file list.
 */
async function findSessionLogs(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await findSessionLogs(full, out)
    else if (entry.name === 'session.jsonl.zstd.dec') out.push(full)
  }
  return out
}

/**
 * Extract bash commands (and the session cwd) from one session log.
 * @param file - path to a decompressed session log.
 * @returns `{ cwd, commands }`.
 */
async function commandsFromLog(file) {
  const text = await readFile(file, 'utf8')
  const found = []
  let cwd
  for (const line of text.split('\n')) {
    if (!line.includes('"tool/call"') && !line.includes('"type": "session"') && !line.includes('"type":"session"')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type === 'session') {
      if (typeof event.cwd === 'string') cwd = event.cwd
      continue
    }
    const data = event?.data
    if (event?.type !== 'tool/call' || data?.name !== 'bash') continue
    let args = data.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        continue
      }
    }
    if (typeof args?.command === 'string' && args.command.trim() !== '') found.push(args.command)
  }
  return { cwd, commands: found }
}

/**
 * Read the human's interactive history.
 * @returns command strings.
 */
async function commandsFromHistory() {
  try {
    const text = await readFile(join(homedir(), '.bash_history'), 'utf8')
    return text.split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))
  } catch {
    return []
  }
}

/**
 * Collect, deduplicate and (optionally) cap the command set.
 * @param options - `{ limit, includeHistory, verbose }`.
 * @returns `{ commands, stats }`.
 */
export async function harvest(options = {}) {
  const logs = await findSessionLogs(join(DSH_HOME, 'sessions'))
  const ordered = []
  const seen = new Set()
  let raw = 0
  for (const file of logs) {
    const { cwd, commands: cmds } = await commandsFromLog(file)
    raw += cmds.length
    for (const c of cmds) {
      const key = c.trim()
      if (seen.has(key)) continue
      seen.add(key)
      ordered.push({ command: key, source: 'dsh-session', cwd })
    }
  }
  const historyRaw = options.includeHistory === false ? [] : await commandsFromHistory()
  for (const c of historyRaw) {
    if (seen.has(c)) continue
    seen.add(c)
    ordered.push({ command: c, source: 'bash-history' })
  }
  const limits = options.limit && options.limit > 0 ? ordered.slice(0, options.limit) : ordered
  return {
    commands: limits,
    stats: {
      logs: logs.length,
      rawCalls: raw,
      history: historyRaw.length,
      unique: ordered.length,
      selected: limits.length,
    },
  }
}

/**
 * 入口守卫:本模块被直接执行时才产出。⚠️ 必须留在本文件里 —— `import.meta.url` 是每个模块
 * 各自的,挪进共享模块后会变成比较那个 lib 文件自己的路径(恒为 false)。
 * 旧写法在 Windows 上恒不相等(argv1 是 `T:\…`,url 是 `file:///T:/…`),工具会"什么都不做地
 * 成功退出";工具脚本危害小,但同一根因值得一起统一。realpathSync 处理盘符/反斜杠/软链。
 * @returns true = 应当执行。
 */
function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  const limitIdx = process.argv.indexOf('--limit')
  const limit = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : 0
  const { commands, stats } = await harvest({ limit })
  if (process.argv.includes('--stats')) {
    process.stderr.write(`${JSON.stringify(stats, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(commands, null, 1)}\n`)
}
