# START-HERE — 把这个目录指给一台机器上的 AI

你在读的是 **jev-guard**(DSH 的执行前安全阀门)的交付包。这份文件是**入口**:把下面那段提示词
原样粘给那台机器上的 AI,它就能自己读懂、自己验证、自己装进 DSH、并把结论写回来。

- 路径:WSL `/mnt/t/dsh-jev-guard` · Windows `T:\dsh-jev-guard`(**同一份文件**,改一处两侧生效)
- 零依赖,不需要 `npm install`
- **只支持 DSH**(2026-09-20 收窄为单一宿主)
- 自检:`node bin/guard.mjs selftest` 应输出 12/12(不联网);`node bin/guard.mjs status` 看健康状态
- 平台:**WSL 与 Windows 都支持** —— 拦 `bash`(WSL)与 `pwsh`(Windows),授权行按平台给正确引号

---

## 一、前置(人做,一次)

1. 让密钥可被解析到,二选一:
   - **推荐**:放进 DSH 的凭据层(`ctx.credentials`,轮换后无需重启);或
   - 在包里建 `secrets.json`,内容 `{"TYPESAFE_API_KEY": "apikey_..."}`。
     **不要**把密钥贴进任何 AI 对话 —— 让 AI 从这个文件读。
2. 想改阈值/降级策略就 `cp config.example.json config.json` 再改。
3. 跑一次 `node bin/guard.mjs judge 'pnpm test'` 确认能联网判定(输出里 `source` 应为 `jev`)。

## 二、粘给那个机器上的 AI 的提示词

```text
你现在的工作目标:在 <平台:WSL / Windows> 上把 jev-guard(DSH 的执行前安全阀门)装进 DSH 并完成验收。

第一步,按顺序读这四个文件(不要跳读):
  <包路径>\README.md
  <包路径>\docs\DSH-INTEGRATION.md    ← 它用 DSH 的哪些机制、四态怎么映射、降级契约
  <包路径>\DEPLOY.md
  <包路径>\docs\VERIFICATION.md        ← 验收清单(含人工介入三通道)

硬约束(违反任何一条就停下来写 blocked):
1. 只允许修改 DSH 自身的 profile 配置 与 <包路径>\verification-results\ 下的文件。
   包内其它文件一律只读 —— 要改就先在结论里提出来,不要自己动手。
2. 绝不把任何 API key / token 打印到对话里;需要时从 secrets.json 或凭据层读。
3. 验证没通过之前,不要把阀门装成"阻断"模式;先确认它能判定(judge 一条必然被拦的命令)。
4. 改任何配置之前先备份原值,并在结论里写清怎么回滚。
5. 判定一律用 `node bin/guard.mjs judge '<命令>'` 实测;**验证要看副作用**
   (命令真的被拦、日志真的有那条记录),不要凭"没报错"下结论。
6. 做完(或卡住)时,用下面这条命令把结论写回来:
   node <包路径>\tools\report-result.mjs --host dsh --item <编号> --status <pass|fail|partial|blocked|skipped> --evidence "证据" --notes "补充"
   卡住时用 --status blocked --question "你的问题"。

完成后请回报:改了哪些文件、每项验证的结论与证据、以及下一步建议。
```

## 三、验收怎么记录

所有结论都落在 `<包路径>\verification-results\`:

- `dsh.json` —— 机器读(主控 AI 直接读这个)
- `SUMMARY.md` —— 自动生成的总表(人读)

**主控 AI 只需要读 `SUMMARY.md`**,就知道哪些项通过了、哪些卡住了、卡在哪一句问题上。
被卡住的条目会带 `--question` 出现在底部的"需要介入的问题"一节。

## 四、边界(必须在心里过一遍)

1. **它是事故安全网,不是安全边界。** 对蓄意绕过不设防,那要靠沙箱/容器。
   **⚠️ 这是显式决策,不是待办。** 已知且有意保留的旁路:agent 可以用文件写入工具直接写
   `~/.jev-guard/allow.txt`;agent 可以换写法绕过判定。**不要试图"顺手修掉"它们** ——
   完整理由与用户定调见 [docs/DECISIONS.md](./docs/DECISIONS.md) **D1**。
2. **判定服务不能是唯一防线。** L0 硬规则不联网、不可覆盖,永远在先(`lib/rules.js`)。
3. **脚本正文会发送到 TypeSafe 的 API。** 敏感路径自动跳过、8KB 上限;
   不想这样做就把 `config.json` 的 `inlineScripts` 设为 `false`(代价是 `node x.mjs` 这类命令
   的检出率从 0.82 掉回 0.31)。
4. **失败一律放行(fail-open)。** 想"服务挂了也拦",就把 L0 规则加厚,而不是改这条策略。
   **额度用完也算失败**(判定服务收费):这时阀门会**降级** —— 停掉要花钱的语义层、
   默认继续跑免费的 L0 + 预筛,并把这件事写进拒绝理由、审计日志、stderr。
   一句话查状态:`node bin/guard.mjs status`(降级时退出码 3)。
5. **授权是人的动作。** `guard allow` 只在交互终端生效(agent 自己跑会被拒),
   但这只是"不顺手发生",不是安全边界 —— 见第 1 条。
   人一共有**三条**介入通道,见 [docs/USER-INTERVENTION.md](./docs/USER-INTERVENTION.md)。
6. **插件"装上了"与"真的在拦"是两件事。** 2026-09-20 真实发生过三层静默失效(脚本一声不响地
   退出 0、命令照跑、日志什么都没有)。所以验收必须看副作用,并跑
   `node tools/selftest-entry.mjs`(Windows 与 WSL 各一遍)。详见
   [docs/MEASUREMENTS.md](./docs/MEASUREMENTS.md) §10。

改了任何一条边界决策,请一并更新 [docs/DECISIONS.md](./docs/DECISIONS.md)。

---

## 五、Windows 上的三条注意事项

1. **授权行**:被拦命令的理由里给出的是 **PowerShell** 形式(POSIX 的 `'\''` 在 PowerShell 里
   直接语法错误,实测)。用 **cmd.exe** 的话两种写法都不认 —— 把命令原文**原样**写进一个文件,
   然后 `node T:\dsh-jev-guard\bin\guard.mjs allow --command-file cmd.txt`(与 shell 无关)。
2. **工具名**:Windows 侧要拦的工具是 `pwsh`(已在默认 `tools` 列表里,无需配置);
   若你用的是别的 shell 工具名,把它加进 `config.json` 的 `tools`。
3. **路径**:`~/.jev-guard/`(`guard.log` / `degraded.json` / `allow.txt`)落在
   `%USERPROFILE%\.jev-guard\`;`apiKeyFile` 的相对路径**按包根解析**,与当前目录无关。
