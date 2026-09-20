# 更新日志

本项目遵循「按日期记录事实」的写法:每条都写清**改了什么、为什么、以及怎么验证的**。
完整的设计取舍见 [`docs/DECISIONS.md`](./docs/DECISIONS.md),实测数据见 [`docs/MEASUREMENTS.md`](./docs/MEASUREMENTS.md)。

## [0.3.1] — 2026-09-20

**L0 锚定补完:假阳与漏判两个方向一起修**(同一个根因 —— 第一轮锚定只做了一半)。
取舍见 [`DECISIONS.md`](./DECISIONS.md) **D2**,实测见 [`MEASUREMENTS.md`](./MEASUREMENTS.md) **§7.5**,
边界矩阵见 [`VERIFICATION.md`](./VERIFICATION.md) 第 7 项。

**起因(用户实测反馈):** 一条"查日志"的命令把 `mkfs.ext4 /dev/…` 的原文写进 python 源码的
字符串里,被 L0 当成命令拦下 —— 顺着查下去才发现反方向的偏差更要紧。

**假阳方向(放松):** 第一轮只锚定了 7 条 deny + 全部 16 条 ask,`mkfs` / `dd` / `shred` /
`chmod -R /` / `vssadmin` / `wbadmin` / `cipher /w` / `diskpart` / `wsl --unregister` /
`kubectl delete ns` / `Clear-Disk` / `Remove-Item … -Recurse` 这 **12 条仍在全文匹配**,
于是引号里的数据、注释、变量赋值、代码字符串都会命中 `deny` —— 而 L0 的 `deny`
**没有一次性令牌通道**,误拦时人只能自己去终端执行。现在这 12 条统一锚定到命令位置。

**漏判方向(收紧,这条更要紧):** 锚定用的 `^` **没有 `m` 标志**,所以"命令位置"实际只等于
**整串开头**。凡被锚定的规则,多行脚本里的真命令全部漏判:

| 形态 | 修正前 | 修正后 |
|---|---|---|
| `echo x \| xargs git push --force …` | MISS(`xargs` 不在包装器列表) | HIT |
| `bash - <<'SH'` + `git push --force …` | MISS(`^` 只匹配串首) | HIT |
| `bash -c "` + 多行 + `git push --force …` | MISS | HIT |
| heredoc 里的 `rm -rf /`、`DROP DATABASE` | MISS | HIT |

漏判只在 `l0-only` 降级(没有额度、没有网络)时才致命 —— 而 L0 的存在理由正是那一刻(D9)。
平时由 Jev 兜着,所以从没被发现。讽刺的是:修正前 heredoc 里的 `mkfs` **反而是命中的**,
只因为它没锚定 —— 两个偏差是同一个根因的两个方向。

**具体改动**

- 锚定正则加 `m` 标志(`^` 从此匹配**每一行**行首)。
- 包装器扩到 `sudo/doas/env/command/nohup/time/nice/ionice/setsid/stdbuf/watch/timeout/xargs/parallel/find`;
  吞掉的参数只允许 ASCII 词/flag/路径字符 —— 中文散文因此仍不会被顺带命中(实测 `xargs 删除 mkfs…` 不命中)。
- `bash -c "` / `sh -c '` 也算命令位置。
- 只剩 `redirect-to-device`(`>`)与 `fork-bomb`(`:(){…};:`)显式标为 `where: 'anywhere'`;
  新增计数器 `RULE_STATS.anywhere`(恒为 2,变大就说明又退回了全文匹配)。

**怎么验证的**

- `tools/selftest-rules.mjs`:25 → **48 例**(22 条矩阵用例分 A 防假阳 / B 防漏判 / C 防误伤散文,
  外加 1 例性能:4KB 包装器前缀 **0.6ms**,确认没有灾难性回溯)。
- 其余六套无回归(entry 15 / quota 54 / reason 56 / token 17 / audit 20 / smoke 10)。
- 真机:第 7 项扩了三行(原来的假阳探针 + 两条"必须被 L0 抓住"的多行/包装器形态)。

## [0.3.0] — 2026-09-20

判定动作**随 DSH 的审批模式分叉**;并修掉重试预算能绕过 L0 硬地板的潜在洞。取舍见
[`docs/DECISIONS.md`](./docs/DECISIONS.md) **D13**,验收步骤见 [`docs/VERIFICATION.md`](./docs/VERIFICATION.md) 第 22 项。

**起因(用户实测反馈):** "安全阀遇到 50% 多的时候也会拦,而我实际上想的是,在全自动模式下拦,
而在需要审批的模式里面所有的拦截都改成弹审批。"

审计佐证:当天 59 条 `revise`/`block` 拒绝里 **9 条发生在 `approval: ask` 的会话中**
(p 全在 0.50–0.63),命令是 `cp` 到部署目录、`sed -i`、`mkdir -p`、`git add -A && git commit`
—— 都是操作者自己的维护动作,**人就在旁边却拿不到弹窗**,等于让一个 50% 的判断替人做决定。

