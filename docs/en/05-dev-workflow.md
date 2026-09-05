# 05 Development Workflow and Quality Gates

<p align="center">
  <a href="../cn/05-dev-workflow.md">简体中文</a> · <b>English</b> · <a href="../ja/05-dev-workflow.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="04-invariants.md">← Prev: 04 Invariants</a> · <a href="06-modification-guide.md">Next: 06 Recipes →</a>
</p>

---

## Command Reference

| Command | Purpose |
| :--- | :--- |
| `bun run start` | Start long polling |
| `bun run lint` / `lint:fix` | Run ESLint / apply automatic fixes |
| `bun run lint:fast` | ESLint with `--cache`, for the local edit loop only. Type-aware rules cross file boundaries while the ESLint cache invalidates per file, so changing only a dependency will not re-report warnings in its dependents. **Gates always use the uncached `lint`** |
| `bun run typecheck` | Run `tsc --noEmit --incremental` in fully strict mode. The build info lives in `tsconfig.tsbuildinfo` (gitignored); changing tsconfig or dependency types invalidates it wholesale, which is why it is safe inside the gate |
| `bun run test` | Run the complete test suite with forced file isolation |
| `bun run test:random` | Run the whole suite in a fixed-seed random order to expose cross-test residue |
| `bun run test:coverage` | Run tests and measure coverage across all source files |
| `bun run check:install-script-syntax` | Parse `install.sh` with `bash -n` only; the installation script is not executed |
| `bun run check:install-isolation` | Actually run `install.sh` inside a dedicated `copy-ninjia-install-test-*` temporary fixture root (`scripts/checkInstallIsolation.ts`) and verify staging-failure cleanup, `telegram.json` rollback, interrupted-then-resumed installs, successful replacement, symlink topology, unverified-backup retention, and credential isolation; no real deployment path is touched |
| `bun run check:conventions` | Check repository conventions with `scripts/checkProjectConventions.ts` |
| `bun run check` | Run all seven segments — install-script-syntax + install-isolation + conventions + lint + typecheck + coverage + the hot-path gate; **required before every commit** |
| `bun run check:coverage` | Measure coverage now and verify the metrics in the three README badges/alts, the three copies of this page, and both coverage images match the real reading; excluded from `check` because it runs the whole suite again |
| `bun run test:fault-injection` | Run the deterministic fault-injection suite |
| `bun run perf:hot-paths` | Measure a single hot-path scenario in its own process (`--profile` adds sampling analysis) |
| `bun run perf:hot-path-gate` | Run the memory/GC/JIT gate over the 10 scenarios selected in `HOT_PATH_PROFILE_SCENARIOS` (the registry holds 30; the rest only run in `perf:full`); already part of `check`. `--write-result` records the run into the repository-root `performance-result.json` |
| `bun run perf:join-log` | Run the independent-process comparison of the join-log capacity, snapshot, and append-accounting paths at the 250,000-record limit |
| `bun run perf:identity-database` | Benchmark six real identity-database cold/hot read and write operations in independent processes |
| `bun run perf:full` | Full benchmark, six sections × three rounds; release and explicit request only. `--write-doc` rewrites all three 09 Performance pages and `fullSuite.lastRun` in `performance-result.json` |
| `bun run migrate:qa-thumbnail` | Offline cold migration dropping the retired `global.assets.qaThumbnailUrl` from `state.json` |
| `bun run migrate:temporary-whitelist` | Stopped-service cold migration over the direct v5 → v7 edge; v6 is only the resumable intermediate lineage of that migration |
| `bun run release:check` | Run frozen-lockfile install + check + coverage-metric verification + fault injection; required before release |
| `bun run audit:release` | Audit dependencies for moderate-or-higher vulnerabilities |

## Quality-Gate Definitions

