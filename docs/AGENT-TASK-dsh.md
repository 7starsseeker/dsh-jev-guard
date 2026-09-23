# Task brief: DSH

> **English** | [简体中文](AGENT-TASK-dsh.zh-CN.md)

> **This package now supports DSH only** (narrowed on 2026-09-20, see [DECISIONS D11](./DECISIONS.md)).
> The acceptance checklist and the number cross-reference table are in [`VERIFICATION.md`](./VERIFICATION.md); the mechanics are in [`DSH-INTEGRATION.md`](./DSH-INTEGRATION.md).
> When you get a new machine, follow [`../DEPLOY.md`](../DEPLOY.md), and record the conclusion per item as `VERIFICATION.md` says.

DSH is the **only** supported host, and it needs no gamble: there is a native `tools/pre-execute`
interception point, and the behaviour has already been confirmed from the source (no more guessing).

## Already verified before the restart (2026-09-20, measured on this machine)

| Check | Command | Result |
|---|---|---|
| Adapter wiring (fake ctx) | `node tools/smoke-dsh-adapter.mjs` | **9/9 passed** (including "under full permissions the denial reason clearly states it is not a user rejection", "the audit recorded `policy` and `preset`", "fail-open when there is no key") |
| **Real tool pipeline integration** | see the note below | **6/6 passed**: `git push --force` and `rm -rf` on a real directory were blocked, **the tool body did not execute**, read-only commands executed normally |
| Composition tree | `dsh --profile web --dump-config` | contains `dsh-jev-guard` → `name: jev-guard`, no parse errors |
| Install | `dsh plugin --profile web add /mnt/t/dsh-jev-guard` | depends on `link:/mnt/t/dsh-jev-guard`; bundles 25 → 26; no critical plugin missing |
| Credential | `refs.TYPESAFE_API_KEY` in `~/.dsh/.credentials.yaml` | written and validated as legal YAML (backup `.bak-before-typesafe-*`) |
| Rollback point | manual snapshot `20260920-124708-6f5f` | the clean state before the install |

How to run the real-pipeline integration test: it needs two things at once, and no single directory of a pnpm workspace checkout has both. Bare `@deepseek-ai/*` resolve **from the file's own location** (so the file must sit in a package directory such as `apps/cli`), while the notice check (item 6) reads `./packages/util/values/lib/index.js` **relative to the cwd** (so the cwd must be the checkout root). Build a throwaway directory that satisfies both — the verified recipe is in the header of `tools/smoke-dsh-pipeline.mjs`, and copying the file into that directory is part of it: `node <absolute path>` resolves the bare specifiers against `/mnt/t/jev-guard/tools/` and dies with `ERR_MODULE_NOT_FOUND`.

**Measured 2026-09-23: 6/6 offline, 7/7 with a key.** The recipe in this document's earlier revision is superseded — from the checkout root the import itself fails, and from `packages/core/agent-loop` item 6 reports a **false FAIL**.

## Known behaviour (confirmed at the source level, no need to re-verify)

| Session approval policy | What the valve returns | Actual effect |
|---|---|---|
| `ask` (workspace-write preset) | `{kind:'ask'}` | raises an approval prompt; the reason carries the Jev verdict |
| `never` (**full permissions / danger-full-access**) | `{kind:'deny'}` | **denies outright** |

Reason: `approval: 'never'` is defined as *never prompt anyone: every ask resolves `rejected`* —
so under full permissions, if `ask` were returned, it would be silently turned into a denial, and the reason
would wrongly say "the user rejected". This package's adapter therefore reads the session policy, and under
`never` it **denies directly and gives an accurate reason**.

## Install

```bash
# 1) the key: at runtime DSH reads its own credential store first
#    add TYPESAFE_API_KEY to refs in ~/.dsh/.credentials.yaml (or have it in the DSH process environment)
# 2) install the plugin
dsh plugin --profile web add /mnt/t/dsh-jev-guard
# 3) restart DSH
```

## Item 6: is the probe blocked after the install

