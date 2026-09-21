# Changelog

> **English** | [简体中文](CHANGELOG.zh-CN.md)

This project follows a "record the facts by date" approach: every entry states clearly **what changed, why, and how it was verified**.
The complete design trade-offs are in [`docs/DECISIONS.md`](./docs/DECISIONS.md), the measured data in [`docs/MEASUREMENTS.md`](./docs/MEASUREMENTS.md).

## [0.5.2] — 2026-09-22

**Releases now publish themselves from a tag.** The plugin's behaviour is unchanged: `bin/`, `lib/`, `adapters/`, `cordis.patch.yml` and the default config are identical to 0.5.1. Only the way a release reaches the registry changed.

Pushing a `v*` tag runs `.github/workflows/publish.yml`, which publishes through npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) — an OIDC identity exchanged for a one-shot publish grant. No publish token exists anywhere, so there is nothing to store, rotate, or to find expired at the worst possible moment; for a public repository and package npm also attaches a provenance attestation automatically.

Three gates run first, and any one of them fails the release:

1. **The tag must match the version in `package.json`.** `npm publish` ships the manifest's version and ignores the tag, so a forgotten bump would try to republish an old version and fail with a message naming the wrong cause.
2. **The same self-checks the `selftest` workflow runs on `main`** — the seven offline suites, `guard selftest`, and the DSH adapter smoke test.
3. **The tarball must carry no local state** — `config.json`, `secrets.json`, `HANDOVER.md`, `guard.log*`, `allow.txt`, `degraded.json`, `verification-results/` and `.zcode/` are rejected by name. A `files` allowlist is a control only for as long as nobody widens it, so the packed tarball is inspected rather than trusted.

That last gate is why this is a release of its own: this project has shipped real credentials by accident before, and a release is precisely the moment such a mistake would reach a registry.

**Acceptance**: `node bin/guard.mjs selftest` (12/12) and the seven offline suites pass, as does the DSH adapter smoke test; the version gate was exercised in both directions (`v0.5.1` accepted against a matching manifest, `v0.5.2` rejected against a `0.5.1` one); the tarball gate was executed against this repository (52 files, none flagged) and its pattern checked against names it must reject and names it must not. The pipeline's first real run is the `v0.5.2` tag itself.

## [0.5.1] — 2026-09-22

**Published to npm, and the host-version declaration is withdrawn.** What changes here is how the plugin is installed and what it declares — not what it does. `bin/`, `lib/`, `adapters/`, `cordis.patch.yml` and the default config are unchanged from 0.5.0.

**Install from the registry.** The package is published as `dsh-jev-guard`, which is the source the plugin market installs from by preference (a repo-verified npm package, then an author-supplied prebuilt GitHub Release tarball, then a full-repo source download). For anyone on a slow or unreliable route to GitHub that is the difference between seconds and a clone:

```bash
dsh plugin --profile web add dsh-jev-guard
```

`private` is removed, and `publishConfig` pins the registry to `https://registry.npmjs.org/` so a mirror configured in `.npmrc` cannot silently redirect a publish.

**No DSH version is declared.** `engines` now carries only `node`. A floor was briefly added after 0.5.0 (`engines.dsh: "0.1.6-alpha.2"`) but never shipped in a tagged release, and it is withdrawn here. The plugin market reads that field from the npm manifest, and an exact version in it makes the market report "confirmed incompatible" and block install and update on every other DSH release — including whatever later version you move to yourself. With the field absent the market reports "no host requirement declared" and never blocks.

**The tested version is still the documented one.** DSH 0.1.6-alpha.2 remains the only release this plugin has been run against. Another version is untested, not forbidden — re-run the self-check suite if you use one.

**Acceptance**: `node bin/guard.mjs selftest` (12/12) and the seven offline suites (`tools/selftest-*.mjs`) pass, and `npm publish --dry-run` reports 52 files with no configuration, key material, audit log or handover notes in the tarball.

## [0.5.0] — 2026-09-20

**A first-time deployment now has a real place to put its key, and "no key" is no longer silent: it degrades like exhausted credit — loudly, stickily, and without stopping the free layer.**
Trade-offs in [`DECISIONS.md`](./DECISIONS.md) **D15**; the mechanism in [`docs/DSH-INTEGRATION.md`](./docs/DSH-INTEGRATION.md).

