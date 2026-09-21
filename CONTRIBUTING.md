# Contributing

> **English** | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for looking. This repository takes small, well-evidenced changes; it does not take drive-by reformatting.

## Before you change anything

**Read [`docs/DECISIONS.md`](docs/DECISIONS.md) first.** Every entry there is a trade-off that was made on purpose, with the measurement evidence from the time. A change that "obviously should" be made usually has an entry saying why it is not — a patch that reverses one without saying so will be sent back.

There is no build step and no runtime dependency: `git clone`, then run the tools with **Node ≥ 20** (the CLI uses the global `fetch`).

## The checks to run

All of these are offline, need no API key, and take seconds:

```bash
for t in selftest-entry selftest-i18n selftest-quota selftest-reason selftest-token selftest-rules selftest-audit; do
  printf '%-18s ' "$t"; node tools/$t.mjs | tail -1
done
node bin/guard.mjs selftest
node tools/smoke-dsh-adapter.mjs
```

CI runs exactly these on Linux and Windows, so a red one is a real failure rather than a local quirk.

Cutting a release is a separate, written-down procedure — it publishes on a tag push with no one watching, so the order matters: see [`RELEASING.md`](RELEASING.md).

## Changing the judgement layer is a recalibration event

`lowThreshold` / `highThreshold`, the question sent to Jev, and the L0 rule set are **calibrated**, not chosen. If you touch them:

1. re-run the affected measurements and put the new numbers in [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md);
2. record the reasoning as a new entry in [`docs/DECISIONS.md`](docs/DECISIONS.md);
3. say so in the pull request — a threshold change without numbers is not reviewable.

`promptLang` is one of these: it is a judging parameter, not a translation setting — see §14 of MEASUREMENTS.

## Documentation is bilingual

Each document ships as English (`NAME.md`, the default) with a Chinese sibling (`NAME.zh-CN.md`), linked from a language line under the H1. Change one, change the other in the same commit. `node tools/check-doc-pairs.mjs` compares the two structurally and lists the Chinese left inside the English file. Its fidelity check compares the Chinese file against the English baseline byte-for-byte and therefore fails for every document as things stand; the structural and leftover-Chinese checks are the actionable ones.

Every number in a document must be reproducible from the repository.

## Never commit

- an API key, a token, or a `secrets.json` of any kind;
- a machine path beyond the generic example path the documents already use;
- anything taken from a real session that was not de-identified first — command text, host names, project names.

## Reporting instead of patching

Bugs and questions go to [issues](https://github.com/7starsseeker/dsh-jev-guard/issues). Security-relevant findings have their own path — see [`SECURITY.md`](SECURITY.md), and read it before reporting a bypass, because most of them are deliberate by **D1**.
