# dsh-jev-guard

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4B6BFB.svg)](https://github.com/topics/dsh-plugin)
[![platform](https://img.shields.io/badge/platform-WSL%20%7C%20Windows-2f2f2f.svg)](#平台支持)
[![version](https://img.shields.io/github/v/tag/7starsseeker/dsh-jev-guard?label=version&style=flat)](https://github.com/7starsseeker/dsh-jev-guard/tags)
[![npm](https://img.shields.io/npm/v/dsh-jev-guard?label=npm&style=flat)](https://www.npmjs.com/package/dsh-jev-guard)
[![selftest](https://img.shields.io/github/actions/workflow/status/7starsseeker/dsh-jev-guard/selftest.yml?label=selftest)](https://github.com/7starsseeker/dsh-jev-guard/actions/workflows/selftest.yml)
[![last commit](https://img.shields.io/github/last-commit/7starsseeker/dsh-jev-guard)](https://github.com/7starsseeker/dsh-jev-guard/commits/main)
[![stars](https://img.shields.io/github/stars/7starsseeker/dsh-jev-guard?style=flat)](https://github.com/7starsseeker/dsh-jev-guard/stargazers)

> [English](README.md) | **简体中文** | [更新日志](CHANGELOG.md) | [设计取舍](docs/DECISIONS.md) | [实测数据](docs/MEASUREMENTS.md)

**给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 用的执行前安全阀门:在命令真正跑起来之前,先问一次"它会不会不可逆地删掉或覆盖你的真实数据?"**

判定用 [TypeSafe Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) —— 一个不产出文本、只产出**结构化决策**的 "System One" 模型。这类判断用是非问句实测最准(114 例校准,中文直送 90.4%)。挂载点是 DSH 原生的 `tools/pre-execute`,所以它是**强制拦截**,不是"提醒模型自觉"。

```
命令文本 ──▶ L0 静态硬规则(不联网·不可覆盖)──▶ 预筛(只读/可重建)──▶ Jev 语义判定(~300ms)
                        │                       │                        │
                        └───────────────┬───────┴────────────────────────┘
                                        ▼
                        allow ／ revise(附降级模板)／ block ／ escalate
                            │        │              │          │
                         直接执行   模型换写法      拒绝     DSH 审批弹窗 或 一次性令牌
```

> **英文摘要** — `dsh-jev-guard` is a pre-execution safety valve for DeepSeek Harness. It judges every `bash` / `pwsh` tool call **before** it runs — offline static rules first, then a paid semantic model — and returns one of four states (`allow` / `revise` / `block` / `escalate`). It blocks unrecoverable commands, teaches the model a safer form when it can, offers a one-shot human token when neither is right, and **degrades loudly instead of silently** when the judging API runs out of credit. **It is an accident net, not a security boundary** — see [已知边界](#已知边界).

---

## 目录

- [它做什么](#它做什么)
- [安装](#安装)
- [语言](#语言)
- [配置](#配置)
- [两种审批策略下的行为](#两种审批策略下的行为)
- [被拦了怎么办:人的三条介入通道](#被拦了怎么办人的三条介入通道)
- [额度用完会怎样:降级而不是静默失效](#额度用完会怎样降级而不是静默失效)
- [看得见:审计日志与状态](#看得见审计日志与状态)
- [平台支持](#平台支持)
- [自检与验收](#自检与验收)
- [目录结构](#目录结构)
- [安全与隐私](#安全与隐私)
- [已知边界](#已知边界)
- [文档](#文档)
- [License](#license)

## 它做什么

| 判定 | 含义 | 谁接手 |
|---|---|---|
| `allow` | 确定性只读,或判定为安全 | 直接执行 |
| `revise` | 证据不足以安全执行,但很可能有更好的写法 | **模型**换写法重试(附三种降级模板:先演练 / 缩小范围 / 先备份) |
| `block` | 会不可逆地删或覆盖,或命中硬规则 | 拒绝;由人手动执行 |
| `escalate` | 必须有人确认(硬规则的"必问"项,或重试预算耗尽) | 人 |

分三层,顺序固定:

1. **L0 静态硬规则**(`lib/rules.js`):21 条"永不允许" + 16 条"必须人工确认"。**不联网、不可被覆盖**,连一次性令牌也过不去。规则只在**命令位置**匹配(每一行行首,或 `;` `&` `|` `(` `$(` 之后,或 `bash -c "` 之后,并允许 `sudo`/`timeout 30`/`xargs -0`/`find … -exec` 这类包装器)—— 所以"在参数里提到危险命令"不会被误伤,**而多行脚本里的真命令也不会被漏掉**。只有两条结构上锚不了的规则(`redirect-to-device`、`fork-bomb`)是全文匹配,计数器 `RULE_STATS.anywhere` 恒为 2。
2. **预筛**:可证明只读或只影响可重建内容(缓存、构建产物、`/tmp`)的命令直接放行,**零网络调用**。
3. **Jev 语义判定**:一次是非问句 —— *"这条命令会不可逆地删除或覆盖用户的真实数据吗?"* —— 按两个阈值切成 `allow` / `revise` / `block`。实测延迟 ~300ms(P50 267ms),成本 ≈ `$0.000019`/次。

## 安装

要求 **Node ≥ 20**(用到全局 `fetch`)。**零运行时依赖**,不需要 `npm install`。

**已验证的宿主版本:DSH 0.1.6-alpha.2。** 这是本插件唯一跑过的 DSH 版本,且**刻意不在 `package.json` 里声明为宿主要求**:插件市场会从 npm manifest 读这个字段,一旦声明就会在其他所有 DSH 版本上拦住安装与更新。所以别的版本是**没验过,而不是被禁止**;换版本后请重跑下面的自检。

```bash
# 1. 把本仓库放到一个固定的位置,例如 T:\dsh-jev-guard(WSL 里是 /mnt/t/dsh-jev-guard)

# 2. 让 DSH 装载它(profile 名按你的实际 profile 填)
dsh plugin --profile web add /mnt/t/dsh-jev-guard      # Windows 侧: T:\dsh-jev-guard

# 3. 重启 DSH(插件没有热加载)
```

`dsh plugin` 的 `add` 走 pnpm 解析,所以 spec 接受 pnpm 接受的一切。发布的包已上 npm —— 也就是插件市场优先采用的安装源:

```bash
dsh plugin --profile web add dsh-jev-guard
```

本地路径是**链接**装法,插件始终跑在你自己那份 checkout 上 —— 改文件、重启,就生效。想直接从 GitHub 源码装,用 `github:7starsseeker/dsh-jev-guard`。

以上几种都没有东西要构建(零依赖、无安装脚本),所以都不会触发构建授权。

**新装的时候没有密钥 —— 它会自己说出来,而不是装死。** 第一个会话会在对话里直接告诉你"没有配置密钥";在录入之前,阀门处于**降级**:免费的 L0 硬规则与预筛照常工作,付费的语义层不工作。录入只要一条命令,而且只从标准输入读 —— 绝不接受参数,那会进 shell 历史与 `ps`:

```bash
node bin/guard.mjs key set        # 粘贴密钥后回车;不回显、不进 shell 历史
node bin/guard.mjs key status     # 当前哪个来源在生效、密钥多长(永不打印值)
```

`guard key status` 在没有密钥时退出码 3,可以直接当健康检查。这里没有需要等的冷却:密钥一解析到,降级状态当场清除,下一条命令就恢复完整判定。

`package.json` 里的声明是一个标准 DSH bundle:

```json
{
  "name": "dsh-jev-guard",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` 把插件插到 `tools/pre-execute` 上,**所有可调参数都在那里**(也可以写在 `config.json` 里,优先级 `patch > config.json > 内置默认`)。

**密钥**三种来源,优先级从高到低:DSH 凭据层(`ctx.credentials`,轮换后无需重启)→ 环境变量 `TYPESAFE_API_KEY` → **你自己在包根建的** `secrets.json`(`{"TYPESAFE_API_KEY": "apikey_..."}`)。该文件写在 `.gitignore` 里,**刻意不入仓库、也不进发布包**,没人会替你带一份 —— 前两种来源才是首选。`node bin/guard.mjs key set` 会替你写这个文件(权限 0600),DSH 适配器也读它。密钥从不被打印,写入日志前会掩码。

**装好后立刻验一次**(别看"没报错"):

```bash
node bin/guard.mjs selftest      # 期望:12 项全部通过(不联网)
node bin/guard.mjs status        # 期望:✅ 正常(降级时退出码为 3)
```

再在会话里跑一条**必然被拦**的命令(例如 `git push --force origin main`),它应该被拒,并且 `node bin/guard.mjs log --tail 3` 里能看到那条记录。

## 语言

**给人或模型看的话**都有中英两份:判定理由、37 条 L0 规则的理由、全部 CLI 输出、降级告警与 `guard status`。

| 开关 | 管什么 | 默认 |
|---|---|---|
| `lang` | 上面那些文案的语言 | `'auto'` —— 按 `JEV_GUARD_LANG` → `LC_ALL`/`LC_MESSAGES`/`LANG`(仅当它们指明受支持的语言)→ 否则 `zh-CN` |
| CLI `--lang zh-CN\|en` | 同一条命令的临时指定 | — |
| `promptLang` | **发给 Jev 的那句问话**与它读的 state 的键 | `'zh-CN'` |

**`promptLang` 不是翻译开关,而是一个判定参数。** 阈值 0.5 / 0.7 是在**中文问话**上标定的(114 例),换语言就等于挪动这条被测过的边界。实测(`tools/probe-prompt-lang.mjs`,21 条探针 × 每臂 3 次 × 2 轮独立运行):

| 指标 | 结果 |
|---|---|
| 与中文问话同带 | **18/21** |
| 概率平均绝对差 | **0.049** |
| 带符号均值(负 = 英文问话更宽松) | **−0.043** |
| 偏低 / 偏高 / 持平 | 12 / 4 / 5 |
| 重复采样噪声(同问话同状态) | **0.015** |

三条命令翻了带,而且**方向全部朝放行**:无 `WHERE` 的 `UPDATE`(block → revise)、`DELETE … WHERE`(block → revise)、内联 `node -e rmSync`(revise → allow)。两轮结论一致。所以真要设 `promptLang: 'en'`,请先重标定,或把两个阈值下调约 0.04 —— 见 [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) §14 与 [docs/DECISIONS.md](docs/DECISIONS.md) **D14**。

代码注释与 `tools/` 里的自检标签**刻意保持中文**:它们由本仓库的维护者读,双语化只会让每次改动的维护成本翻倍,而不改变产品对外说的任何一句话。

**`auto` 为什么不看系统 locale:** 本插件最初也会落到 `Intl`,结果第一次真实部署就踩到 —— WSL 里 `LANG=C.UTF-8` 表示"没有偏好",`Intl` 于是报出 Node 自己的 `en-US` 兜底值,会话里的理由**悄悄变成英文**,而 Windows 侧 CLI 仍是中文。`C`/`POSIX`/未设置一律视作**没有信号**,落在 `zh-CN`;真正指明语言的 locale(`en_US.UTF-8`、`zh_CN.UTF-8`)照常生效。

> English readers: the default README is [README.md](README.md).

## 配置

`config.example.json` 是模板;全部键如下(默认值写在 `lib/gate.js` 的 `DEFAULTS`)。

| 键 | 默认 | 说明 |
|---|---|---|
| `model` | `jev-latest` | 判定模型别名 |
| `endpoint` | `https://api.typesafe.ai/v1/systemone` | 判定服务地址 |
| `apiKeyEnv` / `apiKeyFile` | `TYPESAFE_API_KEY` / `secrets.json` | 密钥来源;**相对路径按包根解析**(与 cwd 无关) |
| `lang` | `auto` | 全部给人/模型看的文案的语言(见[语言](#语言));`auto` 只读环境变量,兜底 `zh-CN` |
| `promptLang` | `zh-CN` | 发给 Jev 的问话与 state 键的语言。**它是判定参数而非翻译开关**:实测切 `en` 会把 p 平均压低约 0.04,并让三条探针翻向放行,见[语言](#语言) |
| `lowThreshold` / `highThreshold` | `0.5` / `0.7` | 四态阈值:`p < low` → allow;`low ≤ p < high` → revise;`p ≥ high` → block。737 条真实命令上得到 98.51% / 0.81% / 0.68% 三分 |
| `reviseInAskMode` / `blockInAskMode` | `ask` / `ask` | 判定动作怎么随审批模式分叉:`ask` = 审批可用时转人工弹窗(人就在场,不该让 50% 的判断替人做决定);`deny` = 退回直接拒绝。`never`(全自动)下两者都仍是直接拒绝。**L0 的 `deny` 类硬规则不受此开关影响** —— 它永远拦死 |
| `timeoutMs` | `1800` | 单次判定预算;超时一律放行(fail-open) |
| `cacheSize` | `256` | 判定缓存条数 |
| `inlineScripts` / `maxScriptBytes` | `true` / `8192` | 把被调用脚本的正文读进判定状态(实测把 `node x.mjs` 这类盲区从 0.31 提到 0.82);敏感路径自动跳过 |
| `retryLimit` | `2` | 同一条命令被拦多少次后升级为 `escalate`(交人处理) |
| `tokens` / `tokenPath` | `true` / `~/.jev-guard/allow.txt` | 一次性放行令牌 |
| `logPath` / `logMaxBytes` | `~/.jev-guard/guard.log` / 4 MiB | 共享审计日志(JSONL,超限轮转) |
| `quotaCooldownMs` / `authCooldownMs` | 15 min / 30 min | 额度、密钥类失败后的降级冷却 |
| `degradePolicy` | `l0-only` | 降级时保留哪一层:`l0-only`(只停要花钱的语义层)或 `off`(整条阀门暂停) |
| `pricePerMTok` | `0.042` | 成本估算单价(美元/百万输入 token;输出按官方说明免费) |

## 两种审批策略下的行为

同一套判定,在 DSH 的两种会话策略下落地不同 —— **这点最容易搞混**:

| 判定 | `approval: ask`(会弹框) | `approval: never`(完全权限 / YOLO) |
|---|---|---|
| `revise`(50–70%) | **转人工弹审批框** | 拒绝 **+ 降级模板 + 一次性令牌提示** |
| `block`(≥70%,语义层) | **转人工弹审批框** | 拒绝 **+ 一次性令牌提示** |
| L0 的 `deny` 类硬规则 | **拒绝**(不弹框、不发令牌) | **拒绝** |
| L0 的 `ask` 类规则(`escalate`) | **DSH 弹审批框**,由人决定 | 拒绝 **+ 一次性令牌提示** |

> **为什么 `ask` 模式下灰区和高分都交给人**:人就在场时,让一个 50.6% 的判断替人做决定没有道理;而 `never` 模式下没人可问,只能由阀门保守地拒。宿主没有应答者时审批是 **fail-closed**,所以转人工**不会**在无人值守时变成自动放行;弹窗只给 `allowed-once`,不留长期旁路。
>
> **L0 的 `deny` 类硬规则是绝对闸门**:两种模式都拦死,连 `retryLimit` 的"反复重试就交人"也不适用于它 —— 否则弹窗里点一次"允许"就绕过了硬地板(令牌不能越过 L0,审批同样不能)。

> `danger-full-access` = `{ sandbox: 'danger-full-access', approval: 'never' }` —— **没有沙箱兜底、审批也等于关掉,阀门是唯一一层**。这正是它存在的意义,也是它判错时代价最大的场景。审计记录里会带上当次的沙箱档位(`preset`)与审批策略(`policy`),事后复盘能看出"当时后面还有没有沙箱"。

## 被拦了怎么办:人的三条介入通道

**① 一次性令牌(与宿主无关,任何时候都在)。** 被拦命令的理由里会附一个 `ALLOW-XXXXXXXXXX`(命令文本的哈希前 10 位),**人**在自己的终端里粘贴理由给的那一整行:

```bash
# WSL / Linux:
node /mnt/t/dsh-jev-guard/bin/guard.mjs allow '<原命令>'
# Windows(PowerShell;引号按平台自动切换):
node T:\dsh-jev-guard\bin\guard.mjs allow '<原命令>'
# 任何平台、任何 shell(不经过 shell 引号规则 —— cmd.exe 用这个):
node T:\dsh-jev-guard\bin\guard.mjs allow --command-file cmd.txt

node bin/guard.mjs allow --list              # 看待用令牌
node bin/guard.mjs allow --revoke ALLOW-…    # 撤销
```

四条性质:**绑定命令原文**(换一个字就是另一个令牌)、**用掉即删**(无法重放)、**不越过 L0 硬规则**、**只在交互终端授权**(AI 自己跑会被拒)。

**② DSH 审批弹窗(`approval: ask`)。** 阀门只负责把命令标成"需要人看",由 DSH 弹框;弹窗里的理由就是阀门原文。DSH 的答案是闭集(只有"允许一次"和"拒绝"),所以**每次都是一次独立的逐次决定**,没有"永久允许"可以被静默吞掉。

**③ 人直接执行。** 你在自己终端里跑那条命令 —— 阀门不参与,也**不会因此给 AI 任何权限**:审计里不会有你那次动作的记录,AI 重试同一条命令仍然会被拦。

## 额度用完会怎样:降级而不是静默失效

判定服务是**按量收费**的,额度用完是必然事件。默认行为:

| 情况 | 阀门怎么办 | 你能在哪里看到 |
|---|---|---|
| 额度耗尽 / 密钥失效(`402` / `401`) | **降级**:写 `~/.jev-guard/degraded.json`,冷却窗口内不再发请求(省钱),默认只跑**免费的 L0 + 预筛** | `guard status`(退出码 3)· 拒绝理由里的一句 `⚠️` · 审计里的 `source: degraded` 与 `level: warn` · CLI 的 stderr |
| 冷却到期 | 自动放**一次**探测请求:成功即恢复(你不用做任何事),失败继续降级 | `guard status` 会显示还剩多久 |
| 超时 / 网络抖 / 5xx / 429 限流 / 无密钥 | **不降级**,只逐次放行(fail-open),但会被分类记录 | `guard log --stats` 的"失败分类"一行 |

```bash
node bin/guard.mjs status --clear    # 不想等冷却:立刻重试一次(失败会再次进入降级)
```

想"额度没了就彻底别插手"(连 L0 也停)就设 `degradePolicy: "off"`。

## 看得见:审计日志与状态

每个判定都会追加一行 JSONL 到 `~/.jev-guard/guard.log`(超 4 MiB 轮转,命令写入前掩码密钥):

```bash
node bin/guard.mjs log --tail 20     # 时间 / 动作 / p / 来源 / 命中规则 / 命令
node bin/guard.mjs log --stats       # 动作·来源·规则计数 + fail-open + 失败分类 + 成本估算
node bin/guard.mjs status            # 一句话:阀门是好的吗?(降级时退出码 3,可当健康检查)
```

## 平台支持

**WSL/Linux 与 Windows 都支持。** 两处平台差异都已处理:

| 项 | WSL / Linux | Windows |
|---|---|---|
| 拦的工具 | `bash` | `pwsh`(**两个都在默认 `tools` 列表里**) |
| 授权行引号 | POSIX `'\''` | **PowerShell `''`**(两种写法不通用,已按平台分叉) |
| cmd.exe 用户 | — | 用 `guard allow --command-file <文件>` |
| 状态与日志 | `~/.jev-guard/` | `%USERPROFILE%\.jev-guard\` |

自检里对引号做了**真机往返断言**(含"POSIX 形式在 PowerShell 里必须失败"的反例);入口守卫的跨平台回归也必须在**两个平台各跑一遍**才算验过。

## 自检与验收

```bash
# 七份离线自检(不需要网络、不需要密钥)
for t in selftest-entry selftest-i18n selftest-quota selftest-reason selftest-token selftest-rules selftest-audit; do
  printf '%-18s ' "$t"; node tools/$t.mjs | tail -1
done

node bin/guard.mjs selftest          # 12 项:规则/预筛/四态映射
node tools/smoke-dsh-adapter.mjs     # 适配器冒烟(假 ctx,9 组断言)
node tools/smoke-dsh-pipeline.mjs    # 真实工具管线集成(需在 DSH 检出目录内跑)
```

验收清单(20 项,含三条人工通道)与逐项判据见 **[docs/VERIFICATION.md](docs/VERIFICATION.md)**;
历次结论落在 [`verification-results/`](verification-results/)。

## 目录结构

```
bin/guard.mjs              CLI:judge | log | status | allow | selftest | rules
lib/gate.js                判定引擎(L0 → 预筛 → 语义 → 四态)—— 与调用方无关
lib/i18n.js                双语文案目录(zh-CN / en)与语言解析
lib/rules.js               L0 静态硬规则(每条带 id / 正则 / 理由)
lib/verdict.js             四态合成、理由文案、重试预算、平台相关引号
lib/audit.js               共享审计日志(掩码 / 轮转 / 汇总 / 成本)
lib/token.js               一次性放行令牌
lib/quota.js               额度/密钥失败后的降级状态机
adapters/dsh/index.js      DSH 原生 Cordis 插件(唯一的适配器)
cordis.patch.yml           DSH bundle patch(装载声明 + 全部可调参数)
tools/                     离线自检、冒烟测试、验证辅助
docs/                      机制、取舍、实测、验收清单
```

## 安全与隐私

1. **会发给判定服务的只有命令文本 + 可选脚本正文**(敏感路径 `.env` / `.ssh` / `*.pem` / `*credential*` / `*secret*` / `*token*` 自动跳过,单文件 8KB 上限)。想彻底关闭:`inlineScripts: false`(代价是 `node x.mjs` 这类命令退回 p≈0.31 的盲区)。
2. **密钥只从凭据层 / 环境变量 / `secrets.json` 读取**,不进日志、不进报告(命令文本写入前掩码)。
3. **失败一律放行(fail-open)**:判定服务不可用时不拦任何东西 —— DSH 自己的沙箱档位(除 `danger-full-access` 外)仍在执行之前。想"服务挂了也拦",加厚 L0 规则,而不是改成 fail-closed。
4. **不防蓄意绕过**:换写法、编码、直接写授权文件都可能绕开。防恶意注入要靠沙箱 / 低权限用户 / 容器。

## 已知边界

**它是事故安全网,不是安全边界。** 它防的是*事故* —— 写错的命令、不透明的脚本、完全权限下没人拦的那一下;它**不**防*对手*。这不是没做完,是显式决策:已知且有意保留的旁路、以及"什么情况下该重新考虑",都写在 [docs/DECISIONS.md](docs/DECISIONS.md) 的 **D1**,**请不要"顺手把它堵上"**。

同样刻意的两条:判定**不模拟文件系统状态**(不会推理"反正那个文件已经是空的"),也不接受"这条命令没害处"这类需要读运行时状态的辩解 —— 那正是事故钻进来的缝。

## 文档

下面的文档**默认是英文**;把扩展名写成 `*.zh-CN.md`(例如 `docs/DECISIONS.zh-CN.md`)就是与它同步的中文版。

| 文档 | 内容 |
|---|---|
| [docs/DSH-INTEGRATION.md](docs/DSH-INTEGRATION.md) | 它用 DSH 的哪些机制、四态怎么映射、降级契约、为什么"装上了≠真的在拦" |
| [docs/USER-INTERVENTION.md](docs/USER-INTERVENTION.md) | 人的三条介入通道 + 实测证据 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 已接受的设计取舍 D1–D14(**改之前先读**) |
| [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) | 全部实测数字、延迟/成本、事故复盘 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 判定分层、为何判定与拦截必须分开 |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | 验收清单与逐项判据 |
| [DEPLOY.md](DEPLOY.md) | 部署手册(含 Windows 变体与回滚) |
| [START-HERE.md](START-HERE.md) | 交给另一台机器上的 AI 的装箱/配置说明 |

## License

[MIT](LICENSE)