**The key entry point: `guard key set` / `guard key status`.** The key is read from **stdin only** — never
from a command-line argument, which would land in your shell history and in `ps`. It writes the file named
by `apiKeyFile` (default `secrets.json` in the package root) with mode `0600`, keeps any other keys already
in that file, and prints the length and the path — never the value. `guard key status` reports which source
resolves and how long the key is, still never echoing it, and exits 3 when there is none, so it doubles as a
health check. Reading and writing share one path resolver, so a relative `apiKeyFile` can never mean two
different files.

**Why the DSH adapter had to change too.** It resolved the key from `ctx.credentials` and the environment
**only**, while `guard key set` writes a file. Without a third source, "record your key with the CLI" would
have been an empty promise for exactly the users who have no credential layer yet — a fresh install. The
adapter now falls back to `apiKeyFile` as well, under the same rule: a relative path resolves against the
package root, independent of cwd.

**`no-key` is now a degrading kind — sticky, and scoped.** It was deliberately non-degrading before
(D10.2), for a good reason: a local configuration problem writing into the machine-wide `degraded.json`
could stop other entries whose key was perfectly fine. That objection is answered by **scope** rather than
by staying silent. Service-side kinds (`quota` / `auth`) stay `scope: 'global'` and suppress every entry;
`no-key` is `scope: 'local'` and suppresses only the entry that wrote it (`'cli'` or `'dsh-adapter'`). And
because a missing key makes **no HTTP request at all**, there is nothing to probe — so the state is
**sticky**: it does not expire with time, it ends the moment a key resolves (cleared on the spot, zero
requests, no restart). `guard status` says that explicitly instead of printing a countdown that would never
matter.

**The user actually gets told.** A host-only plugin has no toast, no banner and no startup notice — every
settings and Plugins surface in DSH is claimed by browser-side (`dsh.client`) registrations. The one channel
that exists is injecting a `notice` message at `agent/pre-step`: it renders as a row in the conversation, is
written into the session history, and enters the model's context (so the model learns the valve is degraded
too). The plugin uses it for three transitions — first run with no key (the demand, carrying the exact
command), entering a degraded state, and recovering — one notice per state per session, deduplicated from
the durable history so a restart or a resume does not repeat it. `notifyInSession: false` turns it off.

**The message shape is a contract, and it is checked.** `source` carries exactly
`kind` / `plugin` / `form` / `summary`, and the summary is bounded to 120 characters (it becomes the
collapsed row's title). Getting this wrong surfaces as `SessionPersistenceCorruptionError` at the *next
resume* — a session that will not open, far away from the change that caused it. So the shape is validated
against DSH's own `snapshotJsonValue` (the step `Session.append` runs first) by a test that runs inside a
DSH checkout, and the four-key source plus the summary bound are asserted offline in the smoke test. That
validation was run for this version and passed.

**Also in this version:** `package.json` no longer declares `dsh.runtime` — it is not a field of DSH's
plugin manifest (`manifestVersion` / `bundle` / `profile` / `client` are), so it did nothing while looking
meaningful to anyone reading the file. `tools/smoke-dsh-adapter.mjs` became hermetic: it used to write
degradation state and audit records into the **real** `~/.jev-guard/`, and every `apply()` in it now pins
`logPath` / `degradedPath` / `apiKeyFile` to a temp directory; it also gained 9 assertions covering the
sticky state, the notice injection (appended rather than replacing; nothing added to an empty batch) and the
file fallback. `tools/selftest-quota.mjs` went from 50 to 78 cases, `tools/selftest-entry.mjs` to 30 (it now
runs `guard key set` for real, including the interactive path through a fake TTY) and
`tools/selftest-i18n.mjs` to 34. Every user-facing string added here exists in both languages.

**Not covered here:** `tools/smoke-dsh-pipeline.mjs` needs a DSH workspace whose bare `@deepseek-ai/*`
specifiers resolve; that does not hold in this deployment, so it could not be executed (it fails the same
way at the previous commit, so this is not a regression). The notice shape was verified directly against
DSH's `snapshotJsonValue` instead.

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
