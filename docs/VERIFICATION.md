# DSH acceptance checklist

> **English** | [简体中文](VERIFICATION.zh-CN.md)

This checklist is **the ledger of "what exactly this package has been verified for on DSH"**, and also **the steps for how to re-verify it when you move to another machine**.
Every item says: how to verify it, the criteria, and its record number in `verification-results/`.

**The iron laws of acceptance (bought with three accidents):**

1. **Look at side effects, not at "it reported no error".** Only "the command really was refused" + "the log really has that entry" counts as passing.
   This package has had three layers of silent failure: the script exits 0 without a sound, the command runs all the same, the log is blank (see `MEASUREMENTS.md` §10).
2. **Run it once on each of the two platforms.** Windows and WSL differ in path/quoting/module-resolution rules; passing on one platform does not mean passing on the other.
3. **Records must carry a timestamp and the original text.** The `at` / `token` / `source` fields are the only thing that can separate "I say it blocked" from "it really did block".

How to record (what you write is summarised automatically into `SUMMARY.md`):

```bash
node tools/report-result.mjs --host dsh --item <item number> --status <pass|fail|partial|blocked|skipped> \
  --evidence "evidence (with timestamp/token/key output)" --notes "additional notes or questions"
# when stuck: --status blocked --question "your question"
```

---

## A. The judgment layer (verifiable without installing DSH; purely offline + one network call)

### 6-pre · Adapter smoke test + the real tool pipeline

```bash
node tools/smoke-dsh-adapter.mjs          # fake ctx: wiring/assertions/approval policy/audit fields
node tools/smoke-dsh-pipeline.mjs         # the real ToolRuntime five-stage pipeline (must be run from inside a DSH checkout)
```

**Judging:** the smoke tests all pass (including "`policy` and `preset` are recorded in the audit"); the pipeline test gives the expected `ToolExecutionResult`.

### 7 · The false-positive defence line (must be run whenever a rule changes)

```bash
node tools/selftest-rules.mjs
# two probes: a command whose text mentions a dangerous phrase, and an ordinary command ending in 2>/dev/null — neither may be blocked
echo "git push --force origin main" > /tmp/jev-anchor-test.txt
node bin/guard.mjs judge 'ls -la /var/log 2>/dev/null'
```

**Judging:** the probes are not blocked (prose is left to Jev to judge; measured p≈0.02–0.08).

**Expanded 2026-09-20 — anchoring must be tested in **both directions** (48 cases: 25 old + 22 matrix + 1 performance):

| Direction | The shape it must pin down | Expectation |
|---|---|---|
| Prevent false positives | arguments inside quotes, comments, variable assignments, strings inside python `-c`/heredoc, grep arguments, **code strings** like `c.startswith('mkfs.ext4 …')` | no hit (left to Jev) |
| Prevent missed detections | real commands inside a multi-line heredoc / a multi-line `bash -c "`; `\| xargs`, `timeout 30`, `nice -n 5`, `find … -exec`, multi-level wrapping | **a hit on the corresponding rule** |
| Prevent collateral damage to prose | `xargs 删除 mkfs.ext4 …` (what follows the wrapper is Chinese) | no hit |
| Prevent catastrophic backtracking | a 4KB pure-wrapper prefix (the worst-case input) | < 50ms (measured 0.6ms) |

> **Looking only at false positives misses half the problem.** The first round of fixes only tested
> "prose must not be a hit", so nobody noticed that the anchoring was missing the `m` flag, which made
> **every real command inside a multi-line script a missed detection** (see [`MEASUREMENTS.md`](./MEASUREMENTS.md) §7.5
> and [`DECISIONS.md`](./DECISIONS.md) D2). When you change a rule, **run both directions**.
> One more quantity that is always unchanging: the `RULE_STATS.anywhere` printed by `staticRule` must
> **always be 2** (`redirect-to-device`, `fork-bomb`); if it grows, that means another rule has fallen back to whole-text matching.

### 8 · Audit log (offline) + 8-fix (running instance)

