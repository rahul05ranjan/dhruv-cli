# Nano deterministic retrieval validation — 2026-10-09

## Scope and reproduction

This is a local macOS run of the deterministic Nano retrieval release at the ticket #177 branch based on `bac61383fa0018807f6046af4b2c3e627630b8d7`. The machine used Node `v24.15.0` on Darwin. The [versioned task manifest](../../evaluation/nano-tasks.v1.json) has SHA-256 `b30da074f31a3bc8074bb2d74486f922e342ef7cf170746639a228aff33eece1`; the [machine-readable results](nano-validation-2026-10-09.json) record each task, miss, emitted fact verdict, timing, coverage, and index freshness. Commands from a clean checkout:

```sh
npm ci
npm run build
node scripts/nano-package-smoke.mjs
node evaluation/run-nano.mjs /tmp/nano-results.json
npm run lint
npm run type-check
npm run test:ci
```

The runner builds an npm tarball with `npm pack --json --ignore-scripts`, installs it in a temporary consumer, clones each repository, checks out the exact full SHA, and runs the **installed CLI** twice per task with `nano context --json --top 10` and the default output and refresh budgets. It uses the installed package's diagnostic-only `contextWithCandidates()` hook to count candidates before top-k and output byte trimming. The task snapshots are Dhruv [bac61383fa0018807f6046af4b2c3e627630b8d7](https://github.com/rahul05ranjan/dhruv-cli/tree/bac61383fa0018807f6046af4b2c3e627630b8d7), Commander.js [ba6d13ddb4243e5913367734f8c159089ffe7834](https://github.com/tj/commander.js/tree/ba6d13ddb4243e5913367734f8c159089ffe7834), and Execa [63ddae6aeb6934da06fdb3754647791e58cd87c3](https://github.com/sindresorhus/execa/tree/63ddae6aeb6934da06fdb3754647791e58cd87c3). Each is MIT licensed. The manifest records why each gold file is relevant. Labels were curated by one reviewer against source and tests. Fix-commit changed paths were not used as complete relevance truth. Eight plausible but uncertain paths were held out of both denominators; there was no second reviewer or adjudication.

## Retrieval and evidence

Candidate recall counts gold paths present before top-k and response byte limits. Recall@10 counts gold paths in the returned ten. Hard negatives have no gold files and are counted by false positives instead. All positive tasks had at least one top-ten hit, but only three of nine returned every gold file.

| Repository | Positive tasks / gold files | Candidate recall | Recall@10 | All gold@10 | Hard negative false positives | Valid evidence facts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dhruv | 3 / 5 | 3/5 (60.0%) | 3/5 (60.0%) | 1/3 | 1 | 92/92 |
| Commander.js | 3 / 7 | 5/7 (71.4%) | 4/7 (57.1%) | 1/3 | 3 | 82/82 |
| Execa | 3 / 5 | 3/5 (60.0%) | 3/5 (60.0%) | 1/3 | 0 | 66/66 |
| Pooled | 9 / 17 | 11/17 (64.7%) | 10/17 (58.8%) | 3/9 | 4 across 3 tasks | 240/240 |

Macro candidate recall is 70.4% and macro Recall@10 is 66.7% across the nine positive tasks. Hit-any@10 is 9/9. The evidence checker independently reads the pinned source bytes and checks paths, text lines, symbol spans and fingerprints, and static import sites, targets, chain endpoints, lines, and claims. It found 0 invalid and 0 unverifiable facts among 25 path, 107 text, 53 symbol, 29 import, and 26 related-test facts. The fact-level Wilson 95% interval for 240/240 is approximately 98.4%–100%; facts within a task are correlated, so this is **not** a task-level accuracy guarantee. The checker verifies syntax and current bytes; it does not establish that a file is semantically sufficient for a fix. No stale fact was observed. Cold and warm runs had identical file/evidence order and index identity for all 12 tasks.

Representative misses: `dhruv-token-context` and `dhruv-index` each missed their relevant contract test during candidate discovery; `execa-cwd` and `execa-duplex` likewise missed tests whose import is through a package entrypoint. `commander-help` discovered `lib/help.js` but ranked it outside the returned output, and missed its direct contract test during candidate discovery. Generic words in the two other negative prompts matched unrelated source, producing 1 and 3 false positives; the Execa negative returned none. These are retrieval failures or weak lexical matches, not invalid evidence claims. All positive responses were marked truncated because candidate sets exceeded the returned limit. Commander.js and Execa responses reported partial relationship coverage from unresolved or ambiguous imports; scanned file counts and warnings are in the JSON artifact. Files trimmed by ranking or budget are scored as misses.

The 17 gold paths form a small, intentionally audited set, with six multi-file tasks. They do not estimate performance across all coding tasks. The absence of a second labeler and the eight held-out uncertain paths are material uncertainty. There is no aggregate performance target and no unrun benchmark claim.

## Installed package and startup

The tarball under test had SHA-256 `18743622ed3b047151cacf76fc23422c396b91e5d2a971281c0a571b3ad5b060`, 67,050 archive bytes, 249,601 unpacked bytes, and 89 files. The explicit package allowlist contains `dist/`, `README.md`, and `LICENSE` plus npm's `package.json`. The smoke verifies the entrypoint and Nano modules and rejects tests, raw `src/`, local `.claude` settings, and other unexpected files. A fresh install in an unrelated directory completed without model or Ollama access. Installed Nano `context`, `index`, `status`, `purge`, JSON/text output, help and completion, Git/non-Git roots, changed/deleted files, a Unicode/spaced path, sensitive-file exclusion, and ordinary `--help` passed locally. The Nano fixture created no log or metrics file; the index did not contain raw task text, source body, or sensitive content.

Local `nano --help` startup after one warm-up was a median **108.4 ms** over five launches (range **107.1–110.8 ms**). The small smoke fixture's `.nano` index occupied **1,463 bytes in one file** after changed/deleted source and was empty after purge. Per-task cold/warm times on the three checked-out repositories are in the JSON artifact; they include process startup and indexing and are not latency service levels. The existing command test suite is the wider regression check.

CI runs the same package smoke after build on Windows, macOS, and Linux using **Node 20.19.0**, plus the existing Linux Node 22 test leg. This report does **not** claim those hosted checks passed; release readiness requires green checks on the final PR SHA. This local run used supported Node 24, not the CI minimum. Local `build`, `lint`, `type-check`, installed-package smoke, and `test:ci` passed (25 suites, 420 tests). The final branch checks must confirm those results.

## Release decision

The package is suitable for cross-platform CI validation, and the observed evidence facts were valid against the pinned snapshots. The low multi-file completeness and hard-negative false positives limit claims to bounded, deterministic file discovery with verifiable Nano Evidence. Release readiness remains conditional on hosted package smoke and regression checks at the final PR SHA and an explicit acceptance of the measured retrieval misses. Git co-change, trained models, diagnostics, MCP, installed agent skills, and Ollama-backed inference are outside this release's claims.
