# DEPLOY.md — 部署手册(DSH)

> [English](DEPLOY.md) | **简体中文**

你正在读的是 jev-guard 的部署说明。目标:让这条"执行前安全阀门"在 **DSH** 上生效,
并且**每一步都有可验收的证据**。**WSL 与 Windows 都支持。**

> **先读这两份,再读本文:**
> [`docs/DSH-INTEGRATION.md`](./docs/DSH-INTEGRATION.md) —— 它用 DSH 的哪些机制、四态怎么映射、
> 降级契约、以及"插件装上了≠真的在拦"这件事的复盘。
> [`docs/USER-INTERVENTION.md`](./docs/USER-INTERVENTION.md) —— 人的三条介入通道。
>
> **如果你是"被派来部署的 AI",先读 [START-HERE.md](./START-HERE.md)** —— 那里有可粘贴的任务
> 提示词与硬约束(能改哪些文件)。读完再回到本文按步骤执行;
> 结论用 `tools/report-result.mjs` 写回 `verification-results/`。

## 0. 工作方式(先读这一段)

1. **不要跳步。** 顺序是:先证明判定层能工作(§2.3)→ 再装进 DSH(§2.4)→ 最后验收(§3)。
2. **改任何 DSH 配置前先备份原值**,并在结论里写清怎么回滚(§6)。
3. **验证要看副作用,不看"没报错"。** 本包真实发生过三层静默失效:脚本一声不响地退出 0、
   命令照跑、日志什么都没有(见 `docs/MEASUREMENTS.md` §10)。
4. **绝不打印密钥。** 需要时从 `secrets.json` 或凭据层读,只报长度或哈希尾号。
5. 所有命令都可以先只读地试跑(`selftest`、`rules`、`judge`、`status`)—— 它们不改任何宿主配置。

## 1. 前置条件

| 项 | 要求 | 检查 |
|---|---|---|
| Node | ≥ 20(用到全局 `fetch`、`AbortSignal.any`) | `node -v` |
| TypeSafe 密钥 | 形如 `apikey_...`;没有就去 https://console.typesafe.ai 申请 | §2.2 |
| 目录位置 | 建议 `T:\dsh-jev-guard`(WSL 里是 `/mnt/t/dsh-jev-guard`) | `ls /mnt/t/dsh-jev-guard` |
| 网络 | 能访问 `https://api.typesafe.ai` | `node bin/guard.mjs judge 'pnpm test'` |
| DSH | 能装本地插件(profile 的 `package.json` 有 `dsh.profile` / bundles) | `dsh --profile <名> --dump-config` |
| DSH 版本 | **0.1.6-alpha.2** 与 **0.1.7-rc.2** —— 均已完整验证;跑了哪些见 README 的「已验证的宿主版本」段。`package.json` 未声明宿主要求,所以插件市场不会因版本不同而阻拦安装 | `dsh --version` |

## 2. 安装与配置

### 2.1 放好目录

整个 `jev-guard` 目录放到 `T:\dsh-jev-guard`(WSL 侧即 `/mnt/t/dsh-jev-guard`,**同一份文件**)。
**不需要 `npm install`** —— 零依赖,只用 Node 内置模块。

### 2.2 密钥

三种来源,优先级从高到低:

1. **DSH 凭据层**(推荐):`ctx.credentials.resolve('TYPESAFE_API_KEY')` —— 走 DSH 自己的凭据存储,
   轮换后**无需重启**。
2. 环境变量 `TYPESAFE_API_KEY`(名字由 `config.json` 的 `apiKeyEnv` 决定)。
3. **你自己在包根建的** `secrets.json`,内容 `{"TYPESAFE_API_KEY": "apikey_..."}`
   (**`apiKeyFile` 若给相对路径,按包根解析,与当前目录无关** —— Windows/WSL 都成立)。

三种都不要提交进任何仓库。

