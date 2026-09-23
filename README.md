# dsh-jev-guard

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4B6BFB.svg)](https://github.com/topics/dsh-plugin)
[![platform](https://img.shields.io/badge/platform-WSL%20%7C%20Windows-2f2f2f.svg)](#platform-support)
[![version](https://img.shields.io/github/v/tag/7starsseeker/dsh-jev-guard?label=version&style=flat)](https://github.com/7starsseeker/dsh-jev-guard/tags)
[![npm](https://img.shields.io/npm/v/dsh-jev-guard?label=npm&style=flat)](https://www.npmjs.com/package/dsh-jev-guard)
[![downloads](https://img.shields.io/npm/dm/dsh-jev-guard?label=downloads&style=flat)](https://www.npmjs.com/package/dsh-jev-guard)
[![selftest](https://img.shields.io/github/actions/workflow/status/7starsseeker/dsh-jev-guard/selftest.yml?label=selftest)](https://github.com/7starsseeker/dsh-jev-guard/actions/workflows/selftest.yml)
[![last commit](https://img.shields.io/github/last-commit/7starsseeker/dsh-jev-guard)](https://github.com/7starsseeker/dsh-jev-guard/commits/main)
[![stars](https://img.shields.io/github/stars/7starsseeker/dsh-jev-guard?style=flat)](https://github.com/7starsseeker/dsh-jev-guard/stargazers)

> **English** | [简体中文](README.zh-CN.md) | [Changelog](CHANGELOG.md) | [Design decisions](docs/DECISIONS.md) | [Measurements](docs/MEASUREMENTS.md)

**A pre-execution safety valve for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): before a command actually runs, it asks one question — "will this irreversibly delete or overwrite your real data?"**

It judges with [TypeSafe Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) — a "System One" model that produces no prose, only a **structured decision**. Yes/no questions are what this kind of judgment measures most accurately (114-case calibration, 90.4% with the Chinese text sent as-is). It hooks into DSH's native `tools/pre-execute`, so it is a **hard interception**, not a "please be careful" nudge to the model.

```
command text ──▶ L0 static hard rules (offline · cannot be overridden) ──▶ pre-screen (read-only / rebuildable) ──▶ Jev semantic judgment (~300ms)
                        │                       │                        │
                        └───────────────┬───────┴────────────────────────┘
                                        ▼
                        allow ／ revise (with downgrade templates) ／ block ／ escalate
                            │        │              │          │
                        run it   model rewrites   refuse    DSH approval prompt or one-shot token
```

> **中文说明** — 本文档为英文版,完整中文介绍见 [README.zh-CN.md](README.zh-CN.md)。`dsh-jev-guard` 是 DeepSeek Harness 的执行前安全阀门:每条 `bash` / `pwsh` 工具调用**执行之前**先判定一次(先离线静态规则,再付费语义模型),返回 `allow` / `revise` / `block` / `escalate` 四态之一。它会拦下不可逆的命令,能教模型更安全的写法时就给出降级模板,两者都不适用时提供一次性人工令牌;额度耗尽时**大声降级而不是静默失效**。**它是事故安全网,不是安全边界** —— 见 [Known limits](#known-limits)。

---

## Table of contents

- [What it does](#what-it-does)
- [Install](#install)
- [Languages](#languages)
- [Configuration](#configuration)
- [Behavior under the two approval policies](#behavior-under-the-two-approval-policies)
- [When something is blocked: the three ways a human can step in](#when-something-is-blocked-the-three-ways-a-human-can-step-in)
- [When credit runs out: degrade, don't fail silently](#when-credit-runs-out-degrade-dont-fail-silently)
- [Visibility: audit log and status](#visibility-audit-log-and-status)
- [Platform support](#platform-support)
- [Self-checks and verification](#self-checks-and-verification)
- [Repository layout](#repository-layout)
- [Security and privacy](#security-and-privacy)
- [Known limits](#known-limits)
- [Documentation](#documentation)
- [License](#license)

## What it does

| Verdict | Meaning | Who acts next |
|---|---|---|
| `allow` | Provably read-only, or judged safe | Run it |
| `revise` | Not enough evidence to run safely, but a better form very likely exists | The **model** rewrites and retries (three downgrade templates: dry run first / narrow the scope / back up first) |
| `block` | Would irreversibly delete or overwrite, or hit a hard rule | Refused; a human runs it by hand |
| `escalate` | A human must confirm (the hard rules' "always ask" class, or the retry budget is spent) | A human |

Three layers, always in this order:

1. **L0 static hard rules** (`lib/rules.js`): 21 "never allowed" + 16 "human confirmation required". **Offline and impossible to override** — not even a one-shot token gets past them. Rules match at **command position only** (the start of a line, or after `;` `&` `|` `(` `$(`, or after `bash -c "`, and skipping wrappers such as `sudo` / `timeout 30` / `xargs -0` / `find … -exec`) — so *mentioning* a dangerous command inside an argument is not a false positive, **and a real command buried in a multi-line script is not missed either**. Only two rules cannot be anchored structurally (`redirect-to-device`, `fork-bomb`) and match the whole text; the counter `RULE_STATS.anywhere` is always 2.
2. **Pre-screen**: commands that are provably read-only or touch only rebuildable content (caches, build output, `/tmp`) pass straight through, with **zero network calls**.
3. **Jev semantic judgment**: one yes/no question — *"will this command irreversibly delete or overwrite the user's real data?"* — split by two thresholds into `allow` / `revise` / `block`. Measured latency ~300ms (P50 267ms), cost ≈ `$0.000019` per call.

## Install

Requires **Node ≥ 20** (it uses the global `fetch`). **Zero runtime dependencies** — no `npm install` needed.

**Verified host version: DSH 0.1.6-alpha.2.** That is the only DSH release this plugin has been run against, and it is deliberately **not** declared as a host requirement in `package.json`: the plugin market reads that field from the npm manifest and would then block install and update on every other DSH release. Another version is therefore **untested, not forbidden**; if you run one, re-run the self-checks below.

```bash
# 1. Put this repository somewhere permanent, e.g. T:\dsh-jev-guard (/mnt/t/dsh-jev-guard in WSL)

# 2. Let DSH load it (fill in your own profile name)
dsh plugin --profile web add /mnt/t/dsh-jev-guard      # on Windows: T:\dsh-jev-guard

# 3. Restart DSH (plugins are not hot-reloaded)
```

`dsh plugin` resolves `add` through pnpm, so the spec takes anything pnpm accepts. The published package is on npm — the source the plugin market installs from by preference:

```bash
dsh plugin --profile web add dsh-jev-guard
```

A local path is **linked**, so the plugin keeps running from your own checkout — edit a file, restart, done. To install straight from GitHub source instead, use `github:7starsseeker/dsh-jev-guard`.

None of these has anything to build (zero dependencies, no install scripts), so none raises a build-approval prompt.

**A fresh install has no key, and it says so instead of going quiet.** The first session tells you in the conversation itself that no key is configured, and until you record one the valve runs **degraded**: the free L0 hard rules and the pre-screen still work, the paid semantic layer does not. Recording a key is one command, and it is read from stdin — never from an argument, which would land in your shell history and in `ps`:

```bash
node bin/guard.mjs key set        # paste the key, Enter; never echoed, never in shell history
node bin/guard.mjs key status     # which source resolves, and how long it is (never the value)
```

`guard key status` exits 3 when no key resolves, so it works as a health check. There is no cooldown to wait out: the moment a key resolves, the degraded state is cleared and judging resumes on the next command.

The declaration in `package.json` is a standard DSH bundle:

```json
{
  "name": "dsh-jev-guard",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` mounts the plugin on `tools/pre-execute`, and **every tunable lives there** (you can also put them in `config.json`; precedence is `patch > config.json > built-in defaults`).

**API key** — three sources, highest precedence first: the DSH credentials layer (`ctx.credentials`, rotation needs no restart) → the environment variable `TYPESAFE_API_KEY` → a `secrets.json` **you create yourself in the package root** (`{"TYPESAFE_API_KEY": "apikey_..."}`). That file is in `.gitignore` and is deliberately **not** part of the repository or of the published package, so nobody ships one to you — the two sources above it are the ones to prefer. `node bin/guard.mjs key set` writes that file for you (mode 0600), and the DSH adapter reads it too. The key is never printed, and it is masked before anything is written to the log.

**Verify right after installing** (don't settle for "it didn't error"):

```bash
node bin/guard.mjs selftest      # expect: all 12 checks pass (offline)
node bin/guard.mjs status        # expect: ✅ healthy (exit code 3 while degraded)
```

Then run a command in a session that is **certain** to be blocked (e.g. `git push --force origin main`): it should be refused, and that record should appear in `node bin/guard.mjs log --tail 3`.

## Languages

Everything a human or a model reads — verdict reasons, the 37 L0 rule reasons, all CLI output, degradation warnings and `guard status` — exists in **English and Chinese**.

| Knob | What it controls | Default |
|---|---|---|
| `lang` | The language of the messages above | `'auto'` — resolves from `JEV_GUARD_LANG` → `LC_ALL`/`LC_MESSAGES`/`LANG` (only when they name a language we ship) → otherwise `zh-CN` |
| CLI `--lang zh-CN\|en` | The same thing, for one invocation | — |
| `promptLang` | The language of the question sent to Jev **and** of the state keys it reads | `'zh-CN'` |

**`promptLang` is not a translation setting — it is a judging parameter.** The 0.5 / 0.7 thresholds were calibrated against the *Chinese* question (114 labelled cases), so switching it moves a measured boundary. Measured (`tools/probe-prompt-lang.mjs`, 21 probes × 3 repeats per arm × 2 independent runs):

| | |
|---|---|
| Same band as the Chinese question | **18/21** |
| Mean absolute probability gap | **0.049** |
| Signed mean (negative = the English question is more permissive) | **−0.043** |
| Lower / higher / level | 12 / 4 / 5 |
| Repeat-sampling noise (same question, same state) | **0.015** |

Three commands changed band, **all in the permissive direction**: `UPDATE` without `WHERE` (block → revise), `DELETE … WHERE` (block → revise), inline `node -e rmSync` (revise → allow). Two runs agreed. So if you set `promptLang: 'en'`, either re-calibrate or lower both thresholds by ≈ 0.04 — see [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) §14 and **D14** in [docs/DECISIONS.md](docs/DECISIONS.md).

Code comments and the labels inside `tools/` stay Chinese on purpose: they are read by maintainers of a Chinese-first codebase, and translating them would double the upkeep of every future change without changing a single word the product says.

**Why `auto` does not look at the system locale:** it used to fall through to `Intl`, and that bit us on the first real deployment — inside WSL `LANG=C.UTF-8` means "no preference", `Intl` then reports Node's own `en-US` default, and the session suddenly spoke English while the Windows-side CLI stayed Chinese. `C`/`POSIX`/unset counts as *absence of a signal* and lands on `zh-CN`; a locale that really names a language (`en_US.UTF-8`, `zh_CN.UTF-8`) still resolves on its own.

> 中文读者:完整中文介绍见 [README.zh-CN.md](README.zh-CN.md)。

## Configuration

`config.example.json` is the template; every key is listed below (the defaults live in `DEFAULTS` in `lib/gate.js`).

| Key | Default | Description |
|---|---|---|
| `model` | `jev-latest` | Alias of the judging model |
| `endpoint` | `https://api.typesafe.ai/v1/systemone` | Judging service endpoint |
| `apiKeyEnv` / `apiKeyFile` | `TYPESAFE_API_KEY` / `secrets.json` | Key sources; **relative paths resolve against the package root** (independent of cwd) |
| `lang` | `auto` | Language of every human/model-facing message (see [Languages](#languages)); `auto` reads the environment only, falling back to `zh-CN` |
| `promptLang` | `zh-CN` | Language of the question asked to Jev and of the state keys. **A judging parameter, not a translation**: see [Languages](#languages) — switching it to `en` was measured to shift ≈ −0.04 and to flip three probes toward permissive |
| `lowThreshold` / `highThreshold` | `0.5` / `0.7` | The four-state thresholds: `p < low` → allow; `low ≤ p < high` → revise; `p ≥ high` → block. Over 737 real commands this split 98.51% / 0.81% / 0.68% |
| `reviseInAskMode` / `blockInAskMode` | `ask` / `ask` | How the verdict action branches by approval policy: `ask` = hand it to a human approval prompt when approval is available (a human is right there — a 50%-confidence judgment should not be deciding for them); `deny` = fall back to a plain refusal. Under `never` (fully automatic) both stay a plain refusal. **L0 `deny`-class hard rules are unaffected by this switch** — they always block |
| `timeoutMs` | `1800` | Budget for a single judgment; anything over it is allowed (fail-open) |
| `cacheSize` | `256` | Number of cached judgments |
| `inlineScripts` / `maxScriptBytes` | `true` / `8192` | Read the body of an invoked script into the judgment context (measured: lifts the `node x.mjs` blind spot from 0.31 to 0.82); sensitive paths are skipped automatically |
| `retryLimit` | `2` | How many times the same command may be blocked before it escalates (`escalate`, i.e. handed to a human) |
| `tokens` / `tokenPath` | `true` / `~/.jev-guard/allow.txt` | One-shot allow tokens |
| `logPath` / `logMaxBytes` | `~/.jev-guard/guard.log` / 4 MiB | Shared audit log (JSONL, rotated when over the limit) |
| `quotaCooldownMs` / `authCooldownMs` | 15 min / 30 min | Cooldown after quota- and key-class failures |
| `degradePolicy` | `l0-only` | Which layer survives degradation: `l0-only` (stop only the paid semantic layer) or `off` (suspend the whole valve) |
| `pricePerMTok` | `0.042` | Unit price for cost estimation (USD per million input tokens; output is free per the vendor's documentation) |

## Behavior under the two approval policies

The same set of verdicts lands differently under DSH's two session policies — **this is the part people mix up most**:

| Verdict | `approval: ask` (prompts) | `approval: never` (full access / YOLO) |
|---|---|---|
| `revise` (50–70%) | **Handed to a human approval prompt** | Refused **+ downgrade templates + one-shot token hint** |
| `block` (≥70%, semantic layer) | **Handed to a human approval prompt** | Refused **+ one-shot token hint** |
| L0 `deny`-class hard rules | **Refused** (no prompt, no token) | **Refused** |
| L0 `ask`-class rules (`escalate`) | **DSH approval prompt**, the human decides | Refused **+ one-shot token hint** |

> **Why `ask` mode hands both the grey zone and the high scores to a human**: when a person is right there, letting a 50.6% judgment decide for them makes no sense; and under `never` there is nobody to ask, so the valve can only refuse conservatively. When the host has no responder, approval is **fail-closed**, so handing something to a human does **not** turn into automatic approval while unattended; the prompt only ever offers `allowed-once`, never a lasting bypass.

> **L0 `deny`-class hard rules are an absolute gate**: they block under both policies, and even `retryLimit`'s "retry enough and a human handles it" does not apply to them — otherwise one click on "allow" in a prompt would bypass the hard floor (a token cannot cross L0, and neither can an approval).

> `danger-full-access` = `{ sandbox: 'danger-full-access', approval: 'never' }` — **no sandbox underneath, approval effectively off: the valve is the only layer left**. That is exactly why it exists, and it is also the situation where a wrong verdict costs the most. Audit records carry the sandbox preset (`preset`) and the approval policy (`policy`) for that call, so a retrospective can tell whether a sandbox was still behind it at the time.

## When something is blocked: the three ways a human can step in

**① One-shot token (independent of the host, always available).** The reason on a blocked command includes an `ALLOW-XXXXXXXXXX` (the first 10 characters of the hash of the command text). **A human** pastes the whole line the reason gives them into their own terminal:

```bash
# WSL / Linux:
node /mnt/t/dsh-jev-guard/bin/guard.mjs allow '<original command>'
# Windows (PowerShell; quoting switches automatically per platform):
node T:\dsh-jev-guard\bin\guard.mjs allow '<original command>'
# Any platform, any shell (bypasses shell quoting rules — use this for cmd.exe):
node T:\dsh-jev-guard\bin\guard.mjs allow --command-file cmd.txt

node bin/guard.mjs allow --list              # list outstanding tokens
node bin/guard.mjs allow --revoke ALLOW-…    # revoke one
```

Four properties: **bound to the exact command text** (change one character and it is a different token), **deleted on use** (it cannot be replayed), **never crosses L0 hard rules**, and **only issued from an interactive terminal** (the AI running it itself is refused).

**② DSH approval prompt (`approval: ask`).** The valve only marks the command as "a human should look at this"; DSH shows the prompt, and the reason in it is the valve's own text. DSH's answers are a closed set (only "allow once" and "deny"), so **every decision is an independent, per-call decision** — there is no "always allow" to be silently swallowed.

**③ The human just runs it.** You run the command in your own terminal — the valve is not involved, and it **grants the AI no permission either**: your action leaves no record in the audit, and the AI retrying the same command is still blocked.

## When credit runs out: degrade, don't fail silently

The judging service is **pay-per-use**, so running out of credit is a certainty. Default behavior:

| Situation | What the valve does | Where you see it |
|---|---|---|
| Credit exhausted / key invalid (`402` / `401`) | **Degrades**: writes `~/.jev-guard/degraded.json` and stops sending requests for the cooldown window (to save money), running only the **free L0 + pre-screen** by default | `guard status` (exit code 3) · one `⚠️` line in the refusal reason · `source: degraded` and `level: warn` in the audit · stderr of the CLI |
| Cooldown expires | Automatically sends **one** probe request: success restores normal operation (you do nothing), failure keeps it degraded | `guard status` shows how long is left |
| Timeout / network hiccup / 5xx / 429 rate limit / no key / **an edge block** (a CDN/WAF answering `403` with an HTML page: the request never reached the judging service, so the key was never checked) | **No degradation** — each call is simply allowed (fail-open), but it is categorized and recorded | the "failure breakdown" line of `guard log --stats` |

```bash
node bin/guard.mjs status --clear    # don't want to wait out the cooldown: retry once now (a failure re-enters degradation)
```

If you want "once the credit is gone, don't interfere at all" (L0 included), set `degradePolicy: "off"`.

## Visibility: audit log and status

Every judgment appends one JSONL line to `~/.jev-guard/guard.log` (rotated past 4 MiB; keys are masked before the command is written):

```bash
node bin/guard.mjs log --tail 20     # time / action / p / source / matched rule / command
node bin/guard.mjs log --stats       # action·source·rule counts + fail-open + failure breakdown + cost estimate
node bin/guard.mjs status            # one line: is the valve healthy? (exit code 3 while degraded — usable as a health check)
```

## Platform support

**Both WSL/Linux and Windows are supported.** Both platform differences are handled:

| Item | WSL / Linux | Windows |
|---|---|---|
| Tools intercepted | `bash` | `pwsh` (**both are in the default `tools` list**) |
| Quoting in the authorisation line | POSIX `'\''` | **PowerShell `''`** (the two forms are not interchangeable; the code branches by platform) |
| cmd.exe users | — | use `guard allow --command-file <file>` |
| State and log | `~/.jev-guard/` | `%USERPROFILE%\.jev-guard\` |

The self-checks assert the quoting with a **real round trip** (including the negative case: "the POSIX form must fail in PowerShell"), and the cross-platform entry-guard regression only counts as verified once it has been run **on both platforms**.

## Self-checks and verification

```bash
# Seven offline self-checks (no network, no API key)
for t in selftest-entry selftest-i18n selftest-quota selftest-reason selftest-token selftest-rules selftest-audit; do
  printf '%-18s ' "$t"; node tools/$t.mjs | tail -1
done

node bin/guard.mjs selftest          # 12 checks: rules / pre-screen / four-state mapping
node tools/smoke-dsh-adapter.mjs     # adapter smoke test (fake ctx, 9 assertion groups)
node tools/smoke-dsh-pipeline.mjs    # real tool-pipeline integration (run from inside a DSH checkout)
```

The acceptance checklist (20 items, including the three human channels) and the criteria for each item are in **[docs/VERIFICATION.md](docs/VERIFICATION.md)**; past results land in [`verification-results/`](verification-results/).

## Repository layout

```
bin/guard.mjs              CLI: judge | log | status | allow | selftest | rules
lib/gate.js                Judgment engine (L0 → pre-screen → semantic → four states) — caller-agnostic
lib/i18n.js                Bilingual message catalog (zh-CN / en) + language resolution
lib/rules.js               L0 static hard rules (each with an id / regex / reason)
lib/verdict.js             Four-state composition, reason text, retry budget, platform-specific quoting
lib/audit.js               Shared audit log (masking / rotation / stats / cost)
lib/token.js               One-shot allow tokens
lib/quota.js               Degradation state machine after quota/key failures
adapters/dsh/index.js      The native DSH Cordis plugin (the only adapter)
cordis.patch.yml           DSH bundle patch (mount declaration + every tunable)
tools/                     Offline self-checks, smoke tests, verification helpers
docs/                      Mechanics, trade-offs, measurements, acceptance checklist
```

## Security and privacy

1. **The only things sent to the judging service are the command text and, optionally, script bodies** (sensitive paths — `.env` / `.ssh` / `*.pem` / `*credential*` / `*secret*` / `*token*` — are skipped automatically, with an 8KB per-file cap). To turn this off entirely: `inlineScripts: false` (at the cost of `node x.mjs`-style commands dropping back into the p≈0.31 blind spot).
2. **The key is read only from the credentials layer / environment / `secrets.json`** and never enters the log or a report (the command text is masked before writing).
3. **Every failure is fail-open**: when the judging service is unavailable nothing is blocked — DSH's own sandbox preset (anything except `danger-full-access`) still applies before execution. If you want "block even when the service is down", thicken the L0 rules rather than switching to fail-closed.
4. **It does not defend against deliberate bypass**: rewriting the command, encoding it, or writing the authorisation file directly can all get around it. Defending against malicious injection takes a sandbox / a low-privilege user / a container.

## Known limits

**It is an accident net, not a security boundary.** It guards against *accidents* — a mistyped command, an opaque script, the moment nobody stops when full access is granted; it does **not** guard against an *adversary*. This is not unfinished work but an explicit decision: the known and deliberately kept bypasses, together with "under what circumstances to reconsider", are written up in **D1** of [docs/DECISIONS.md](docs/DECISIONS.md) — **please do not "helpfully" seal them.**

Two more deliberate omissions: judging **does not simulate filesystem state** (it will not reason "that file is empty anyway"), and it does not accept "this command is harmless" arguments that would require reading runtime state — that is precisely the crack accidents come in through.

> Every document ships **in English by default, with a Chinese sibling** (`*.zh-CN.md`, linked from a language line at the top of each file). Every number in this README is reproducible from them.

## Documentation

Each document below is English by default; add `.zh-CN` before `.md` (e.g. `docs/DECISIONS.zh-CN.md`) for the Chinese version, which is kept in step with it.

| Document | Contents |
|---|---|
| [docs/DSH-INTEGRATION.md](docs/DSH-INTEGRATION.md) | Which DSH mechanisms it uses, how the four states map, the degradation contract, and why "installed" ≠ "actually blocking" |
| [docs/USER-INTERVENTION.md](docs/USER-INTERVENTION.md) | The three human channels + measured evidence |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Accepted design trade-offs D1–D14 (**read before changing anything**) |
| [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) | Every measured number, latency/cost, incident retrospectives |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The judgment layers, and why judging and intercepting must stay separate |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | The acceptance checklist and per-item criteria |
| [DEPLOY.md](DEPLOY.md) | Deployment manual (including the Windows variant and rollback) |
| [START-HERE.md](START-HERE.md) | Packing/configuration instructions to hand to an AI on another machine |

## License

[MIT](LICENSE)
