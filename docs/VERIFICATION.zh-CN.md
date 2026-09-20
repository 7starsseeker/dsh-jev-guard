# DSH 验收清单

> [English](VERIFICATION.md) | **简体中文**

这份清单是**这份包在 DSH 上"到底验过什么"的账本**,也是**换一台机器时该怎么重验**的步骤。
每条都写了:怎么验、判定标准、以及它在 `verification-results/` 里的记录编号。

**验收铁律(三条事故换来的):**

1. **看副作用,不看"没报错"。** "命令真的被拒"+"日志真的有那条记录"才算过。
   本包出现过三层静默失效:脚本一声不响退出 0、命令照跑、日志空白(见 `MEASUREMENTS.md` §10)。
2. **两个平台各跑一遍。** Windows 与 WSL 的路径/引号/模块解析规则不同,一个平台过不代表另一个过。
3. **记录要带时间戳与原文。** `at` / `token` / `source` 这几个字段是唯一能把"我说它拦了"与"它真的拦了"分开的东西。

记录方式(写完自动汇总到 `SUMMARY.md`):

```bash
node tools/report-result.mjs --host dsh --item <编号> --status <pass|fail|partial|blocked|skipped> \
  --evidence "证据(带时间戳/令牌/关键输出)" --notes "补充或疑问"
# 卡住时:--status blocked --question "你的问题"
```

---

## A. 判定层(不装 DSH 也能验,纯离线 + 一次联网)

### 6-pre · 适配器冒烟 + 真实工具管线

```bash
node tools/smoke-dsh-adapter.mjs          # 假 ctx:接线/断言/审批策略/审计字段
node tools/smoke-dsh-pipeline.mjs         # 真 ToolRuntime 五阶段管线(需在 DSH 检出目录内跑)
```

**判定:** 冒烟全过(含"审计里记下了 `policy` 与 `preset`");管线测试给出预期的 `ToolExecutionResult`。

### 7 · 误报防线(改规则时必跑)

```bash
node tools/selftest-rules.mjs
# 双探针:命令文本里提到危险短语、以及以 2>/dev/null 结尾的普通命令,都不得被拦
echo "git push --force origin main" > /tmp/jev-anchor-test.txt
node bin/guard.mjs judge 'ls -la /var/log 2>/dev/null'
```

**判定:** 探针不被拦(散文归 Jev 判,实测 p≈0.02–0.08)。

**2026-09-20 扩充 —— 锚定必须**两个方向**都测**(48 例:25 旧 + 22 矩阵 + 1 性能):

| 方向 | 要钉住的形态 | 期望 |
|---|---|---|
| 防假阳 | 引号里的参数、注释、变量赋值、python `-c`/heredoc 里的字符串、grep 参数、`c.startswith('mkfs.ext4 …')` 这类**代码字符串** | 不命中(交给 Jev) |
| 防漏判 | 多行 heredoc / 多行 `bash -c "` 里的真命令;`\| xargs`、`timeout 30`、`nice -n 5`、`find … -exec`、多级包装 | **命中对应规则** |
| 防误伤散文 | `xargs 删除 mkfs.ext4 …`(包装器后面是中文) | 不命中 |
| 防灾难性回溯 | 4KB 纯包装器前缀(最坏输入) | < 50ms(实测 0.6ms) |

> **只看假阳会漏掉一半问题。** 第一轮修正只测了"散文不该命中",于是谁也没发现
> 锚定缺 `m` 标志导致**多行脚本里的真命令全部漏判**(见 [`MEASUREMENTS.md`](./MEASUREMENTS.md) §7.5
> 与 [`DECISIONS.md`](./DECISIONS.md) D2)。改规则时**两个方向都要跑**。
> 另外一个总是不变的量:`staticRule` 打印的 `RULE_STATS.anywhere` 必须**恒为 2**
> (`redirect-to-device`、`fork-bomb`);它变大就意味着又有一条规则退回了全文匹配。

### 8 · 审计日志(离线)+ 8-fix(运行实例)

```bash
node tools/selftest-audit.mjs             # 掩码/追加/轮转/汇总/空白 logPath
node tools/selftest-i18n.mjs              # 双语文案:目录完整性/占位符/英文残留/promptLang 不随界面语言
node bin/guard.mjs log --tail 5           # 运行实例里真的有记录
node bin/guard.mjs log --stats
```

