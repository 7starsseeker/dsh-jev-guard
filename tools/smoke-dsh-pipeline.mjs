#!/usr/bin/env node
/**
 * DSH 工具管线集成测试 —— 在**真实的** `@deepseek-ai/dsh-tools` 管线里跑一遍阀门。
 *
 * 与 `smoke-dsh-adapter.mjs` 的区别:那个用假 ctx 验证接线,这个把插件真的挂进
 * ToolRuntime,然后走 `ctx.tools.execute()` 的完整五阶段管线
 * (pre-execute → guards → execute → post-execute → result),看最终给出的
 * `ToolExecutionResult` 是不是我们要的拒绝/放行。
 *
 * 运行方式:这个测试只依赖两件事,而它们必须**同时**成立
 *   ① 裸 `@deepseek-ai/*` 能解析 —— 注意 ESM 是按**文件自身所在目录**向上找 node_modules 的(不是
 *      cwd),所以在 pnpm 工作区检出里必须让本文件待在**包目录**里(如 `apps/cli`);
 *   ② `./packages/util/values/lib/index.js` 存在(第 6 项拿 DSH 自己的 `snapshotJsonValue` 校验
 *      notice 形状,那是 `Session.append` 之前的一步)—— 这一条按 **cwd** 算,只有检出**根**满足。
 * 检出的两个目录各满足一条,所以做法是搭一个临时目录把两者接过来(2026-09-23 实测:6/6;带密钥 7/7):
 *
 *   H=<DSH 检出>; T=/tmp/jev-guard-pipeline; rm -rf $T; mkdir -p $T/node_modules/@deepseek-ai
 *   for p in cordis dsh-tools dsh-session dsh-system-prompt; do
 *     ln -s $H/apps/cli/node_modules/@deepseek-ai/$p $T/node_modules/@deepseek-ai/$p; done
 *   ln -s $H/packages $T/packages
 *   cp <本文件> $T/ && cd $T && JEV_GUARD_ROOT=/mnt/t/jev-guard node smoke-dsh-pipeline.mjs
 *   # 加 TYPESAFE_API_KEY 则第 4 项会真的走一次联网判定(7/7)
 *
 * 三个**别照抄**的旧配方:从检出根直接跑会以 `ERR_MODULE_NOT_FOUND` 崩在下面的 import 上;
 * 从 `packages/core/agent-loop` 跑则第 6 项会假报 FAIL(那个 cwd 下没有 `./packages/...`);
 * 用绝对路径跑本文件(不复制)同样在 import 那一步就崩 —— 裸说明符不认 cwd。
 * 测试自身不写真实 `~/.jev-guard/`:日志与降级状态都钉在临时目录里(与 `smoke-dsh-adapter` 同规矩)。
 *
 * @module jev-guard/tools/smoke-dsh-pipeline
 */

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.JEV_GUARD_ROOT ?? '/mnt/t/dsh-jev-guard'
const mod = await import(`${ROOT}/adapters/dsh/index.js`)

/** 审计日志与降级状态都落在这里 —— 跑测试不该改动本机真实的阀门状态。 */
const SANDBOX = await mkdtemp(join(tmpdir(), 'jev-guard-pipeline-'))

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
  process.stdout.write(`DSH 工具管线集成测试  root=${ROOT}  sandbox=${SANDBOX}  ${hasKey ? '(含联网)' : '(无密钥)'}\n\n`)

  // 日志/状态钉在临时目录:真实 `~/.jev-guard/` 不该因为跑一次测试而被写入(与 smoke-dsh-adapter 同规矩)。
  const paths = { logPath: join(SANDBOX, 'guard.log'), degradedPath: join(SANDBOX, 'degraded.json') }
  const ctx = await harness({ tools: ['bash'], inlineScripts: false, ...paths })

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
  const ctx2 = await harness({ tools: ['read'], inlineScripts: false, ...paths })
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

  // 收尾与 smoke-dsh-adapter 同规矩:先等审计队列落盘(record() 是 fire-and-forget,
  // 不等它 process.exit 会丢尾部记录),再把整个临时目录删掉。
  // 审计模块从 ROOT 动态导入 —— 本文件可能被复制到临时目录里运行,相对路径在那里是无效的。
  try {
    const audit = await import(`${ROOT}/lib/audit.js`)
    await audit.flush()
  } catch {
    // 清理失败不该改变测试结论
  }
  await rm(SANDBOX, { recursive: true, force: true }).catch(() => {})

  process.stdout.write(`\n${failures === 0 ? `全部通过(${checks} 组断言)` : `${failures} 组失败 / 共 ${checks} 组`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
