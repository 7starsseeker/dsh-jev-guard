#!/usr/bin/env node
/**
 * 文档双语对的机械校验 —— 让"两份一起改"这条规矩**可执行**,而不是靠自觉。
 *
 * 背景:仓库里每份给人读的文档都有两份(英文默认 + `<name>.zh-CN.md` 中文)。双语并存的
 * 真实风险不是翻错,而是**漂移**:改了英文那份忘了中文,或者中文那份被人顺手润色,
 * 两边从此说的不是一件事。所以这里把三件事变成断言:
 *
 *   A) **成对改动**:两份各自在 H1 下面带一行语言切换行(互相指向),并且相对基线(默认 `HEAD`)
 *      **不能只动一边** —— 改了英文忘了中文、或中文被顺手润色而英文没动,都会当场失败。
 *      这里**不再**拿中文版去和英文基线比:中文是真翻译,逐字节比对对任何已翻译文档恒假
 *      (那正是本检查长期红着的原因)。确属有意只改一边的,用 `--edited-both` 声明,只留一条提示。
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
  'measurements/README.md',
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

  // A) 成对改动:两边各自带语言切换行,且相对基线**必须同时变或同时不变**。
  //    (旧版把中文版与英文基线逐字节比 —— 中文是真翻译,那条对任何已翻译文档恒假,已废弃。)
  const enBase = en.split('/').pop()
  const zhBase = zh.split('/').pop()
  const lineStartingWith = (text, prefix) => text.split('\n').find(l => l.startsWith(prefix)) ?? ''
  // README 那行后面还挂着几个导航链接,所以只要求"这行以切换行开头、且确实指向对侧文件"。
  const enSwitcherOk = lineStartingWith(enText, '> **English**').includes(`[简体中文](${zhBase})`)
  const zhSwitcherOk = lineStartingWith(zhText, '> [English](').includes(`[English](${enBase})`)
  const originalEn = atBase(base, en)
  const originalZh = atBase(base, zh)
  const newFile = originalEn === null || originalZh === null
  // 比的是内容,不是工作区那份的换行风格:`git show` 永远吐 LF,而 Windows 上 core.autocrlf
  // 检出的是 CRLF —— 不归一化的话"两边都算改过",单边改动就永远抓不到。
  const norm = (s) => s.replace(/\r\n/g, '\n')
  const changedEn = originalEn !== null && norm(enText) !== norm(originalEn)
  const changedZh = originalZh !== null && norm(zhText) !== norm(originalZh)
  let faithful = enSwitcherOk && zhSwitcherOk
  let sideEdit = ''
  if (faithful && !newFile && changedEn !== changedZh) {
    sideEdit = changedEn ? '英文改了、中文版没跟着改' : '中文版改了、英文版没跟着改'
    if (!editedBoth.has(en)) faithful = false
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
  if (!enSwitcherOk || !zhSwitcherOk) {
    const missing = !enSwitcherOk && !zhSwitcherOk
      ? '两份都缺'
      : (!enSwitcherOk ? `英文版缺 \`> **English** | [简体中文](${zhBase})\`` : `中文版缺 \`> [English](${enBase}) | **简体中文**\``)
    console.log(`     语言切换行:${missing}`)
  }
  if (sideEdit) {
    console.log(editedBoth.has(en)
      ? `     只动了一边:${sideEdit}(已用 --edited-both 声明,不计失败)`
      : `     单边改动:${sideEdit}(两份要在同一个提交里一起改;确属有意只改一边就加 --edited-both ${en})`)
  }
  if (newFile && faithful && (diff.length === 0 || onlyNumbers)) console.log('     (基线里没有这份文件:新文档只查结构同构与切换行,单边改动要等它进了基线才算数)')
  if (diff.length) console.log(`     ${onlyNumbers ? '仅数字多重集差异(标题序号 一→1. 会造成这个)' : '两部未对齐'}: ${diff.join(', ')}`)
  if (leftovers.length) console.log(`     英文版残留中文 ${leftovers.length} 行(应只有实测引用): ${leftovers.map(l => l.trim().slice(0, 60)).join(' || ')}`)
}
console.log(failed === 0 ? '\n全部文件对通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
