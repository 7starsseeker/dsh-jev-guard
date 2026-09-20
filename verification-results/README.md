# verification-results

> **English** | [简体中文](README.zh-CN.md)

When a verification item is done, write the conclusion here with `tools/report-result.mjs`:

```bash
node tools/report-result.mjs --host dsh --item 6 --status pass \
  --evidence "after a restart, git push --force was blocked, and the audit log shows rule=git-force-push"
```

- `verification-results/dsh.json` — the raw record (read by a machine)
- `verification-results/SUMMARY.md` — the auto-generated summary table (read by a human)

**Do not write `pass` here for an item that has not really been run.** If you are not sure, write `blocked` and fill in `--question`,
and it will be listed in the "needs intervention" section of the summary.

The files in this directory are **the only runtime artifacts allowed to be written in this package**; every other file is released code and documentation.
