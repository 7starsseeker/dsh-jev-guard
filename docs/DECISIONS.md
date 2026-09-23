# Accepted design trade-offs (do not "helpfully fix" them)

> **English** | [简体中文](DECISIONS.zh-CN.md)

This file is for **whoever comes later — human or AI**: every entry below is a trade-off that was **made on purpose**, with the measurement evidence from the time.
If you think one of them "obviously shouldn't be this way", read the reasoning through first; if you want to change it, change it as an explicit decision and update this file.

---

## D1 · The valve is an **accident net**, not a **security boundary** (user's call, 2026-09-20)

**Decision:** We do not aim to "stop an agent that deliberately bypasses". We only prevent **accidents**: a mistyped command by a model/human, an opaque script,
the one shot nobody stops in YOLO mode.

**This is the bypass list we deliberately accept:**

| Bypass | Current state | Why we don't plug it |
|---|---|---|
| The agent writes `~/.jev-guard/allow.txt` directly with a file-writing tool | Entirely possible (the valve hangs only on the `bash`/`pwsh` tools) | Plugging it would mean bringing `write`/`edit` into judging too (the question would have to be redesigned), or doing file-level permissions — that is **another product** (the job of a sandbox/container/seccomp), not this valve's job |
| The agent rewrites the command to bypass judging (`rm -rf` → `find -delete` → `python -c shutil.rmtree`) | Jev usually still understands it, but there is no guarantee | See D2's fallback idea: rely on **layering**, not on a single point |
| Prompt injection makes the agent act maliciously | Not defended | Defending against this requires a sandbox/container/permission model |

**The user's own words (the tone-setter):** *"This bypass that still exists can be recorded in the documentation, no need to plug it — as long as this can prevent accidents, that's enough."*

**When to reconsider this:** if some day you want to lend the agent on this machine to someone else, or let untrusted input drive it.
The right move then is to **add another layer** (sandbox / low-privilege user / container), not to rebuild the valve into a security boundary.

---

## D2 · L0 hard rules are anchored on "command position"; commands inside quotes go to Jev

**Decision:** Except for two structural exceptions, **all** L0 rules match only at **command position**.
Command position = start of line (under the `m` flag, the start of **every line**) / after `;` `&` `|` `(` `$(` /
after the quotes of the `bash -c "` kind, where "a string is executed as a script", with a chain of wrappers allowed
(`sudo` / `timeout 30` / `xargs -0` / `nice -n 5` / `find … -exec` …).
The two exceptions are explicitly marked `where: 'anywhere'`: `redirect-to-device` (the pattern starts with `>`)
and `fork-bomb` (pure syntax `:(){…};:`) — they cannot be anchored to the concept of "command position".
`RULE_STATS.anywhere` is always 2, and `tools/selftest-rules.mjs` prints it.

**Evidence:** whole-text matching in L0 **three times** blocked the operator's own legitimate operations (writing the command text inside an argument,
writing self-check code containing test cases inside a heredoc). And measured, Jev gives these "prose-style mentions" only **p=0.02–0.08**, while for a real invocation it gives
**0.8–1.0** — so handing the prose inside quotes to it as a fallback costs no real coverage.

**Second correction, 2026-09-20 (the first pass turned out to be incomplete, and wrong in both directions):**

The first pass changed only the 7 deny rules + all 16 ask rules, while `mkfs` / `dd` / `shred` / `chmod -R` / `vssadmin` /
`wbadmin` / `cipher` / `diskpart` / `wsl --unregister` / `kubectl delete ns` / `Clear-Disk` /
`Remove-Item … -Recurse` — these **12 rules still matched the whole text**, so data inside quotes, comments, variable assignments and
**strings inside code** (measured: `c.startswith('mkfs.ext4 /dev/sdb1')`) all hit deny
— and L0's `deny` has **no one-shot token channel**, so when it is wrongly blocked a human can only go run it in a terminal themself.

More serious is the **opposite direction**: the `^` used for anchoring had no `m` flag, so "command position" actually equalled only **the start of the whole string**
(plus after a separator). The consequence was that for any anchored rule, real commands inside multi-line scripts (heredocs) and multi-line `-c` were **all missed**:

| Form | Before the fix | After the fix |
|---|---|---|
| `git push --force origin main` (single line) | HIT | HIT |
| `cd /tmp && git push --force …` (after a separator) | HIT | HIT |
| `echo x \| xargs git push --force …` | **MISS** | HIT |
| `bash - <<'SH'` + `git push --force …` (multi-line) | **MISS** | HIT |
| `bash -c "` + multi-line + `git push --force …` | **MISS** | HIT |
| `rm -rf /` / `DROP DATABASE` inside a heredoc | **MISS** | HIT |
| the raw text inside quotes/comments/assignments/code strings | **HIT (false positive)** | — (handed to Jev) |

