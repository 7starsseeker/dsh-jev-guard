# Changelog

> **English** | [简体中文](CHANGELOG.zh-CN.md)

This project follows a "record the facts by date" approach: every entry states clearly **what changed, why, and how it was verified**.
The complete design trade-offs are in [`docs/DECISIONS.md`](./docs/DECISIONS.md), the measured data in [`docs/MEASUREMENTS.md`](./docs/MEASUREMENTS.md).

## [0.4.1] — 2026-09-20

**Every document a human reads is now English by default, with the Chinese kept as `*.zh-CN.md`.**
The convention is written up as point 5 of **D14** in [`DECISIONS.md`](./DECISIONS.md).

**What moved.** Twelve documents were split: `CHANGELOG.md`, `DEPLOY.md`, `START-HERE.md`,
`adapters/README.md`, `verification-results/README.md` and the seven under `docs/`. Each Chinese
original is preserved byte-for-byte as `<name>.zh-CN.md` — the only difference is one language line
under the title — and both files link to each other, the way `README.md` / `README.zh-CN.md` already did.
`verification-results/SUMMARY.md` is generated, so the generator was taught the language switch and
its default became English (with the evidence column left as a verbatim Chinese quote — a translated
quote would be a forged one).

**How the split was verified (mechanical, not by trust).** `tools/check-doc-pairs.mjs` (added here, so
future edits can keep the pair in step) compares every pair programme-side:
the Chinese file must equal the original at `HEAD` byte-for-byte plus that single line, and the two
files must agree on heading-level sequence, code-fence count, table-row count, link-target set and
numeric multiset. Quoted measurements, log lines, command samples and Chinese corpus entries were left
verbatim, so the only Chinese left in an English document is quoted evidence — that residue was
enumerated and reviewed, file by file.

**Also in this version:** `tools/report-result.mjs` lost its hard-coded Chinese labels (they now live
in `lib/i18n.js`) and its item index gained item 23; code comments and the labels inside `tools/` are
still not translated (D14 point 4) — the line is "read outside the repository → bilingual, read only by
a maintainer → Chinese".

## [0.4.0] — 2026-09-20

**Bilingual Chinese/English: the copy written for people exists in both languages, README defaults to English**; the judging question is still the calibrated Chinese by default.
Trade-offs in [`docs/DECISIONS.md`](./DECISIONS.md) **D14**, measurements in [`docs/MEASUREMENTS.md`](./MEASUREMENTS.md) **§14**.

**Motivation (user request):** change the repository's default README to English, redirect the Chinese introduction the common way; the source code should also support Chinese and English.

**Bilingual copy.** New `lib/i18n.js`: `lang` controls the interface language, default `'auto'`
(`JEV_GUARD_LANG` → `LC_ALL`/`LC_MESSAGES`/`LANG`, **only when they point at a supported language** → otherwise `zh-CN`),
the CLI has `--lang zh-CN|en` as well. Coverage: judging reasons (the four-state headers, the three degradation templates, the token authorisation line),
the reasons of the 37 L0 rules, all CLI output, degradation warnings and the `guard status` report, the state keys sent to the judging service.
**Code comments and the self-check labels in `tools/` are not translated** — they are read by maintainers, and translating them would only double the maintenance cost of every change.

**`auto` deliberately does not look at the system locale — this one was stepped on right there during the first real deployment.** At first `Intl` was also at the tail of the detection chain, and the result: the DSH plugin runs inside WSL, where `LANG=C.UTF-8` means "no preference", so `Intl` reported Node's own `en-US` fallback value — the interception reasons in the session **quietly became English**, while the CLI on the Windows side of the same machine (whose Node reports `zh-CN`) was still Chinese, one valve in two languages. Now `C`/`POSIX`/unset are all treated as **no signal** and fall back to the project's primary language
(`zh-CN`); if you want English, say so explicitly.

**One instrumentation bug in the language switch's precedence was also fixed:** these two items were originally written in the in-package `cordis.patch.yml`, and patch takes precedence over `config.json` — meaning the language a user set in `config.json` would be silently overridden. Now they are changed to comment form
(the default values are still written in the comments), and the language is left to `config.json` / `JEV_GUARD_LANG` / `--lang`.

