# 更新日志

本项目遵循「按日期记录事实」的写法:每条都写清**改了什么、为什么、以及怎么验证的**。
完整的设计取舍见 [`docs/DECISIONS.md`](./docs/DECISIONS.md),实测数据见 [`docs/MEASUREMENTS.md`](./docs/MEASUREMENTS.md)。

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