```bash
node tools/selftest-audit.mjs             # masking/appending/rotation/summary/blank logPath
node tools/selftest-i18n.mjs              # bilingual copy: catalogue completeness/placeholders/leftover English/promptLang does not follow the UI language
node bin/guard.mjs log --tail 5           # the running instance really has entries
node bin/guard.mjs log --stats
```

**Judging:** the offline suites all pass; **and** the running instance yields real records (there was once a case of "the valve was working and the log had not a single entry").

### 13 · Quota degradation (offline)

```bash
node tools/selftest-quota.mjs             # stand-in fetch: 402/401/403/two kinds of 429/5xx/timeout/network/bad state file
```

**Judging:** all pass. Three things to confirm specifically: a persistent failure **degrades**, a transient failure **does not degrade**,
and while degraded L0 still blocks and there are **zero HTTP requests**.

---

## B. After installing it into DSH

### 6 · The probe is blocked after installation

Run a command that **is certain to be blocked** (costs nothing):

```bash
# in a DSH session, have the AI execute: git push --force origin main
node bin/guard.mjs log --tail 1
```

**Judging:** the command really is refused, the reason contains `hard rule git-force-push hit`; that entry appears in `guard.log`.
**If it does not pass, read first** `DSH-INTEGRATION.md` §5 (three layers of silent failure).

### 9 · The one-shot token closed loop

1. Have the AI execute a real command that will be blocked (for example `rm -rf <a demo directory>`).
2. The reason should contain `ALLOW-XXXXXXXXXX` + one line of **absolute-path** authorisation command.
3. **The human** pastes that line into their own terminal (a non-TTY is refused — that is the correct behaviour).
4. Have the AI **retry the exact same command, character for character**.

**Judging:** the command really is executed, the token file goes empty, and `guard.log` shows `source: token` and `overridden: <original action>`.
Also verify the binding: change one character in the command → it is **still blocked**, and what is published is **a different** token.

### 10 · The authorisation entry point and the reason wording

```bash
echo | node bin/guard.mjs allow 'rm -rf /tmp/x'   # non-TTY: should be refused and print the whole command line
node tools/selftest-reason.mjs                    # 28+ cases: absolute path/no truncation/quote escaping/policy branching
```

**Judging:** the non-TTY is refused and gives the whole line in a copyable form; `selftest-reason` all passes.
**Windows addition:** quotes in the reason must be in **PowerShell** form (`''` escaping); `--command-file` is available.

### 14 · Degradation is visible in a real session

Inject a degraded state (fault injection), then run two commands:

```bash
# write a kind=quota ~/.jev-guard/degraded.json (with until set in the future)
# then: mkfs.ext4 /dev/whatever   → L0 refuses it; the tail of the reason should carry a ⚠️ degradation warning
#       touch /tmp/whatever       → source=degraded, ms=0 (zero requests)
node bin/guard.mjs status --clear   # wrap up: clear the injected state
```

**Judging:** the warning appears in the **refusal reason**, the audit has one `level: warn` entry, a non-L0 command is `source=degraded` with `ms=0`;
after `status --clear` it goes back to "✅ healthy" (exit code 0).

### 16 · The cross-platform entry guard (run it once on WSL **and** Windows)

```bash
node tools/selftest-entry.mjs             # WSL
# Windows (if DSH/Windows, or this machine, has node.exe):
"C:\Program Files\nodejs\node.exe" T:\dsh-jev-guard\tools\selftest-entry.mjs
```

**Judging:** both platforms pass everything. **Only Windows can expose** that class of problem — "a drive letter + backslash in argv[1]";
if you only ran WSL, mark it `partial` rather than `pass`.

### 17 · Platform-dependent shell quoting (Windows)

```bash
node tools/selftest-reason.mjs    # includes a real PowerShell round-trip + the negative case "the POSIX form fails to parse in PS"
```

**Judging:** all pass. Check by hand: paste that line from the reason into **PowerShell**; `--list` should show the token that was published.

### 21 · Activation check after restarting once renamed to `dsh-jev-guard`

These changes — the rename, the new `preset` field in the audit, the degradation/approval copy fixes, the removal of `serve`/`mcp` — **all take effect only after DSH is restarted**.
After the restart, check three things in order, then do one more real block:

```bash
node bin/guard.mjs status                                  # ① exit code 0 and prints "✅ ... healthy"
dsh --profile <yours> --dump-config | grep -A2 jev-guard     # ② the bundle's id and name are both dsh-jev-guard
tail -n 1 ~/.jev-guard/guard.log                           # ③ the new entry should carry policy and preset as well
```

**Judging:** ① and ② must pass (**with a `degraded.json` present, the `status` exit code is 3** — that is degradation, not a fault).
③ requires `preset` (such as `danger-full-access` / `workspace-write`) to appear in an entry written **after the restart** —
this is the hard evidence that "what is running is the renamed new adapter"; the old version has no such field; ditto `policy`.

Finally hand it one command that **was going to be blocked anyway** for an end-to-end re-verification (pick a harmless one, e.g. `truncate -s 0` on a /tmp probe file),
and confirm three things: the block reason is given as usual, the corresponding entry appears in the audit (`action=escalate` / `decision=deny` /
`source=static-rule` + the same token), and **the command really was not executed** (the probe file does not exist = the block happened before the fact, not a warning after it).

### 22 · The verdict action branches with the approval policy (`ask` hands it to a human / `never` blocks hard / L0 is an absolute gate)

This changes [`DECISIONS.md`](./DECISIONS.md) **D13**. First run the two offline suites; they cover the routing matrix itself:

```bash
node tools/selftest-reason.mjs      # 56 cases: includes the revise/block × ask/never × L0 routing matrix
node tools/smoke-dsh-adapter.mjs    # 10 groups: includes "an L0 hard rule tried 4 times in a row is always deny (the retry budget does not upgrade it into a prompt)"
```

Then **both sides must be run on the real deployment** (the policy can be switched inside a session; no restart needed):

| Scenario | What command to hand it | Expectation |
|---|---|---|
| `ask` + grey zone | a command landing at 50–70% (look at `p` in `guard.log`) | **the approval prompt pops up**; the reason header is "needs human confirmation" and it carries the three degradation templates; the token authorisation line **does not appear** |
| `never` + the same one | as above | **a plain refusal**, with the token authorisation line attached |
| `ask` + L0 hard rule | `git push --force origin main` (in a repo with no remote or a safe repo) | **a plain refusal, no prompt**; audit `decision=deny` |
| `ask` + L0 hard rule tried 4 times in a row | as above, submitted repeatedly | still **not a single prompt** (the budget does not upgrade hard rules); `attempts` in the audit increments up to 4 |

**Judging:** both offline suites pass + all four rows on the real deployment match. **Running only the `never` side does not count as passing** (the routing branch is exactly what this change introduced),
mark `partial`. After approving one, remember to confirm: the approved command **really was executed** (`kind: 'ask'` passes once the host has approved it),
which shows that handing it to a human is not "the block reworded".

### 23 · Bilingual copy and the language switch

Mechanics in [`DECISIONS.md`](./DECISIONS.md) **D14**, measurements in [`MEASUREMENTS.md`](./MEASUREMENTS.md) §14.

```bash
node tools/selftest-i18n.mjs          # 24 cases: same keys in both languages/identical placeholders/no leftover Chinese in English/the question is unaffected by the UI language
node tools/selftest-entry.mjs         # 20 cases: includes --lang / JEV_GUARD_LANG / "the switch's value is not a positional argument"
```

Four rows on the real deployment (each one must be **looked at once in each language**):

| Scenario | Command | Expectation |
|---|---|---|
| Default language | `node bin/guard.mjs status` | when not set explicitly = `zh-CN` (the system locale is not consulted; see the lesson about the WSL `en-US` fallback value in D14) |
| Explicit switch | `node bin/guard.mjs status --lang en` | all English; `--lang zh-CN` all Chinese |
| Environment variable | `JEV_GUARD_LANG=en node bin/guard.mjs rules` | the rule-list reasons become English (the rule ids do not change) |
| The verdict does not change | run the same batch of commands once per language with `judge --json` | `action` / `p` / `source` are **identical field by field**; only the reason copy differs |

**Judging:** both offline suites pass + all four rows on the real deployment match. **Running only one language does not count as passing** — what this item verifies is exactly "the verdict is consistent in both languages and
the copy is correct in each". Also confirm: changing `lang` **must not** change the action/decision in `guard.log` (compare the same batch of commands before and after).