**改了什么**

- `ask`(人就在场):`revise`(50–70%)与 **Jev 高分的 `block`(≥70%)都转人工弹审批框**;
  理由抬头改成"需要人工确认",弹窗正文照旧带三种降级模板;**不再**附一次性令牌授权行。
- `never`(全自动):两者仍是**直接拒绝** + 令牌提示 —— 那种会话里 DSH 会把任何 `ask` 直接判成
  `rejected`,由阀门保守地拒是唯一正确的落法。
- **唯一例外**:L0 的 `deny` 类硬规则(`rm -rf /`、`mkfs`、`git push --force`…)两种模式都**拦死**,
  不弹窗、不发令牌。
- 新增配置 `reviseInAskMode` / `blockInAskMode`(默认 `ask`);想回到旧行为填 `deny`,不用改代码。
- **修潜在洞**:重试预算原本把"任何非 escalate 判定"在第 `retryLimit+1` 次后升级为 escalate ——
  对 L0 硬命中也一样,于是 `ask` 模式下连交三次 `git push --force` 就会弹窗,而点"允许"**越过了硬地板**
  (与 D5"令牌不越过 L0"自相矛盾)。现在硬命中不参与预算升级(仍记 `attempts` 供审计)。
  审计显示这条路径在修复前**从未被触发过**(纯潜在洞,不是已发生的事故)。

**怎么验证的**

- `tools/selftest-reason.mjs`:38 → **56 例**,新增 `revise`/`block` × `ask`/`never` × L0 的路由矩阵、
  两个配置开关、以及"抬头跟着路由结果走"。
- `tools/smoke-dsh-adapter.mjs`:9 → **10 组**,新增"L0 硬规则连试 4 次始终是 deny(不被预算升级成弹窗)"。
- 真机验收(第 22 项)在 `ask` 与 `never` 两侧**都要跑** —— 只跑一侧标 `partial`。

## [0.2.0] — 2026-09-20

从"想做成通用"收窄为 **DSH 专用**,并把"人怎么介入"与"花钱的额度用完了怎么办"补齐。

**改名**

- 包名 `jev-guard` → `dsh-jev-guard`(符合 `dsh-*` 插件命名);`cordis.patch.yml` 的 loader `name` 同步。
- 平台支持不变:**WSL/Linux 与 Windows 都支持**。

**新增:人的三条介入通道**(见 [`docs/USER-INTERVENTION.md`](./docs/USER-INTERVENTION.md))

- 一次性放行令牌:绑定命令原文、用掉即删、不越过 L0 硬规则、只在交互终端授权;
  授权行按**平台**给出正确的引号写法(POSIX `'\''` vs PowerShell `''`),Windows 另有 `--command-file`。
- 宿主审批弹窗:在 `approval: ask` 下由 DSH 弹框,理由里带上阀门原文;能弹框时不再附令牌提示。
- 人工手动执行:阀门不参与,且不会因此给 AI 任何权限。

**新增:额度耗尽的降级**(见 [`docs/DECISIONS.md`](./docs/DECISIONS.md) D9)

- `quota` / `auth` 类失败 → 写 `~/.jev-guard/degraded.json`,冷却窗口内不再发请求(省钱),
  默认只跑**免费的 L0 + 预筛**;窗口到期自动放一次探测,成功即恢复。
- 告警出现在拒绝理由、审计(`source: degraded` + `level: warn`)、stderr 与 `guard status`(降级时退出码 3)。
- 新增成本可见性:响应里的 `usage` 计入审计,`guard log --stats` 折算美元并标注覆盖率。

**DSH 特化**

- 审计记录带上会话的**沙箱档位**(`permission/preset`),事后复盘能看出"当时后面还有没有沙箱"。
- 去掉两个面向外部调用方的入口(常驻 HTTP 判定服务、stdio 协议服务)——DSH 插件是进程内的。

**修复(三层跨平台入口缺陷,详见 [`docs/MEASUREMENTS.md`](./docs/MEASUREMENTS.md) §10)**

1. `import.meta.url === \`file://${process.argv[1]}\`` 在 Windows 上恒为 false → 脚本静默退出 0;
2. 修第一层时为 DRY 抽共享模块,导致 `import.meta.url` 指向该模块自身 → 连 WSL 也失效;
3. 动态 `import(join(ROOT, …))` 在 Windows 上抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
   另修:`apiKeyFile` 相对路径按包根解析;`no-key` 不再触发全局降级。

**安全**

- 测试夹具里的三个真实密钥(两个 API key + 一个 GitHub token)已替换为合成值 —— 它们本会随仓库一起被发布。

**验收**:WSL 与 Windows 两侧整套自检全过(见 [`verification-results/`](./verification-results/))。

## [0.1.0] — 2026-09-20

首版:挂 DSH `tools/pre-execute` 的四态阀门(L0 静态硬规则 + 预筛 + Jev 语义判定)、
共享审计日志、重试预算、拒绝理由里的降级模板。
