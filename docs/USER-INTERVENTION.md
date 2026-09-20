# How a human gets involved — three channels, and their evidence

> **English** | [简体中文](USER-INTERVENTION.zh-CN.md)

The valve works in a "nobody is watching" mode (YOLO / full permissions / auto-approve), so **"how a human gets in" has to be part of the design** — it cannot rely on "a prompt will pop up anyway". This document spells out the three channels: what each of them needs, who carries it out, and what proves it actually works.

> Every conclusion carries **measured evidence** (2026-09-20, DSH). What has not been measured is written as "unverified", not as fact.

---

## 0. In one sentence

**A human has only three ways to get involved: hand over execution rights once, do it themself, or nod on the spot.** All three implemented — only then is there really "someone in charge".

| Channel | Who carries it out | The valve's role | Does it depend on the host? |
|---|---|---|---|
| **① One-shot token** | **the AI** (retries after being blocked) | verify the token → let **that one command** through once | **No dependency** — pure local hash + a file |
| **② Host approval** | **the AI** (with a human nod) | only marks the command as "a human needs to look at it" | depends on the host's ability to ask a human |
| **③ A human doing it by hand** | **the human** | **not involved at all** | No dependency |

---

## 1. Channel ①: the one-shot token (host-independent, available at any time)

**Mechanism.** A command judged `revise` / `block` / `escalate` gets an
`ALLOW-XXXXXXXXXX` attached to its reason (= the first 10 hex digits of `sha256(normalised command text)`, uppercase).
Once a human writes it into `~/.jev-guard/allow.txt`, the AI **retrying the same command** is let through once, and the token is deleted right after.

**Six properties** (each one has a test):

| Property | Meaning | Evidence |
|---|---|---|
| **Bound to the command's exact text** | change one character and it is a different token; rephrasing gets you no authorisation | a variant with a trailing slash was blocked, and what it gave out was a **different** token, `ALLOW-ADCD5EA86D` |
| **One-shot** | deleted the moment it is used, impossible to replay | after the pass, `allow --list` is empty |
| **Deterministic** | the same command always gets the same token | the same command appeared three times, and was always `ALLOW-5031AC2085` |
| **Does not cross an L0 deny** | "never allowed" things like `dd` writing to a disk / formatting / dropping a database are **deliberately not given a token** | the authorisation line **does not appear** in the reason |
| **Authorised only from an interactive terminal** | `guard allow` requires stdin to be a TTY; the AI running it itself gets refused | refused outright when not a TTY, and it prints the whole absolute-path command line |
| **Leaves an audit trail** | the allowance record keeps the danger level of the original verdict | `{source:"token", p:0.83, token:"ALLOW-…", overridden:"block"}` |

**Why this channel matters:** it is the **only human channel that does not depend on the host**. When the host has no ability to ask a human (or cannot ask), it is how a human can still "let just this one through". The cost is one copy-paste.

**That line in the reason is there for a human to copy-paste whole**: absolute path, the command's exact text **untruncated**, quotes already escaped
(a regression test feeds it to `bash -c 'printf %s …'` and demands byte-for-byte restoration).

---

## 2. Channel ②: host approval (stronger when you have it, not fatal when you don't)

The valve hands `escalate` to the host, and the host decides in what form to ask the human. **The same four states, the same reason**, a different shape:

| Session policy | The host's action | What the valve records | What the human does |
|---|---|---|---|
| `ask` (with approvals) | **pops the approval prompt** | `action=escalate, decision=ask, policy=ask` | click in the prompt — no terminal, no command copying |
| `never` (full permissions) | no prompt available → **a plain refusal** | `action=escalate, decision=deny` | go through channel ①, or run it yourself in a terminal |

**Measured (DSH, 2026-09-20):** after the user switched the session to `ask`, the same blocked command triggered a real approval —
the session log showed the pair `approval/asked` + `approval/decided`, and `asked.reason` was **verbatim the valve's reason**
(the hard rule id and why included); after the user clicked allow, `outcome=allowed-once` (2.2 seconds from pop-up to click),
and the command ran right away, taking the target file from 148 → 0 bytes. This channel **needs no terminal from the human**.

### 2.1 DSH's answer set is a **closed set**: there is no "always allow"

This was verified specifically (source evidence, `deepseek-harness` @ `ddefc45fbc`):

