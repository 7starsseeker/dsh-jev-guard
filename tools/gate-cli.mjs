#!/usr/bin/env node
/**
 * Offline gate harness: run the exact production gate logic over real command
 * traffic and report what the valve WOULD do, before anything is mounted into a
 * DSH profile.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... node tools/gate-cli.mjs --sessions --limit 200
 *   node tools/gate-cli.mjs --file commands.txt --threshold 0.5 --out report.json
 *   node tools/gate-cli.mjs --selftest          # prefilter unit checks, no network
 *
 * The key is read from the environment (or --key-file) and never printed.
 *
 * @module dsh-jev-guard/tools/gate-cli
 */

import { readFile, writeFile } from 'node:fs/promises'
import { DEFAULTS, VerdictCache, evaluateCommand, prefilter } from '../lib/gate.js'
import { harvest } from './extract-commands.mjs'

/**
 * @param name - flag name including dashes.
 * @param fallback - value when absent.
 * @returns the following argument or the fallback.
 */
function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}

function flag(name) {
  return process.argv.includes(name)
}

/**
 * Mask anything that looks like an API key before it lands in a report file.
 * Real command traffic contains keys typed inline (`DEEPSEEK_API_KEY=sk-... node x`),
 * and a report is a file that gets shared, committed and quoted back into chats.
 */
const SECRET_RE = /\b(?:sk|ghp|gho|glpat|tvly|xoxb|as_sk|apikey)[-_A-Za-z0-9]{10,}/gi

/**
 * @param value - any text that may carry a credential.
 * @returns the text with recognizable credentials masked.
 */
function maskSecrets(value) {
  return String(value).replace(SECRET_RE, m => `${m.slice(0, 3)}****${m.slice(-4)}`)
}

/** Deterministic prefilter checks — these must never need the network. */
const SELFTEST = [
  ['ls -la /var/log', true],
  ['cat /etc/wsl.conf', true],
  ['grep -c "rm -rf" ~/.bash_history', true],
  ['git status --short', true],
  ['git log --oneline -5', true],
  ['git reset --hard HEAD~3', false],
  ['docker ps -a', true],
  ['docker system prune -f', false],
  ['rm -rf /tmp/build-cache', true],
  ['rm -rf /home/user/Photos/2024', false],
  ['rm -rf node_modules', true],
  ['rm -rf /', false],
  ['dd if=/dev/zero of=/dev/sda bs=1M', false],
  ['mysql -e "DROP DATABASE production"', false],
  ['df -h', true],
  ['sed -n 1,20p file.txt', true],
  ['sed -i s/a/b/ file.txt', false],
  ['find . -name "*.tmp" -delete', false],
  ['find . -name "*.tmp"', true],
  ['ls -la && rm -rf /tmp/x', true],   // 逐段判断：ls 只读 + rm 落在 /tmp
  ['ls -la && rm -rf ~/Photos', false],
  ['ls -la; df -h; git status', true],
  ['cat f | grep x | head -3', true],
  ['cat f | tee out.txt', false],
  ['echo a; echo b > file.txt', false],
  ['echo "hello > world"', true],
  ['systemctl status nginx', true],
  ['systemctl restart nginx', false],
  ['kubectl get pods', true],
  ['kubectl delete pod x', false],
]

