# Releasing

> **English** | [简体中文](RELEASING.zh-CN.md)

A release is a version bump, a tag, and a push. The tag runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml), which publishes to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers). No publish token exists anywhere in this project.

## The steps

```bash
# 1. Bump package.json "version", and add the CHANGELOG entry in both languages.

# 2. The checks the workflow runs anyway — running them first is faster than
#    waiting for CI to tell you.
for t in selftest-entry selftest-i18n selftest-quota selftest-reason selftest-token selftest-rules selftest-audit; do
  printf '%-18s ' "$t"; node tools/$t.mjs | tail -1
done
node bin/guard.mjs selftest
node tools/smoke-dsh-adapter.mjs

# 3. See what the tarball would contain.
npm pack --dry-run --json

# 4. Commit, push, tag, push the tag. The tag push is the release.
git commit -am "chore(release): X.Y.Z"
git push
git tag -a vX.Y.Z -m "dsh-jev-guard vX.Y.Z"
git push origin vX.Y.Z
```

Nothing but a tag starts a publish. There is deliberately no manual trigger: `npm publish` ships whatever `package.json` says, so a manual run would be a path to publishing a version nobody tagged.

## The three gates

The workflow stops before uploading anything if any of these is false:

1. **The tag matches `package.json`'s version.** The publish takes its version from the manifest and ignores the tag, so a forgotten bump would attempt to republish an old version and report a cause that is not the real one.
2. **The self-checks `selftest` runs on `main` pass** — the seven offline suites, `guard selftest`, and the DSH adapter smoke test.
3. **The tarball carries no local state.** `config.json`, `secrets.json`, `HANDOVER.md`, `guard.log*`, `allow.txt`, `degraded.json`, `verification-results/` and `.zcode/` are rejected by name. A `files` allowlist is a control only for as long as nobody widens it, so the packed tarball is inspected rather than trusted: this project has shipped real credentials by accident before, and a release is exactly when that would reach a registry.

## A published version is spent

npm refuses a version that already exists. Every release therefore needs a new version number, and a tag whose version was already published cannot be re-run into existence.

## Publishing authenticates as the repository

The version appears in the registry under the identity `GitHub Actions` with an `oidcConfigId`, and npm attaches a provenance attestation binding the tarball to this repository, this workflow and the tagged commit. In a directory where the package is installed:

```bash
npm audit signatures
```

## What to expect right after the tag

- **`Validating: Automated review hasn't finished`** is npm's automated review of a new version, not a failure. The first release published this way took about 3 minutes; until it finishes, the version is absent from the public read surface, so the registry still lists only the previous one.
- **A local `npm install` may report `notarget` for a version that does exist**, because npm caches the package's version list. `--prefer-online` revalidates it. A plain HTTP request to the registry is unaffected, so for a while the two disagree.
- **The plugin market does not move on npm's clock.** Its catalog is rebuilt daily, so a new version reaches the market on the order of a day.

## Recovering a release that did not publish

What to do depends on whether the version reached the registry:

- **The run failed before the publish step** — a gate, or a rejection from npm: the version is still unspent. Fix `main`, then move the tag onto the fixed commit by deleting it and pushing it again. That rewrites a ref, so it is only appropriate while the tag is fresh and unpublished.
- **The version is on the registry**: it is spent. Fix forward with the next version.
- **To re-run without changing anything**: delete the tag and push it again at the same commit. Creating the ref is what starts a run.

## The npm side, configured once

Trusted publishing is set per package on npmjs.com: package settings → Trusted Publisher → GitHub Actions, giving the repository, the workflow filename `publish.yml`, and an empty environment. One field is easy to get wrong: **direct publish is an opt-in under "Allowed actions"**. A configuration created after 2026-09-03 allows `npm stage publish` only, by default, and a direct publish is then refused with `403 ... OIDC permission denied for this action` — *after* the provenance statement has been signed, which makes it look like an identity problem when it is not.

This workflow publishes directly. Moving to `npm stage publish` with a human 2FA approval is a deliberate change on both sides: the workflow's command, and the publisher's allowed actions.
