#!/usr/bin/env node
/**
 * DSH 工具管线集成测试 —— 在**真实的** `@deepseek-ai/dsh-tools` 管线里跑一遍阀门。
 *
 * 与 `smoke-dsh-adapter.mjs` 的区别:那个用假 ctx 验证接线,这个把插件真的挂进
 * ToolRuntime,然后走 `ctx.tools.execute()` 的完整五阶段管线
 * (pre-execute → guards → execute → post-execute → result),看最终给出的
 * `ToolExecutionResult` 是不是我们要的拒绝/放行。
 *
 * 运行方式(必须在 deepseek-harness 目录树内运行,否则解析不到 @deepseek-ai/*):
 *
 *   cp tools/smoke-dsh-pipeline.mjs /home/user/deepseek-harness/.tmp-guard-pipeline.mjs
 *   cd /home/user/deepseek-harness && node .tmp-guard-pipeline.mjs
 *   rm /home/user/deepseek-harness/.tmp-guard-pipeline.mjs
 *
 * @module jev-guard/tools/smoke-dsh-pipeline
 */

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.JEV_GUARD_ROOT ?? '/mnt/t/dsh-jev-guard'
const mod = await import(`${ROOT}/adapters/dsh/index.js`)

let failures = 0
let checks = 0

/**
 * 建一个能挂起 ToolRuntime 的 Context(`ToolRuntime.inject = ['systemPrompt']`),
 * 注册一个假 bash 工具,再挂上阀门。
 * @param config - 传给插件的配置。
 * @returns the context.
 */
async function harness(config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(defineContentToolFixture({
    name: 'bash',
    description: 'bash',
    parameters: { command: { type: 'string', required: true } },
    execute: async ({ command }) => [{ type: 'text', text: `RAN: ${command}` }],
  }))
  // 测试里只注入 tools(credentials 服务由 profile 提供,这里用环境变量代替)
  await ctx.plugin({ name: mod.name, inject: ['tools'], apply: mod.apply }, config)
  return ctx
}

/**
 * 跑一条命令并返回规范化结果。
 * @param ctx - context。
 * @param command - 命令文本。
 * @returns `{ isError, text }`.
 */
async function run(ctx, command) {
  const result = await ctx.tools.execute({
    callId: `call-${Math.random().toString(36).slice(2)}`,
    name: 'bash',
    arguments: { command },
    signal: new AbortController().signal,
  })
  const text = (result?.content ?? []).map(b => (b?.type === 'text' ? b.text : `[${b?.type}]`)).join(' ')
  return { isError: Boolean(result?.isError), text }
}

/**
 * @param label - 用例名。
 * @param actual - 实得。
 * @param wantError - 期望 isError。
 * @param needles - 文本里必须出现的片段。
 */
function expect(label, actual, wantError, needles = []) {
  checks += 1
  const errOk = actual.isError === wantError
  const miss = needles.filter(n => !actual.text.includes(n))
  const ok = errOk && miss.length === 0
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${label}\n      isError=${actual.isError}(期望 ${wantError})`)
  if (miss.length) process.stdout.write(`  缺少片段: ${miss.join(' / ')}`)
  process.stdout.write(`\n      输出: ${actual.text.slice(0, 160)}\n`)
}

async function main() {
  const hasKey = Boolean(process.env.TYPESAFE_API_KEY)
  process.stdout.write(`DSH 工具管线集成测试  root=${ROOT}  ${hasKey ? '(含联网)' : '(无密钥)'}\n\n`)

  const ctx = await harness({ tools: ['bash'], inlineScripts: false })

  // 1. 只读命令:预筛放行 → 假工具真的被执行
  expect('ls -la → 真的执行(管线走通)', await run(ctx, 'ls -la'), false, ['RAN: ls -la'])

  // 2. L0 硬规则:应当在 pre-execute 就被 deny,工具体不执行
  const blocked = await run(ctx, 'git push --force origin main')
  checks += 0
  expect('git push --force → 被拦,工具体未执行', blocked, true, ['git-force-push'])
  checks += 1
  if (blocked.text.includes('RAN:')) {
    failures += 1
    process.stdout.write('FAIL  工具体竟然执行了(拦截不彻底)\n')
  } else {
    process.stdout.write('ok    工具体没有被执行(拦截发生在 dispatch 之前)\n')
  }

  // 3. L0 必问项 + 无审批服务 → 规范化拒绝(而不是静默放行)
  expect('git reset --hard → 无审批通道时被拒', await run(ctx, 'git reset --hard HEAD~1'), true, ['git-reset-hard'])

  // 4. 联网:真实目录 rm -rf
  if (hasKey) {
    const live = await run(ctx, 'rm -rf ~/dsh-cross-search')
    expect('rm -rf 真实目录 → 被拦(联网判定)', live, true, [])
  }

  // 5. 非目标工具不受影响
  const ctx2 = await harness({ tools: ['read'], inlineScripts: false })
  expect('tools 不匹配 → 放行', await run(ctx2, 'ls -la'), false, ['RAN: ls -la'])

  // 6. 会话内 notice 的形状:交给 DSH 自己的 JSON 快照校验(真实 Session.append 之前那一步)
  //
  // 为什么必须在这里做:notice 是本插件唯一"写进别人会话历史"的东西,而形状写错的表现是
  // **下次恢复会话时**报 SessionPersistenceCorruptionError —— 会话打不开,而现场离改动很远。
  // 这个校验需要 DSH 自己的模块,所以只有"在 DSH 目录树里跑"的这一份测试能做(见文件头部的运行方式)。
  let noticeOk = false
  let noticeWhy = ''
  try {
    const treeRoot = pathToFileURL(`${process.cwd()}/`)
    const values = await import(new URL('./packages/util/values/lib/index.js', treeRoot).href)
    const snapshot = values.snapshotJsonValue(mod.noticeMessage('正文', '摘要'))
    noticeOk = Object.keys(snapshot).join(',') === 'id,role,content,source'
      && Object.keys(snapshot.source).join(',') === 'kind,plugin,form,summary'
    noticeWhy = `keys=${Object.keys(snapshot).join(',')} | source=${Object.keys(snapshot.source).join(',')}`
  } catch (error) {
    noticeWhy = String(error?.message ?? error).slice(0, 200)
  }
  checks += 1
  if (!noticeOk) failures += 1
  process.stdout.write(`${noticeOk ? 'ok  ' : 'FAIL'}  notice 通过 DSH 自己的 snapshotJsonValue(Session.append 之前那一步)\n      ${noticeWhy}\n`)

  process.stdout.write(`\n${failures === 0 ? `全部通过(${checks} 组断言)` : `${failures} 组失败 / 共 ${checks} 组`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
