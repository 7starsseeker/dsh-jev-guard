# 任务简报:DSH

> [English](AGENT-TASK-dsh.md) | **简体中文**

> **本包现在只支持 DSH**(2026-09-20 收窄,见 [DECISIONS D11](./DECISIONS.md))。
> 验收清单与编号对照表在 [`VERIFICATION.md`](./VERIFICATION.md);机制在 [`DSH-INTEGRATION.md`](./DSH-INTEGRATION.md)。
> 拿到一台新机器时照 [`../DEPLOY.md`](../DEPLOY.md) 走,并按 `VERIFICATION.md` 逐项记录结论。

DSH 是**唯一**被支持的宿主,而且它不需要赌:有原生的 `tools/pre-execute` 拦截位,
行为已从源码确认(不再需要猜测)。

## 重启前已经验证过的(2026-09-20,本机实测)

| 检查 | 命令 | 结果 |
|---|---|---|
| 适配器接线(假 ctx) | `node tools/smoke-dsh-adapter.mjs` | **9/9 通过**(含"完全权限下拒绝理由明确不是用户拒绝"、"审计里记下了 `policy` 与 `preset`"、"无密钥时 fail-open") |
| **真实工具管线集成** | 见下方说明 | **6/6 通过**:`git push --force` 与真实目录 `rm -rf` 被拦、**工具体未执行**、只读命令正常执行 |
| 组合树 | `dsh --profile web --dump-config` | 含 `dsh-jev-guard` → `name: jev-guard`,无解析错误 |
| 安装 | `dsh plugin --profile web add /mnt/t/dsh-jev-guard` | 依赖 `link:/mnt/t/dsh-jev-guard`;bundles 25 → 26;关键插件无缺失 |
| 凭据 | `~/.dsh/.credentials.yaml` 的 `refs.TYPESAFE_API_KEY` | 已写入并校验 YAML 合法(备份 `.bak-before-typesafe-*`) |
| 回退点 | 手动快照 `20260920-124708-6f5f` | 安装前的干净状态 |

跑真实管线集成测试的方法(必须在 deepseek-harness 目录树内,否则解析不到 `@deepseek-ai/*`):

```bash
cp /mnt/t/dsh-jev-guard/tools/smoke-dsh-pipeline.mjs <DSH 检出>/packages/core/agent-loop/.tmp-guard-pipeline.mjs
cd <DSH 检出>/packages/core/agent-loop
JEV_GUARD_ROOT=/mnt/t/dsh-jev-guard TYPESAFE_API_KEY=... node .tmp-guard-pipeline.mjs
rm .tmp-guard-pipeline.mjs
```

**剩下只有一件事:重启后跑第 6 项 probe。**

## 已知行为(源码级确认,不必重新验证)

| 会话审批策略 | 阀门返回 | 实际效果 |
|---|---|---|
| `ask`(workspace-write 预设) | `{kind:'ask'}` | 弹审批;理由里带 Jev 判定 |
| `never`(**完全权限 / danger-full-access**) | `{kind:'deny'}` | **直接拒绝** |

原因:`approval: 'never'` 的定义是 *never prompt anyone: every ask resolves `rejected`* ——
所以完全权限下若返回 `ask`,会被静默转成拒绝,并且理由错说成"用户拒绝了"。本包的适配器
因此读取会话策略,在 `never` 下**直接 deny 并给出准确理由**。

## 安装

```bash
# 1) 密钥:DSH 运行时优先读自己的凭据库
#    在 ~/.dsh/.credentials.yaml 的 refs 里加 TYPESAFE_API_KEY(或让 DSH 进程环境里有它)
# 2) 装插件
dsh plugin --profile web add /mnt/t/dsh-jev-guard
# 3) 重启 DSH
```

## 第 6 项:安装后 probe 是否被拦

重启后,在 DSH 会话里执行:

```bash
echo "" > ~/jev-guard-probe.txt      # 覆盖/截断一个文件,应当被拦或弹确认
```