第三种用 `node bin/guard.mjs key set` 录:**只从标准输入**读密钥(绝不接受参数 —— 那会进 shell 历史与
`ps`),写 `apiKeyFile`、权限 `0600`,保留文件里已有的其它键,只打印长度与路径、永不打印值。
`node bin/guard.mjs key status` 说明当前哪个来源在生效,没有密钥时退出码 3,可以直接当健康检查。

**没有密钥会降级,不会装死(D15)。** 解析不到密钥时,付费的语义层暂停 —— 免费的 L0 规则与预筛照常
工作 —— 而且这个状态是**粘性**的:不随时间到期(没有可探测对象),密钥一出现就结束,当场清除、零请求、
不用重启。它还带作用域,只压制写下它的那条入口(`'cli'` 或 `'dsh-adapter'`),所以 CLI 看不到密钥不会
让 DSH 停止判定,反之亦然。降级期间 `guard status` 退出码为 3,DSH 会话里还会在对话中出现一行提示,
说明阀门当前处于什么状态。

### 2.2b 语言(可选,不配也能跑)

文案(判定理由 / CLI 输出 / 降级告警)有中英两份,`lang` 默认 `'auto'`:
按 `JEV_GUARD_LANG` → `LC_ALL`/`LC_MESSAGES`/`LANG` 解析,**只有当这些变量真的指明了一种受支持的语言**
(如 `en_US.UTF-8` / `zh_CN.UTF-8`)才生效;否则(含 `C.UTF-8`、未设置)一律用 `zh-CN`。
**这里刻意不看系统 locale**:WSL 常见的 `LANG=C.UTF-8` 下 Node 的 `Intl` 会报 `en-US`,
那会让中文会话的理由悄悄变英文(2026-09-20 实测)。想显式选语言:`config.json` 里写 `"lang": "en"`,
给 DSH 进程设 `JEV_GUARD_LANG=en`,或 CLI 单次 `--lang en`。

**别顺手改 `promptLang`。** 它管的是发给判定服务的那句问话,默认中文,正是阈值 0.5/0.7 的标定语言;
实测换成英文后 p 平均压低约 0.04,且有三条探针翻向放行(`docs/MEASUREMENTS.md` §14)。
真要切:先重标定,或把两个阈值一起下调约 0.04。

### 2.3 先证明判定层能工作(还没装进 DSH)

```bash
cd /mnt/t/dsh-jev-guard
node bin/guard.mjs selftest                                    # 期望:12 项全部通过(不联网)
node bin/guard.mjs rules | head -5                             # 期望:列出 21 条 deny + 16 条 ask
node bin/guard.mjs judge 'ls -la' 'git push --force origin main' 'pnpm test'
```

| 命令 | 期望 action | 期望 source |
|---|---|---|
| `ls -la` | `allow` | `prefilter`(不联网) |
| `git push --force origin main` | `block` | `static-rule`(不联网) |
| `pnpm test` | `allow` | `jev`(联网,`p` 应远低于 0.5) |

失败时:`source: error` = 密钥或网络问题(看 `errorKind` 分类);`selftest` 失败 = 包不完整。

**再跑一次整套离线自检**(七份,跨平台):

```bash
for t in selftest-entry selftest-i18n selftest-quota selftest-reason selftest-token selftest-rules selftest-audit; do
  printf '%-18s ' "$t"; node tools/$t.mjs | tail -1
done
```

### 2.4 装进 DSH

```bash
dsh plugin --profile <profile> add /mnt/t/dsh-jev-guard      # Windows 侧换成 T:\dsh-jev-guard
# 然后重启 DSH —— 插件没有热加载
```

装完后**确认插件真的挂上了**(别看"没报错"):

1. 在会话里跑一条**必然被拦**的命令(例如 `git push --force origin main`,它命中 L0 硬规则,不花钱)。
   期望:被拒绝,理由里有 `命中硬规则 git-force-push`。