- **The coverage denominator includes all source code**: `bun run check` adds every production runtime module to the denominator. Modules untouched by any test count as 0% covered. Both function and line coverage must remain at least 90%, so adding an untested module directly lowers global coverage.
- **ESLint + fully strict tsc**: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, and `noUnusedParameters` are all enabled. `any` is forbidden in production code but exempted in tests.
- **Explicit type annotations are lint-enforced**: in production code (`index.ts`, `packages/`, `scripts/`), variables, parameters, and destructuring must be annotated via `@typescript-eslint/typedef`, and function and callback return types via `@typescript-eslint/explicit-function-return-type` — neither accepts contextual inference. TypeScript forbids annotating `for...of` / `for...in` loop variables, so the rule skips them automatically; consts whose initializer is already an arrow function are also exempt. Test files are not subject to this.
- **Convention checks**: `check:conventions` checks code placement, local Markdown targets, executable permissions on tracked non-script files, constants, cache ownership, and Worker/Telegram boundaries against the real thread module graph. It also statically checks that every timer handle installed under `packages/workers/` is `unref()`ed, Node-compatibility imports in production code and scripts, the allowed `Buffer` methods, process arguments that must use `Bun.argv`, Telegram cleanup and retention exemptions, active cold-migration entries, all 14 declared coverage locations, and the trilingual performance record. Cross-references written in comments as "see `<module>.ts`'s `<symbol>`" are checked the same way: it fails when the named module no longer declares or re-exports that symbol (`export *` compatibility entries are expanded one level). `check:coverage` performs a separate real coverage run to ensure the declarations have not drifted together.
  Module-level literal constants and literal combinations belong in domain `consts`; function composition and cache ownership are checked separately. Builtin Node modules share one allowlist with or without the `node:` prefix. Dynamic loading, re-exports, `require`, `process.hrtime` / `nextTick`, and destructuring are checked too; type-only declarations are excluded from runtime checks.

### Dependency Release-Age Gate

Dependency installation always uses the seven-day release-age gate in `bunfig.toml`. An exact version younger than seven days may receive a temporary package-specific exemption only after informed user approval and verification of its upstream source, npm integrity, and lifecycle scripts. The exemption is removed immediately after installation, and its package name, reason, and removal time are recorded. The Bun runtime is pinned to 1.4.1 and `@types/bun` to 1.4.0; the version gate requires the same major and minor versions, while `packageManager` and `install.sh` jointly pin the runtime patch version.

### Measurements for This Documentation Version

`bun run test:coverage`: **3179 tests / 321 files / 123010 `expect()` calls**; full-source **function coverage 97.12% / line coverage 97.38%**. The Coverage badge in each project README displays line coverage.

## Test Isolation

Tests must run through `bun run test`, which invokes `bun test --isolate`, with four layers of protection:

1. **File isolation**: Bun creates a fresh global object for every test file, so `mock.module` and module-level state do not contaminate other files. `--parallel` is not enabled, so this project does not claim that every file gets a separate process.
2. **Temporary data root**: before any production module loads, `test/preloadEnv.ts` injects an independent temporary data root for each isolate. Even real, unmocked file I/O can read or write only that temporary directory and never production `state.json`, `bot.lock`, `logs/`, `memory/`, or `database/`. The directory is removed afterward. **The path injection lives in its own file** because ESM evaluates imports before any statement in the importing file: the moment `test/preload.ts` statically imports a production module, an environment assignment written inside that file is already too late and `CONFIG_ROOT` resolves to the developer's real deployment directory.
3. **Read-only configuration root**: the same injection also points `COPY_NINJIA_CONFIG_ROOT` at the in-repo `config_example/` (see `CONFIG_ROOT` in `packages/consts/paths.ts`). The deployed `config/` is not version-controlled, so this layer both keeps a clean checkout runnable and stops tests and test Workers from reading a developer's real Telegram and feature configuration. The preceding temporary-data-root layer isolates the identity database. That variable exists for tests only — it is not a deployment switch, which is why the README environment table omits it.
4. **Agent configuration snapshot**: `agent.json` is the one deployment input no runtime path reads from disk (in a real process the main thread parses it and hands it to each Worker in an init message, see [04 Runtime Invariants](04-invariants.md)). Test isolates never receive those messages, so `test/preload.ts` adopts the same `config_example/agent.json` into the isolate's holder once — equivalent to "the snapshot already arrived". Tests that need the unconfigured path clear the holder themselves.

Direct `bun test` runs are acceptable for debugging a single file, but the complete `bun run check` must pass before merge.

### Test-Writing Conventions

- Mirror `packages/` paths: `packages/foo/bar.ts` → `test/foo/bar.test.ts`.
- Cross-domain doubles, fixtures and harnesses belong in `test/helpers/`; domain-agnostic utilities belong in `test/libs/helpers.ts`. Do not share mutable module state across tests; isolation can conceal such mistakes until someone runs without `--isolate`.
- Tests that exercise real file I/O are safe because the preload provides a temporary data root. Still, watch mock boundaries around `infra/storage`: mocking only `infra/diskIO` while leaving `infra/storage` real can reach the real `saveStateInBackground`, which is exactly the situation where [`AGENTS.md`](../../AGENTS.md) requires backing up runtime files first.

