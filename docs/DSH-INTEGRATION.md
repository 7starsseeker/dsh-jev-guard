# DSH 集成 —— 这个阀门怎样挂在 DeepSeek Harness 上

**一句话:** 本包**只支持 DSH**(2026-09-20 收窄,见 [`DECISIONS.md`](./DECISIONS.md) D11)。
判定核心在 `lib/`(宿主无关、纯函数),宿主相关的一切都集中在 `adapters/dsh/index.js` 这一个文件里。

---

## 1. 它用到了 DSH 的哪些机制

| DSH 机制 | 我们怎么用 | 拿不到会怎样 |
|---|---|---|
| **`tools/pre-execute` 瀑布** | 唯一真正的拦截点。返回 typed `PreToolDecision`:`{kind:'allow'}` / `{kind:'ask', reason}` / `{kind:'deny', reason}` | 没有它就只能做"建议层"(模型可以不理) |
| **`agent.session.snapshotEvents()` → `approval/policy`** | 读当前会话的审批策略:`ask`(会弹框)/ `never`(完全权限,ask 会被解析成拒绝) | 只能靠部署默认值猜,理由文案会说错话 |
| **`agent.session.snapshotEvents()` → `permission/preset`** | 读沙箱档位(`workspace-write` / `danger-full-access`),**只进审计** | 事后复盘看不出"当时后面还有没有沙箱" |
| **`ctx.credentials.resolve(ref)`** | 取 TypeSafe 密钥(走 DSH 的凭据层,轮换后无需重启);取不到再回落 `process.env` | 退回"从文件读",密钥轮换要重启 |
| **`exec.arguments.workdir` / `exec.agent.session.cwd`** | 判定时的工作目录(用来读取被调用脚本的正文) | 脚本正文猜不到,`node x.mjs` 这类退化为盲区 |
| **工具名 `bash` / `pwsh`** | 默认要拦的两个工具 —— 正好覆盖 **WSL/Linux(`bash`)与 Windows(`pwsh`)** | 少拦一个平台 |
| **`ctx.logger`** | 尽力而为的宿主日志(`info`/`debug` 常被宿主阈值过滤,所以**不依赖它**) | 审计靠 `~/.jev-guard/guard.log`,不靠宿主日志 |
| **`dispose`** | 退出前 `flush()` 审计队列(否则尾部记录会丢) | 最后几条判定丢失 |

**判定逻辑本身不依赖 DSH 的任何东西**:不看文件系统状态、不需要模型参与、不需要会话历史。
所以同一条判定既能被 DSH 插件在会话里调用,也能被 `bin/guard.mjs` 离线复核 —— 后者是回归测试的基础。

---

## 2. 两套策略组合:同一条命令的四种去向

| 判定 | 审批策略 `ask`(会弹框) | 审批策略 `never`(完全权限) |
|---|---|---|
| `allow` | 放行 | 放行 |
| `revise`(50–70%) | **`ask`** —— 转人工弹审批框,理由里带上三种降级模板 | **拒绝** + 降级模板,**并附**一次性令牌提示 |
| `block` ≥70%(语义层) | **`ask`** —— 转人工弹审批框 | **拒绝** + 一次性令牌提示 |
| L0 的 `deny` 类硬规则 | **拒绝**(不弹框、不发令牌) | **拒绝** |
| `escalate`(L0 的 `ask` 类规则 / 重试预算升级) | **`ask`** —— 宿主弹审批框,由人决定 | **拒绝** + 一次性令牌提示 |

两条容易搞错、但很重要的细节:

1. **`ask` 策略下,`revise` 与语义层的 `block` 也会走到人面前**(2026-09-20 改,见
   [`DECISIONS.md`](./DECISIONS.md) **D13**):人就在场时,让一个 50.6% 的判断替人做决定没有道理。
   改之前的实测代价是一天里 9 次 `revise` 拒绝发生在 `ask` 会话中,而人就在旁边。
   **例外是 L0 的 `deny` 类硬规则** —— 绝对闸门,两种策略都拒绝,也不参与 `retryLimit` 的升级。
2. **能弹框时就不再附令牌提示。** 实测教训(2026-09-20):两条人工通道同时出现在一个弹窗里,
   读者不知道该走哪条;人就在窗口前面时,令牌是多余的。

> `danger-full-access` = `{ sandbox: 'danger-full-access', approval: 'never' }`。此时**阀门是唯一一层**
> —— 没有文件沙箱兜底、审批也等于关掉。这正是它存在的意义,也是它判错时代价最大的场景。

---

## 3. 装进来之后的三种人工通道

| 通道 | 谁执行 | 依赖 DSH 的什么 |
|---|---|---|
| 一次性令牌 | AI(被拦后重试) | **不依赖** —— 纯本地哈希 + 文件;DSH 只是把提示写进理由 |
| 宿主审批弹窗 | AI(经人点头) | `approval/policy = ask` + 宿主的审批界面 |
| 人工手动执行 | 人 | 完全不经过阀门 |