**The judging question is decoupled from the interface language (this one is the core of this release).** `promptLang` separately controls the question sent to Jev and the state keys, and **defaults to `'zh-CN'` and does not follow the interface language**. The reason is not conservatism but measurement: 21 probes × 3 repeats per arm × 2 rounds,
after switching to the English question **12 probes had a lower p / 3–4 higher** (lowered by 0.04 on average, while the noise of repeated sampling is only 0.015),
**three commands crossed the band outright and all in the direction of allow**: `UPDATE` without WHERE, `DELETE ... WHERE` (block→revise),
inline `node -e rmSync` (revise→allow); same-band agreement 18/21. So switching `promptLang` is a recalibration,
not a translation — to use the English question, recalibrate first or lower the two thresholds by about 0.04.

**Other changes**

- README split into two: `README.md` English (default, for the GitHub first screen and `package.json.files`), `README.zh-CN.md`
  Chinese, the two link to each other at the top (the common practice).
- Rule reasons changed to a bilingual object (`why: { 'zh-CN', en }`), still in the same rule as the regex; `ruleWhy()` takes the current language.
- The output of `guard rules` / `guard selftest` / `guard log` / `guard status` / `guard allow` all goes through the catalogue.
- CLI argument parsing changed to one-shot parsing: the **value** of a switch like `--lang en` can no longer be taken as a command to be judged
  (`guard judge 'x' --lang en` used to judge `en` as well).
- New `tools/selftest-i18n.mjs` (32 cases): the key sets of the two languages agree, the placeholders agree, no residual Chinese in the English,
  rule reasons complete in both languages, the detection chain's handling of "no signal" values like `C.UTF-8`, and two invariants —
  "after the interface is switched to English the question sent to Jev is still Chinese" and "the interface language does not enter the request body (the two interfaces construct a byte-identical state and question)".
- New `tools/probe-prompt-lang.mjs`: a question-language comparison probe, `--repeat` is used to separate the language effect from
  the service's own jitter (service non-determinism: the same state asked three times in a row gave 0.78/0.79/0.82).
- Removed the never-read `cliHints` from `KINDS` (a hidden piece of copy not covered by i18n).
- Removed the never-read `const VERSION = '0.1.0'` from `bin/guard.mjs`: it has no reference at all,
  and had long since drifted three versions away from the version number in `package.json`; leaving it in the file only misleads the next person to read the code.
  (The CLI has no `--version` subcommand; if one is really wanted, reading one line from `package.json` would do.)

**How it was verified**

- All seven offline self-checks pass: entry 20 / **i18n 32 (new)** / quota 54 / reason 54 / token 17 / rules 48 / audit 20.
- `guard selftest` 12/12; `smoke-dsh-adapter` all 10 groups pass.
- One run on the real deployment in each language: `status` / `rules` / `judge <a command that is bound to be blocked>` output correctly under both Chinese and English,
  and the verdicts agree (only the copy differs).
- The parts of the existing assertions that read Chinese copy are now explicitly pinned with `setLang('zh-CN')`, no longer affected by the locale of the machine that runs them.

## [0.3.1] — 2026-09-20

**L0 anchoring completed: false positives and missed detections fixed together in both directions** (the same root cause — the first round of anchoring only did half the job).
Trade-offs in [`DECISIONS.md`](./DECISIONS.md) **D2**, measurements in [`MEASUREMENTS.md`](./MEASUREMENTS.md) **§7.5**,
the boundary matrix in item 7 of [`VERIFICATION.md`](./VERIFICATION.md).