## Fault-Injection Suite

`bun run test:fault-injection` concentrates on crash recovery and persistence boundaries: lifecycle failure, update-runner acknowledgement boundaries, StateStore and cleanup, AI/Anti-Raid Worker mirrors and lifecycles, Disk I/O append/snapshot/log files, flush barriers, and more. See the scripts in [`package.json`](../../package.json) for the complete list. This suite must pass whenever a changed path is covered by [04 Authoritative Runtime Invariants](04-invariants.md).

## Hot-Path Gate

`bun run perf:hot-path-gate` is the final stage of `bun run check`, so it runs before every commit. For each scenario in `HOT_PATH_PROFILE_SCENARIOS` (`packages/consts/performance.ts`) and each repeat it spawns two independent children: `steadyProfile` judges only GC and JIT during the formal loop, while `retained` judges RSS, the heapUsed peak, and post-full-GC retention without the profiler's own memory interfering.

`scripts/perf/hotPaths/gateResult.ts` strictly parses the calibration stored in [`performance-result.json`](../../performance-result.json). Before convention checks proceed or hot-path children start, `gateRuntime.ts` compares `packageManager`, the current Bun version/revision, and the calibrated build; mismatches require remeasurement. The record contains process counts, per-scenario latency sources, and hard GC/RSS/retention limits. Historical `fullSuite` results retain their own timestamps and Bun builds.

The `hotPathProfileGate` section is bidirectional, but the two halves have different owners. `calibration` is edited by hand after a recalibration and is read-only to the gate. `lastRun` records the most recent gate readings and is only overwritten when you explicitly pass `bun run perf:hot-path-gate -- --write-result`, so a plain `bun run check` leaves the working tree clean. The write-back never touches a byte of `calibration` — letting the gate rewrite its own criteria from one run would weld the gate shut at today's performance.