细节、实测证据与三条通道各自的性质见 [`USER-INTERVENTION.md`](./USER-INTERVENTION.md)。

---

## 4. 降级契约(额度用完以后)

| 失败类别 | 阀门行为 | 审计里的 `source` |
|---|---|---|
| `quota`(402 / 额度字样)/ `auth`(401/403) | **降级**:写 `~/.jev-guard/degraded.json`,冷却窗口内不再发请求,默认只跑免费的 L0 + 预筛 | 第一次:`error` + `degraded`;之后:`degraded` |
| `timeout` / `network` / `server` / `rate-limit` / `no-key` | **不降级**,逐次 fail-open,以 `errorKind` 分类记录 | `error` |

`no-key` 刻意**不**降级:它是本地配置状况、零 HTTP 成本,而 `degraded.json` 是全局共享的 ——
一条路径读不到密钥,不该把别的路径也按停(见 [`DECISIONS.md`](./DECISIONS.md) D10.2)。

DSH 侧要注意的三件事:

1. **把 `verdict.warning` 转达给人** —— 插件会把它写进拒绝理由、`level:'warn'` 审计记录与
   `ctx.logger.warn`。**不要把 `source: 'degraded'` 当成"判定过无害"**,它等于"这一条没经过语义判定"。
2. **`guard status` 可以当健康检查** —— 降级时**退出码是 3**。
3. 冷却时长与"降级时保留哪一层"在 `config.json`:`quotaCooldownMs`(15 分钟)/ `authCooldownMs`(30 分钟)/
   `degradePolicy`(`'l0-only'` 默认 / `'off'` = 整条阀门暂停)。窗口到期会自动放**一次**探测,成功即恢复。

---

## 5. 插件写不对时的静默失效,以及为什么必须真机验证

DSH 这边最坏的失效形态是**插件一声不响地没挂上**:没有报错、没有日志、命令照跑。
2026-09-20 真实发生过**三层**同类事故(入口守卫在 Windows 恒为 false;为 DRY 抽成共享模块后连 WSL
也失效;动态 `import()` 用绝对路径在 Windows 直接抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`)。
完整复盘见 [`MEASUREMENTS.md`](./MEASUREMENTS.md) §10。三条规则:

1. **入口守卫内联、跨平台:**
   `realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))`,
   **不要抽共享模块**(`import.meta.url` 跟着模块走,抽出去就恒为 false)。
2. **动态导入用相对说明符**(`await import('../../lib/gate.js')`),别用绝对路径字符串。
3. **验证要看副作用,不看"有没有报错":** 跑一条**必然被拦**的命令,确认它**真的被拦**;
   再看 `~/.jev-guard/guard.log` 有没有那条记录。`tools/selftest-entry.mjs` 是这件事的自动化版本,
   **Windows 与 WSL 各跑一遍**才算验过。

---

## 6. 失败一律放行(fail-open)

超时(默认 1800 ms)、网络错、服务 5xx、代码异常 → **放行**并记 `source: error`。

理由不是"我们不在乎":DSH 自己还有沙箱档位(`permission/preset`)在阀门**之后**生效
(除非是 `danger-full-access`)。阀门是**增量**检查,不是唯一防线。改成 fail-closed 的话,
判定服务抖一下你就干不了活 —— 一个"防事故"的东西变成了"制造事故"的东西。
想做到"服务挂了也拦",正确做法是**把 L0 规则加厚**(那一层不联网、不依赖任何服务),
而不是改这条策略。见 [`DECISIONS.md`](./DECISIONS.md) D3。

---

## 7. 边界:它是事故安全网,不是安全边界

**读到这一行就够了,不用往下猜。** 它防的是**事故** —— 模型/人写错的命令、不透明的脚本、
完全权限下没人拦的那一下。它**不**防蓄意绕过(换写法、编码、直接写授权文件)。

这不是没做完,是**显式决策**:完整理由、已知旁路清单、"什么情况下该重新考虑",见
[`DECISIONS.md`](./DECISIONS.md) **D1**。要防恶意,正确做法是**另加一层**(沙箱 / 低权限用户 / 容器),
不是把这条阀门改造成安全边界。

---

## 8. 词汇表(别把三个"信任"搞混)

| 词 | 指什么 | 谁维护 | 会不会持久 |
|---|---|---|---|
| **一次性令牌** | 放行**某一条命令原文**一次 | 阀门(`~/.jev-guard/allow.txt`) | 不持久:用掉即删,不可重放 |
| **DSH 审批** | 对**这一次调用**点头 | DSH | 只有"允许一次",**没有永久允许**(见 [`USER-INTERVENTION.md`](./USER-INTERVENTION.md) §2.1) |
| **L0 静态规则** | 不联网的硬规则(21 条 deny + 16 条 ask) | `lib/rules.js` | 令牌**过不去** `deny` |

还要区分两个编号体系:`L0 / L1 / L2` 是**判定层**(见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)),
`allow / revise / block / escalate` 是**判定结果**。前者是"怎么算出来的",后者是"算出了什么"。