2. 看审计:`node bin/guard.mjs log --tail 3` —— 应出现那一条记录,且带 `policy` 与 `preset`。

两条都成立才算装上。**只有第 1 条不成立时**,先查 `docs/DSH-INTEGRATION.md` §5 那三层静默失效。

### 2.5 Windows 上的差异

| 项 | WSL | Windows |
|---|---|---|
| 要拦的工具 | `bash` | `pwsh`(**已在默认 `tools` 列表里**) |
| 授权行引号 | POSIX `'\''` | **PowerShell `''`**(插件按平台自动切换) |
| cmd.exe 用户 | — | 用 `guard allow --command-file cmd.txt`(与 shell 的引号规则无关) |
| 状态/日志目录 | `~/.jev-guard/` | `%USERPROFILE%\.jev-guard\` |

## 3. 验收(必须全过才继续)

验收清单在 **[docs/VERIFICATION.md](./docs/VERIFICATION.md)**,含**三条人工介入通道**(U1–U3)。
摘要:

| # | 验收 | 判定依据 |
|---|---|---|
| 1 | 安装后 probe 命令被拦 | 命令真的被拒 + `guard.log` 有记录 |
| 2 | L0 路径(不联网、不可覆盖) | `mkfs` / `git push --force` → `block` / `static-rule` |
| 3 | Jev 路径(联网语义判定) | 真实目录 `rm -rf` → `revise` 或 `block`,记录里带 `p` |
| 4 | 误报防线(散文/重定向不误伤) | 命令文本里的危险短语、以 `2>/dev/null` 结尾的命令都**不被拦** |
| 5 | 审计日志 | 每个判定一行 JSONL;`log --stats` 有动作/来源/规则/失败分类/成本 |
| 6 | 令牌闭环 | 授权 → 重试同一条 → 放行一次 → 令牌消失,记录里 `source: token` |
| 7 | 授权入口只在交互终端 | 非 TTY 被拒并打印可复制的整行命令 |
| 8 | 审批弹窗(策略 `ask`) | 弹窗出现且带阀门理由原文;点允许后命令执行 |
| 9 | 额度降级 | 402/401 → 降级、零请求、`guard status` 退出码 3、L0 仍拦;`403` 带 HTML 页 → `edge`,**不**降级 |
| 10 | 人工手动执行 ≠ 给 AI 授权 | 审计零新增,且 AI 重试**仍然被拦** |

## 4. 运行期

```bash
node bin/guard.mjs log --tail 20     # 最近 20 条判定
node bin/guard.mjs log --stats       # 汇总:动作/来源/规则/失败分类/成本
node bin/guard.mjs status            # 健康状态(降级时退出码 3)
```

## 5. 总验收清单

- [ ] `node bin/guard.mjs selftest` 12/12
- [ ] 七份 `tools/selftest-*.mjs` 全过(**Windows 与 WSL 各跑一遍**)
- [ ] `judge 'ls -la'` = allow / prefilter(零网络调用)
- [ ] `judge 'git push --force origin main'` = block / static-rule
- [ ] `judge 'rm -rf ~/某个真实目录'` = revise 或 block(联网判定)
- [ ] 装进 DSH 后,一条必然被拦的命令**真的被拦**,且 `guard.log` 有记录
- [ ] `guard status` 输出"✅ 正常"(健康自检;降级时退出码为 3)
- [ ] **人工介入三通道 U1–U3** 各走一遍(令牌 / 审批弹窗 / 人工手动执行)
- [ ] 回滚演练:按 §6 撤掉,确认恢复原状

## 6. 回滚

| 动作 | 命令 |
|---|---|
| 卸掉插件 | `dsh plugin --profile <profile> remove jev-guard` + 重启 |
| 一键回到某个配置快照 | `dsh-undo-savepoint` 的 `undo_list` / `undo_restore` |
| 只想停用 | `dsh-undo-savepoint` 的 SAFE MODE(`undo_safe_mode on`)让所有用户插件停用 |
| 清状态/日志 | 删 `~/.jev-guard/`(它不写其他位置) |

## 7. 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| 装了插件但什么都不拦 | 插件没挂上,或包路径不对 | 跑 `selftest-entry` + 看 `guard.log` 有没有记录;读 `DSH-INTEGRATION.md` §5 |
| `source: error`,理由是 `HTTP 401` | 密钥无效或被撤销 | 换密钥;**同时阀门已自动降级 30 分钟**(不再发请求),修好后等冷却到期自动恢复,或 `guard status --clear` |
| `source: error`,理由是 `HTTP 402` | 额度用尽 | 同上一行(这条会**降级**而不是逐次重试,省钱) |
| `source: error`,理由是 `HTTP 403` 且正文是 HTML | CDN/WAF 在边缘把请求挡了,它没到判定服务 | 你这边不用做什么:这被分类为 `edge`,**不降级**。若持续出现,说明出口被拦了 —— 看 `guard log --stats` 的 `edge` 计数 |
| `source: degraded` | 处在降级窗口内 | `guard status` 会说明是哪一类 + 还剩多久;免费的 L0 + 预筛仍在工作 |
| `source: error`,理由是 `fetch failed` | 网络/代理不通 | 检查 `https://api.typesafe.ai` 可达性。**不会降级**(瞬态),但会累计在"失败分类"里 |
| `guard status` 一直显示已降级,或告警说状态文件删不掉 | 状态文件所在目录只读,冷却与恢复都写不进去 | 手工删除 `~/.jev-guard/degraded.json`,或修好该目录权限。除此之外阀门是健康的、照常联网判定;那个文件消失之前,每个新进程会重复一次探测 |
| 危险命令没被拦 | 不在 L0 且 `p < lowThreshold` | 看 `judge` 输出的 `p`;必要时调低 `lowThreshold` 或给该类命令加 L0 规则 |
| 全被拦,干不了活 | 阈值过低或 L0 太激进 | 先看 `judge` 的 `rule.id`;编辑 `lib/rules.js` 或调高 `lowThreshold` |
| 授权行粘到 cmd.exe 里报语法错 | cmd 不认 POSIX/PowerShell 的引号 | 改用 `guard allow --command-file cmd.txt` |
| 判定服务抖动导致干不了活 | 不该发生(fail-open) | 若确实发生,查 `guard.log` 里的 `source: error` 与 `errorKind` |

