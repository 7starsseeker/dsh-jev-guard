# Security policy

> **English** | [简体中文](SECURITY.zh-CN.md)

## What this project is

`dsh-jev-guard` is a **pre-execution safety valve for accidents**, mounted on DSH's `tools/pre-execute`. It is **not a security boundary**, and it does not defend against a deliberate bypass. That is an explicit, documented decision — **D1** in [`docs/DECISIONS.md`](docs/DECISIONS.md), which also carries the list of bypasses that were accepted on purpose. **Read D1 before reporting a bypass.**

These three are **known and accepted**, not vulnerabilities:

| Accepted bypass | Why it stays |
|---|---|
| The agent writes the token file itself with a file-writing tool | Plugging it means bringing `write` / `edit` into judging, or file-level permissions — that is another product, the sandbox's job |
| The command is rewritten into a form that judges differently | The answer to this is **layering**, not a single-point guarantee — see **D2** |
| Prompt injection drives the agent to act maliciously | Requires a sandbox, a low-privilege user or a container — explicitly out of scope |

## What leaves your machine

The judging service receives **the command text** and, when `inlineScripts` is on, **the body of an invoked script** (paths matching `.env` / `.ssh` / `*.pem` / `*credential*` / `*secret*` / `*token*` are skipped automatically, with an 8 KB per-file cap). Set `inlineScripts: false` to send command text only — at the cost of `node x.mjs`-style calls dropping back into the p≈0.31 blind spot. Nothing else is transmitted: no file contents beyond that, no session history, no environment.

## Credentials

The key is resolved from the DSH credentials layer, then the environment, then a `secrets.json` **you create yourself** in the package root — and it is never printed. It is masked before anything reaches the audit log. `node bin/guard.mjs key status` reports which source resolves and how long the value is, not the value.

## Failures are fail-open — on purpose

Timeout, network error, 5xx and 429 all **allow** the command and record `source: error`. The valve is an **incremental** check: DSH's own sandbox preset still applies after it (except under `danger-full-access`). Making it fail-closed would turn a thing that prevents accidents into a thing that causes them — **D3**. If you want "blocked even while the service is down", thicken the L0 rules instead.

## The audit log

Every verdict appends one JSONL line to `~/.jev-guard/guard.log` (on Windows `%USERPROFILE%\.jev-guard\guard.log`), rotated past 4 MiB. The command text is masked before it is written. Each line records the verdict, the probability, whether the verdict came from a rule or the model, the matched rule id, the sandbox preset and the approval policy in force. Delete the file if you do not want the record.

## Reporting a vulnerability

Use GitHub's private channel: **Security** → **Report a vulnerability** on this repository. That opens a private advisory only the maintainers can see — please do not open a public issue for anything exploitable before a fix exists.

A useful report says what you ran, what you expected the valve to decide, what it decided instead, and the audit line for that call (`node bin/guard.mjs log --tail 5`). Nothing has to be destroyed: a command text that judges wrongly is enough, and it becomes a regression case.

## Scope

In scope: the judgment layers, the L0 rule set and its anchoring, the token file, the audit log's masking and rotation, the degradation state machine, and the CLI. Out of scope: DSH itself, its sandbox presets and its approval UI — those belong upstream, at [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