**判定:** 离线全过;**并且**运行实例里能读到真实记录(曾经出现过"阀门在工作、日志一条没有")。

### 13 · 额度降级(离线)

```bash
node tools/selftest-quota.mjs             # 替身 fetch:402/401/403/429两种/5xx/超时/网络/坏状态文件
```

**判定:** 全过。重点确认三件事:持久性失败**降级**、瞬态失败**不降级**、
降级期间 L0 仍然拦且**零 HTTP 请求**。

---

## B. 装进 DSH 之后

### 6 · 安装后 probe 被拦

跑一条**必然被拦**的命令(不花钱):

```bash
# 在 DSH 会话里让 AI 执行:git push --force origin main
node bin/guard.mjs log --tail 1
```

**判定:** 命令真的被拒,理由含 `命中硬规则 git-force-push`;`guard.log` 里出现该记录。
**不通过时先读** `DSH-INTEGRATION.md` §5(三层静默失效)。

### 9 · 一次性令牌闭环

1. 让 AI 执行一条会被拦的真实命令(例如 `rm -rf <一个演示目录>`)。
2. 理由里应有 `ALLOW-XXXXXXXXXX` + 一行**绝对路径**的授权命令。
3. **人**在自己的终端里粘贴那一行(非 TTY 会被拒 —— 那是正确行为)。
4. 让 AI **重试一字不差的同一条命令**。

**判定:** 命令真的被执行、令牌文件变空、`guard.log` 出现 `source: token` 与 `overridden: <原动作>`。
另外验绑定:把命令换一个字 → **仍然被拦**,且公示的是**另一个**令牌。

### 10 · 授权入口与理由文案

```bash
echo | node bin/guard.mjs allow 'rm -rf /tmp/x'   # 非 TTY:应被拒并打印整行命令
node tools/selftest-reason.mjs                    # 28+ 例:绝对路径/不截断/引号转义/策略分叉
```

**判定:** 非 TTY 拒绝且给出可复制的整行;`selftest-reason` 全过。
**Windows 追加:** 理由里的引号必须是 **PowerShell** 形式(`''` 转义);`--command-file` 可用。

### 14 · 降级在真实会话里可见

注入一份降级状态(故障注入),再跑两条命令:

```bash
# 写一份 kind=quota 的 ~/.jev-guard/degraded.json(until 设在未来)
# 然后:mkfs.ext4 /dev/whatever   → L0 拒绝,理由尾部应带 ⚠️ 降级告警
#      touch /tmp/whatever        → source=degraded、ms=0(零请求)
node bin/guard.mjs status --clear   # 收工:清掉注入的状态
```

**判定:** 告警出现在**拒绝理由**里、审计里有 `level: warn` 一条、非 L0 命令为 `source=degraded` 且 `ms=0`;
`status --clear` 后回到"✅ 正常"(退出码 0)。

### 16 · 跨平台入口守卫(WSL **与** Windows 各跑一遍)

```bash
node tools/selftest-entry.mjs             # WSL
# Windows(若 DSH/Windows 或本机有 node.exe):
"C:\Program Files\nodejs\node.exe" T:\dsh-jev-guard\tools\selftest-entry.mjs
```

**判定:** 两个平台都全过。**只有 Windows 能暴露**"盘符 + 反斜杠的 argv[1]"那一类问题;
若只跑 WSL,请把它标成 `partial` 而不是 `pass`。

### 17 · 平台相关的 shell 引号(Windows)

```bash
node tools/selftest-reason.mjs    # 含真实 PowerShell 往返 + "POSIX 形式在 PS 里解析失败"的反例
```

**判定:** 全过。手工复核:把理由里那一行粘进 **PowerShell**,`--list` 应出现公示的那个令牌。

### 21 · 改名 `dsh-jev-guard` 后重启激活核对

改名、审计新增 `preset` 字段、降级/审批文案修正、移除 `serve`/`mcp` 这些改动**都要重启 DSH 才生效**。
重启后按顺序核三件,再补一次实拦:

