# DSH Integration — How This Valve Attaches to DeepSeek Harness

> **English** | [简体中文](DSH-INTEGRATION.zh-CN.md)

**In one sentence:** this package **supports DSH only** (narrowed on 2026-09-20, see [`DECISIONS.md`](./DECISIONS.md) D11).
The judging core lives in `lib/` (host-agnostic, pure functions); everything host-related is concentrated in the single file `adapters/dsh/index.js`.

---

## 1. Which of DSH's mechanisms it uses

| DSH mechanism | How we use it | What happens if we cannot get it |
|---|---|---|
| **`tools/pre-execute` waterfall** | The only real interception point. Returns a typed `PreToolDecision`: `{kind:'allow'}` / `{kind:'ask', reason}` / `{kind:'deny', reason}` | Without it we could only do a "suggestion layer" (the model can ignore it) |
| **`agent.session.snapshotEvents()` → `approval/policy`** | Reads the current session's approval policy: `ask` (a prompt is shown) / `never` (full permissions, ask is resolved into a denial) | We could only guess from the deployment default, and the reason text would say the wrong thing |
| **`agent.session.snapshotEvents()` → `permission/preset`** | Reads the sandbox preset (`workspace-write` / `danger-full-access`), **audit only** | A retrospective cannot see whether there was still a sandbox behind it at the time |
| **`ctx.credentials.resolve(ref)`** | Fetches TypeSafe secrets (through DSH's credential layer, no restart needed after rotation); if that fails, falls back to `process.env` | Falls back to "reading from a file", and key rotation requires a restart |
| **`exec.arguments.workdir` / `exec.agent.session.cwd`** | The working directory at judging time (used to read the body of the invoked script) | The script body cannot be guessed, and things like `node x.mjs` degrade into a blind spot |
| **Tool names `bash` / `pwsh`** | The two tools intercepted by default — covering exactly **WSL/Linux (`bash`) and Windows (`pwsh`)** | One less platform is intercepted |
| **`ctx.logger`** | Best-effort host logging (`info`/`debug` are often filtered out by the host threshold, so **we do not rely on it**) | Auditing relies on `~/.jev-guard/guard.log`, not on host logs |
| **`dispose`** | `flush()` the audit queue before exit (otherwise the trailing records are lost) | The last few verdicts are lost |

**The judging logic itself depends on nothing from DSH**: it does not look at filesystem state, needs no model involvement, and needs no session history.
So the same judging can be called by the DSH plugin inside a session, and can also be re-checked offline by `bin/guard.mjs` — the latter is the basis of the regression tests.

---

## 2. Two policies combined: four destinations for the same command

| Verdict | Approval policy `ask` (a prompt is shown) | Approval policy `never` (full permissions) |
|---|---|---|
| `allow` | Allowed | Allowed |
| `revise` (50–70%) | **`ask`** — escalated to a human with an approval prompt, with the three degradation templates in the reason | **Denied** + degradation template, **plus** a one-shot token hint |
| `block` ≥70% (the semantic layer) | **`ask`** — escalated to a human with an approval prompt | **Denied** + one-shot token hint |
| L0's `deny`-class hard rules | **Denied** (no prompt, no token issued) | **Denied** |
| `escalate` (L0's `ask`-class rules / retry budget escalation) | **`ask`** — the host shows an approval prompt, a human decides | **Denied** + one-shot token hint |

Two details that are easy to get wrong, but matter a lot:

1. **Under the `ask` policy, `revise` and the semantic layer's `block` also reach the human** (changed 2026-09-20, see
   [`DECISIONS.md`](./DECISIONS.md) **D13**): when the human is present, letting a 50.6% judgment decide for them makes no sense.
   The measured cost before the change was that 9 `revise` denials in a day happened in `ask` sessions while the human was right beside it.
   **The exception is L0's `deny`-class hard rules** — an absolute gate, denied under both policies, and not taking part in `retryLimit` escalation.
2. **When a prompt can be shown, the token hint is not attached any more.** A measured lesson (2026-09-20): two human channels
   appearing in one prompt at the same time left the reader unsure which one to take; and when the human is in front of the
   window, the token is superfluous.

> `danger-full-access` = `{ sandbox: 'danger-full-access', approval: 'never' }`. At this point **the valve is the only layer**
> — there is no file sandbox as a fallback, and approval is effectively off. This is exactly why it exists, and also the scenario
> where a misjudgment costs the most.

---

## 3. The three human channels after it is installed

| Channel | Who executes it | What it depends on from DSH |
|---|---|---|
| One-shot token | The AI (retries after being blocked) | **Nothing** — pure local hash + files; DSH only writes the hint into the reason |
| Host approval prompt | The AI (with a human's nod) | `approval/policy = ask` + the host's approval UI |
| Human executed by hand | The human | Does not go through the valve at all |

Details, measured evidence, and the nature of each of the three channels are in [`USER-INTERVENTION.md`](./USER-INTERVENTION.md).

---

## 4. The degradation contract (after the quota is used up)

| Failure category | Valve behaviour | `source` in the audit |
|---|---|---|
| `quota` (402 / quota wording) / `auth` (401/403) | **Degrades**: writes `~/.jev-guard/degraded.json`, sends no more requests within the cooldown window, by default only the free L0 + pre-screen runs | First time: `error` + `degraded`; afterwards: `degraded` |
| `no-key` (no key could be resolved) | **Degrades, stickily and scoped**: no HTTP is sent at all, the state never expires with time (there is nothing to probe) and is cleared the moment a key resolves; it records the identity of the entry that reported it, so it suppresses only that entry | First time: `error` + `degraded`; afterwards: `degraded` |
| `timeout` / `network` / `server` / `rate-limit` | **Does not degrade**, fail-open each time, recorded classified by `errorKind` | `error` |

`no-key` used to be deliberately non-degrading (D10.2): it is a local configuration condition with zero HTTP cost, while
`degraded.json` is globally shared — one path being unable to read a secret should not stop the other paths too.
**D15 keeps that objection and answers it with scope instead of silence**: a local state records *who wrote it*, and an entry
obeys only its own (`'cli'` / `'dsh-adapter'`). Service-side states stay `global`.

### 4b. The in-session notice: the only way a host-only plugin can speak to the user

DSH gives a plugin without `dsh.client` **no** toast, banner or startup notice — every settings/Plugins seat is a browser-side
registration, and boot warnings reach the terminal only. So the plugin mounts a second event:

| Mechanism | Where | What it is for | What the user sees |
|---|---|---|---|
| **`agent/pre-step` waterfall** | `adapters/dsh/index.js` | Appends one `notice`-form user message: first run with no key (the demand, carrying the exact recording command), entering a degraded state, recovering — one per state per session | A row in the conversation, collapsed to `jev-guard · <summary>` and expandable to the body |

Three properties are load-bearing, and each is asserted by `tools/smoke-dsh-adapter.mjs`:

1. **It appends, it never replaces.** The decision's `messages` array *is* the whole batch for that step — a listener returning its
   own array silently swallows the user's message. The handler always `await next()` first and returns `[...decision.messages, notice]`.
2. **It never injects into an empty batch** (`decision.messages.length === 0 && (step === 1 || messages.length > 0)`): a non-empty
   decision opens a step, so adding a message there would spend a whole extra model request just to say something.
3. **The message shape is a contract.** `source` carries exactly `kind` / `plugin` / `form` / `summary`, `summary` is ≤120 characters
   (it becomes the collapsed row's title), and `id` / `role` are set. A malformed message surfaces as
   `SessionPersistenceCorruptionError` at the **next resume** — a session that will not open, far from the change that caused it. The
   shape is therefore validated against DSH's own `snapshotJsonValue` (the step `Session.append` runs first) by a test that must run
   inside a DSH checkout.

Deduplication runs against the **durable history** (`agent.session.deriveMessages()`), not an in-memory flag: a harness restart or a
session resume starts a fresh plugin instance, and a notice already written into the history must not be repeated. `notifyInSession:
false` turns the whole channel off.

The notice is a `role:'user'` message, so it **enters the model's context** — intended (the model should know the valve is degraded),
and the reason it fires per state transition rather than per step: each one costs a prefix-cache miss from that point on.

### 4c. Where the key comes from (all three layers, and why the third exists)

| Order | Source | Notes |
|---|---|---|
| 1 | `ctx.credentials.resolve(ref)` | DSH's own credential store (`~/.dsh/.credentials.yaml`); a rotation needs no restart |
| 2 | the process environment | the variable named by `apiKeyEnv` |
| 3 | `apiKeyFile` (default `secrets.json` in the package root) | what `guard key set` writes; a relative path resolves against the **package root**, independent of cwd — the same rule the CLI uses |

The third layer is what makes "record your key with the CLI" true for a fresh install, which has neither a credential-layer entry
nor an environment variable. The value is never printed and never logged.

Three things to note on the DSH side:

1. **Convey `verdict.warning` to the human** — the plugin writes it into the denial reason, the `level:'warn'` audit record and
   `ctx.logger.warn`. **Do not treat `source: 'degraded'` as "judged harmless"**; it means "this one did not go through semantic judgment".
2. **`guard status` can serve as a health check** — while degraded **the exit code is 3**.
3. The cooldown length and "which layer is kept while degraded" are in `config.json`: `quotaCooldownMs` (15 minutes) / `authCooldownMs` (30 minutes) /
   `degradePolicy` (`'l0-only'` default / `'off'` = the whole valve paused). When the window expires it automatically lets **one** probe through, and a success restores it.

---

## 5. Silent failure when the plugin is written wrong, and why the real deployment must verify it

The worst failure mode on the DSH side is **a plugin that silently is not attached**: no error, no log, commands run as usual.
On 2026-09-20 **three layers** of same-kind accidents really did happen (the entry guard was constantly false on Windows; after
extracting it into a shared module for DRY it failed on WSL too; a dynamic `import()` using an absolute path threw
`ERR_UNSUPPORTED_ESM_URL_SCHEME` outright on Windows). The full retrospective is in [`MEASUREMENTS.md`](./MEASUREMENTS.md) §10. Three rules:

1. **Inline the entry guard, cross-platform:**
   `realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))`,
   **do not extract it into a shared module** (`import.meta.url` follows the module, so once extracted it is constantly false).
2. **Use relative specifiers for dynamic imports** (`await import('../../lib/gate.js')`), not absolute path strings.
3. **Verification looks at side effects, not at "whether there was an error":** run a command that **is bound to be intercepted**
   and confirm that it **really is intercepted**; then check whether `~/.jev-guard/guard.log` has that record. `tools/selftest-entry.mjs` is the automated
   version of this, and it counts as verified only after **running it once on Windows and once on WSL**.

---

## 6. Every failure is allowed through (fail-open)

Timeout (1800 ms by default), network error, service 5xx, code exception → **allowed** and recorded as `source: error`.

The reason is not "we do not care": DSH itself still has the sandbox preset (`permission/preset`) taking effect **after** the valve
(unless it is `danger-full-access`). The valve is an **incremental** check, not the only line of defence. If it were changed to fail-closed,
one hiccup of the judging service and you cannot work — a thing that "prevents accidents" would have become a thing that
"manufactures accidents". To achieve "blocked even when the service is down", the right approach is **to thicken the L0 rules**
(that layer has no network access and depends on no service), not to change this policy. See [`DECISIONS.md`](./DECISIONS.md) D3.

---

## 7. Boundaries: it is an accident net, not a security boundary

**Reading this line is enough; there is no need to guess further.** What it prevents is **accidents** — commands the model or a human
wrote wrong, opaque scripts, the moment under full permissions when nobody intercepts. It does **not** prevent deliberate bypass
(changing the wording, encoding, writing the authorisation file directly).

This is not unfinished work, it is an **explicit decision**: the full rationale, the list of known bypasses, and "under what
circumstances this should be reconsidered" are in [`DECISIONS.md`](./DECISIONS.md) **D1**. To defend against malice, the right approach
is **to add another layer** (sandbox / low-privilege user / container), not to rebuild this valve into a security boundary.

---

## 8. Glossary (do not confuse the three "trusts")

| Term | What it refers to | Who maintains it | Does it persist |
|---|---|---|---|
| **One-shot token** | Allows **the exact text of one command** once | The valve (`~/.jev-guard/allow.txt`) | Not persistent: deleted once used, not replayable |
| **DSH approval** | A nod for **this one call** | DSH | Only "allow once", **no permanent allow** (see [`USER-INTERVENTION.md`](./USER-INTERVENTION.md) §2.1) |
| **L0 static rules** | Hard rules with no network (21 deny + 16 ask) | `lib/rules.js` | A token **cannot get past** `deny` |

Two numbering systems must also be distinguished: `L0 / L1 / L2` are **judging layers** (see [`ARCHITECTURE.md`](./ARCHITECTURE.md)),
and `allow / revise / block / escalate` are **judging results**. The former is "how it was computed", the latter is "what was computed".
