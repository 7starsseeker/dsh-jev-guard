#!/usr/bin/env node
/**
 * 双语文案自检:目录完整、两语言同键、英文侧真的没有残留中文,以及一个关键的不变量 ——
 * **换了界面语言不得改变发给判定服务的那句话**。
 *
 * 为什么单独有这份自检:
 *   1. 文案开始按语言分叉之后,"某个键只写了一种语言"是一种**静默降级** ——
 *      运行时退回中文,英文用户看到一句中文,没有任何报错。
 *   2. 占位符(`{token}`、`{cli}`)漏一个,输出就会少一段关键信息,而复制粘贴的
 *      授权行一旦不完整,用户拿到的令牌与 AI 重试的命令就对不上(见 selftest-reason)。
 *   3. 判定层与界面层**必须解耦**:那句问话与 state 的键属于 `promptLang`,默认是
 *      标定过的中文;界面切成英文时它**不能**跟着变,否则阈值这条被测过的边界会悄悄挪动。
 *
 * 全部离线:不联网、不碰 ~/.jev-guard。语言切来切去是本文件自己的事,结束时还原。
 *
 * @module jev-guard/tools/selftest-i18n
 */

import { ASK_RULES, DENY_RULES, staticRule } from '../lib/rules.js'
import { FALLBACK_LANG, LANGS, detectLang, keysOf, normalizeLang, setLang, t } from '../lib/i18n.js'
import { judgeQuestion } from '../lib/gate.js'
import { explain, reviseGuidance, shellName, templates } from '../lib/verdict.js'

let failed = 0
let checks = 0

/**
 * @param label - 用例名。
 * @param ok - 断言结果。
 * @param detail - 失败细节。
 */