```bash
node bin/guard.mjs status                                  # ① 退出码 0 且打印 "✅ ... 正常"
dsh --profile <你的> --dump-config | grep -A2 jev-guard     # ② bundle 的 id 与 name 都是 dsh-jev-guard
tail -n 1 ~/.jev-guard/guard.log                           # ③ 新记录应同时含 policy 与 preset
```

**判定:** ① 与 ② 必过(**有 `degraded.json` 时 `status` 退出码是 3**,那是降级不是故障)。
③ 要**重启之后**的新记录里出现 `preset`(如 `danger-full-access` / `workspace-write`)——
这是"跑的是改名后的新适配器"的硬证据,旧版没有这个字段;`policy` 同理。

最后交一条**本来就该被拦**的命令做端到端复验(挑效果无害的那种,例如 `truncate -s 0` 一个 /tmp 探针文件),
确认三件事:拦截理由照常给出、审计里出现对应记录(`action=escalate` / `decision=deny` /
`source=static-rule` + 同一个令牌)、且**命令确实没被执行**(探针文件不存在 = 拦在事前,不是事后告警)。

### 22 · 判定动作随审批模式分叉(`ask` 转人工 / `never` 拦死 / L0 绝对闸门)

改的是 [`DECISIONS.md`](./DECISIONS.md) **D13**。先跑两个离线的,它们覆盖路由矩阵本身:

```bash
node tools/selftest-reason.mjs      # 56 例:含 revise/block × ask/never × L0 的路由矩阵
node tools/smoke-dsh-adapter.mjs    # 10 组:含"L0 硬规则连试 4 次始终是 deny(不被预算升级成弹窗)"
```

然后**真机两边都要跑**(策略切换在会话里就能改,不必重启):

| 场景 | 交什么命令 | 期望 |
|---|---|---|
| `ask` + 灰区 | 一条落在 50–70% 的命令(看 `guard.log` 里的 `p`) | **弹审批框**;理由抬头是"需要人工确认",且带三种降级模板;**不出现**令牌授权行 |
| `never` + 同一条 | 同上 | **直接拒绝**,附令牌授权行 |
| `ask` + L0 硬规则 | `git push --force origin main`(在无 remote 或安全仓库里) | **直接拒绝、不弹窗**;审计 `decision=deny` |
| `ask` + L0 硬规则连试 4 次 | 同上,重复提交 | 仍然**一次都不弹**(预算不升级硬规则);审计里 `attempts` 递增到 4 |

**判定:** 离线两套全过 + 真机四行都符合。**只跑 `never` 一侧不算过**(路由分叉正是这次改的东西),
标 `partial`。批准一次之后记得确认:被批准的那条命令**确实执行了**(`kind: 'ask'` 经宿主审批后放行),
说明转人工不是"拦截换了个说法"。

### 23 · 双语文案与语言开关

机制见 [`DECISIONS.md`](./DECISIONS.md) **D14**,实测见 [`MEASUREMENTS.md`](./MEASUREMENTS.md) §14。

```bash
node tools/selftest-i18n.mjs          # 24 例:两语言同键/占位符一致/英文无残留中文/问话不受界面语言影响
node tools/selftest-entry.mjs         # 20 例:含 --lang / JEV_GUARD_LANG / "开关的值不是位置参数"
```

真机四条(每条都要**两种语言各看一眼**):

| 场景 | 命令 | 期望 |
|---|---|---|
| 默认语言 | `node bin/guard.mjs status` | 未显式设置时 = `zh-CN`(不看系统 locale;见 D14 里 WSL `en-US` 兜底值那次教训) |
| 显式切换 | `node bin/guard.mjs status --lang en` | 全英文;`--lang zh-CN` 全中文 |
| 环境变量 | `JEV_GUARD_LANG=en node bin/guard.mjs rules` | 规则清单理由变英文(规则 id 不变) |
| 判定不变 | 同一批命令各语言跑一次 `judge --json` | `action` / `p` / `source` **逐字段一致**,只有理由文案不同 |

**判定:** 离线两套全过 + 真机四条符合。**只跑一种语言不算过** —— 这一项验的正是"两种语言下判定一致、
文案各自正确"。另需确认:改 `lang` **不得**改变 `guard.log` 里的 action/decision(可用同一批命令前后对比)。

