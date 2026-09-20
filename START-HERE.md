# START-HERE — Point This Directory at an AI on a Machine

> **English** | [简体中文](START-HERE.zh-CN.md)

You are reading the delivery package of **jev-guard** (DSH's pre-execution safety valve). This file is the **entry point**: paste the prompt below
verbatim to the AI on that machine, and it can work it out on its own, verify it on its own, install it into DSH on its own, and write its conclusions back.

- Path: WSL `/mnt/t/dsh-jev-guard` · Windows `T:\dsh-jev-guard` (**the same files**, edit one side and it takes effect on both)
- Zero dependencies, no `npm install` needed
- **DSH only** (narrowed to a single host on 2026-09-20)
- Self-check: `node bin/guard.mjs selftest` should output 12/12 (no network); `node bin/guard.mjs status` shows the health state
- Platforms: **both WSL and Windows are supported** — it intercepts `bash` (WSL) and `pwsh` (Windows), and the authorisation line gives the correct quoting for the platform

---

## 1. Prerequisites (done by a human, once)

1. Make the key resolvable, one of two ways:
   - **Recommended**: put it into DSH's credential layer (`ctx.credentials`, no restart needed after rotation); or
   - create `secrets.json` in the package with the content `{"TYPESAFE_API_KEY": "apikey_..."}`.
     **Do not** paste the key into any AI conversation — let the AI read it from this file.
2. To change thresholds / degradation policy / language, `cp config.example.json config.json` and then edit it.
   The copy comes in two versions, Chinese and English, and `lang` defaults to `'auto'` (follows the system locale); **leave `promptLang` alone** — it is a judging parameter,
   and the Chinese default is exactly the language in which the thresholds 0.5/0.7 were calibrated (`docs/MEASUREMENTS.md` §14).
3. Run `node bin/guard.mjs judge 'pnpm test'` once to confirm it can judge over the network (`source` in the output should be `jev`).

## 2. The Prompt to Paste to the AI on That Machine

```text
Your objective now: on <platform: WSL / Windows>, install jev-guard (DSH's pre-execution safety valve) into DSH and complete acceptance.

First step, read these four files in order (do not skip any):
  <package path>\README.md
  <package path>\docs\DSH-INTEGRATION.md    ← which DSH mechanisms it uses, how the four states map, the degradation contract
  <package path>\DEPLOY.md
  <package path>\docs\VERIFICATION.md        ← the acceptance checklist (including the three channels for human intervention)

Hard constraints (violate any one of them and stop and write blocked):
1. You may only modify DSH's own profile configuration and files under <package path>\verification-results\.
   All other files in the package are read-only — if you want to change one, raise it in your conclusions first, do not do it yourself.
2. Never print any API key / token into the conversation; read it from secrets.json or the credential layer when needed.
3. Before verification passes, do not install the valve in "blocking" mode; first confirm it can judge (judge a command that is bound to be intercepted).
4. Back up the original value before changing any configuration, and write clearly in your conclusions how to roll back.
5. Always judge by actually running `node bin/guard.mjs judge '<command>'`; **verification must look at side effects**
   (the command really was intercepted, the log really has that entry), do not draw conclusions from "there was no error".
6. When you are done (or stuck), write your conclusions back with this command:
   node <package path>\tools\report-result.mjs --host dsh --item <item number> --status <pass|fail|partial|blocked|skipped> --evidence "evidence" --notes "notes"
   When stuck, use --status blocked --question "your question".

When you are done, please report back: which files you changed, the conclusion and evidence for each verification item, and your suggested next steps.
```

## 3. How Acceptance Is Recorded

All conclusions land in `<package path>\verification-results\`:

- `dsh.json` — machine-readable (the orchestrating AI reads this one directly)
- `SUMMARY.md` — the auto-generated summary table (human-readable)

**The orchestrating AI only needs to read `SUMMARY.md`** to know which items passed, which are stuck, and which question sentence they are stuck on.
Stuck entries appear with `--question` in the "Questions Needing Intervention" section at the bottom.

## 4. Boundaries (you must run through these in your head)

1. **It is an accident net, not a security boundary.** It offers no defence against deliberate bypass; that needs sandboxing/containers.
   **⚠️ This is an explicit decision, not a todo.** Known and deliberately kept bypasses: the agent can write
   `~/.jev-guard/allow.txt` directly with a file-writing tool; the agent can change how it phrases things to bypass judging. **Do not try to "fix them in passing"** —
   the full rationale and the user's ruling are in [docs/DECISIONS.md](./docs/DECISIONS.md) **D1**.
2. **The judging service must not be the only line of defence.** The L0 hard rules need no network and cannot be overridden; they always come first (`lib/rules.js`).
3. **Script bodies are sent to TypeSafe's API.** Sensitive paths are skipped automatically, with an 8KB cap;
   if you do not want this, set `inlineScripts` in `config.json` to `false` (the cost is that the detection rate for commands
   like `node x.mjs` drops from 0.82 back to 0.31).
4. **Failure always passes (fail-open).** If you want "block even when the service is down", thicken the L0 rules, rather than changing this policy.
   **Running out of quota also counts as failure** (the judging service is paid): the valve then **degrades** — it stops the semantic layer that costs money,
   keeps running the free L0 + pre-screen by default, and writes this matter into the rejection reason, the audit log and stderr.
   One command tells you the state: `node bin/guard.mjs status` (exit code 3 while degraded).
5. **Authorisation is a human action.** `guard allow` only takes effect in an interactive terminal (if the agent runs it itself it is refused),
   but this only means "it does not happen by accident", not a security boundary — see item 1.
   A human has **three** channels of intervention in all; see [docs/USER-INTERVENTION.md](./docs/USER-INTERVENTION.md).
6. **"The plugin is installed" and "it really is intercepting" are two different things.** On 2026-09-20 a three-layer silent failure really happened (the script silently
   exited 0, the command ran as usual, the log had nothing at all). So acceptance must look at side effects, and run
   `node tools/selftest-entry.mjs` (once on Windows and once on WSL). See
   [docs/MEASUREMENTS.md](./docs/MEASUREMENTS.md) §10.

If you change any boundary decision, please update [docs/DECISIONS.md](./docs/DECISIONS.md) along with it.

---

## 5. Three Things to Watch Out for on Windows

1. **The authorisation line**: the reason given for an intercepted command is in **PowerShell** form (POSIX's `'\''` is
   an outright syntax error in PowerShell, measured). With **cmd.exe**, neither form is recognised — write the command text **verbatim** into a file,
   and then `node T:\dsh-jev-guard\bin\guard.mjs allow --command-file cmd.txt` (independent of the shell).
2. **Tool name**: the tool to be intercepted on the Windows side is `pwsh` (already in the default `tools` list, no configuration needed);
   if you use a different shell tool name, add it to `tools` in `config.json`.
3. **Paths**: `~/.jev-guard/` (`guard.log` / `degraded.json` / `allow.txt`) lands in
   `%USERPROFILE%\.jev-guard\`; the relative path of `apiKeyFile` is **resolved against the package root**, independent of the current directory.
