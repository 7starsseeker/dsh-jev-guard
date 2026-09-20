# DEPLOY.md — Deployment manual (DSH)

> **English** | [简体中文](DEPLOY.zh-CN.md)

You are reading the deployment instructions for jev-guard. The goal: make this "pre-execution safety valve" take effect on **DSH**,
and **have acceptable evidence for every step**. **Both WSL and Windows are supported.**

> **Read these two first, then this document:**
> [`docs/DSH-INTEGRATION.md`](./docs/DSH-INTEGRATION.md) — which of DSH's mechanisms it uses, how the four states map,
> the degradation contract, and the retrospective on "the plugin is installed ≠ it is really blocking".
> [`docs/USER-INTERVENTION.md`](./docs/USER-INTERVENTION.md) — the three channels a human can step in through.
>
> **If you are "an AI sent to deploy this", read [START-HERE.md](./START-HERE.md) first** — it has the pasteable task
> prompt and the hard constraints (which files may be changed). When you have finished, come back to this document and follow the steps;
> write the conclusion back to `verification-results/` with `tools/report-result.mjs`.

## 0. How to work (read this first)

1. **Do not skip steps.** The order is: first prove the judging layer works (§2.3) → then install it into DSH (§2.4) → finally the acceptance (§3).
2. **Back up the original value before changing any DSH configuration**, and state clearly in the conclusion how to roll back (§6).
3. **Verify against side effects, not against "it didn't error".** This pack has really had three layers of silent failure: the script exits 0 without a sound,
   the command runs anyway, and the log has nothing at all (see `docs/MEASUREMENTS.md` §10).
4. **Never print the key.** Read it from `secrets.json` or the credentials layer when needed, and report only its length or the last digits of a hash.
5. Every command can first be trial-run read-only (`selftest`, `rules`, `judge`, `status`) — they change no host configuration.

## 1. Prerequisites