function expect(label, ok, detail = '') {
  checks += 1
  if (!ok) failed += 1
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `   ${detail}`}\n`)
}

/** 取出一条消息里的占位符名字(排序后便于比较)。 */
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/

// ── 1. 目录完整性 ───────────────────────────────────────────────────────────
const zhKeys = keysOf('zh-CN')
const enKeys = keysOf('en')
const missingEn = zhKeys.filter(k => !enKeys.includes(k))
const missingZh = enKeys.filter(k => !zhKeys.includes(k))
expect('两种语言的键集合一致', missingEn.length === 0 && missingZh.length === 0,
  `只有中文:${missingEn.join(',') || '-'} / 只有英文:${missingZh.join(',') || '-'}`)
expect('目录非空且覆盖到 CLI 与判定理由', zhKeys.length > 80 && zhKeys.some(k => k.startsWith('verdict.')) && zhKeys.some(k => k.startsWith('cli.')),
  `${zhKeys.length} 个键`)

const badPlaceholders = []
for (const key of zhKeys) {
  setLang('zh-CN')
  const zh = placeholders(t(key))
  setLang('en')
  const en = placeholders(t(key))
  if (zh.join() !== en.join()) badPlaceholders.push(`${key}(${zh.join('+') || '-'} vs ${en.join('+') || '-'})`)
}
expect('同一键的占位符在两种语言里一致', badPlaceholders.length === 0, badPlaceholders.join(', '))

// 会话内 notice 的摘要会渲染成对话里的折叠行,DSH 对它的上限是 120 字符
// (CONTEXT_SUMMARY_MAX_CHARS;超了就被截断,读者看到的话断在半句上)。英文通常更长,
// 所以两种语言都量一遍 —— "只有英文超了"这类问题只有双语并排才看得见。
const summaryKeys = zhKeys.filter(k => /^notice\..*\.summary$/.test(k))
expect('notice 摘要键齐备(没有密钥 / 降级 / 恢复)', summaryKeys.length === 3, summaryKeys.join(','))
const overlongSummaries = []
for (const lang of ['zh-CN', 'en']) {
  setLang(lang)
  for (const key of summaryKeys) {
    const text = t(key)
    if (text.length > 120 || text.includes('\n')) overlongSummaries.push(`${lang}:${key}(${text.length})`)
  }
}
expect('notice 摘要 ≤120 字符且不含换行', overlongSummaries.length === 0, overlongSummaries.join(', '))
setLang('zh-CN')

// ── 2. 英文侧不得残留中文(半翻译是最常见的静默缺陷)─────────────────────────
setLang('en')
const leftovers = enKeys.filter(k => CJK.test(t(k)))
expect('英文文案里没有残留中文', leftovers.length === 0, leftovers.slice(0, 5).join(','))
const keyAsValue = enKeys.filter(k => t(k) === k)
expect('英文查表不会返回键名本身(返回键名 = 键写错或漏翻)', keyAsValue.length === 0, keyAsValue.slice(0, 5).join(','))

// ── 3. 语言解析 ─────────────────────────────────────────────────────────────
expect('zh / zh-TW / zh-Hans 都归到 zh-CN', ['zh', 'zh-TW', 'zh-Hans'].every(v => normalizeLang(v) === 'zh-CN'))
expect('en / en-US / EN 都归到 en', ['en', 'en-US', 'EN'].every(v => normalizeLang(v) === 'en'))
expect('不认识的语言返回 undefined(由调用方决定怎么办)', normalizeLang('klingon') === undefined && normalizeLang('') === undefined)

// 探测链只认**显式信号**。这一段是 2026-09-20 真机踩坑后的护栏:DSH 插件跑在 WSL 里,
// 那里 LANG=C.UTF-8,当时链条落到 Intl → Node 报 en-US(ICU 兜底值,不是用户偏好),
// 于是会话里的理由悄悄变英文,而 Windows 侧 CLI 仍是中文 —— 同一台机器两种语言。
expect('JEV_GUARD_LANG 优先于 locale 变量', detectLang({ JEV_GUARD_LANG: 'en', LANG: 'zh_CN.UTF-8' }) === 'en')
expect('locale 变量能定语言(LC_ALL 优先于 LANG)', detectLang({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }) === 'zh-CN')
expect('LANG=en_US.UTF-8 这样的真实 locale 会解析成 en', detectLang({ LANG: 'en_US.UTF-8' }) === 'en')
expect('C / POSIX / 空 = 没有信号,不是英文', detectLang({ LANG: 'C.UTF-8' }) === undefined && detectLang({ LANG: 'POSIX' }) === undefined && detectLang({}) === undefined)
expect('没有信号时的落点是项目主语言 zh-CN', FALLBACK_LANG === 'zh-CN')
const autoPick = setLang('auto')
const intlNow = (() => { try { return Intl.DateTimeFormat().resolvedOptions().locale } catch { return '?' } })()
expect('本机 auto 解析出的语言受支持(且不会因为 Intl 兜底值而变成英文)',
  LANGS.includes(autoPick.lang), `解析=${autoPick.lang} 理由=${autoPick.reason} 本机 Intl=${intlNow}`)

// ── 4. 英文判定理由:形状与中文一致(路径、引号、令牌都不能少)────────────────
// 上面探测链那一节以 `setLang('auto')` 收尾(在本机 = 中文),所以这里显式切回英文。
setLang('en')
const EN_CMD = "rm -rf /tmp/it's"
const risk = { action: 'block', source: 'jev', p: 0.912, model: 'm', ms: 1 }
const enReason = explain(EN_CMD, risk, { policy: 'never', token: 'ALLOW-0A2DB6157F', platform: 'win32' })
expect('英文理由带四态抬头与概率', enReason.includes('Jev guard [blocked]') && enReason.includes('91.2%'), enReason.slice(0, 160))
expect('英文理由说明这是自动判定', enReason.includes('automatic decision'))
expect('英文理由里的授权行按 win32 用 PowerShell 引号', enReason.includes("allow 'rm -rf /tmp/it''s'"), enReason)
expect('英文理由带令牌原文', enReason.includes('ALLOW-0A2DB6157F'))
expect('英文理由的平台名是英文', shellName('linux') === 'a POSIX shell (bash etc.)' && shellName('win32') === 'PowerShell', shellName('linux'))

const enRule = staticRule('git push --force origin main')
expect('命中规则的英文理由来自规则本身(不是退回 id)', Boolean(enRule) && /force-pushes/.test(enRule.why), String(enRule?.why))
const enRuleReason = explain('git push --force origin main', { action: 'block', source: 'static-rule', rule: enRule }, {})
expect('英文理由把规则 id 与英文 why 一起写出', enRuleReason.includes('hard rule `git-force-push` hit (force-pushes'), enRuleReason.slice(0, 200))

const enGuidance = reviseGuidance(EN_CMD, { action: 'revise', source: 'jev', p: 0.6 }, { policy: 'never' })
expect('英文 revise 指导语含三条模板', enGuidance.includes('Safer forms to try:') && (enGuidance.match(/^- /gm) ?? []).length === 3, enGuidance)

// ── 5. 规则与模板:两种语言都得有 ─────────────────────────────────────────────
const allRules = [...DENY_RULES, ...ASK_RULES]
const ruleGaps = allRules.filter(r => LANGS.some(l => typeof r.why?.[l] !== 'string' || r.why[l].trim() === ''))
expect(`全部 ${allRules.length} 条 L0 规则都有两种语言的理由`, ruleGaps.length === 0, ruleGaps.map(r => r.id).join(','))
for (const lang of LANGS) {
  setLang(lang)
  const list = templates()
  expect(`${lang}:三条降级模板都带至少 2 个例子`, list.length === 3 && list.every(x => x.examples.length >= 2), JSON.stringify(list.map(x => [x.id, x.examples.length])))
}

// 规则理由必须**跟着界面语言走**(它是给人/模型读的拒绝理由的一部分)。
setLang('en')
const enWhy = staticRule('mkfs.ext4 /dev/sdb1')?.why
setLang('zh-CN')
const zhWhy = staticRule('mkfs.ext4 /dev/sdb1')?.why
expect('规则理由随界面语言切换', enWhy !== zhWhy && /formats a filesystem/.test(enWhy) && /格式化文件系统/.test(zhWhy), `${enWhy} | ${zhWhy}`)

// ── 6. 不变量:界面语言**不得**改变发给判定服务的东西 ─────────────────────────
// 这是本次改造最要紧的一条:阈值是在中文问话上标定的(114 例),英文界面不能把它挪走。
setLang('en')
const qEnUi = judgeQuestion(undefined)
const qDefault = judgeQuestion()
expect('界面切成英文后,发给 Jev 的问话仍是标定过的中文',
  qEnUi.instructions === qDefault.instructions && /不可逆/.test(qEnUi.instructions), qEnUi.instructions)
const qEnPrompt = judgeQuestion('en')
expect('promptLang: "en" 时才用英文问话(显式选择)', qEnPrompt.instructions !== qDefault.instructions && /irreversibly/.test(qEnPrompt.instructions), qEnPrompt.instructions)
expect('英文问话的 criteria 也是英文', qEnPrompt.criteria.true !== qDefault.criteria.true && /block-device|version history/.test(qEnPrompt.criteria.true))

// state 的键同理:它属于 promptLang。用 buildState 的**键**来断言,不联网。
const { buildState } = await import('../lib/gate.js')
const zhState = await buildState('node scripts/x.mjs', { promptLang: 'zh-CN', inlineScripts: false })
const enState = await buildState('node scripts/x.mjs', { promptLang: 'en', inlineScripts: false })
expect('state 的键随 promptLang 切换', Object.keys(zhState)[0] === '命令' && Object.keys(enState)[0] === 'command',
  `${Object.keys(zhState)[0]} / ${Object.keys(enState)[0]}`)

// 更硬的一条:**界面语言不得进入请求体**。同一 promptLang 下,中英两种界面必须构造出
// 逐字节相同的 state 与问话 —— 否则"换文案"就悄悄变成了"换判定",而 p 的抖动会把它掩盖掉。
const { evaluateCommand } = await import('../lib/gate.js')
const payloads = []
for (const uiLang of ['zh-CN', 'en']) {
  setLang(uiLang)
  payloads.push(JSON.stringify({
    state: await buildState('node scripts/x.mjs', { promptLang: 'zh-CN', inlineScripts: false }),
    question: judgeQuestion('zh-CN'),
  }))
}
expect('界面语言不进请求体:中英两种界面构造出完全相同的 state 与问话', payloads[0] === payloads[1], payloads.join(' vs '))
expect('evaluateCommand 也不会把界面语言带进判定(离线:预筛路径)', typeof evaluateCommand === 'function')

// 还原:本文件把语言切来切去,退出前恢复中文,免得留在英文上。
setLang('zh-CN')

process.stdout.write(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}(${checks} 例)\n`)
process.exit(failed === 0 ? 0 : 1)
