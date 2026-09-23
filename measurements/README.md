# Measured artefacts

> **English** | [简体中文](README.zh-CN.md)

The raw records behind [`docs/MEASUREMENTS.md`](../docs/MEASUREMENTS.md). Most sections there quote a summary of a run; this directory holds the run itself, so a number can be traced back to the command that produced it.

They are **evidence, not build input**: nothing here is executed by a self-check, read by `lib/`, or shipped to npm.

## 1. What is here

| Path | What it is | Backs |
|---|---|---|
| `offline-report-737.json` | The 737-entry command corpus, one record per command (`command` / `source` / `action` / `p` / `model` / `threshold` / `ms`). Run config: `threshold 0.5`, script bodies **not** filled in | §3 |
| `offline-report-737-inline.json` | The same 737 commands re-judged with `inlineScripts: true` (config `threshold 0.6`). Adds an `enriched` field saying what was filled in (a script body, a package script) | §3 (three-way split, script-body row), §7.1 |
| `offline-report-737.md`, `offline-report-737-inline.md` | The two run summaries as printed, including the list of commands that were flagged | §3 |
| `probe-scripts.json`, `probe-scripts.md` | The 18 script-blind-spot cases, judged twice each (command line only, then with the body filled in) | §4 |
| `calibration-114/cases.zh.json` | The 40 cases / 114 questions of the three-arm calibration | §2 |
| `calibration-114/results.json` | Every response (120 records) plus every scored judgment (342 = 3 arms × 114) | §2 |
| `calibration-114/report.md`, `run.log`, `run2.log`, `run3.log` | The report of that run and the logs of the three runs | §2 |
| `calibration-114/run_calibration.py` | The script that produced them — the one §2's "Reproduce" line points at | §2 |

## 2. Provenance

Both batches were produced on **2026-09-20** on the maintainer's machine, by the then-current (v0.1.0) toolchain, in two working directories outside this repository. Those directories were deleted on 2026-09-23 after being archived; the copies here were extracted from that archive:

`~/dsh-workspace/backups/jev-leftovers-workspace-20260923.tar.gz` (864,371 bytes, 368 entries).

The byte count and sha256 below are of the artefact **as first written** — for seven of the thirteen files that is also the committed copy (see §3):

| Path here | Bytes | sha256 of the raw artefact |
|---|---|---|
| `offline-report-737.json` | 292247 | `aac68c58d4be025fe6613a179d0efb59b4de7c143d27d606cc7442ebe091a6df` |
| `offline-report-737-inline.json` | 303418 | `f1162830cf9f1f093109e1ef74d8c9187a5a4acc8e24fdbe0916b37ed30fa12e` |
| `offline-report-737.md` | 2235 | `ee5fc99a4c68432f0241b9c5ebf6901581f47b018c30c39e5f0c7c40e8efcbfe` |
| `offline-report-737-inline.md` | 1809 | `ca2f84639ca75a41da8e31d90dddd09278576812ac896e32a22acc63e23dd525` |
| `probe-scripts.json` | 4182 | `c9f4da7de135a5a6793c45defb9fdfbd7caaa4a8873c534f3bff815698d4de63` |
| `probe-scripts.md` | 1891 | `5280624fd34677ba603c572910f3d9fbd57f9a1ba75589a7e740e324cb2e7f1f` |
| `calibration-114/cases.zh.json` | 16466 | `530924d7942ba08b8b318364d34385ea6175716d90e90b9694042ba707153578` |
| `calibration-114/results.json` | 348997 | `51c405d125d5b7e624caf8240c7d851b9cb98e76d3a5c6e60fe292d7e28793e2` |
| `calibration-114/report.md` | 2448 | `3c10659425cc7064af040b3f3ec33efbf419bc151835d7341f980e9ea21f05c4` |
| `calibration-114/run_calibration.py` | 21607 | `4f586fa2436b49c0d5a330459f7ce0dab7edd8d0d9fd9c207fd2c393c8d25315` |
| `calibration-114/run.log` | 3485 | `540f563179f9dd208895c424d0c93f821d90593eda2ad83e1616c375facabe62` |
| `calibration-114/run2.log` | 3495 | `d2dcb6ece569dda4bec3f5128ba267358782b2accf884cba6df0bf03b5ee7253` |
| `calibration-114/run3.log` | 3736 | `d3a2780a3b93ec0183a7b1722e8cd62a927f6e0228babd2a86f261430fcae0a5` |

## 3. De-identification

The 737 corpus is **real shell history**: `tool/call` entries from the session logs this project was built in, plus `~/.bash_history`. It was reviewed for what a public repository should carry, and the fragments below were replaced. Both lists are exhaustive — the committed files contain nothing else that was changed.

| Fragment | Placeholder | Occurrences | Kind |
|---|---|---|---|
| The Linux home path | `<HOME>` | 570 | identity |
| A bare occurrence of that user name | `<USER>` | 78 | identity |
| WSL drive mounts | `<DRIVE_<letter>>/` | 42 | identity |
| The Windows user name | `<WINUSER>` | 6 | identity |
| Two masked key literals (`sk-…`, `tvl…` — head and tail visible) | `<REDACTED-KEY>` | 6 | credential |
| A third-party commit name and its noreply address | `<REDACTED-IDENTITY>`, `<REDACTED-EMAIL>` | 2 + 2 | third party |
| Names of other AI tools and vendors in the command text | `<other-tool>` | 850 | third-party tooling |