**判定:**

- 会话审批策略是 `ask`:出现审批提示,理由里含"Jev 判定风险概率" → 通过
- 会话审批策略是 `never`(完全权限):命令**被拒**,模型收到"这不是用户手动拒绝"的说明 → 通过
- 命令照常执行了 → 检查三件事:① `dsh --dump-config` 里有没有 `jev-guard`;
  ② 密钥是否可达(日志里会有 `jev-guard: fail-open after ...` 说明是判定失败);
  ③ `tools` 配置里是否包含 `bash`。

顺手再测一条安全命令确认没被误伤:

```bash
ls -la ~ | head -3
```

**回传:**

```bash
node /mnt/t/dsh-jev-guard/tools/report-result.mjs --host dsh --item 6 --status pass \
  --evidence "完全权限模式下 echo \"\" > file 被拒,理由含'本会话是无审批提示的模式';ls -la 正常放行"
```

## 运行期可观测性(2026-09-20 已实现)

DSH 的 logger 阈值会过滤插件的 `info` 级日志 —— `dsh-web.log` 里一条 `jev-guard` 都没有。
所以阀门自己写一个**共享审计日志**:

```bash
node /mnt/t/dsh-jev-guard/bin/guard.mjs log --tail 20      # 最近 20 条判定
node /mnt/t/dsh-jev-guard/bin/guard.mjs log --stats        # 近 24 小时汇总(按动作/来源/规则)
```

- 文件:`~/.jev-guard/guard.log`(JSONL;超过 4 MiB 轮转到 `guard.log.1`)
- 每行:时间、动作、来源、p、命中规则、耗时、补齐了哪些 state、命令(写入前**已掩码密钥**)
- **DSH 插件与 CLI 写同一个文件**,所以"今天它判了什么"只需看一处

**跑 probe 时顺手看一眼**:被拦的那条应出现在 `--tail` 里,`action` 是 `block` 或 `escalate`。
如果一个记录都没有,那本身就是诊断信息:插件没跑,或日志路径不可写。
(`lib/audit.js` 的 `flush()` 已接在插件的 `dispose` 上,退出时不会丢尾部记录。)

## 被拦之后的出口:一次性放行令牌

硬拦不是死路。被拦命令的理由里带 `ALLOW-XXXXXXXXXX`,人员可以在终端执行:

```bash
node /mnt/t/dsh-jev-guard/bin/guard.mjs allow '<那条命令的原文>'   # 写入令牌
node /mnt/t/dsh-jev-guard/bin/guard.mjs allow --list              # 看待用令牌
node /mnt/t/dsh-jev-guard/bin/guard.mjs allow --revoke ALLOW-…    # 撤销
```

然后**重试同一条命令**(空白差异不影响匹配)即放行一次,令牌同时被删除。两点注意:
① **L0 的"永不允许"规则不受令牌影响**(写盘、格式化、删库这类只能人工手动执行);
② 凭令牌放行会在 `guard.log` 留下 `source: token` 记录,事后可审计。

## 回滚

```bash
dsh plugin --profile web remove jev-guard     # 然后重启
```

DSH 的 `dsh-undo-savepoint` 会在配置变更时自动存快照,也可以用它的 `undo_restore` 一键回退。
注意:安装会改 profile 的 `dependencies` 与 `dsh.profile.bundles` 两处。

## 装完之后可选的两件事(不在本简报范围内,先提出来)

1. **把 `write` / `run_code` 也纳入阀门**:改 `cordis.patch.yml` 的 `tools` 列表为
   `[bash, pwsh, write, edit]` —— 但注意非 shell 工具的判定问题需要重新设计(问句目前是针对命令的)。
2. **L0 硬规则接 `ctx.tools.guard()`**:DSH 有个"只能拒绝、不能被后续监听器翻案"的单调守卫
   (文档原话:*may deny or abstain, **never force-allow***),把"永不允许"那 21 条搬进去,
   会得到一个比 pre-execute 返回值更硬的层。
