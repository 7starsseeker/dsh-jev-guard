# 发布流程

> [English](RELEASING.md) | **简体中文**

一次发布等于:升版本号、打 tag、推上去。tag 会触发 [`.github/workflows/publish.yml`](.github/workflows/publish.yml),它通过 [trusted publishing](https://docs.npmjs.com/trusted-publishers) 把包发到 npm。**这个项目里不存在任何发布 token。**

## 步骤

```bash
# 1. Bump package.json "version", and add the CHANGELOG entry in both languages.

# 2. The checks the workflow runs anyway — running them first is faster than
#    waiting for CI to tell you.
for t in selftest-entry selftest-i18n selftest-quota selftest-reason selftest-token selftest-rules selftest-audit; do
  printf '%-18s ' "$t"; node tools/$t.mjs | tail -1
done
node bin/guard.mjs selftest
node tools/smoke-dsh-adapter.mjs

# 3. See what the tarball would contain.
npm pack --dry-run --json

# 4. Commit, push, tag, push the tag. The tag push is the release.
git commit -am "chore(release): X.Y.Z"
git push
git tag -a vX.Y.Z -m "dsh-jev-guard vX.Y.Z"
git push origin vX.Y.Z
```

**只有 tag 能触发发布。**这里刻意没有手动触发入口:`npm publish` 发的是 `package.json` 里写的版本,手动跑就等于开了一条"发布一个没人打过 tag 的版本"的路。

## 三道闸

下面任意一条不成立,工作流就会在**上传之前**停下:

1. **tag 与 `package.json` 的 version 一致。**发布时取的版本号来自 manifest、根本不看 tag,所以忘了升版会变成"试图重发一个旧版本",而报出来的原因并不是真实原因。
2. **`selftest` 在 `main` 上跑的那套自检通过** —— 七套离线自检、`guard selftest`、DSH 适配器冒烟。
3. **tarball 不夹带本机状态。**`config.json`、`secrets.json`、`HANDOVER.md`、`guard.log*`、`allow.txt`、`degraded.json`、`verification-results/`、`.zcode/` 按名字拦下。`files` 白名单只在没人放宽它的前提下才算控件,所以这里检查的是打好的 tarball,而不是相信白名单:这个项目**有过真的把凭据发出去的历史**,而发布正是这类失误会抵达 registry 的时刻。

## 发布过的版本号就消耗掉了

npm 拒绝已存在的版本号。所以每次发布都必须是一个新版本号,而"版本号已经发布过"的 tag 也不可能靠重跑把它变出来。

## 发布是以仓库的身份认证的

版本在 registry 上显示的身份是 `GitHub Actions` 加一个 `oidcConfigId`,并且 npm 会附上一份 provenance 证明,把 tarball 绑到本仓库、本条工作流与被打 tag 的那个提交上。在装着这个包的目录里跑:

```bash
npm audit signatures
```

## tag 推上去之后会发生什么

- **`Validating: Automated review hasn't finished`** 是 npm 对新版本的自动化审查,**不是失败**。以这种方式发的第一个版本大约用了 3 分钟;审查结束之前,该版本不在公开读面上,所以 registry 仍然只列着上一个版本。
- **本机 `npm install` 可能对确实存在的版本报 `notarget`**,因为 npm 缓存了该包的版本列表。`--prefer-online` 会重新校验。直接用 HTTP 请求 registry 不受影响,所以两者会有一段时间不一致。
- **插件市场不跟着 npm 的时钟走。**它的目录每天重建一次,所以新版本到达市场是以"天"为量级的。

## 发布没发出去之后怎么补救

怎么做取决于那个版本有没有进 registry:

- **run 在发布步骤之前失败** —— 闸没过,或被 npm 拒了:版本号还没被消耗。修好 `main`,然后把 tag 挪到修复后的提交上(删掉再推)。这会重写一个 ref,所以只适合在该 tag 还很新、且尚未发布的时候做。
- **版本已经在 registry 上**:它已经消耗掉了。用下一个版本号向前修。
- **只想不改变任何东西地重跑一次**:把 tag 删掉、在同一个提交上再推一次。**创建 ref 这个动作本身才是触发运行的原因。**

## npm 那边的一次性配置

trusted publishing 是按包配置的:在 npmjs.com 的包设置 → Trusted Publisher → GitHub Actions,填仓库、工作流文件名 `publish.yml`、环境留空。有一个字段很容易配错:**直接发布是 "Allowed actions" 里的一个可选项**。2026-09-03 之后创建的配置**默认只允许** `npm stage publish`,于是直接发布会以 `403 ... OIDC permission denied for this action` 被拒 —— 而且是在 provenance 证明**已经签好之后**才被拒,看起来像身份有问题,其实不是。

这条工作流用的是直接发布。要改成 `npm stage publish` + 人工 2FA 批准,是一次**两边都要动**的改动:工作流里的命令,与 publisher 的 allowed actions。