> `promptLang` 不在本项的通过条件里:它不是文案开关而是一个判定参数,切它属于重标定,
> 见 MEASUREMENTS §14 —— 拿 `tools/probe-prompt-lang.mjs --repeat 3` 重新量过才算数。

---

## C. 人工介入三通道(任何机器都要跑)

三条通道的机制与各性质见 [`USER-INTERVENTION.md`](./USER-INTERVENTION.md)。

### U1 · 一次性令牌通道(**宿主无关**的那条)

1. 制造一次拦截,记下理由里公示的令牌。
2. 在人自己的终端里粘贴授权行;`node bin/guard.mjs allow --list` 应出现该令牌。
3. 让 AI 重试**一字不差**的同一条命令 → 放行、令牌消失、`guard.log` 记 `source=token`。

### U2 · 宿主审批通道(DSH 有,**必测**)

1. 把会话切到带审批的模式(`approval: ask`)。
2. 触发一次 `escalate` 类拦截(命中 L0 `ask` 规则的命令,如 `truncate -s 0 <演示文件>`)。
3. **人**应真的看到审批弹窗,且弹窗里的理由**就是阀门的原文**(硬规则 id + why),并且
   **不再附**"复制到终端授权"那一行(人就在窗口前面)。

**判定:** 弹窗出现且带原文;点允许后命令执行(`outcome=allowed-once`)。
会话日志里能查到成对的 `approval/asked` + `approval/decided`。

### U3 · 人工手动执行 ≠ 给 AI 授权(反直觉,但必须验)

1. 让人在终端里**直接**执行那条被拦的命令(不走令牌、不走弹窗)。
2. 观察两件事:审计里那条命令的判定记录**零新增**;让 AI 重试同一条命令 → **仍然被拦**。

**判定:** "零新增 + 仍被拦" = 通过。失败意味着存在未察觉的授权泄漏。

> 统计审计时注意一个陷阱:`guard.log` 记录的是**每条经过判定的命令文本**,
> 所以用子串 `grep` 统计某条命令时,**自己的检查命令**(里面引用了那段文本)也会被数进去。
> 请用「`command` 字段以该命令开头」精确过滤。

---

## D. 编号速查

| 编号 | 验的是什么 | 记录 |
|---|---|---|
| 6-pre | 适配器冒烟 + 真实工具管线 | ✅ pass |
| 6 | 安装后 probe 被拦 | ✅ pass |
| 7 | 误报防线 | ✅ pass |
| 8 / 8-fix | 审计日志(离线 / 运行实例) | ✅ pass |
| 9 | 令牌闭环 | ✅ pass |
| 10 | 授权入口与理由文案 | ✅ pass |
| 11 | 人工三通道(用户手工验收) | ✅ pass |
| 12 | 宿主审批通道 | ✅ pass |
| 13 | 额度降级(离线 + CLI) | ✅ pass |
| 14 | 降级在真实会话可见 | ✅ pass |
| 15 | `ask` 分支文案分叉 | ✅ pass |
| 16 | 跨平台入口守卫(WSL + Windows) | 见 `SUMMARY.md` |
| 17 | 平台相关 shell 引号(Windows) | 见 `SUMMARY.md` |
| 18 | 收窄为 DSH 专用 | 见 `SUMMARY.md` |
| 19 | 包内清除非 DSH 痕迹 | 见 `SUMMARY.md` |
| 20 | 包内现状核对(只描述 DSH) | 见 `SUMMARY.md` |
| 21 | 改名 `dsh-jev-guard` 后重启激活核对 | 见 `SUMMARY.md` |
| 22 | 判定动作随审批模式分叉(`ask` 转人工 / `never` 拦死 / L0 绝对闸门) | 见 `SUMMARY.md` |
| 23 | 双语文案与语言开关(两种语言下判定一致) | 见 `SUMMARY.md` |
| U1–U3 | 人工介入三通道 | 记在 11 / 12 |

历史:本清单早期还有几条"别的执行通道能不能承载拦截"的前置验证(编号 1–5),已随
"只支持 DSH"的决定作废 —— 那些实现**已从本包移除**,可迁移的教训保留在
[`MEASUREMENTS.md`](./MEASUREMENTS.md) §12 与 [`DECISIONS.md`](./DECISIONS.md) D11。