The other section of the same file, `fullSuite.lastRun`, belongs to the [full benchmark](#full-performance-benchmark) and is written by `bun run perf:full -- --write-doc`. The two benchmarks run in different processes at different times, so both write through `scripts/perf/performanceResult.ts`, which reads the whole document, replaces only its own slot, and writes the whole document back. Neither rebuilds the file from parsed output — doing so would let whichever ran last erase the other section along with the human-written notes under `calibration`.

Gated metrics: GC sample share; the sampled RSS peak and the process lifetime RSS high-water mark (they share one limit — the latter catches a transient allocation that falls entirely between two sampling ticks); sampled heapUsed growth; post-full-GC retained JSC heap, extra memory, and object count; the minimum sample count; and, per production probe, "entered DFG during warmup" plus "no recompilation or deoptimization during steady sampling".

Fields suffixed with `Diagnostic` are reported but not gated. The aggregate FTL share is one of them: it approaches 100% for a pure leaf scenario yet stays in the single digits for the asynchronous spine (whose samples mix in native Promise and scheduler frames), so a single threshold carries no shared meaning across the two. The absolute `reoptRetries` count is another — the JIT stabilization rounds already require it to stay unchanged across consecutive rounds before sampling begins, so what remains is warmup history.

The `profile` / `retained` prefixes record which child a reading came from; their warmup iteration counts differ by an order of magnitude (profiled scenarios run extra JIT stabilization rounds), so the two must not be read together.

There is one **mandatory sink rule** when adding or rewriting a scenario: when the function under test returns a string, the benchmark must not sink it by reading `.length` alone. A JSC rope carries its own length, so reading it never materializes the string — that measures "a concatenation tree was built", not "a usable string was produced". On identical input, after transcript rendering switched to per-line `+=` the two sinks differ by 42.0 vs 57.5 µs/op (27%), whereas before the change they differed by only 3.1%: a length-only benchmark would have scored that change as 42% faster, more than half of which is work not yet done. Always sink through a forced resolution such as `charCodeAt(length - 1)` (see `transcript-render` in `scripts/perf/hotPaths/transcriptScenarios.ts`). The same reasoning applies to any lazy structure that is only realized later: **a benchmark must pay the step production actually pays**, otherwise a regression that drops that step from the chain shows up as a faster reading instead of a failure.

## Join-Log Performance Benchmark

`bun run perf:join-log` fixes the input at a 250,000-record capacity, 300-record overflow, and 10,000-record warm-up. Baseline and current variants of all three paths — `snapshot`, `capacity`, and `append-accounting` — run in five independent Bun processes each, and the parent compares the two variants’ checksums sample by sample, failing outright on any mismatch. The `append-accounting` batch size is the production `JOIN_LOG_MAX_BUFFERED_ENTRIES`, repeated until the total input matches the 250,000-record scale of the other two. The report records the complete Bun version/revision, median and range of elapsed time, and JSC heap/object changes before and after forced GC. The baseline freezes the pre-optimization algorithms — whole-Map copy, full sort, and complete-JSON-string generation for snapshot and capacity; re-serializing each record once merely to measure its byte length for append-accounting — solely for before/after comparison within the same Bun build; `Bun.gc(true)` exists only in this benchmark and never in production control flow. Run it whenever join indexing, capacity trimming, snapshot serialization, post-append byte accounting, or chunked atomic writes change, and verify that the difference is materially larger than the noise shown by the five-sample ranges.

## Identity-Database Performance Benchmark

`bun run perf:identity-database` uses temporary data roots and SQLite databases to measure six production operations: two-table reads in batches of 8 identities (hot on one connection, cold with a fresh connection per batch), explicit 128-row transaction writes (again split into hot and cold connections), hot reads through the main-thread 8,192-entry LRU, and write-through that crosses the Worker, JSONB transaction, and exact ACK boundary. "Cold" only means an empty connection page cache and statement cache, not a dropped OS page cache. Each operation warms up before five independent Bun processes are sampled. The report fixes Bun version/revision and records throughput, batch latency, sample range/coefficient of variation, retained JSC heap/extra memory/object counts, and GC time. `--single-process` repeats each operation three times in one measurement process to investigate retained growth across rounds; it does not replace independent-process performance comparison. `Bun.gc(true)` remains outside timed regions and diagnostic-only. Run this benchmark when identity LRU, cold prefetch, encoding, transaction batching, acknowledgements, or Worker replay changes, and judge the same-Bun-build difference together with sample noise and heap/GC results.

## Full Performance Benchmark

`bun run perf:full` runs on release and on explicit request only. It is not part of `bun run check` and sets no failure threshold — the hard gate for hot paths is still `perf:hot-path-gate` above. It runs six sections for three independent-process rounds each and reports the mean: cold start, production hot paths, end-to-end persistence chains, SQLite and main-thread caches, containers and algorithms, and the join-log capacity line. Every item also carries min, max, and coefficient of variation; a row whose CV jumps cannot be compared against history.

Everything measured reuses existing code: hot paths run the `perf:hot-paths` scenarios at their own iteration counts, storage calls the `perf:identity-database` implementations, the capacity line calls the `perf:join-log` children, and the chains drive a real Disk I/O Worker through the main-thread production entries `recordJoinLog`, `persistChatState`, `queueIdentityPolicyWrite`, `postDiskIO`, and `relayLogMessage`, timed until the durable acknowledgement. Two further chains time a **whole command**: `ad-detect-command` runs `enqueueAdCandidate` through `runAdDetectBatch` into the main-thread `handleAdDetected` disposal drain, and `ai-reply-command` runs `recordChatMessage` and `generateAndSendReply` until the reply is actually sent. Their model calls and Telegram traffic are answered by the in-process canned replies in `scripts/perf/outboundGuard.ts` — the benchmark never issues a real request and never incurs API cost; `ai-reply-command` additionally subtracts the measured human-like pause before sending, documented in [09 Performance](09-performance.md). Cold start times a fully seeded fixture phase by phase in the order of `packages/app/lifecycle.ts`, excluding networked handshakes and the two business Workers.

All data is written under the repository-root `performance/` directory (already in `.gitignore`), configuration is read from `config_example/`, and each round's tree is removed afterwards; nothing should remain there once the run ends. The parent process imports no production implementation module, so it has no way to write to the real data root. Adding `--write-doc` rewrites the trilingual block in `docs/{cn,en,ja}/09-performance.md`; the figures and the meaning of each section live in [09 Performance Benchmark](09-performance.md).

## Commit Workflow

1. Develop on the `dev` branch and never commit straight to `master`; merge into `master` with a squash so one change set becomes one commit. See “分支与提交” in [`AGENTS.md`](../../AGENTS.md) for the branch rules, which are not repeated here.
2. Users may adjust parameters while development is in progress. Reread files before editing so uncommitted work is not overwritten.
3. Review the complete `git diff --stat` before committing, and keep unrelated files out of the commit.
4. Make sure `bun run check` passes.
5. Use Conventional Commits style—`feat(ai): ...`, `fix(runtime): ...`, `docs: ...`—with an English subject line.
6. Every commit is stored only after joint human/AI review, following the project convention described in the root README's “Pure AI Development” section.

### Updating README Metrics

The badges in all three project READMEs and the test, assertion, and coverage figures above are measured values. Update them after changes to tests, production modules, or the coverage definition:

```bash
bun run test:coverage 2>&1 | tail -5           # test count, file count, expect() count
bun run test:coverage 2>&1 | grep 'All files'  # function and line coverage
```

These places all carry the same measured figures, so updating one obliges updating every one:

- **The Tests/Coverage badges in all three READMEs.** The Coverage badge always uses the `All files` line-coverage value.
- **The coverage graphics**: [`pictures/coverage_light.svg`](../../pictures/coverage_light.svg) and [`pictures/coverage_dark.svg`](../../pictures/coverage_dark.svg), referenced from the “Project Quality” block in each README's “Pure AI Development” section. One pair is shared by all three READMEs (like the banner), so both theme files need the new figures.
- **The equivalent `<img alt>` text in all three READMEs.** The graphic loads as an image, so the SVG's own `<title>` / `aria-label` never reaches a screen reader and the alt is the only accessible path.
- **“Measurements for This Documentation Version” in all three workflow documents.**

Two more sets of measured figures drift just as silently, independently of coverage:

- **The Chinese string-literal count**. The figures live only in the “no i18n” section of all three copies of [06 Common Modification Recipes](06-modification-guide.md); the “On languages” note in each README just links there and carries no numbers. Recount after adding or removing user-facing copy: count the source lines spanned by string/template-literal nodes in the TypeScript AST, excluding comments. Do not grep for backticks — a backtick inside a regex literal throws the count off.
- **Behavioral figures** such as probabilities, capacities, and durations, which must stay aligned with `packages/consts/`; see [06 Common Modification Recipes](06-modification-guide.md#adjusting-behavioral-parameters).

## Release

This repository does not rely on GitHub Actions. Release environments should make `bun run release:check` an explicit build or pre-deploy step. Networked environments should additionally run `bun run audit:release`; network failure means the audit was not completed, not that there are zero vulnerabilities. Any ignored CVE needs a recorded reason and expiration date. For releases with persistence-structure changes, first follow the migration process in [06 Common Modification Recipes](06-modification-guide.md#changing-a-persistence-schema).

After the gates pass on `dev`, stop the service and other heavy workloads, wait for the machine to
be idle, and run `bun run perf:full -- --write-doc` with the default three rounds. The command updates
both the trilingual [09 Performance Benchmark](09-performance.md) and `fullSuite.lastRun` in
`performance-result.json`; commit both with the code. Do not run the full benchmark alongside or
immediately before or after `bun run check`; wait for the machine to become idle between them.
Performance comparisons require the same machine and Bun build. Figures after a runtime upgrade
establish the baseline for that build; cross-build differences do not measure code optimization.
Investigate failures or abnormal readings and rerun before publishing.

Every squash merge into `master` must produce one GitHub Release:

1. Synchronize remote tags and read the current Latest Release tag through `gh release list`. Tags must use `MAJOR.MINOR.PATCH` without a `v` prefix. Select the version from the highest semantic impact in the complete change set: increment `MAJOR` for a breaking change (`1.0.9` → `2.0.0`), `MINOR` for backward-compatible functionality (`1.0.9` → `1.1.0`), and `PATCH` only for fixes, performance work, refactoring, or documentation (`1.0.9` → `1.0.10`).
2. After pushing the `master` squash commit, create and push an immutable annotated version tag for that commit. Never overwrite, move, or reuse an existing tag.
3. Create an English Release with `gh release create <tag> --verify-tag --target master ...`. Release notes must cover only the delta from the previous Latest Release tag to the current `master`, with at least Highlights, Compatibility / Migration Notes, and Validation. Gate metrics must come from the current run.
4. If the tag push succeeded but Release creation failed, retry the same tag instead of incrementing again. Align `dev` with `master` as described in [`AGENTS.md`](../../AGENTS.md) only after `master`, the tag, and the Release are all confirmed.

---

<div align="center">

[← Prev: 04 Invariants](04-invariants.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#05-development-workflow-and-quality-gates) · [Next: 06 Recipes →](06-modification-guide.md)

</div>