**Why this missed detection matters:** the whole reason L0 exists is to hold the `mkfs` / `dd of=/dev/*` / `git push --force` class
when there is **no network and no quota** (`degradePolicy: 'l0-only'`) (see D9). In normal times Jev covers the missed detection, so nobody ever found out;
while degraded it is a vacuum. Ironically: before the fix, `mkfs` inside a heredoc **did hit** — only because it was not anchored.

The boundary matrix (18 forms) and the performance cases (a 4KB wrapper prefix, against catastrophic backtracking) are in
[`../tools/selftest-rules.mjs`](../tools/selftest-rules.mjs); acceptance item 7 is run against them.

---

## D3 · A failed judging is always **fail-open** (allow)

**Decision:** timeout, network error, service 5xx, code exception → allow, and record `source: error` in the audit log.

**Evidence:** the host's own sandbox and approval policy are still enforced before execution; the valve is only an **incremental** check. If it were changed to fail-closed,
one wobble at Typesafe and you can't get any work done. To "block even when the service is down" you should **thicken the L0 rules** (the layer that does not depend on the network),
not change this policy.

**Health signal:** the `fail-open` counter in `guard log --stats`; if it stays 0, the judging service has never quietly gone down.

---

## D4 · The thresholds stay 0.5 / 0.7 — solve the friction with tokens, not by lowering the bar

**Decision:** `lowThreshold: 0.5` / `highThreshold: 0.7` (measured on 737 real commands:
98.51% allowed / 0.81% grey zone / 0.68% blocked).

**Evidence:** raising the threshold lets real destruction through — `rm -rf ~/真实目录` measured at **0.68–0.82**,
and the grey zone also contains `docker compose down -v` (0.69). Now that a **one-shot allow token** exists, "blocked" no longer equals "stuck",
so we would rather err strict. If you really want less interruption, one line in `config.json` changes it (0.6/0.8), but that is an explicit trade of risk.

---

## D5 · A one-shot token covers only the grey zone and blocks; it **does not cross L0**

**Decision:** a token can allow `revise`/`block`; for L0's `deny` rules it is **ineffective**, and no token is shown in the reason either.
It is bound to the full command text (whitespace collapsed), deleted once used, and the allow is written to the audit (`source: token` + `overridden`).

**Evidence:** L0 is the hard floor in the four-layer design; if a token could cross it, "never allowed" would exist in name only.

---

## D6 · Authorisation (`guard allow`) can only be done in an **interactive terminal**

**Decision:** `guard allow` / `--revoke` check `stdin.isTTY`; a non-TTY is refused outright and the whole line is printed, ready to copy.

**Evidence:** measured, when the agent runs the authorisation command itself it is **also judged dangerous** (p=56%) — because the destructive command is right there in
the command text. This used to be stopped by coincidence; rather than rely on coincidence, make it an explicit design point: **authorisation = a human action.**
(Note this is not a security boundary, see D1: the agent can still write a file to bypass it; it just means "the supervised party opening a back door for itself" will not **happen casually**.)

---

## D7 · The script body gets uploaded to TypeSafe's API

**Decision:** `inlineScripts: true` by default — read the body of the invoked script as judging input.

**Evidence:** looking at the command line alone, `node migrate.mjs` (with `DROP COLUMN` inside) scores only **p=0.32**;
with the body read in, **0.82**. This is the necessary price for "understanding opaque commands".

**Existing mitigations:** sensitive paths (`.env` / `.ssh` / `*.pem` / `*credential*` / `*secret*` / `*token*`)
are automatically skipped and not uploaded; an 8KB per-file cap; `inlineScripts: false` turns it off entirely (the price: falling back to a 0.31 blind spot).

---

## D8 · The package structure is "judging core + a thin adapter layer"; no DSH mechanics in `lib/`