| Location | Content |
|---|---|
| `packages/interaction/user-approval/src/types.ts:32` | `ApprovalOutcome = 'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'` |
| `packages/interaction/user-approval/src/index.ts:204` | comment: `'allowed-once' is the only grant` |
| `packages/client/ui-approval/.../slots.ts:64` | `ApprovalDecision = 'allowed-once' \| 'rejected'` — the UI has only two buttons |
| `packages/session/session-format-v0-to-v1/src/payload-validation.ts:40,43` | validating outcome and policy (`ask`/`never`) are both closed sets |
| `packages/interaction/user-approval/tests/invariant.spec.ts:103` | a negative assertion that `policy: 'always'` **must be rejected** |

**Design implication (good news for the valve):** under `ask` mode every `escalate` is an **independent, one-at-a-time decision**,
and there is no standing authorisation that can silently swallow the valve's ask. So the valve **does not need** to maintain
state like "the user has already agreed permanently" — and therefore there is no risk of that state being bypassed or going stale.

### 2.2 Only DSH is supported (the rest are archived)

As of 2026-09-20 this package **supports DSH only** (see [`DECISIONS.md`](./DECISIONS.md) D11). The other execution channels
tried historically never got finished: each host's approval/trust mechanism is different, and making any one of them solid is a
separate round of work of its own; one of those measurements also exposed a structural defect — **information that was unavailable was pretended to be available by a default value**,
so "can the host ask a human" came out permanently no there, and the host approval channel was unreachable.

There is only one criterion: **does that host have a callback that execution must pass through, and that can say you may not run this?**
Without one you can only build a suggestion layer (the model may simply not comply), and **an unverified adapter is more dangerous than no adapter** —
it looks like the valve is installed while in fact nothing is blocked. Those implementations were removed along with the narrowing of scope; the
transferable lessons are in [`MEASUREMENTS.md`](./MEASUREMENTS.md) §12 and [`DECISIONS.md`](./DECISIONS.md) D11.

---

## 3. Channel ③: the human runs it directly (the valve is not involved)

A human can just run that command in their own terminal — that **does not go through the valve**, and it gives the AI no permission whatsoever.

**Measured (2026-09-20):** a human truncated the target file to 0 bytes in a terminal (153 → 0), and then:

- the audit log gained **zero new entries** — after precise filtering, that command still had 3 verdict records (2 escalates + 1 token allowance).
  The valve audits **the agent's actions**, not the human's: it guards you, it does not watch you.
- the AI then retried **the exact same command, character for character**, was still blocked, and was shown **the same** token.

**Conclusion: `the human did it once` ≠ `a door was opened for the agent`.** The latter has to be delivered explicitly (channel ① or ②).

---

## 4. Why the valve does not need to remember "the human already agreed"

Because **not one of the three channels needs the valve to remember**:

- channel ①: the token file is the fact — read once, consumed once, deleted;
- channel ②: the host decides, and the valve asks afresh every time;
- channel ③: the valve is not on the path at all.

The value of this design is that the valve has **no** "approved list" that can be corrupted, tripped up by an expiry policy, or scrambled by concurrent writes.
Every judging is a clean, replayable, independent computation.

---

## 5. How to verify these three on a **new host**

The protocol steps are in [`VERIFICATION.md`](./VERIFICATION.md) **U1–U3** (they apply to any host;
write the conclusion back into `verification-results/` with `tools/report-result.mjs --host <host> --item U1`).

Three minimal criteria:

- **U1**: the reason for a blocked command **contains** a token; walk through "authorise → retry → let through → token gone", and `source=token` shows up in the audit.
- **U2**: does the host **have** a channel for asking a human? If so, does the prompt carry the valve's reason verbatim? After clicking allow, does the command actually run?
  If not, write down "on this host only channel ① is available".
- **U3**: a human runs the same command by hand in a terminal — the audit gains **zero new entries**, and the AI's retry is **still blocked**.

---

## 6. A wrong guess on the record (staying honest)

On 2026-09-20, this project guessed: *"if the user picks 'always allow' in the prompt, the host might answer the valve's later asks
automatically, degrading one-at-a-time confirmation into a standing policy."*

**That guess does not hold** — DSH has no such option (evidence in §2.1). The one who raised it was the AI; the one who pointed out the error was **the user**.
The recorded entry is `Correction: DSH has no persistent/always approval` in the repository's memory.

This section is kept not as self-criticism but to make one point: **the "unverified" marks in this document are not politeness** —
a guess written down will be taken at face value, so either measure it, or label it.
