# adapters/ — there is only one adapter

> **English** | [简体中文](README.zh-CN.md)

**Here there is only "translation", no judging.** Judging, rules, tokens and the audit log all live in [`lib/`](../lib/), and the code there
contains no DSH mechanism at all (no Cordis, no ctx, no `PreToolDecision`).
The reason `lib/` stays independent is not that other callers are going to be attached, but that **the judging logic should not know who is calling it** —
only that way can it be re-run offline by `bin/guard.mjs` and covered by the seven self-checks.

| Directory | Form of interception | Interception force |
|---|---|---|
| `dsh/` | DSH-native Cordis plugin, hooks `tools/pre-execute` | **mandatory** |

## Why there is only this one (2026-09-20, see ../docs/DECISIONS.md D11 for details)

Several routes for "hanging the valve into another execution channel" were tried historically, and none of them worked out — each host's approval/trust
mechanism is different, and making any one of them solid is a separate round of work of its own; one measurement also exposed a structural defect (**information
that could not be obtained was pretended to be obtained by a default value**), and fixing it would mean redoing that output contract. So the scope was narrowed to DSH only.

**There is only one criterion: does that host have a callback that execution must pass through, and that can say you may not run this.** Without one you can only build a suggestion layer,
and **an unverified adapter is more dangerous than no adapter** — it looks like the valve is installed while in fact nothing is blocked.
Those attempted implementations and the per-item reasons **were removed along with the narrowing of scope** (this package keeps no unverified code); the transferable lessons that were kept are in
[`../docs/MEASUREMENTS.md`](../docs/MEASUREMENTS.md) §12 and [`../docs/DECISIONS.md`](../docs/DECISIONS.md) D11.

## The four iron laws for writing a second adapter

If you really are going to attach another host (or bring the archived one back), first read [`../docs/DSH-INTEGRATION.md`](../docs/DSH-INTEGRATION.md) §5 and
`../docs/MEASUREMENTS.md` §10 — three layers of real accidents are recorded there. The four:

1. **You must obtain the command text before execution**, and **be able to return "you may not run this"**. If you cannot, that belongs to the "suggestion layer" — do not write it as an adapter.
2. **fail-open**: whatever goes wrong on the adapter's own side must be allowed through (timeout / parse error / unknown payload shape).
3. **Inline the entry guard, cross-platform**:
   `realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))`.
   **Do not extract it into a shared module** — `import.meta.url` follows the module, so once extracted it is constantly false (measured: even WSL silently stops working).
   Use **relative specifiers** for dynamic imports, not absolute path strings (not a legal ESM specifier on Windows).
4. **The audit must write `record()`**, and **there must be an observable side effect** that lets a verifier confirm "it really ran" —
   "no error reported" is not the same as "it is working".
