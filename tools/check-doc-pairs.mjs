#!/usr/bin/env node
/**
 * 文档双语对的机械校验 —— 让"两份一起改"这条规矩**可执行**,而不是靠自觉。
 *
 * 背景:仓库里每份给人读的文档都有两份(英文默认 + `<name>.zh-CN.md` 中文)。双语并存的
 * 真实风险不是翻错,而是**漂移**:改了英文那份忘了中文,或者中文那份被人顺手润色,
 * 两边从此说的不是一件事。所以这里把三件事变成断言:
 *
 *   A) **逐字节保真**:中文版必须等于该文件的基线(默认 `HEAD`)加上**唯一一行**语言切换行。
 *      比对方式是枚举切换行在 H1 之后的四种插入形态(前后各 0/1 个空行)并要求逐字节命中 ——
 *      多一个空格、少一个空行、被"顺手润色"过一个字,都会当场失败。
 *      两边**故意一起改**的文档(切换行之外还有内容改动)用 `--edited-both` 列出,
 *      对它们只验 B) 与"两部各有切换行"。
 *   B) **两部同构**:英文版与中文版必须在标题层级序列、代码围栏数、表格行数、链接目标集合、
 *      数字多重集上一致。链接比较会剔除两类注定不同的目标:同文件锚点(英文标题的锚点当然
 *      与中文标题不同)与语言切换行互相指向的那两个文件名。
 *   C) **残留中文清单**:英文版里剩下的中文逐行列出来供人过目。它们**只应该是被引用的实测
 *      原文**(日志、命令样例、中文语料)—— 引用被翻译就变成了伪造,所以这类残留是对的;
 *      除此之外的任何中文都是漏翻。
 *
 *   node tools/check-doc-pairs.mjs
 *   node tools/check-doc-pairs.mjs --edited-both CHANGELOG.md,docs/DECISIONS.md
 *   node tools/check-doc-pairs.mjs --base HEAD~1        # 换基线(例如对照上一个提交)
 *
 * 退出码 0 = 全部通过;1 = 有文件对没对齐(输出里逐条说明差在哪)。
 *
 * @module jev-guard/tools/check-doc-pairs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 每份"英文默认 + 中文副本"的文件。加新文档时把它加到这里,校验才有覆盖。 */
const FILES = [
  'README.md',
  'CHANGELOG.md',
  'DEPLOY.md',
  'START-HERE.md',
  'RELEASING.md',
  'adapters/README.md',
  'verification-results/README.md',
  'docs/ARCHITECTURE.md',
  'docs/DECISIONS.md',
  'docs/DSH-INTEGRATION.md',
  'docs/MEASUREMENTS.md',
  'docs/USER-INTERVENTION.md',
  'docs/VERIFICATION.md',
  'docs/AGENT-TASK-dsh.md',
]

/**
 * @param name - flag name including dashes.
 * @param fallback - value when the flag is absent.
 * @returns the flag's value or the fallback.
 */
function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}

/** 中文副本的路径(`README.md` → `README.zh-CN.md`,其余同理)。 */
const zhOf = (p) => (/README\.md$/.test(p) ? p.replace(/README\.md$/, 'README.zh-CN.md') : p.replace(/\.md$/, '.zh-CN.md'))

/** @param p - 仓库内相对路径。 @returns 文件内容。 */
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/**
 * @param base - git 基线。
 * @param p - 仓库内相对路径。
 * @returns 该文件在基线里的内容;基线里没有这份文件(刚加的新文档)时返回 null 而不是抛错。
 */
