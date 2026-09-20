# 更新日志

本项目遵循「按日期记录事实」的写法:每条都写清**改了什么、为什么、以及怎么验证的**。
完整的设计取舍见 [`docs/DECISIONS.md`](./docs/DECISIONS.md),实测数据见 [`docs/MEASUREMENTS.md`](./docs/MEASUREMENTS.md)。

## [0.4.0] — 2026-09-20

**中英双语:给人看的文案两种语言都有,README 默认英文**;判定问话默认仍是标定过的中文。
取舍见 [`docs/DECISIONS.md`](./DECISIONS.md) **D14**,实测见 [`docs/MEASUREMENTS.md`](./MEASUREMENTS.md) **§14**。

**起因(用户要求):** 仓库默认 README 改英文、中文介绍按通行做法跳转;源代码也要中英双语支持。

**文案双语化。** 新增 `lib/i18n.js`:`lang` 控制界面语言,默认 `'auto'`
(`JEV_GUARD_LANG` → `LC_ALL`/`LC_MESSAGES`/`LANG`,**仅当它们指明一种受支持的语言** → 否则 `zh-CN`),
CLI 另有 `--lang zh-CN|en`。覆盖范围:判定理由(四态抬头、三种降级模板、令牌授权行)、
37 条 L0 规则的理由、CLI 全部输出、降级告警与 `guard status` 报告、发给判定服务的 state 键。
**代码注释与 `tools/` 里的自检标签不翻译** —— 它们是维护者读的,翻译只会让每次改动的维护成本翻倍。

**`auto` 刻意不看系统 locale —— 这一条是第一次真实部署时当场踩出来的。** 最初把 `Intl` 也放在
探测链尾,结果:DSH 插件跑在 WSL 里,那里 `LANG=C.UTF-8` 表示"没有偏好",`Intl` 于是报出 Node
自己的 `en-US` 兜底值 —— 会话里的拦截理由**悄悄变成英文**,而同一台机器的 Windows 侧 CLI(其 Node
报 `zh-CN`)仍是中文,同一个阀门两种语言。现在 `C`/`POSIX`/未设置一律视为**没有信号**并落回项目主语言
(`zh-CN`),要英文就明说。

**语言开关的优先级也修了一处埋点:** 这两项原本写在包内 `cordis.patch.yml` 里,而 patch 优先级
高于 `config.json` —— 意味着用户在 `config.json` 里设的语言会被无声覆盖。现在改为注释形式
(默认值仍写在注释里),语言交给 `config.json` / `JEV_GUARD_LANG` / `--lang` 控制。

**判定问话与界面语言解耦(这条是本版的核心)。** `promptLang` 单独控制发给 Jev 的那句问话与
state 的键,**默认 `'zh-CN'` 不随界面语言变**。理由不是保守,是实测:21 条探针 × 每臂 3 次 × 2 轮,
换成英文问话后 **12 条 p 更低 / 3–4 条更高**(平均压低 0.04,重复采样噪声只有 0.015),
**三条命令直接翻带且方向全部朝放行**:无 WHERE 的 `UPDATE`、`DELETE ... WHERE`(block→revise)、
内联 `node -e rmSync`(revise→allow);同带一致率 18/21。所以切 `promptLang` 是一次重标定,
不是翻译 —— 要用英文问话,先重标定或把两个阈值下调约 0.04。

**其它改动**

- README 拆成两份:`README.md` 英文(默认,给 GitHub 首屏与 `package.json.files`),`README.zh-CN.md`
  中文,两份顶部互相跳转(通行做法)。
- 规则理由改成双语对象(`why: { 'zh-CN', en }`),仍与正则同处一条规则;`ruleWhy()` 取当前语言。
- `guard rules` / `guard selftest` / `guard log` / `guard status` / `guard allow` 的输出全部走目录。
- CLI 参数解析改为一次性解析:`--lang en` 这类开关的**值**不再可能被当成一条待判定的命令
  (`guard judge 'x' --lang en` 以前会把 `en` 也判一遍)。
- 新增 `tools/selftest-i18n.mjs`(32 例):两语言键集合一致、占位符一致、英文里无残留中文、
  规则理由双语齐全、探测链对 `C.UTF-8` 这类"没有信号"值的处理、以及两条不变量 ——
  "界面切英文后发给 Jev 的问话仍是中文"和"界面语言不进请求体(两种界面构造出逐字节相同的 state 与问话)"。
- 新增 `tools/probe-prompt-lang.mjs`:问话语言对照探针,`--repeat` 用来把语言效应与
  服务自身的抖动分开(服务非确定性:同一 state 连问三次得过 0.78/0.79/0.82)。
- 清掉 `KINDS` 里从未被读取的 `cliHints`(一份不受 i18n 覆盖的隐藏文案)。
- 清掉 `bin/guard.mjs` 里从未被读取的 `const VERSION = '0.1.0'`:它没有任何引用,
  且早已与 `package.json` 的版本号脱节三版,留在文件里只会误导下一个读代码的人。
  (CLI 没有 `--version` 子命令;真要加,从 `package.json` 读一行即可。)

**怎么验证的**

- 七份离线自检全过:entry 20 / **i18n 32(新)** / quota 54 / reason 54 / token 17 / rules 48 / audit 20。
- `guard selftest` 12/12;`smoke-dsh-adapter` 10 组全过。
- 真机双语各跑一次:`status` / `rules` / `judge <必然被拦的命令>` 在中英两种语言下输出正确,
  判定结果一致(只有文案不同)。
- 既有断言里读中文文案的部分已显式 `setLang('zh-CN')` 钉死,不再受运行机器 locale 影响。

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
