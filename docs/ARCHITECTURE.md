# Architecture: why four layers, and why judging must be separate from interception

> **English** | [简体中文](ARCHITECTURE.zh-CN.md)

## In one sentence

**What is portable is the judgment, not the power.** Judging can be made a caller-agnostic function (which is what this package does);
but **enforcement interception must land on DSH's own pre-execution interception point**. Only by separating these two things does the approach hold up —
and it is also the reason it can run the same judging on both Windows and WSL.

## The four layers

```
                            ┌─────────────────────── jev-guard ────────────────────────┐
                            │  L0 static hard rules   offline · cannot be overridden   │
      DSH ──native plugin──▶│  L1 Jev semantic judgment 300ms · the four states · cache│ ──▶ TypeSafe API
                            │  L2 pre-execution snapshot (planned)                     │
      (DSH only)  ─────▶    │  Three surfaces: CLI · library · offline self-check      │
                            └──────────────────────────────────────────────────────────┘
```

### L0 — static hard rules (offline)

**Responsibility:** the two lists "never allowed" and "must be confirmed by a human". `lib/rules.js`, 21 deny + 16 ask.

**Why it is a separate layer:** it must not depend on the network, must not depend on a model, and must not be overridable
by anything downstream. In DSH the counterpart is
`ctx.tools.guard()` — the documentation's own words: may deny or abstain, **never force-allow**.
Implementing hard rules with a semantic model amounts to building safety on one network request.

### L1 — Jev semantic judgment

**Responsibility:** grey-zone judgment. "Will this command/script irreversibly delete or overwrite real data?"

**Why it is this one question:** across 114 measured cases, the same question scored **12/12** in Chinese; while in the
same batch "what should be done" (a semantically adjacent three-way choice) scored only 75%, and "risk level" only 50%. **Yes/no questions are accurate, degree questions are not** —
so the level is composed by code, not asked of the model.

**The four states rather than three:** "let the model try again" (a seconds-long closed loop) and "wait for a human" (possibly hours) are two different control flows.
Mixed together, they either drag a person into small matters, or let the model retry without end in the same pit with a different phrasing. `revise` must carry three deterministic
degradation templates (read-only equivalent / narrower scope / back up first), because it cannot give a command — it produces no text.

### L2 — pre-execution snapshot (planned)

**Responsibility:** judging can never be 100% accurate; this layer catches the misjudgment. **Do only the git provider first** (highest coverage, lowest cost):
snapshot only when it can be enumerated and the size is within budget; when it cannot be enumerated or is over budget, block outright. The measured constraints on this machine are in `docs/MEASUREMENTS.md` §5.

### L3 — the human exit

It is not in this pipeline, but it is part of the design: the **one-shot token** (lets one command through once),
the **DSH approval prompt** (`approval: ask`), and **a human running it by hand**. The properties of the three channels and the measured evidence for each are in
[`USER-INTERVENTION.md`](./USER-INTERVENTION.md).

## Data flow (one judgment)

```
command text + cwd
   │
   ├─ L0 hit? ──yes──▶ block / escalate (end, zero network)
   │
   ├─ deterministic pre-screen hit? ──yes──▶ allow (end, zero network)
   │        (read-only commands / rm on rebuildable paths; compound commands judged segment by segment)
   │
   ├─ cache hit? ──yes──▶ return the previous verdict (still goes through the current policy mapping)
   │
   ├─ fill in state:
   │     · the body of the script the command invokes (`node x.mjs` → read x.mjs)
   │     · the script body in package.json (`pnpm run deploy:prod` → read scripts)
   │     · sensitive paths skipped, 8KB cap
   │
   └─ one Jev question ──▶ p
          p < low        → allow
          low ≤ p < high → revise (with templates)
          p ≥ high       → block
          timeout/error  → allow (fail-open)
```

## Host mapping (the same verdict lands differently on different hosts)

| verdict | DSH (approval policy `ask`) | DSH (approval policy `never`, i.e. full permissions) |
|---|---|---|
| allow | run it | run it |
| revise | refuse + three degradation templates | refuse + one-shot token hint |
| block | refuse | refuse + one-shot token hint |
| escalate | **raises the approval prompt** (a human decides) | **refuse outright** + one-shot token hint |

> The last row is the easiest pit to fall into in this project: **under full-permissions mode `ask` is not "a prompt", it is "being rejected"**.
> In the DSH source the definition of `approval: 'never'` is exactly *never prompt anyone: every ask resolves rejected*.
> If we returned `ask` directly in such a session, the model would receive a **false statement** ("the user rejected tool bash");
> so we refuse ourselves, and write the real reason out clearly (which hard rule was hit, and that this is not a human refusing by hand).

## Why a "suggestion layer" cannot be a line of defence

Any approach that "hands the judging to the model to decide for itself whether to ask" (a prompt / an optional tool) is **not interception**:

- **A prompt** = the model may disobey it;
- **A judgment tool the model can call** = the model **decides for itself** whether to call it.

Neither can stop any other tool call. This package therefore takes only the enforcement route of the **pre-execution interception point**:
DSH's `tools/pre-execute`. That the judging itself is still made a caller-agnostic function is so that it can be **replayed offline**,
not so that the power is handed away.

## Known blind spots (accepted in the design, not bugs)

| blind spot | current state | mitigation |
|---|---|---|
| Infrastructure tooling | `terraform apply -auto-approve` measured at 0.48, below the threshold it is let through | lower the threshold for this class of command separately, or add an L0 ask rule |
| Paths only computed at runtime | the script decides from configuration which directory to delete; we can only guess from the source | filling in state can only supply the body text; this class falls under "cannot be enumerated → block" |
| Inline long code | a short `node -e` is visible (0.91); an over-long heredoc / concatenated variables are not | known; when necessary, treat heredoc as "script body" too |
| Non-shell tools | file-writing tools and `run_code` are not wired up yet | extend the `tools` list (a config change on the DSH side is enough) |
| Remote/cloud state | `git push --force`, `npm publish`, deleting cloud resources | already in L0; the rest relies on adding a parallel question "will this change remote state?" |
| Deliberate bypass | re-wrapping/encoding/absolute paths | **not defended** — this is an accident net, not a security boundary |
| The authorisation file being rewritten directly | an agent with file-writing tools can write `~/.jev-guard/allow.txt` directly (equivalent to issuing an authorisation to itself) | **deliberately kept, not sealed** — see [DECISIONS.md](./DECISIONS.md) **D1**; this is not a bug, it is a scope statement |

> The last two rows of the table are two ways of saying one thing: this valve guards against **accidents** (the model did not look carefully, the command was written out of habit, the state got mixed up),
> not an **adversary**. The user's own wording on this scope is in D1. **On seeing these two rows, do not "helpfully" seal them**:
> that would amount to requiring file-writing tools to be brought into the judging as well + file-level permissions, which is another product's worth of work,
> and the benefit would only target the "deliberate bypass" scenario that this project explicitly does not cover.