function atBase(base, p) {
  try {
    return execFileSync('git', ['show', `${base}:${p}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
  } catch {
    // 新加的文档在基线里当然不存在 —— 那只有"结构同构"可查,保真检查对它不适用。
    return null
  }
}

/** 已配对的文档名(不含 `.md`),由 FILES 推导 —— 加新文档时不必再改下面的剔除规则。 */
const PAIR_NAMES = [...new Set(FILES.map(p => p.split('/').pop().replace(/\.md$/, '')))]
/** 语言切换行互相指向的那两个文件名,注定不同,比对链接时剔除。 */
const SWITCHER_TARGET = new RegExp(`(${PAIR_NAMES.join('|')})(\\.zh-CN)?\\.md$`)

const headings = (s) => [...s.matchAll(/^(#{1,6})\s/gm)].map(m => m[1].length).join(',')
const fences = (s) => (s.match(/^```/gm) ?? []).length
const tableRows = (s) => s.split('\n').filter(l => /^\s*\|/.test(l)).length
const links = (s) => [...s.matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1])
  // 剔两类注定不同的目标:同文件锚点、以及语言切换行互相指向的那份文件名。
  .filter(l => !l.startsWith('#'))
  .filter(l => !SWITCHER_TARGET.test(l))
  .sort()
const numbers = (s) => [...s.matchAll(/\d+(?:\.\d+)?/g)].map(m => m[0]).sort()

/**
 * 去掉语言切换行,用于"两部同构"比较(那一行本来就该不同)。
 * @param text - 文件内容。
 * @returns 去掉切换行后的内容。
 */
const withoutSwitcher = (text) => text.split('\n').filter(l => !l.startsWith('> [English](') && !l.startsWith('> **English**')).join('\n')

const base = arg('--base', 'HEAD')
const editedBoth = new Set(String(arg('--edited-both', '')).split(',').map(s => s.trim()).filter(Boolean))

let failed = 0
for (const en of FILES) {
  const zh = zhOf(en)
  const zhText = read(zh)
  const enText = read(en)
  const original = atBase(base, en)

  // A) 保真(基线里没有这份文件时,只有"两部都带切换行"这一条可查)
  const switcher = `> [English](${en.split('/').pop()}) | **简体中文**`
  const hasSwitchers = zhText.includes('> [English](') && enText.includes('> **English** | [简体中文](')
  const newFile = original === null
  let faithful = hasSwitchers
  if (!newFile && !editedBoth.has(en)) {
    const lines = original.split('\n')
    const h1 = lines.findIndex(l => l.startsWith('# '))
    const candidates = []
    for (const before of [0, 1]) {
      for (const after of [0, 1]) {
        const copy = [...lines]
        copy.splice(h1 + 1, 0, ...Array(before).fill(''), switcher, ...Array(after).fill(''))
        candidates.push(copy.join('\n'))
      }
    }
    faithful = candidates.includes(zhText)
  }
  if (!faithful) failed += 1

  // B) 两部同构
  const zhBody = withoutSwitcher(zhText)
  const diff = []
  const cmp = (name, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) diff.push(name) }
  cmp('标题', headings(enText), headings(zhBody))
  cmp('代码围栏', fences(enText), fences(zhBody))
  cmp('表格行', tableRows(enText), tableRows(zhBody))
  cmp('链接', links(enText), links(zhBody))
  cmp('数字', numbers(enText), numbers(zhBody))
  // 纯数字差异通常是"中文标题序号 一/二/三 译成 1./2./3.",提示人工确认即可。
  const onlyNumbers = diff.length > 0 && diff.every(d => d === '数字')
  if (diff.length > 0 && !onlyNumbers) failed += 1

  // C) 残留中文
  const leftovers = enText.split('\n').filter(l => /[\u4e00-\u9fff]/.test(l) && !l.startsWith('> **English**'))
  console.log(`${faithful && (diff.length === 0 || onlyNumbers) ? 'ok  ' : 'FAIL'} ${en}`)
  if (!faithful) console.log(`     中文版不等于"基线 + 仅一行切换行"的任一种形态${editedBoth.has(en) ? '(该文件声明了两边一起改,只查切换行是否都在)' : ''}`)
  if (newFile && faithful && (diff.length === 0 || onlyNumbers)) console.log('     (基线里没有这份文件:新文档只查结构同构与切换行,保真检查要等它进了基线才算数)')
  if (diff.length) console.log(`     ${onlyNumbers ? '仅数字多重集差异(标题序号 一→1. 会造成这个)' : '两部未对齐'}: ${diff.join(', ')}`)
  if (leftovers.length) console.log(`     英文版残留中文 ${leftovers.length} 行(应只有实测引用): ${leftovers.map(l => l.trim().slice(0, 60)).join(' || ')}`)
}
console.log(failed === 0 ? '\n全部文件对通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
