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
 * 编号对照表在 docs/VERIFICATION.md(第 6–22 项 + U1–U3)。
 * status: pass | fail | partial | blocked | skipped
 *
 * @module jev-guard/tools/report-result
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setLang, t } from '../lib/i18n.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// `SUMMARY.md` 是**入库给人读**的产物,所以它的默认语言是英文(与仓库里其它文档一致),
// 而不是这里默认的 zh-CN:换机器重新生成不该让它的语言漂移。要中文就 JEV_GUARD_LANG=zh-CN。
// 注意证据列里的正文是**逐字引用**(dsh.json 里记录的原话),不翻译 —— 那是史料,不是文案。
setLang(process.env.JEV_GUARD_LANG ?? 'en')
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
      if (r.status === 'blocked' && r.question) blocked.push(t('summary.blockedItem', { host, item, question: r.question }))
    }
  }
  const md = [
    t('summary.title'),
    '',
    t('summary.generatedBy'),
    '',
    `| ${t('summary.colHost')} | ${t('summary.colItem')} | ${t('summary.colStatus')} | ${t('summary.colEvidence')} | ${t('summary.colTime')} |`,
    '|---|---|---|---|---|',
    ...(rows.length > 0 ? rows : [`| — | — | — | ${t('summary.empty')} | — |`]),
    '',
    ...(blocked.length > 0 ? [t('summary.blockedHeading'), '', ...blocked, ''] : []),
    t('summary.indexHeading'),
    '',
    t('summary.index.0'),
    t('summary.index.1'),
    t('summary.index.2'),
    t('summary.index.3'),
    t('summary.index.4'),
    '',
    t('summary.channels'),
    '',
    t('summary.publish'),
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