## 8. 安全与隐私(必须原样转告用户)

1. **脚本正文会被发送到 TypeSafe 的 API。** 这是"看懂 `node x.mjs` 干了什么"的代价。
   敏感路径(`.env` / `.ssh` / `*.pem` / `*credential*` / `*secret*` / `*token*`)自动跳过,单文件 8KB 上限。
   想彻底关闭:`config.json` 里 `inlineScripts: false`(代价是这类命令退回 p≈0.31 的盲区)。
2. **密钥只从凭据层 / 环境变量 / `secrets.json` 读取,不写进任何日志和报告。** 报告里的命令文本会经过掩码。
3. **失败一律放行(fail-open)**:判定服务不可用时阀门不拦任何东西 —— 因为 DSH 自己的沙箱档位
   (除 `danger-full-access` 外)仍在执行之前。想"服务挂了也拦",把 L0 规则加厚,而不是改这条策略。
4. **它挡不住蓄意绕过。** 换壳、编码、直接写 `~/.jev-guard/allow.txt` 都可能绕开。
5. **它防的是事故,不是对手 —— 这个范围是用户显式定下来的,别自作主张收窄。**
   已知且**有意保留**的旁路至少两条:文件写入类工具直接写 `allow.txt`;换一种写法绕开判定。
   处置方式是**记录在案**,不是堵。决策原文与理由:[docs/DECISIONS.md](./docs/DECISIONS.md) **D1**。
