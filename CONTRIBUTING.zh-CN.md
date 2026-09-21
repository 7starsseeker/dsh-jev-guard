# 参与贡献

> [English](CONTRIBUTING.md) | **简体中文**

谢谢来看这份东西。本仓库接受小而**带证据**的改动;不接受顺手重排格式。

## 动手之前

**先读 [`docs/DECISIONS.md`](docs/DECISIONS.md)。** 那里每一条都是**有意为之**的取舍,带着当时的实测依据。看起来"显然该改"的东西,通常正有一条条目在说明为什么不该改——一条不说清理由就把某条取舍反过来的补丁,会被打回。

本仓库没有构建步骤、没有运行时依赖:`git clone` 下来,用 **Node ≥ 20** 跑工具即可(CLI 用的是全局 `fetch`)。

## 要跑的检查

下面全部离线、不需要密钥、几秒跑完:

```bash
for t in selftest-entry selftest-i18n selftest-quota selftest-reason selftest-token selftest-rules selftest-audit; do
  printf '%-18s ' "$t"; node tools/$t.mjs | tail -1
done
node bin/guard.mjs selftest
node tools/smoke-dsh-adapter.mjs
```

CI 在 Linux 与 Windows 上跑的就是这些,所以红的那一条是真失败,不是本地环境怪癖。

## 改判据层 = 一次重新校准事件

`lowThreshold` / `highThreshold`、发给 Jev 的那句问话、以及 L0 规则集都是**标定出来的**,不是随手选的。要动它们就得:

1. 重跑受影响的实测,把新数字写进 [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md);
2. 把理由作为新条目记进 [`docs/DECISIONS.md`](docs/DECISIONS.md);
3. 在 PR 里明说——没有数字的阈值改动,是没法评审的。

`promptLang` 就属于这一类:它是**判定参数**,不是翻译开关——见 MEASUREMENTS 的 §14。

## 文档双语

每份文档都是英文(`NAME.md`,默认)配一份中文副本(`NAME.zh-CN.md`),由 H1 下面那行语言切换行互相指向。改一份就在同一个提交里改另一份。`node tools/check-doc-pairs.mjs` 会做结构比对,并列出英文版里残留的中文。它的保真检查是把中文版与**英文基线逐字节**比,按现状对每一份文档都会失败;真正可据以行动的是结构检查与残留中文检查这两项。

文档里的每个数字都必须能从仓库复现。

## 永远不要提交

- API 密钥、令牌,或任何形式的 `secrets.json`;
- 文档已经在用的那个通用示例路径之外的任何机器路径;
- 任何没有先去痕的真实会话内容——命令原文、主机名、项目名。

## 报问题而不是提补丁

缺陷与疑问走 [issues](https://github.com/7starsseeker/dsh-jev-guard/issues)。与安全相关的发现另有渠道——见 [`SECURITY.md`](SECURITY.md);报"绕过"之前请先读它,因为那些大多是有意保留的,理由见 **D1**。
