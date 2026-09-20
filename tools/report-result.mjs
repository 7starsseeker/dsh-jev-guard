#!/usr/bin/env node
/**
 * 结果回传器 —— 让验收结论可以被机器读回。
 *
 * 做完一项验证后,用它把结论写进 `verification-results/dsh.json`,同时自动生成人可读的
 * `SUMMARY.md`。主控 AI(或人)读这两个文件就知道整体状态。
 *
 *   node tools/report-result.mjs --item 6 --status pass \
 *        --evidence "重启后实测:git push --force 被拒,guard.log 里 rule=git-force-push"
 *
 *   node tools/report-result.mjs --item 16 --status blocked \
 *        --question "只跑了 WSL 侧,Windows 侧的入口守卫还没验,能否在 Windows 上跑一次 selftest-entry?"
 *
 *   node tools/report-result.mjs --show         只看当前全部结论
 *
 * 编号对照表在 docs/VERIFICATION.md(第 6–17 项 + U1–U3)。
 * status: pass | fail | partial | blocked | skipped
 *
 * @module jev-guard/tools/report-result
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'verification-results')
const STATUSES = new Set(['pass', 'fail', 'partial', 'blocked', 'skipped'])

/**
 * @param name - flag name including dashes.
 * @param fallback - default value.
 * @returns the following argument or the fallback.
 */
function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}

/**
 * Read one host's result file.
 * @param host - host name.
 * @returns the parsed result object.
 */
async function readHost(host) {
  try {
    return JSON.parse(await readFile(join(OUT_DIR, `${host}.json`), 'utf8'))
  } catch {
    return { host, updatedAt: null, items: {} }
  }
}

/**
 * 重建汇总表(只支持 DSH 之后,列表里只留 dsh;旧文件仍会被读到,不会被删)。
 */
async function writeSummary() {
  const hosts = ['dsh']
  const rows = []
  for (const host of hosts) {
    const data = await readHost(host)
    const entries = Object.entries(data.items ?? {})
    if (entries.length === 0) continue
    for (const [item, r] of entries) {
      rows.push(`| ${host} | ${item} | ${r.status} | ${(r.evidence ?? '').replace(/\|/g, '\\|').slice(0, 80)} | ${r.at ?? ''} |`)
    }
  }
  const blocked = []
  for (const host of hosts) {
    const data = await readHost(host)
    for (const [item, r] of Object.entries(data.items ?? {})) {
      if (r.status === 'blocked' && r.question) blocked.push(`- **${host} / 第 ${item} 项**:${r.question}`)
    }
  }
  const md = [
    '# 验证结果汇总(DSH)',
    '',
    '由 `tools/report-result.mjs` 自动生成。编号对照表在 `docs/VERIFICATION.md`。',
    '',
    '| 宿主 | 验证项 | 结论 | 证据 | 时间 |',
    '|---|---|---|---|---|',
    ...(rows.length > 0 ? rows : ['| — | — | — | 还没有任何结论 | — |']),
    '',
    ...(blocked.length > 0 ? ['## 需要主控 AI / 人介入的问题', '', ...blocked, ''] : []),
    '## 验证项编号(详见 docs/VERIFICATION.md)',
    '',
    '6-pre 适配器冒烟 + 真实工具管线 | 6 安装后 probe 被拦 | 7 误报防线 | 8/8-fix 审计日志',
    '9 令牌闭环 | 10 授权入口与理由文案 | 11 人工三通道 | 12 宿主审批通道',
    '13 额度降级(离线) | 14 降级在真实会话可见 | 15 ask 分支文案 | 16 跨平台入口守卫 | 17 Windows 引号',
    '',
    'U1–U3:人工介入三通道(令牌 / 宿主审批 / 人工手动执行)',
    '',
  ].join('\n')
  await writeFile(join(OUT_DIR, 'SUMMARY.md'), md, 'utf8')
  return md
}

/** `--show`:打印当前结论。 */
async function show() {
  const md = await writeSummary()
  process.stdout.write(`${md}\n`)
}

async function main() {
  if (process.argv.includes('--show')) return show()

  // --host 默认 dsh(本包现在只支持 DSH);保留这个参数是为了兼容既有命令与旧记录文件。
  const host = arg('--host', 'dsh')
  const item = arg('--item')
  const status = arg('--status')
  if (!item || !status) {
    process.stderr.write('用法: [--host dsh] --item <编号> --status <pass|fail|partial|blocked|skipped> [--evidence 文本] [--notes 文本] [--question 文本]\n')
    process.exit(2)
  }
  if (!STATUSES.has(status)) {
    process.stderr.write(`status 必须是: ${[...STATUSES].join(' / ')}\n`)
    process.exit(2)
  }

  await mkdir(OUT_DIR, { recursive: true })
  const data = await readHost(host)
  data.host = host
  data.updatedAt = new Date().toISOString()
  data.items = data.items ?? {}
  data.items[item] = {
    status,
    evidence: arg('--evidence', ''),
    notes: arg('--notes', ''),
    question: arg('--question', ''),
    at: data.updatedAt,
  }
  await writeFile(join(OUT_DIR, `${host}.json`), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  process.stdout.write(`已记录 ${host} 第 ${item} 项 = ${status}\n\n`)
  await show()
}

await main()