After the restart, run this in a DSH session:

```bash
echo "" > ~/jev-guard-probe.txt      # overwrite/truncate a file; should be blocked or raise a confirmation
```

**Judging:**

- the session approval policy is `ask`: an approval prompt appears and its reason contains "Jev 判定风险概率" → pass
- the session approval policy is `never` (full permissions): the command **is denied**, and the model receives an explanation that "这不是用户手动拒绝" → pass
- the command executed normally → check three things: ① whether `jev-guard` is in `dsh --dump-config`;
  ② whether the key is reachable (the log will have `jev-guard: fail-open after ...`, which says the judging failed);
  ③ whether `bash` is included in the `tools` config.

By the way, test one more safe command to confirm nothing was hit by mistake:

```bash
ls -la ~ | head -3
```

**Report back:**

```bash
node /mnt/t/dsh-jev-guard/tools/report-result.mjs --host dsh --item 6 --status pass \
  --evidence "in full-permission mode echo \"\" > file was denied, the reason contained '本会话是无审批提示的模式'; ls -la was allowed normally"
```

## Runtime observability (implemented 2026-09-20)

DSH's logger threshold filters the plugin's `info`-level logs — there is not a single `jev-guard`
line in `dsh-web.log`. So the valve writes its own **shared audit log**:

```bash
node /mnt/t/dsh-jev-guard/bin/guard.mjs log --tail 20      # the most recent 20 verdicts
node /mnt/t/dsh-jev-guard/bin/guard.mjs log --stats        # last-24-hours summary (by action/source/rule)
```

- File: `~/.jev-guard/guard.log` (JSONL; rotates to `guard.log.1` past 4 MiB)
- Each line: time, action, source, p, rule hit, elapsed time, which state fields were filled in, and the command (**keys already masked** before writing)
- **The DSH plugin and the CLI write the same file**, so "what did it judge today" needs only one place

**While running the probe, take one look**: the blocked entry should appear in `--tail`, with
`action` being `block` or `escalate`. If there is not a single record, that itself is diagnostic
information: the plugin did not run, or the log path is not writable.
(`flush()` in `lib/audit.js` is already hooked onto the plugin's `dispose`, so the trailing records are not lost on exit.)

## The way out after a block: the one-shot allow token

A hard block is not a dead end. The reason for a blocked command carries `ALLOW-XXXXXXXXXX`, and a human can run this in a terminal:

```bash
node /mnt/t/dsh-jev-guard/bin/guard.mjs allow '<the original text of that command>'   # write the token
node /mnt/t/dsh-jev-guard/bin/guard.mjs allow --list              # see the pending tokens
node /mnt/t/dsh-jev-guard/bin/guard.mjs allow --revoke ALLOW-…    # revoke
```

Then **retry the same command** (whitespace differences do not affect matching) and it is allowed once, with the
token deleted at the same time. Two things to note:
① **L0's "never allowed" rules are not affected by the token** (writing to disk, formatting, dropping a database and the like can only be done by hand);
② an allow by token leaves a `source: token` record in `guard.log`, auditable afterwards.

## Rollback

```bash
dsh plugin --profile web remove jev-guard     # then restart
```

DSH's `dsh-undo-savepoint` saves a snapshot automatically on config changes, and its `undo_restore` can roll back in one command.
Note: the install changes two places, the profile's `dependencies` and `dsh.profile.bundles`.

## Two optional things after the install (outside this brief's scope, raised here anyway)

1. **Bring `write` / `run_code` into the valve too**: change the `tools` list in `cordis.patch.yml` to
   `[bash, pwsh, write, edit]` — but note that the judging problem for non-shell tools needs to be redesigned (the question is currently aimed at commands).
2. **Wire the L0 hard rules into `ctx.tools.guard()`**: DSH has a monotonic guard that "can only deny, and cannot be
   overturned by later listeners" (the documentation's own words: *may deny or abstain, **never force-allow***); moving those 21 "never allowed" entries over
   would give a layer harder than the pre-execute return value.