**Decision:** `lib/` holds only the caller-independent judging core (`gate` / `rules` / `verdict` / `token` / `audit` / `quota`),
and everything DSH-related lives in the single file `adapters/dsh/index.js`.
(`package.json`'s `exports["."]` points at it, and `main` is in sync.)

**Evidence:** the way this project was first written makes it easy to assume judging is tied to DSH. But in fact judging looks at nothing belonging to the host
(it doesn't look at filesystem state, doesn't look at session history, doesn't need a model to take part), so it should have been separated anyway —
**the reason for separating was changed once, in D11**: not to take on other callers, but so that judging can be **replayed offline**
(calibration, regression and accident retrospectives all depend on this). Putting it in `lib/` would lead the next maintainer to keep adding host logic into the core.

**A verifiable form:** `grep -riE "cordis|PreToolDecision|ctx\.|approval/policy" lib/*.js` should hit only **comments**
(the comment there currently explains "why escalate turns into a rejection under full permissions").
The only host difference in the code is one boolean unrelated to DSH: `canPrompt`.

**Contract document:** at the time it was `docs/HOST-CONTRACT.md` (a host-independent contract). **It has been superseded by D11** —
what corresponds now is [`DSH-INTEGRATION.md`](./DSH-INTEGRATION.md) (DSH integration: which mechanisms are used, how the four states map, the degradation contract).
D8's "keep host logic out of `lib/`" **is still in force**, but the reason changed in D11: not to support more callers,
but so that judging can be replayed offline.

**Rollback:** this move left a `lib/index.js.bak-moved-to-adapters-dsh` on the deployed instance; after verifying on restart that the plugin loaded as usual, it was deleted.

---

## D9 · When the quota runs out, **degrade to L0-only and warn explicitly** (default), rather than a silent fail-open

**Decision:** the judging service is **paid**, so running out of quota is a certain event. Once a failure falls into a persistent category
(`quota` / `auth` / `no-key`), we:

1. **Write a readable state file** `<JEV_GUARD_HOME>/degraded.json` (reason, start time, recovery time, failure count, the raw error);
2. Within the cooldown window (**quota 15 minutes / key 30 minutes**) **send no more requests** — saving money, and saving every command from waiting on a request that is bound to fail;
3. When the window expires, send **one** probe request: success → recover automatically (a human need do nothing); failure → extend and stay degraded;
4. **During degradation, run only the free L0 + pre-screen by default** (`degradePolicy: 'l0-only'`); transient failures (timeout/network/5xx/429 rate limiting)
   still fail open per occurrence and do **not** degrade, but are classified and recorded.

**Why D3's fail-open alone is not enough:** functionally it is not wrong (commands still run), but it is **silent** — commands keep being allowed,
the log fills up with `source: error`, and **nobody can see at a glance that the valve is no longer protecting anything**. This project has already been burned once by
a "silent failure" (the audit-log round, see MEASUREMENTS §7), so this time we don't repeat it.

**Why degradation still keeps L0 (rather than "stopping the whole valve"):** L0 and the pre-screen **cost nothing, need no network, and are deterministic**,
and they happen to cover the worst class (`mkfs` / `dd of=/dev/*` / `git push --force` / `wsl --unregister`).
Stopping them too amounts to trading "the quota is gone" for "the most dangerous class of commands loses its protection". Stopping them as well is an **explicit choice**:
`degradePolicy: 'off'` (measured and covered: with that config even `mkfs` is allowed).

> **User confirmation (2026-09-20):** in their own words, *"if the layer that costs money is not in effect, that's fine"* — that is,
> `degradePolicy: 'l0-only'` is the desired default, not a stopgap. This entry shares its root with D1: the valve's job is
> to separate "the semantic judgment that costs money" from "the deterministic rules that are free"; when the quota is gone, only the former stops.

**Where the warning shows up (the landing place of "someone must be able to find out"):**
- In the **reason of every non-allow verdict** (so the approval prompt, the rejection message and the model feedback all carry it);
- On a degraded allow, `source: degraded`, a **separate source** in the audit, not mixed into error;
- At the moment degradation starts, one audit entry with `level: 'warn'` (at most one per window, so it doesn't spam);
- The CLI's **stderr**; the DSH plugin's `ctx.logger.warn`;
- `guard status` (exit code **3** = currently degraded, usable as a health check), `guard log --stats`.

**Known trade-off:** during degradation **the semantic layer has no effect at all on new commands** — a carefully disguised destructive command will be allowed.
That is the inevitable consequence of "the quota is gone", not something code can remove; all we can do is ① keep the free layer ② let people find out quickly.
Per D1, this is not a security-boundary problem (it never defended against deliberate bypass anyway).

**Evidence:** on 2026-09-20 a real API was hit with an invalid key: `HTTP 401` → classified `auth` → degraded for 30 minutes,
the state file wrote out the real error body, the second call was `source: degraded` with **zero requests**, and `guard status` exited 3.
There are also 109 offline assertions (`tools/selftest-quota.mjs`, with a stand-in fetch covering 402/401/403 (JSON auth vs edge HTML)/two kinds of 429/5xx/timeout/network/no key/a corrupt state file/a state file that cannot be removed).

---

## D10 · The entry guard is **inlined**, dynamic imports use **relative specifiers**; the degradation set takes in only the two classes where "the service's attitude changed"

Both were forced out by real accidents, and **both look like "improving the code"**, so they must be written down to keep them from being changed back.

### D10.1 The entry guard must be inlined in each file

**Decision:** the lines that decide "am I being executed as the entry point?" are **written separately in each entry script**
(the one left in the package is `tools/extract-commands.mjs`; there used to be two more, archived outside the package as the scope narrowed).

**Evidence:** the old form `import.meta.url === \`file://${process.argv[1]}\`` is **always false** on Windows
(argv1 is `T:\…`, the url is `file:///T:/…`) → the script **exits 0 immediately** after loading, and under many calling conventions
**exit code 0 means "allow"**: the valve neither blocks nor records, and nobody knows. When fixing it, DRY led the guard to be pulled into `lib/entry.js` —
and so it became **always false on WSL too**, because **`import.meta.url` is each module's own**; once it is in a shared module,
what gets compared is that file's own path.

**So this is not duplicated code, it is "each copy speaks only about its own identity".** The correct form:

```js
function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
```

`realpathSync` also handles drive letters, backslashes, relative paths and symlinks. **Companion clause:** a dynamic import must use a **relative specifier**
(`await import('../../lib/gate.js')`), not `import(join(ROOT, …))` — on Windows an absolute path is not a valid ESM specifier
(`ERR_UNSUPPORTED_ESM_URL_SCHEME`), whereas a relative specifier resolves against this module's own URL, which holds on both platforms.

**Guard rail:** `tools/selftest-entry.mjs` really spawns each entry script and asserts that "the three files each define the guard and
do not import it from a shared module". **This layer only counts as verified when run on Windows** — on WSL the drive-letter problem can never be caught.

### D10.2 Only `quota` and `auth` trigger degradation; `no-key` does not

**Decision:** the degradation set narrows to `{quota, auth}`. `no-key` is classified and warned about, but **does not write the shared `degraded.json`**.

**Evidence:** `degraded.json` is **globally shared**, while key resolution **is independent per entry**
(the DSH plugin uses `ctx.credentials`, the CLI and the offline scripts use an environment variable or a file). This amplification chain has occurred: one entry could not
read the key because the cwd was wrong → wrote a shared `no-key` degradation → **other entries with a working key also stopped network judging for 30 minutes**.
And `no-key` does not send a single HTTP request, so degrading saves nothing — it is a **local configuration** condition, not "the service's attitude toward us changed".
At the same time the trigger itself was fixed: in `bin/guard.mjs`, **a relative-path `apiKeyFile` is always resolved against the package root** (independent of cwd).

**The rule of thumb:** whenever you have "shared state + each component's own premises", first ask "can this local failure get written into global state?".

> **Partly superseded by D15 (2026-09-20).** The amplification chain described above is real, but it is now
> answered by **scope** rather than by staying silent: `no-key` *does* degrade, and the state records the
> identity of the entry that wrote it, so only that entry is suppressed. The per-entry key-resolution fix
> below still stands — and the rule of thumb above is exactly what produced the scope field.

---

## D11 · **DSH only** (narrowed 2026-09-20, user decision)

**Decision:** this package no longer keeps a "generic" promise. The other execution channels tried historically, together with their implementation and verification tooling,
**have been removed from this package** (on 2026-09-20 the user decided not to keep that archive), and only DSH is left:

- under `adapters/` there is only `dsh/`;
- the docs talk only about DSH's mechanisms (`docs/DSH-INTEGRATION.md` replaced the old `HOST-CONTRACT.md`);
- the acceptance checklist keeps only DSH's items (`docs/VERIFICATION.md`);
- **no file in the package mentions other tools any more** (cleaned up 2026-09-20);
- the **transferable lessons** worth keeping are written in [`MEASUREMENTS.md`](./MEASUREMENTS.md) §12, without naming specific tools.

**Evidence (it is not "we can't", it is cost-effectiveness):**

1. **Each host's approval/trust mechanism differs**, and doing any one of them solidly is a separate round of work.
2. **A structural defect was exposed by measurement**: on the question "can the host ask a human", that implementation **was permanently equivalent to no** —
   the policy came from an env the host could not inject, it ignored the permission fields in the payload, and whatever the policy it emitted the same rejection verdict.
   So "can it ask a human" degraded into "always hard-reject", and **the host-approval human channel was unreachable**. Fixing it would mean redoing that output contract.
   (The transferable lesson: **information you cannot obtain must be acknowledged as unobtainable; don't use a default value to pretend it exists.**)
3. **An unverified adapter is more dangerous than no adapter**: it looks like it has the valve installed, but in fact it doesn't block.

**What is kept:**

- `lib/` is still caller-independent — **the reason changed**: not to take on other hosts, but because judging must be **replayable offline**
  (calibration, regression and accident retrospectives all depend on this). `bin/guard.mjs` and the seven self-checks depend on it.
- **Cross-platform (WSL + Windows) is unchanged** — a platform is not a host. Both platform differences are handled: both the `bash`/`pwsh` tools are in the default list;
  the quotes in the authorisation line fork by platform (see D12).
- The code in the archive directory carries the cross-platform fix for the entry guard; don't lose it if it is ever revived.

**The bar for reviving any route:** first run the full acceptance on that host (including "the command really gets blocked + the log really has a record"),
then add it back to the supported list; merely "the script runs" does not count. **Files in the package must not mention them in advance** —
write them into the docs once they are actually done.

---

## D12 · The quotes in the authorisation line **fork by platform**; on Windows there is also a shell-independent `--command-file`

**Decision:** `shellQuote(value, platform)`: POSIX uses `'…'` + `'\''`; Windows uses `'…'` + `''` (PowerShell).
The reason text additionally points out "use PowerShell" on Windows. Also `guard allow --command-file <file>` reads the raw command from the file,
**completely bypassing the shell's quoting rules** — for cmd.exe (which understands neither form).

**Evidence (measured):**

| Form | In PowerShell |
|---|---|
| `'a''b'` (this package's win32 form) | ✅ round-trips back to `a'b` |
| `'a'\''b'` (the old POSIX form) | ❌ **ParserError**, the syntax isn't even valid |

This text is for the user to **copy verbatim**: paste it and get a syntax error = the authorisation entry is unusable = the human's only exit is blocked. And nobody would find out before
"not a single verdict has happened yet" (R2 only appears when something is blocked).

**Why `process.platform` by default:** when DSH runs on WSL, the terminal the user can paste into is usually WSL/POSIX too;
when DSH runs on Windows, that is PowerShell. "Host and terminal on the same side" is the norm.
When they are on different sides (DSH on WSL, the terminal on Windows), use the `--command-file` route, which is shell-independent.

---

## D13 · The judging action **forks with the approval mode**: under `ask`, `revise`/`block` go to a human, and L0 hard rules still hard-block (user's call, 2026-09-20)

**Decision:**

| Verdict | `approval: ask` (a human is present) | `approval: never` (fully automatic) |
|---|---|---|
| `revise` (50–70%) | **goes to a human approval prompt** (with the three downgrade templates) | rejected outright (+ template + token) |
| `block` ≥70% (semantic layer) | **goes to a human approval prompt** | rejected outright (+ token) |
| L0's `deny`-class hard rules | **rejected** (no prompt, no token issued) | **rejected** |
| L0's `ask`-class rules / retry-budget escalation | goes to a human approval prompt | rejected outright |

The config switches `reviseInAskMode` / `blockInAskMode` (values `'ask'` (default) / `'deny'`) leave a fallback path that needs **no code change**.

**Evidence (measured, 2026-09-20):** before the change only `escalate` looked at the approval policy; `revise`/`block` were always rejected outright.
Of the **59** `revise`/`block` rejections in that day's audit log, **9 happened in sessions with `policy=ask`** (all p in 0.50–0.63);
the commands were `cp` to a deployment directory, `sed -i`, `mkdir -p`, `git add -A && git commit` — all the operator's own maintenance actions,
**with the human right there, yet getting only a "please use a safer form"**. The user's own words: "what I actually had in mind was to block
in fully automatic mode, and in the modes that need approval turn all the blocks into an approval prompt".

This also closes **class (3) in D1's three-way classification** — "the middle state: don't run it yet, look for an alternative; **if you can't find one, wait for the user**".
"Wait for the user" needs a channel that can reach a human, and at the time only `escalate` had one.

**Why this does not make it looser:**

1. `never` (fully automatic) is semantically the `danger-full-access` preset; in such a session DSH judges any `ask` directly as
   `rejected`, so "when there is nobody to ask, the valve rejects directly" is the only correct landing.
2. Under `ask`, **with no responder the approval fails closed** (rejected outright) — going to a human does not become an unattended automatic allow.
3. The prompt grants only `allowed-once`; there is no "allow from now on".
4. The frequency is low: 0.5–0.7 is only 0.81% of the 737-command corpus (about 1/125), so it won't turn prompts into noise.

**It also plugs a latent hole:** the retry budget used to escalate "any non-escalate verdict" to
escalate after the `retryLimit+1`-th attempt — including for a hard hit on a rule with an L0 `deny` rule. That meant under `ask` mode, submitting `git push --force` three times in a row would pop a prompt,
and clicking "allow" in it **crossed the hard floor** (contradicting D5's "a token does not cross L0"). Now a hard hit **does not take part** in budget escalation
(it still records `attempts` for the audit). The audit shows this path was **never triggered** before the fix (a purely latent hole).

**The price (stated plainly):** under `ask` mode, a high-scoring destructive command now **pops a prompt and waits for your click**, instead of being rejected at once — click too fast and get it wrong,
and the consequence is borne by whoever decided; the valve no longer covers for you. If you want "high scores always hard-blocked", set `blockInAskMode` to `deny`;
but **the L0 tier hard-blocks no matter how it is configured**.

## D14 · Copy is bilingual, but **the interface language and the language of the judging question are separate**: `promptLang` still defaults to Chinese (2026-09-20)

**Decision:**

1. All **copy meant for a human or a model** (verdict reasons, L0 rule reasons, CLI output, degradation warnings and status, the referenced script's
   skip note, audit summary titles) exists in both Chinese and English, kept together in `lib/i18n.js` (the L0 rule reasons are the exception: they are written
   next to the rule itself, keeping "one rule, one self-contained unit", see the typedef in `lib/rules.js`).
2. `lang` controls the interface language, default `'auto'`: `JEV_GUARD_LANG` → `LC_ALL`/`LC_MESSAGES`/`LANG`
   (**only when they name a supported language**) → otherwise `zh-CN`. The CLI also has `--lang zh-CN|en`.
   **`Intl`/the system locale is deliberately not in the chain**: the first version put it last, and the real deployment tripped over it right away —
   the DSH plugin runs in WSL, where `LANG=C.UTF-8` means "no preference", so `Intl` reported Node's own
   `en-US` fallback, the reasons in the session quietly turned English, while the CLI on the Windows side of the same machine (whose Node reports `zh-CN`)
   stayed Chinese. One valve, two languages; extremely hard to explain in a retrospective afterwards. `C`/`POSIX`/unset = **no signal**,
   falling back to the project's primary language; if you want English, say so explicitly.
3. `promptLang` controls **the one question sent to the judging service** and the state keys, and **defaults to `'zh-CN'`, independent of `lang`**.
4. Code comments and the self-check labels in `tools/` are **not translated**: the former are read by maintainers, the latter are test-case names;
   translating them would double the maintenance cost of every change, without changing a single sentence of the product's outward-facing copy.

**Why item 3 has to be pulled out on its own (this is the core of this entry):** the thresholds 0.5 / 0.7 were calibrated on the **Chinese question**
(114 cases, see MEASUREMENTS §2). The measurements in §14 show: after switching to an English question, of the 21 probes **12 had a lower p /
4 a higher one**, the average dropping by about **0.04**, and **three commands flipped bands outright** — `DELETE ... WHERE` (block→revise),
an `UPDATE` without WHERE (block→revise), inline `node -e rmSync` (revise→allow), with the direction **all** toward the more permissive side.
Two independent runs agreed, and the noise floor is only 0.015. That is to say: switching the interface to English and casually switching the question to English as well
is equivalent to **quietly moving a measured boundary one notch toward allow**. So the two must be configured separately, defaulting to Chinese;
switching must be acknowledged as a recalibration, not a translation.

**Why not "just don't do an English question at all":** in a non-Chinese deployment, an English question is more natural for the model, and an English question is not unusable —
18/21 agree. Making it an **explicit option with the price written down** beats hiding it or pretending it doesn't exist.

**The price (stated plainly):**

- One more catalogue to maintain; `selftest-i18n` fails outright on three things: "a key written in only one language",
  "placeholders that differ between the two sides", "Chinese left over in the English".
- Automatically resolving the language from the system locale means: **on a machine with an English locale, the output turns English after the upgrade** (a behaviour change).
  If you want it fixed, say `lang: "zh-CN"`.
- The judging behaviour itself is **unaffected**: L0 rules, the pre-screen, thresholds, cache keys and the promptLang default all stay the same —
  `lang` only swaps copy.

5. **The repository's documents are English-first too**: every document defaults to English, with the
   Chinese kept byte-for-byte as `<name>.zh-CN.md` in the same directory and a language line at the top
   of both (point 1 above was about *messages*; this one is about the documents themselves). The rules:
   - **the Chinese file is a byte-for-byte copy of the original**, differing only by that one language
     line; **change both together**;
   - **mechanical comparison instead of trust**, run by `node tools/check-doc-pairs.mjs`: the Chinese
     file must equal the baseline byte-for-byte plus that one language line, and the two sides must
     agree on heading-level sequence, code-fence count, table row count, link-target set and numeric
     multiset (the tool also prints every Chinese line left in the English file, so you can check that
     they are all quotations);
   - **quoted measurements are not translated** — log lines, command samples and Chinese corpus entries
     (such as `xargs 删除 mkfs.ext4 …`) stay exactly as observed wherever they are quoted; a translated
     quote would be a forged one. Any Chinese left in an English document should only ever be of this kind;
   - **generated files follow the language switch**: `verification-results/SUMMARY.md` is produced by
     `tools/report-result.mjs`, which defaults to English (it is a committed artifact read by people, and
     regenerating it on another machine should not make its language drift), while its evidence column
     remains a verbatim quote, i.e. Chinese;
   - code comments and the labels inside `tools/` are still not translated (point 4). The line is:
     **what a reader outside the repository sees** (GitHub visitors, users, models) → bilingual;
     **what only a maintainer reads** → Chinese.

**Relationship to D2/D5/D13:** it changes no judging path. The only thing that touches the judging input is explicitly setting `promptLang: "en"`,
and that belongs to the category "you chose it yourself, and now you have the numbers" (§14).

---

## D15 · `no-key` degrades **stickily and scoped**; the user is told through an **in-session notice**; the key is recorded from **stdin only** (2026-09-20, user decision)

**Context.** A fresh install has no key: no credential-layer entry, no environment variable, no file. Before
this decision the valve stayed silent in that state — each gated command failed open at the semantic layer
with an `error`-class verdict, and nothing the user would ever see (DSH's logger drops plugin info-level
lines). The user asked for three things at once: a real place to record the key, a first-run demand for it,
and a degraded state that says "no valid key" out loud — while keeping the properties that make the plugin
installable at all (zero dependencies, no build step, source install with no build approval).

**Decisions.**

1. **`no-key` is a degrading kind, and the state is sticky.** A missing key sends no HTTP request at all, so
   there is nothing to probe. Unlike `quota`/`auth` — whose recovery is "ask the service once the cooldown
   expires" — `no-key` cannot end with time. It ends with its **condition**: the moment a key resolves,
   `evaluateCommand` clears the state and judges normally. `probeDue()` is false for sticky kinds for good,
   so a keyless deployment never re-enters the judge on every command.
2. **Degradation carries a scope.** `quota`/`auth` are service-side facts and stay `scope: 'global'` (every
   entry obeys them). `no-key` is a local configuration fact, written with the **identity of the entry** that
   reported it (`'cli'` / `'dsh-adapter'`), and an entry obeys only a local state whose scope is its own.
   That is what retires the objection in D10.2 — the fix is the scope field, not silence.
3. **The user is told inside the conversation.** DSH gives a host-only plugin no toast, no banner and no
   startup notice: every settings/Plugins seat is claimed by a browser-side (`dsh.client`) registration, and
   startup warnings reach the terminal only. The one channel that exists is injecting a `notice`-form user
   message at `agent/pre-step`: it renders as a conversation row, is written into the session history, and
   enters the model's context. Rejected alternatives: a slash command (its typed input is durably logged
   unless `recordInput: false`, and the browser composer sees it regardless — never acceptable for a secret)
   and shipping a browser half (that adds a build step, a committed bundle and React externals, giving up the
   zero-build / zero-dependency property this plugin is built on). The notice fires on three transitions —
   first run with no key, entering a degraded state, recovering — **one per state per session**, deduplicated
   against the durable history (`session.deriveMessages()`) so a restart or a resume does not repeat it, and
   it is **never** injected into an empty step batch (that would spend a whole extra model request).
   `notifyInSession: false` turns it off.
4. **The key is recorded with `guard key set`, from stdin only.** Arguments land in the shell history and in
   `ps`, so `key set` accepts no value on the command line and refuses a non-TTY stdin — the same boundary
   `guard allow` uses: a human at a keyboard, and that is verifiable. It writes the `apiKeyFile` in **0600**,
   preserving other keys already in that file, and prints the length and the path, never the value.
   `guard key status` answers "which source wins" and exits 3 when none does.
5. **The adapter had to learn the file.** It resolved the key from `ctx.credentials` and the environment
   only. Because `key set` writes a file, the CLI entry point would have been an empty promise for exactly
   the users who need it most — a fresh install with neither. The adapter now resolves
   `ctx.credentials` → environment → `apiKeyFile`, sharing the CLI's path rule (a relative path resolves
   against the package root, independent of cwd).

**Evidence.** `tools/selftest-quota.mjs` (109 cases) covers the sticky state, the never-probe rule, scope
isolation in both directions, the clear-on-key, and (since 2026-09-23) a state file that cannot be removed.
`tools/smoke-dsh-adapter.mjs` (23 assertions, now
hermetic — it no longer writes into the real `~/.jev-guard/`) covers the notice being **appended** rather
than replacing, the empty-batch guard, the four-key `source` shape and the summary bound, and the file
fallback. `tools/selftest-entry.mjs` runs `guard key set` for real (including the interactive path through a
fake TTY) and asserts the file is written, parseable, 0600 on POSIX, and never echoed.

**The shape is a contract.** `source` carries exactly `kind`/`plugin`/`form`/`summary`; a fifth key is
rejected by the pre-v3 migration validator, and a malformed message surfaces as
`SessionPersistenceCorruptionError` at the **next resume** — a session that will not open, long after the
change. That shape was verified against DSH's own `snapshotJsonValue` (the step `Session.append` performs
first) from inside a DSH checkout; the CHANGELOG records why `tools/smoke-dsh-pipeline.mjs` itself could not
be run in this deployment.

**Trade-off accepted:** a notice is a `role:'user'` message, so it **enters the model's context** (intended —
the model should know the valve is degraded) and costs one prefix-cache miss from that point on. That is why
it fires per state transition, never per step.

**Rule of thumb:** when a plugin "must tell the user something" and ships no UI, first ask what the host
already renders — a conversation notice is durable, attributed and model-visible; inventing a UI surface is
a different project with a different dependency budget.

---

## D16 · A `403` is split by its **body**: an HTML/WAF page is an **edge** block and does not degrade; JSON stays `auth` (2026-09-23)

**Decision:** `401`/`403` no longer map to `auth` wholesale. A response that does not look like it came from the JSON API —
a `text/html` content-type, an HTML body (`<!doctype html`), or a WAF fingerprint (Cloudflare's `cf-ray` /
`Attention Required` / `Error code: 10xx`, and Sucuri, Akamai, Imperva) — is classified into a new, **non-degrading** class
`edge`: no state file, no cooldown, per-call fail-open, recorded as `errorKind: edge`. A 401/403 whose body **is** JSON stays
`auth` and degrades for 30 minutes, because that is what a rejected key actually looks like.

**Why:** 2026-09-23 02:43:19Z, on a live deployment: one judgment came back `403` carrying Cloudflare's generic HTML error
page (183 ms — a quick edge rejection, not a timeout). The old single line filed it as `auth`, wrote a **global** 30-minute
cooldown and told the user "the judging service rejected or revoked the key". All three of those statements were wrong: the
request never reached the application, the key was never read, and the same key answered `200` 0.2 seconds earlier and
6 minutes later. The shape of a genuinely rejected key was measured against the live API with a deliberately invalid key:
`401` with `application/json` and `error_type: authentication_error` — and that shape still degrades.

**Why no cooldown at all, rather than a short one:** an edge block is not a statement about the service's attitude toward us;
it may last a second or an hour and we cannot tell which. A cooldown would switch the semantic layer off for every command in
the meantime on the strength of a guess, while per-call fail-open costs one edge round-trip and keeps the class visible in
`guard log --stats`. That is the rule D9 already applies to timeouts and 5xx.

**When the state file cannot be deleted** (a read-only filesystem — the sandbox case that produced this report) the probe
itself still succeeds, so the valve keeps judging online; what must not happen is the bookkeeping turning every command into
a "probe". That verdict therefore carries `clearFailed` with the errno, the stale window stops driving decisions inside that
process, and the adapter records one `level: 'warn'` audit entry so the cause stays findable; `clearDegraded()` returns the
errno instead of swallowing it, and `guard status --clear` prints it and exits 1 rather than claiming "nothing to clear".
What cannot be fixed from inside is a **new process**: it reads the same old file, and since nobody can delete it, one more
probe happens. That is the honest limit of a filesystem that refuses to forget.