The four identity rules are reversible (the inverse substitution restores the original text exactly); the other three are one-way, and the tool-name rule deliberately collapses several distinct names into one placeholder. Six of the thirteen files changed at all — `offline-report-737.json`, `offline-report-737-inline.json`, the two summaries beside them, `probe-scripts.json` and `probe-scripts.md`; the other seven are byte-identical to the raw artefact above.

**What was deliberately left in.** Projects, containers, DSH-ecosystem keywords, libraries and RFC1918 addresses are still named, because that is what the commands were about — a judgment record whose subject matter has been filtered out is no longer a record. The tokens that became `<other-tool>` are visible in a diff against the raw artefact and are not repeated here, for the same reason they were replaced. `measurements/` is outside the `files` allowlist in `package.json`, so none of it reaches the npm package; D11 ("the package describes DSH and nothing else") is about the package, and this directory is not a support claim for anything named inside it.

**Integrity of the transformation** (each asserted, not assumed): both JSON files parse; `results` is still 737 records; `cfg`, `stats`, `byAction` and `bySource` are unchanged; every record's `p` / `action` / `ms` / `source` / `threshold` / `model` is unchanged; the calibration files are deep-equal to the raw ones; and reversing the identity rules on each committed file reproduces the raw artefact with only the one-way redactions applied.

The rewritten command text is therefore **not** the text the judge was shown: each `p` and `action` beside a record was produced from the original wording.

A residual `sk-` search still hits `ui-skin`, `task-board` and `disk-usage` — substrings of ordinary words, not keys.

## 4. Re-verifying

```bash
# The corpus, whole: expect 737 and the four summary blocks
node -e "const d=require('./measurements/offline-report-737.json');console.log(d.results.length,JSON.stringify(d.stats),JSON.stringify(d.byAction),JSON.stringify(d.bySource))"

# The calibration, per arm: expect 103/102/102 of 114 and confidence 0.867/0.869/0.867
node -e "const s=require('./measurements/calibration-114/results.json').scored;for(const a of ['A','B','C']){const x=s.filter(v=>v.arm===a);console.log(a,x.filter(v=>v.correct).length+'/'+x.length,(x.reduce((t,v)=>t+v.confidence,0)/x.length).toFixed(3))}"

# Nothing identity-shaped is left, and the counts match §3
# expect: <HOME> 570 / <USER> 78 / <DRIVE_ 42 / <WINUSER> 6 / <REDACTED- 10 / <other-tool> 850
node -e "const fs=require('fs'),p=require('path');const w=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?w(p.join(d,e.name)):[p.join(d,e.name)]);const t=w('measurements').filter(f=>!/README/.test(f)).map(f=>fs.readFileSync(f,'utf8')).join('');for(const x of ['<HOME>','<USER>','<DRIVE_','<WINUSER>','<REDACTED-','<other-tool>'])console.log(x,(t.split(x).length-1))"
```

## 5. What the numbers in the docs reconcile to

Every figure in §2, §3 and §4 of [`docs/MEASUREMENTS.md`](../docs/MEASUREMENTS.md) was recomputed from these files:

| Claim in the docs | Recomputed from | Value |
|---|---|---|
| Deterministic pre-screen hits 174/737 | `bySource.prefilter` | 174 |
| Real calls to Jev, 563 entries | `bySource.jev` | 563 |
| Three-way split 98.51% / 0.81% / 0.68% | `p` bands 0.5 / 0.7 over all 737, inline run | 726 / 6 / 5 |
| Latency mean 297–301ms, P50 267ms, P95 367–405ms | `ms` over the 563 calls, both runs | 297 / 268 / 367 and 301 / 267 / 405 |
| `p` P50 0.01, P90 0.13, max 0.82 | the 563 calls | run at 0.5: 0.01 / 0.13 / 0.82; inline run: 0.01 / 0.14 / 0.82 |
| "By filling in the script body, 18 entries (2.4%), 0 new false positives" | records carrying a non-empty `enriched` field | 18 of 737, and **0** of them moved up across 0.5 (2 moved down) |
| §2 arm accuracies 90.4% / 89.5% / 89.5% | `scored`, per arm | 103/114, 102/114, 102/114 |
| §2 mean confidence 0.867 / 0.869 / 0.867 | `scored`, per arm | 0.867 / 0.869 / 0.867 |
| §2 paired test 1 / 0 / 11 (A vs B and A vs C) | `scored`, paired per question | 1 / 0 / 11 both |

## 6. What these files still do not support

1. **The corpus cannot be regenerated.** The session logs it was taken from no longer exist; `docs/MEASUREMENTS.md` says so and should keep saying so. What can be done is what this table does — check a claim against the record.
2. **A single record flipping a band is not a finding.** The two runs judged the same 563 commands; 451 came back with an identical `p`, 112 differed at all, mean |Δp| = 0.0036, largest 0.150 — and §14's own noise floor for asking the same state three times is 0.015. Only a shift larger than that, or a whole-corpus count, carries information.
3. **The cost figure is derived, not measured.** The records carry no token counts; §3's ≈$0.011 is 563 calls × §1's measured per-call cost.
4. **The two runs are not a controlled comparison.** They differ in two things at once (`threshold` 0.5 vs 0.6, and whether script bodies were filled in), so "what filling in the body changed" is only clean for the 18 records that were actually enriched.