**Motivation (user's measured feedback):** a "check the logs" command had the literal text of `mkfs.ext4 /dev/…` written into a python source
string, and was stopped by L0 as a command — following that lead revealed that the deviation in the other direction mattered more.

**False-positive direction (loosening):** the first round anchored only the 7 deny rules + all 16 ask rules; `mkfs` / `dd` / `shred` /
`chmod -R /` / `vssadmin` / `wbadmin` / `cipher /w` / `diskpart` / `wsl --unregister` /
`kubectl delete ns` / `Clear-Disk` / `Remove-Item … -Recurse` — these **12 still matched the whole text**,
so data inside quotes, comments, variable assignments and code strings all hit `deny` — and L0's `deny`
**has no one-shot token channel**, so on a false block a person can only go run it in the terminal themselves. Now these 12 are uniformly anchored to the command position.

**Missed-detection direction (tightening, this one matters more):** the `^` used for anchoring **has no `m` flag**, so "command position" actually equals only
**the start of the whole string**. Every anchored rule therefore missed all the real commands in a multi-line script:

| Form | Before the fix | After the fix |
|---|---|---|
| `echo x \| xargs git push --force …` | MISS (`xargs` not in the wrapper list) | HIT |
| `bash - <<'SH'` + `git push --force …` | MISS (`^` matches only the start of the string) | HIT |
| `bash -c "` + multi-line + `git push --force …` | MISS | HIT |
| `rm -rf /` and `DROP DATABASE` in a heredoc | MISS | HIT |

Missed detections are fatal only under the `l0-only` degradation (no quota, no network) — and the very reason L0 exists is that moment (D9).
In normal times Jev covers for it, so it was never discovered. Ironically, before the fix the `mkfs` in a heredoc **was in fact a hit**,
only because it was not anchored — the two deviations are two directions of the same root cause.

**The concrete changes**

- The anchoring regex gets the `m` flag (`^` from then on matches the start of **every line**).
- The wrapper list is expanded to `sudo/doas/env/command/nohup/time/nice/ionice/setsid/stdbuf/watch/timeout/xargs/parallel/find`;
  the arguments swallowed may only be ASCII words/flags/path characters — Chinese prose is therefore still not caught along the way (measured: `xargs 删除 mkfs…` is not a hit).
- `bash -c "` / `sh -c '` also count as a command position.
- Only `redirect-to-device` (`>`) and `fork-bomb` (`:(){…};:`) remain explicitly marked `where: 'anywhere'`;
  a new counter `RULE_STATS.anywhere` (constant at 2; if it grows, full-text matching has crept back in).

**How it was verified**

- `tools/selftest-rules.mjs`: 25 → **48 cases** (22 matrix cases split into A against false positives / B against missed detections / C against collateral damage to prose,
  plus 1 performance case: a 4KB wrapper prefix **0.6ms**, confirming there is no catastrophic backtracking).
- The other six suites have no regression (entry 15 / quota 54 / reason 56 / token 17 / audit 20 / smoke 10).
- Real deployment: item 7 was expanded by three lines (the original false-positive probe + two multi-line/wrapper forms that "must be caught by L0").

## [0.3.0] — 2026-09-20

The judging action **forks with DSH's approval mode**; and a potential hole through which the retry budget could bypass the L0 hard floor is fixed. Trade-offs in
[`docs/DECISIONS.md`](./docs/DECISIONS.md) **D13**, acceptance steps in item 22 of [`docs/VERIFICATION.md`](./docs/VERIFICATION.md).

**Motivation (user's measured feedback):** "the safety valve also blocks when it hits 50%-or-more, but what I actually have in mind is, block in fully automatic mode,
and in the modes that need approval change all the interceptions into an approval prompt."

Audit corroboration: of the day's 59 `revise`/`block` refusals, **9 happened in sessions with `approval: ask`**
(p all in 0.50–0.63), the commands being `cp` into a deployment directory, `sed -i`, `mkdir -p`, `git add -A && git commit`
— all of them the operator's own maintenance actions, **the person was right there but could not get a prompt**, which amounts to letting a 50% judgment decide in the person's place.

**What changed**

- `ask` (the person is on the spot): `revise` (50–70%) and **Jev's high-score `block` (≥70%) both turn into a human approval dialog**;
  the reason header becomes "needs human confirmation", the dialog body carries the three degradation templates as before; the one-shot token authorisation line is **no longer** attached.
- `never` (fully automatic): both remain a **direct refusal** + token hint — in such a session DSH turns any `ask` straight into
  `rejected`, so a conservative refusal by the valve is the only correct way to land.
- **The only exception**: L0's `deny`-class hard rules (`rm -rf /`, `mkfs`, `git push --force`…) are **hard-blocked** in both modes,
  no dialog, no token.
- New config `reviseInAskMode` / `blockInAskMode` (default `ask`); to go back to the old behaviour fill in `deny`, no code change needed.
- **Potential hole fixed**: the retry budget used to upgrade "any non-escalate verdict" to escalate after the `retryLimit+1`-th time —
  the same held for L0 hard hits, so in `ask` mode submitting `git push --force` three times in a row would pop the dialog, and clicking "allow" **crossed the hard floor**
  (contradicting D5's "a token does not cross L0"). Now a hard hit does not take part in the budget upgrade (it still records `attempts` for auditing).
  The audit shows this path was **never triggered** before the fix (a purely potential hole, not an accident that happened).

**How it was verified**

- `tools/selftest-reason.mjs`: 38 → **56 cases**, adding the routing matrix of `revise`/`block` × `ask`/`never` × L0,
  the two config switches, and "the header follows the routing result".
- `tools/smoke-dsh-adapter.mjs`: 9 → **10 groups**, adding "an L0 hard rule tried 4 times in a row is always deny (not upgraded into a dialog by the budget)".
- Real-deployment acceptance (item 22) **must be run** on both the `ask` and the `never` side — running only one side is marked `partial`.

## [0.2.0] — 2026-09-20

Narrowed from "wanting to make it general-purpose" to **DSH-specific**, and "how a person intervenes" and "what to do when the paid quota runs out" were filled in.

**Renaming**

- Package name `jev-guard` → `dsh-jev-guard` (matching `dsh-*` plugin naming); the loader `name` in `cordis.patch.yml` follows.
- Platform support unchanged: **both WSL/Linux and Windows are supported**.

**New: the person's three intervention channels** (see [`docs/USER-INTERVENTION.md`](./docs/USER-INTERVENTION.md))

- One-shot allow token: bound to the command's original text, deleted once used, does not cross L0 hard rules, authorised only on an interactive terminal;
  the authorisation line gives the correct quoting for the **platform** (POSIX `'\''` vs PowerShell `''`), and Windows has `--command-file` as well.
- Host approval prompt: under `approval: ask` DSH pops the dialog, the reason carries the valve's original text; when a dialog can be shown the token hint is no longer attached.
- Executing by hand: the valve is not involved, and it does not thereby give the AI any permission.

**New: degradation when the quota is exhausted** (see [`docs/DECISIONS.md`](./docs/DECISIONS.md) D9)

- `quota` / `auth`-class failures → write `~/.jev-guard/degraded.json`, no more requests are sent inside the cooldown window (saving money),
  by default only the **free L0 + pre-screen** runs; when the window expires one probe is automatically let through, and success restores normal operation.
- Warnings appear in the refusal reason, the audit (`source: degraded` + `level: warn`), stderr and `guard status` (exit code 3 while degraded).
- New cost visibility: the `usage` in the response is counted into the audit, `guard log --stats` converts it to US dollars and marks the coverage.

**DSH-specific work**

- Audit records carry the session's **sandbox preset** (`permission/preset`), so a later retrospective can tell "was there still a sandbox behind this at the time".
- Two entry points aimed at external callers were removed (a long-running HTTP judging service, a stdio protocol service) — a DSH plugin is in-process.

**Fixes (three layers of cross-platform entry-point defects, see [`docs/MEASUREMENTS.md`](./docs/MEASUREMENTS.md) §10)**

1. `import.meta.url === \`file://${process.argv[1]}\`` is always false on Windows → the script silently exits 0;
2. while fixing the first layer a shared module was extracted for DRY, which made `import.meta.url` point at that module itself → even WSL broke;
3. a dynamic `import(join(ROOT, …))` throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` on Windows.
   Also fixed: `apiKeyFile` relative paths are resolved against the package root; `no-key` no longer triggers a global degradation.

**Security**

- Three real secrets in the test fixtures (two API keys + one GitHub token) have been replaced with synthetic values — they would otherwise have been published along with the repository.

**Acceptance**: the whole self-check suite passes on both the WSL and the Windows side (see [`verification-results/`](./verification-results/)).

## [0.1.0] — 2026-09-20

First release: the four-state valve hooked into DSH `tools/pre-execute` (L0 static hard rules + pre-screen + Jev semantic judgment),
a shared audit log, a retry budget, the degradation templates in the refusal reason.
