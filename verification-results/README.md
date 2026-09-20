# verification-results

每个宿主上的 AI 做完验证后,用 `tools/report-result.mjs` 把结论写到这里:

```bash
node tools/report-result.mjs --host dsh --item 6 --status pass \
  --evidence "重启后 git push --force 被拦,审计里 rule=git-force-push"
```

- `verification-results/<host>.json` —— 原始记录(机器读)
- `verification-results/SUMMARY.md` —— 自动生成的总表(人读)

**没有跑过验证的宿主不要在这里写 `pass`。** 拿不准就写 `blocked` 并填 `--question`,
主控 AI 会看到。

这个目录里的文件是**唯一允许写在这个包里的运行期产物**,其余文件都是发布的代码与文档。