| Item | Requirement | Check |
|---|---|---|
| Node | ≥ 20 (uses the global `fetch`, `AbortSignal.any`) | `node -v` |
| TypeSafe key | of the form `apikey_...`; if you don't have one, apply at https://console.typesafe.ai | §2.2 |
| Directory location | `T:\dsh-jev-guard` recommended (in WSL that is `/mnt/t/dsh-jev-guard`) | `ls /mnt/t/dsh-jev-guard` |
| Network | able to reach `https://api.typesafe.ai` | `node bin/guard.mjs judge 'pnpm test'` |
| DSH | able to install local plugins (the profile's `package.json` has `dsh.profile` / bundles) | `dsh --profile <name> --dump-config` |

## 2. Install and configure

### 2.1 Put the directory in place

Put the whole `jev-guard` directory at `T:\dsh-jev-guard` (on the WSL side that is `/mnt/t/dsh-jev-guard`, **the same files**).
**`npm install` is not needed** — zero dependencies, only Node's built-in modules.

### 2.2 The key

Three sources, highest precedence first:

1. **The DSH credentials layer** (recommended): `ctx.credentials.resolve('TYPESAFE_API_KEY')` — goes through DSH's own credential store,
   and after a rotation **needs no restart**.
2. The environment variable `TYPESAFE_API_KEY` (the name is decided by `apiKeyEnv` in `config.json`).
3. A `secrets.json` **you create yourself in the package root**, containing `{"TYPESAFE_API_KEY": "apikey_..."}`
   (**if `apiKeyFile` is given a relative path it resolves against the package root, independently of the current directory** — true on both Windows and WSL).

Do not commit any of the three into any repository.

Record the third one with `node bin/guard.mjs key set` — it reads the key from **stdin only** (never from an
argument, which would land in your shell history and in `ps`), writes `apiKeyFile` with mode `0600`, keeps any
other keys already in that file, and prints the length and the path, never the value. `node bin/guard.mjs key
status` reports which source resolves and exits 3 when none does, so it doubles as a health check.

**A missing key degrades; it does not go quiet (D15).** With no key resolved the paid semantic layer is
paused — the free L0 rules and the pre-screen keep working — and the state is **sticky**: it does not expire
with time (there is nothing to probe), it ends the moment a key resolves, cleared on the spot with zero
requests and no restart. It is also scoped to the entry that reported it (`'cli'` or `'dsh-adapter'`), so a
CLI that cannot see a key does not stop DSH from judging, and vice versa. `guard status` exits 3 while
degraded, and the DSH session gets a one-line notice in the conversation saying which state the valve is in.

### 2.2b Language (optional, it runs without configuring it)

The copy (verdict reasons / CLI output / degradation warnings) exists in Chinese and English, and `lang` defaults to `'auto'`:
it resolves from `JEV_GUARD_LANG` → `LC_ALL`/`LC_MESSAGES`/`LANG`, **and only takes effect when those variables really name a supported language**
(such as `en_US.UTF-8` / `zh_CN.UTF-8`); otherwise (including `C.UTF-8`, or unset) it always uses `zh-CN`.
**This deliberately does not look at the system locale**: under WSL's common `LANG=C.UTF-8`, Node's `Intl` reports `en-US`,
which would quietly turn a Chinese session's reasons into English (measured 2026-09-20). To choose the language explicitly: write `"lang": "en"` in `config.json`,
set `JEV_GUARD_LANG=en` for the DSH process, or use the CLI's one-off `--lang en`.

**Do not casually change `promptLang`.** What it governs is the question sent to the judging service; it defaults to Chinese, which is exactly the language the 0.5/0.7 thresholds were calibrated against;
measured, switching it to English lowers p by about 0.04 on average, and three probes flip towards allow (`docs/MEASUREMENTS.md` §14).
If you really want to switch: re-calibrate first, or lower both thresholds by about 0.04 together.

### 2.3 First prove the judging layer works (not yet installed into DSH)

```bash
cd /mnt/t/dsh-jev-guard
node bin/guard.mjs selftest                                    # expect: all 12 checks pass (offline)
node bin/guard.mjs rules | head -5                             # expect: 21 deny + 16 ask rules listed
node bin/guard.mjs judge 'ls -la' 'git push --force origin main' 'pnpm test'
```

| Command | Expected action | Expected source |
|---|---|---|
| `ls -la` | `allow` | `prefilter` (offline) |
| `git push --force origin main` | `block` | `static-rule` (offline) |
| `pnpm test` | `allow` | `jev` (online, `p` should be far below 0.5) |

On failure: `source: error` = a key or a network problem (see the `errorKind` classification); a `selftest` failure = the pack is incomplete.

**Then run the whole set of offline self-checks again** (seven of them, cross-platform):

```bash
for t in selftest-entry selftest-i18n selftest-quota selftest-reason selftest-token selftest-rules selftest-audit; do
  printf '%-18s ' "$t"; node tools/$t.mjs | tail -1
done
```

### 2.4 Install it into DSH

```bash
dsh plugin --profile <profile> add /mnt/t/dsh-jev-guard      # on the Windows side use T:\dsh-jev-guard
# then restart DSH — plugins are not hot-reloaded
```

After installing, **confirm the plugin is really mounted** (don't look at "it didn't error"):

1. In a session, run a command that **is certain to be blocked** (for example `git push --force origin main`, which hits an L0 hard rule and costs nothing).
   Expect: refused, with `hard rule git-force-push hit` in the reason.
2. Look at the audit: `node bin/guard.mjs log --tail 3` — that entry should appear, with `policy` and `preset`.

It only counts as installed when both hold. **Only when item 1 does not hold**, first check the three layers of silent failure in `docs/DSH-INTEGRATION.md` §5.

### 2.5 Differences on Windows

| Item | WSL | Windows |
|---|---|---|
| Tool to intercept | `bash` | `pwsh` (**already in the default `tools` list**) |
| Quoting in the authorisation line | POSIX `'\''` | **PowerShell `''`** (the plugin switches automatically by platform) |
| cmd.exe users | — | use `guard allow --command-file cmd.txt` (independent of the shell's quoting rules) |
| State/log directory | `~/.jev-guard/` | `%USERPROFILE%\.jev-guard\` |

## 3. Acceptance (all must pass before continuing)

The acceptance checklist is in **[docs/VERIFICATION.md](./docs/VERIFICATION.md)**, and includes **the three human intervention channels** (U1–U3).
Summary:

| # | Acceptance | Criteria |
|---|---|---|
| 1 | The probe command is blocked after installation | the command really is refused + `guard.log` has the record |
| 2 | The L0 path (offline, cannot be overridden) | `mkfs` / `git push --force` → `block` / `static-rule` |
| 3 | The Jev path (online semantic judgment) | `rm -rf` on a real directory → `revise` or `block`, with `p` in the record |
| 4 | The false-positive defence (prose / redirection not hit by mistake) | a dangerous phrase inside the command text, and a command ending in `2>/dev/null`, are both **not blocked** |
| 5 | Audit log | one JSONL line per verdict; `log --stats` has actions/sources/rules/failure breakdown/cost |
| 6 | The token closed loop | authorise → retry the same one → allowed once → the token disappears, with `source: token` in the record |
| 7 | The authorisation entry point is only on an interactive terminal | a non-TTY is refused and prints the whole copyable command line |
| 8 | The approval prompt (policy `ask`) | the prompt appears and carries the valve's reason text as it stands; after clicking allow the command runs |
| 9 | Quota degradation | 402/401 → degradation, zero requests, `guard status` exit code 3, L0 still blocks |
| 10 | A human running it by hand ≠ granting the AI permission | zero new audit entries, and an AI retry is **still blocked** |

## 4. Runtime

```bash
node bin/guard.mjs log --tail 20     # the last 20 verdicts
node bin/guard.mjs log --stats       # summary: actions/sources/rules/failure breakdown/cost
node bin/guard.mjs status            # health status (exit code 3 while degraded)
```

## 5. Overall acceptance checklist

- [ ] `node bin/guard.mjs selftest` 12/12
- [ ] all seven `tools/selftest-*.mjs` pass (**run once each on Windows and WSL**)
- [ ] `judge 'ls -la'` = allow / prefilter (zero network calls)
- [ ] `judge 'git push --force origin main'` = block / static-rule
- [ ] `judge 'rm -rf ~/<a real directory>'` = revise or block (online judgment)
- [ ] after installing it into DSH, a command that is certain to be blocked **really is blocked**, and `guard.log` has the record
- [ ] `guard status` outputs "✅ healthy" (health self-check; exit code 3 while degraded)
- [ ] **the three human intervention channels U1–U3** run through once each (token / approval prompt / a human running it by hand)
- [ ] rollback drill: remove it per §6 and confirm the original state is restored

## 6. Rollback

| Action | Command |
|---|---|
| Uninstall the plugin | `dsh plugin --profile <profile> remove jev-guard` + restart |
| One-click return to a configuration snapshot | `dsh-undo-savepoint`'s `undo_list` / `undo_restore` |
| Only want to disable it | `dsh-undo-savepoint`'s SAFE MODE (`undo_safe_mode on`) disables all user plugins |
| Clear state/log | delete `~/.jev-guard/` (it writes nowhere else) |

## 7. Troubleshooting

| Symptom | Cause | Handling |
|---|---|---|
| The plugin is installed but nothing is blocked | the plugin is not mounted, or the package path is wrong | run `selftest-entry` + see whether `guard.log` has records; read `DSH-INTEGRATION.md` §5 |
| `source: error`, with the reason `HTTP 401` | the key is invalid or revoked | change the key; **in the meantime the valve has already degraded automatically for 30 minutes** (it sends no more requests), so once it is fixed either wait for the cooldown to expire and it recovers by itself, or `guard status --clear` |
| `source: error`, with the reason `HTTP 402` | the credit is used up | same as the line above (this one **degrades** rather than retrying every time, which saves money) |
| `source: degraded` | inside a degradation window | `guard status` will say which class it is + how much is left; the free L0 + pre-screen still work |
| `source: error`, with the reason `fetch failed` | the network/proxy is unreachable | check that `https://api.typesafe.ai` is reachable. It does **not degrade** (transient), but it accumulates in the "failure breakdown" |
| A dangerous command was not blocked | not in L0 and `p < lowThreshold` | look at the `p` in the `judge` output; if necessary lower `lowThreshold` or add an L0 rule for that class of command |
| Everything is blocked and no work can be done | the threshold is too low or L0 is too aggressive | look at the `rule.id` from `judge` first; edit `lib/rules.js` or raise `lowThreshold` |
| The authorisation line pasted into cmd.exe reports a syntax error | cmd does not accept POSIX/PowerShell quoting | switch to `guard allow --command-file cmd.txt` |
| A judging-service hiccup makes work impossible | this should not happen (fail-open) | if it really does happen, check `source: error` and `errorKind` in `guard.log` |

## 8. Security and privacy (must be passed on to the user as it stands)

1. **The script body is sent to TypeSafe's API.** That is the price of "understanding what `node x.mjs` does".
   Sensitive paths (`.env` / `.ssh` / `*.pem` / `*credential*` / `*secret*` / `*token*`) are skipped automatically, with an 8KB per-file cap.
   To turn it off entirely: `inlineScripts: false` in `config.json` (at the cost of those commands dropping back into the p≈0.31 blind spot).
2. **The key is read only from the credentials layer / environment variable / `secrets.json`, and is written into no log and no report.** The command text in a report goes through masking.
3. **Every failure is fail-open**: when the judging service is unavailable the valve blocks nothing — because DSH's own sandbox preset
   (anything except `danger-full-access`) is still in force before execution. If you want "block even when the service is down", thicken the L0 rules rather than changing this policy.
4. **It cannot stop a deliberate bypass.** Rewrapping it, encoding it, or writing `~/.jev-guard/allow.txt` directly can all get around it.
5. **What it guards against is accidents, not an adversary — that scope was fixed explicitly by the user; do not narrow it on your own initiative.**
   There are at least two known and **deliberately kept** bypasses: file-writing tools writing `allow.txt` directly; and writing the same thing another way to get around the judgment.
   The handling is to **record it**, not to seal it. The original decision text and the reasoning: [docs/DECISIONS.md](./docs/DECISIONS.md) **D1**.