> `promptLang` is not among this item's pass conditions: it is not a copy switch but a judging parameter, and switching it amounts to re-calibration,
> see MEASUREMENTS §14 — it only counts once it has been re-measured with `tools/probe-prompt-lang.mjs --repeat 3`.

---

## C. The three human-intervention channels (must be run on any machine)

The mechanics and properties of the three channels are in [`USER-INTERVENTION.md`](./USER-INTERVENTION.md).

### U1 · The one-shot token channel (**the host-independent** one)

1. Produce a block and note down the token published in the reason.
2. Paste the authorisation line into the human's own terminal; `node bin/guard.mjs allow --list` should show that token.
3. Have the AI retry **the exact same command, character for character** → it is allowed, the token disappears, `guard.log` records `source=token`.

### U2 · The host approval channel (DSH has it, **must be tested**)

1. Switch the session to a mode with approval (`approval: ask`).
2. Trigger one `escalate`-class block (a command that hits an L0 `ask` rule, such as `truncate -s 0 <demo file>`).
3. **The human** should really see the approval prompt, and the reason in it **is the valve's own original text** (hard-rule id + why), and
   the "copy into the terminal to authorise" line is **no longer attached** (the human is right in front of the window).

**Judging:** the prompt appears and carries the original text; after clicking allow the command executes (`outcome=allowed-once`).
The session log shows a matching pair of `approval/asked` + `approval/decided`.

### U3 · Running it by hand ≠ authorising the AI (counter-intuitive, but it must be verified)

1. Have the human execute that blocked command **directly** in the terminal (no token, no prompt).
2. Watch two things: the judgment record for that command in the audit gains **zero new entries**; have the AI retry the same command → it is **still blocked**.

**Judging:** "zero new entries + still blocked" = pass. Failure means there is an unnoticed authorisation leak.

> When counting the audit, mind one trap: `guard.log` records **the text of every command that went through judging**,
> so when you count a command with a substring `grep`, **your own checking command** (which quotes that text) gets counted too.
> Filter precisely with "the `command` field starts with that command".

---

## D. Number quick reference

| Number | What it verifies | Record |
|---|---|---|
| 6-pre | adapter smoke test + the real tool pipeline | ✅ pass |
| 6 | probe blocked after installation | ✅ pass |
| 7 | the false-positive defence line | ✅ pass |
| 8 / 8-fix | audit log (offline / running instance) | ✅ pass |
| 9 | the token closed loop | ✅ pass |
| 10 | authorisation entry point and reason wording | ✅ pass |
| 11 | the three human channels (accepted by hand by the user) | ✅ pass |
| 12 | the host approval channel | ✅ pass |
| 13 | quota degradation (offline + CLI) | ✅ pass |
| 14 | degradation visible in a real session | ✅ pass |
| 15 | the `ask` branch copy branches | ✅ pass |
| 16 | the cross-platform entry guard (WSL + Windows) | see `SUMMARY.md` |
| 17 | platform-dependent shell quoting (Windows) | see `SUMMARY.md` |
| 18 | narrowed to DSH only | see `SUMMARY.md` |
| 19 | non-DSH traces cleared out of the package | see `SUMMARY.md` |
| 20 | checking the package's current state (describes DSH only) | see `SUMMARY.md` |
| 21 | activation check after restarting once renamed to `dsh-jev-guard` | see `SUMMARY.md` |
| 22 | the verdict action branches with the approval policy (`ask` hands it to a human / `never` blocks hard / L0 absolute gate) | see `SUMMARY.md` |
| 23 | bilingual copy and the language switch (consistent verdicts in both languages) | see `SUMMARY.md` |
| U1–U3 | the three human-intervention channels | recorded under 11 / 12 |

History: this checklist once had several preliminary verifications (numbers 1–5) of "can some other execution channel carry the block", which were voided by
the decision to "support DSH only" — those implementations **have been removed from this package**, and the transferable lessons are kept in
[`MEASUREMENTS.md`](./MEASUREMENTS.md) §12 and [`DECISIONS.md`](./DECISIONS.md) D11.