function runSelftest() {
  let failed = 0
  for (const [command, expectedFast] of SELFTEST) {
    const got = prefilter(command) !== undefined
    const ok = got === expectedFast
    if (!ok) failed += 1
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${expectedFast ? 'allow' : 'inspect'}  ${command}\n`)
  }
  process.stdout.write(failed === 0 ? `\nprefilter selftest: all ${SELFTEST.length} passed\n` : `\nprefilter selftest: ${failed} FAILED\n`)
  process.exit(failed === 0 ? 0 : 1)
}

/**
 * Load the command set from --sessions, --file, or stdin.
 * @returns `{ commands, stats }`.
 */
async function loadCommands() {
  if (flag('--sessions')) {
    const limit = Number(arg('--limit', '0'))
    return harvest({ limit })
  }
  const file = arg('--file')
  const text = file ? await readFile(file, 'utf8') : await readFile(0, 'utf8')
  const commands = text.split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))
  const seen = new Set()
  const unique = []
  for (const c of commands) {
    if (seen.has(c)) continue
    seen.add(c)
    unique.push({ command: c, source: file ? 'file' : 'stdin' })
  }
  return { commands: unique, stats: { unique: unique.length, selected: unique.length } }
}

/**
 * Run the gate over every command with a small worker pool.
 * @param commands - `{ command, source }[]`.
 * @param cfg - gate config including apiKey.
 * @param concurrency - parallel Jev calls.
 * @returns per-command results.
 */
async function evaluateAll(commands, cfg, concurrency) {
  const results = new Array(commands.length)
  let cursor = 0
  let done = 0
  const cache = new VerdictCache(cfg.cacheSize)
  async function worker() {
    for (;;) {
      const i = cursor++
      if (i >= commands.length) return
      const { command, source, cwd } = commands[i]
      const verdict = await evaluateCommand(command, { ...cfg, cache, cwd })
      results[i] = { command, source, ...verdict }
      done += 1
      if (done % 25 === 0 || done === commands.length) {
        process.stderr.write(`  ${done}/${commands.length}\n`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return results
}

function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

function percentile(xs, p) {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

async function main() {
  if (flag('--selftest')) runSelftest()

  const keyFile = arg('--key-file')
  const apiKey = process.env.TYPESAFE_API_KEY ?? (keyFile ? (await readFile(keyFile, 'utf8')).trim() : undefined)
  const cfg = {
    ...DEFAULTS,
    apiKey,
    threshold: Number(arg('--threshold', String(DEFAULTS.threshold))),
    timeoutMs: Number(arg('--timeout', String(DEFAULTS.timeoutMs))),
    mode: arg('--mode', DEFAULTS.mode),
    cacheSize: Number(arg('--cache', String(DEFAULTS.cacheSize))),
  }

  const { commands, stats } = await loadCommands()
  process.stderr.write(`[gate] ${commands.length} 条命令 (sessions=${stats.logs ?? 0}, raw=${stats.rawCalls ?? 0})\n`)
  if (!apiKey) process.stderr.write('[gate] 警告：没有可用的 TYPESAFE_API_KEY，只有 prefilter 能给出判定\n')

  const started = Date.now()
  const results = await evaluateAll(commands, cfg, Number(arg('--concurrency', '6')))
  const wall = (Date.now() - started) / 1000

  const bySource = {}
  const byAction = { allow: 0, ask: 0, deny: 0 }
  for (const r of results) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1
    byAction[r.action] = (byAction[r.action] ?? 0) + 1
  }
  const jevMs = results.filter(r => r.source === 'jev').map(r => r.ms)
  const errors = results.filter(r => r.source === 'error')

  const flagged = results.filter(r => r.action !== 'allow')
  const enriched = results.filter(r => (r.enriched ?? []).length > 0)

  const lines = []
  lines.push('# Jev 安全阀门 · 离线验证报告\n')
  lines.push(`命令数 ${results.length}；耗时 ${wall.toFixed(1)}s；阈值 ${cfg.threshold}；模式 ${cfg.mode}\n`)
  lines.push('## 判定分布\n')
  lines.push('| 动作 | 数量 | 占比 |\n|---|---|---|')
  for (const [k, v] of Object.entries(byAction)) {
    lines.push(`| ${k} | ${v} | ${((v / results.length) * 100).toFixed(1)}% |`)
  }
  lines.push('\n## 判定来源\n')
  lines.push('| 来源 | 数量 | 含义 |\n|---|---|---|')
  const sourceMeaning = {
    prefilter: '确定性只读/可重建路径，未调用 Jev',
    cache: '命中缓存',
    jev: '真实调用了 Jev',
    error: '调用失败 → fail-open 放行',
  }
  for (const [k, v] of Object.entries(bySource)) {
    lines.push(`| ${k} | ${v} | ${sourceMeaning[k] ?? ''} |`)
  }
  lines.push(`\nJev 调用延迟：均值 ${mean(jevMs).toFixed(0)}ms，P50 ${percentile(jevMs, 0.5).toFixed(0)}ms，P95 ${percentile(jevMs, 0.95).toFixed(0)}ms\n`)
  if (errors.length > 0) {
    lines.push(`\n调用失败 ${errors.length} 条（全部 fail-open）：`)
    for (const e of errors.slice(0, 10)) lines.push(`- \`${maskSecrets(e.command).slice(0, 120)}\` → ${maskSecrets(e.error)}`)
    lines.push('')
  }
  lines.push(`\n## 会被拦下的命令（${flagged.length} 条，需人工复核误报）\n`)
  lines.push('| p | 动作 | 来源 | 补齐内容 | 命令 |\n|---|---|---|---|---|')
  for (const f of flagged.sort((a, b) => (b.p ?? 0) - (a.p ?? 0))) {
    const p = f.p === undefined ? '-' : f.p.toFixed(3)
    lines.push(`| ${p} | ${f.action} | ${f.source} | ${(f.enriched ?? []).join('+') || '-'} | \`${maskSecrets(f.command).replace(/\|/g, '\\|').slice(0, 160)}\` |`)
  }
  lines.push(`\n## 状态补齐统计\n`)
  lines.push(`有 ${enriched.length} 条命令被补齐了额外上下文（脚本正文 / 包脚本），占 ${((enriched.length / results.length) * 100).toFixed(1)}%；`
    + ` 其中被拦下的 ${enriched.filter(r => r.action !== 'allow').length} 条。\n`)
  const byKey = {}
  for (const r of enriched) for (const k of r.enriched) byKey[k] = (byKey[k] ?? 0) + 1
  if (Object.keys(byKey).length > 0) {
    lines.push('| 补齐字段 | 次数 |\n|---|---|')
    for (const [k, v] of Object.entries(byKey)) lines.push(`| ${k} | ${v} |`)
    lines.push('')
  }
  const report = `${lines.join('\n')}\n`
  const out = arg('--out', '/home/user/workspace/dsh-jev-guard/offline-report.md')
  await writeFile(out, maskSecrets(report), 'utf8')
  await writeFile(out.replace(/\.md$/, '.json'), maskSecrets(`${JSON.stringify({ cfg: { ...cfg, apiKey: undefined }, stats, byAction, bySource, results }, null, 1)}\n`), 'utf8')
  process.stdout.write(report)
  process.stderr.write(`[gate] 报告: ${out}\n`)
}

await main()
