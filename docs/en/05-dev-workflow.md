# 05 Development Workflow and Quality Gates

<p align="center">
  <a href="../cn/05-dev-workflow.md">简体中文</a> · <b>English</b> · <a href="../ja/05-dev-workflow.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="04-invariants.md">← Prev: 04 Invariants</a> · <a href="06-modification-guide.md">Next: 06 Recipes →</a>
</p>

---

## Command Reference

| Command | Purpose | Notes |
| :--- | :--- | :--- |
| `bun run start` | Start long polling | Production entry point |
| `bun run lint`<br>`bun run lint:fix` | ESLint check / auto-fix | Strict code conventions. Quality gates always run uncached `lint` |
| `bun run lint:fast` | Local cached ESLint | Appends `--cache` for fast iterative feedback during local dev |
| `bun run typecheck` | TypeScript type check | Strict check of the whole project with `bun --check`, driven by `tsconfig.json`; writes no incremental cache |
| `bun run test` | Full test suite | Forces process context isolation (`bun test --isolate`) |
| `bun run test:random` | Random-order test suite | Fixed-seed shuffled test suite to uncover cross-test state leaks and lingering mocks |
| `bun run test:coverage` | Tests + coverage | Runs the full test suite and measures coverage across all production source files |
| `bun run check:install-script-syntax` | Install script syntax check | Uses `bash -n` to parse `install.sh` and all included shell modules without executing |
| `bun run check:install-isolation` | Installer isolation test | Runs real `install.sh` fixtures in a dedicated temp root to verify rollback, resumption, backup safety, credential isolation, and service supervision |
| `bun run check:conventions` | Repository convention check | Runs `scripts/checkProjectConventions.ts` to validate constants, cache ownership, doc links, and architecture boundaries |
| `bun run check` | **Full integration gate** | Syntax + installer isolation + conventions + lint + typecheck + coverage + shuffled tests + hot-path gate (required before merge to `master`) |
| `bun run check:coverage` | Coverage metrics reconciliation | Validates that figures in trilingual READMEs, docs, and SVG badges match actual test readings |
| `bun run test:fault-injection` | Deterministic fault-injection suite | Validates state recovery across process crashes, abnormal exits, database drops, and Worker respawns |
| `bun run perf:hot-paths -- <scenario> [--profile]` | Hot-path standalone measurement | Profiles a single hot-path scenario (pass `--profile` for detailed CPU sampling) |
| `bun run perf:hot-path-gate` | **Hot-path performance gate** | Enforces hard memory/GC/JIT limits on core hot paths (included in `check`) |
| `bun run perf:join-log` | Join-log performance benchmark | Standalone benchmark for join-log capacity limits, snapshots, and append accounting |
| `bun run perf:identity-database` | Identity database benchmark | Standalone benchmark for cold/hot SQLite reads/writes, main-thread LRU cache, and write-through pipelines |
| `bun run perf:full` | Full performance benchmark suite | Runs each section across independent child processes for default rounds (`--write-doc` syncs all three 10 performance docs and `performance-result.json`) |
| `bun run perf:review` | Targeted performance review | In-depth evaluation covering hot paths, AI replies, audio encoding, full command chains, and Disk I/O Worker pressure |
| `bun run build -- --version <tag>` | Build binary package | Requires an explicit version with no prefix; produces the `dist/` archive and SHA-256 for the current platform |
| `bun run release:check -- --version <tag>` | Pre-release full validation | frozen lockfile + check + coverage check + fault injection + binary build verification |
| `bun run release:build -- --version <tag>` | Build release package | Natively builds the current platform binary on a clean `dev` branch. Other platforms must be built natively in their own matching environments |
| `bun run release:verify -- --version <tag> --platforms <list>` | Release package verification | Verifies archives, SHA-256 sums, versions, and Git tree alignment across all declared platforms |
| `bun run release:publish -- --version <tag> --platforms <list> --notes-file <file>` | Publish to GitHub | Verifies remote refs, creates a draft, uploads and validates assets, and officially publishes as Latest |
| `bun run audit:release` | Dependency security audit | Scans installed dependencies for vulnerabilities (moderate and above) |

---

## Quality-Gate Definitions

- **Isolated installer startup verification**:
  - Test fixtures run against completely isolated temporary configuration and data roots. They mock out system service managers, package downloads, and outbound network traffic while executing genuine `index.ts` startup, background Worker threads, and graceful shutdown persistence.
  - Workers use Bun's `preload` mechanism to install network stubs: the weather API returns a canned response, while all other outbound network calls are strictly rejected.
  - The suite asserts that stubs loaded successfully, the polling loop stayed intact, SIGTERM cleanly drained all in-flight work, and lock files were released.
- **Source file line limit (`MAX_SOURCE_LINES`)**:
  - Handwritten TypeScript, JavaScript, and Shell files exceeding `MAX_SOURCE_LINES` (defined in `scripts/conventions/fileLength.ts`) fail the gate immediately.
  - Review files for refactoring once they exceed 512 lines; files exceeding 1024 lines must be split.
  - The check scans all Git-tracked files and staged new files, while ignoring ignored deployment data. Installer syntax checks cover `install.sh` and every standalone shell module it invokes.
- **Universal source code coverage**:
  - `test/productionModules.test.ts` eagerly imports `index.ts` and all runtime modules under `packages/` (except pure type declarations in `packages/types/`). Any module untouched by tests is factored into the denominator with 0% coverage.
  - Both function and line coverage must satisfy the `coverageThreshold` in `bunfig.toml`. Adding business code without tests will fail the build.
- **Strict typing and syntax standards**:
  - `tsconfig.json` enforces `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, and `noUnusedParameters`.
  - Production code strictly forbids `any` (exempted in test files). The native `Promise.all` is disallowed by ESLint (`no-restricted-syntax`); use `Promise.allSettled` with bounded concurrency instead.
- **Standalone type imports**:
  - Production code, scripts, and tests must use explicit, separate `import type` declarations. ESLint strictly rejects mixed import statements like `import { value, type Shape }`.
- **Explicit type annotations**:
  - All variables, function parameters, and destructuring patterns in production code must specify explicit types (enforced by `@typescript-eslint/typedef`). Functions and callbacks must declare explicit return types (enforced by `@typescript-eslint/explicit-function-return-type`), avoiding reliance on contextual inference.
  - Loop variables in `for...of` and `for...in` statements are exempt because TypeScript does not permit syntax annotations there. Const variables initialized directly with fully annotated arrow functions are also exempt.
- **Repository convention checks (`check:conventions`)**:
  - **Structure and links**: Verifies source line counts, file locations, relative Markdown links, and in-page anchor IDs. Confirms that all file paths referenced in docs actually exist on disk, verifies script execution bits, and ensures installer step numbers match module references.
  - **Architectural boundaries**: Validates constant and cache ownership (`packages/cache/<owner>/` thread-single-owner policy) and verifies Worker and Telegram capability isolation against the actual import graph. Environment variables may only be read in `consts/paths.ts` and `consts/environment.ts`. The `consts/` layer may only depend on `consts` at runtime (other `packages/` modules only through `import type`). The `states/` layer may only depend on `consts`, `libs`, `types`, and `states`. The `infra/` layer cannot import business modules. The benchmark parent process may only import pure constants and types.
  - **Constant table rules**: exported constant tables with object elements (regular expressions and function values excluded) must have an access in `test/consts/immutability.test.ts` on the line right after a `@ts-expect-error` comment (`scripts/conventions/constImmutability.ts`). Exported array tables whose elements are a literal union must be written as `exhaustiveList<U>()([...])` (`packages/consts/exhaustiveList.ts`), with `U` equal to the declared element type and every item a string or number literal, so adding or removing a member of the type without updating the table fails to compile. Tables that intentionally list a subset are registered as `<relative path>#<table name>` in `PARTIAL_LITERAL_TABLES` in `scripts/conventions/constExhaustiveLists.ts`; stale registrations are reported as well.
  - **Runtime safety and APIs**: Every timer in `packages/workers/` must explicitly call `.unref()`. Node compatibility modules and `Buffer` usage are restricted to an explicit whitelist; unused registrations trigger errors. CLI arguments must be read via `Bun.argv`. Runtime packages imported bare must be declared directly in the root `package.json`.
  - **Gate reconciliation**: Statically verifies Telegram prompt cleanup exemptions and topic ownership. Validates that active cold migration scripts match `migrate:*` entries in `package.json`. Checks that test coverage and performance metrics documented in trilingual files match `performance-result.json`.
  - **Test assertion rules**: Test assertions must not compare uppercase constants against raw numeric or string literals. Never hardcode strings or long Chinese prompt fragments identical to those in `packages/consts` directly in test assertions (import the constant or use `test/helpers/templateText.ts`). Contract tests verifying exact prompt wording must be registered in `scripts/conventions/testAssertionFragments.ts`.

---

### Dependency Release-Age Gate

All dependency installations enforce a 7-day release cooling period defined in `bunfig.toml` (`minimumReleaseAge = 604_800`):
- **Emergency security patch exemption**: When an urgent vulnerability fix is under 7 days old, add only that single package name to `install.minimumReleaseAgeExcludes`. Remove the exemption immediately after installation. Bypassing the gate via the command-line flag `--minimum-release-age` is strictly prohibited.
- **Verification protocol**: The exempted package version must be cross-checked against at least two independent security incident advisories. You must verify the package `integrity` hash in the npm registry, inspect install scripts for backdoors, and log the package name, CVE/incident ID, and removal date in the commit message.
- **Pinned runtime versions**: The Bun runtime and `@types/bun` are pinned to the exact version declared in `package.json`. The `packageManager` field and `install.sh` lock the runtime environment.
- **TypeScript compilers**: `bun run typecheck` invokes Bun's built-in type checker as `bun --check`; `bun check` runs the repository's `check` script. ESLint and convention checks use `@typescript/old` (TypeScript 6 compiler API).

---

### Bun Runtime Boundaries

- **Execution mode**: `bunfig.toml` sets `run.bun = true`, so CLI dependencies with Node shebangs run directly under Bun.
- **Image transcoding**: Images are processed via native `Bun.Image` (`packages/infra/image.ts`):
  - JPEG and PNG images pass through without modification. WebP and GIF convert to PNG with full Alpha transparency preserved. For GIFs, the first frame is extracted; for animated WebP, the first `ANMF` frame is repackaged as static WebP before decoding.
  - Single-image decoding is capped at `VISION_TRANSCODE_MAX_PIXELS`. Excessively large images are rejected before memory allocation. Codecs are built into Bun, eliminating any need for external C/C++ native addons in `node_modules`.
- **Native file I/O guidelines**: Reading, writing, and deleting files prioritize native `Bun.write` and `Bun.file`. Exclusive atomic writes (`atomicWriteText`) use `Bun.write(Bun.file(handle.fd), content)` followed by `fsync` and atomic rename. Synchronous file I/O, directory traversal, path handling, and hard links use explicit `node:` compatibility modules.
- **Performance recalibration**: After upgrading the Bun runtime, all performance benchmarks must be re-calibrated against the new Bun version.

---

### Measurements for This Documentation Version

`bun run test:coverage`: **6386 tests / 530 files / 445518 `expect()` calls**; full-source **function coverage 98.27% / line coverage 98.78%**. The Coverage badge in each project README displays line coverage.

---

## Test Isolation

All tests must be run via `bun run test` (which invokes `bun test --isolate`), providing comprehensive automated isolation:

1. **Test file context isolation**: Bun creates a clean, independent global context for every test file. Mock overrides (`mock.module`) and module-level variables never leak across files.
2. **Dedicated temporary data root**: `test/preloadEnv.ts` creates a fresh temporary data directory via `mkdtempSync` before any production code loads and assigns it to `COPY_NINJIA_DATA_ROOT`. Real file I/O never touches production directories (`memory/`, `logs/`, `database/`, `bot.lock`), and the entire temporary tree is deleted after tests finish.
3. **Isolated configuration root**: Copies `config_example/` to `config/` inside the temporary root and points `COPY_NINJIA_CONFIG_ROOT` to it. Placeholder keys are replaced with safe mock credentials, `g-auth.json` is masked, and `cron.json` is initialized as an empty task schedule.
4. **Snapshot sync and empty database setup**: `test/preload.ts` loads copies of `agent.json`, `ad_samples.json`, `mood.json`, `stickers.json`, `cron.json`, bot atmosphere settings, and built-in personas into isolate holders, while provisioning an empty SQLite database with time zone markers. All readiness flags are set to available.

### Key Test Suite Distribution

- **Installation and upgrade suites**: `test/scripts/installStartup.test.ts` and `test/scripts/installMigration.test.ts` test installation scripts, fresh database provisioning, and full startup sequences. They ensure the installer safely halts without mutating existing data when encountering unrecognized schemas or configs.
- **Cold migration suites**: `test/scripts/migrateChatPersonaRemoval.test.ts` verifies migrations from schema version 16.3.2 (`CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION`) to the current version (`IDENTITY_DATABASE_SCHEMA_VERSION`, including the Asia/Tokyo time zone stamp), checking validation both before and after migration.
- **Media and outbound suites**: `test/aiChat/ai/mediaAdmission.test.ts`, `test/aiChat/ai/imageDescription.test.ts`, and `test/infra/telegramWorkerCapabilities.test.ts` test multimodal safety filters and duplex outbound gates.
- **Unified outbound integration suites**: `test/infra/telegramOutboundIntegration.test.ts` uses real client initialization, outbound gates, and per-chat lanes, stubbing out only innermost network responses. It validates per-chat FIFO queues across threads, category-specific 429 exponential backoffs, download throttling, and shutdown drain.
- **Security and logger suites**: `test/infra/loggerSecurity.test.ts` ensures sensitive tokens and credentials are redacted across all error-logging formats.

---

## Fault-Injection Suite

`bun run test:fault-injection` validates system consistency under process crashes, unexpected shutdowns, and boundary failures (see [`package.json`](../../package.json) for the full list):
- **Lifecycle and recovery limits**: Covers application and Worker lifecycles, group lockdown recovery, AI reply limits and cancellations, credential snapshots, Telegram outbound shutdown drains, delayed-deletion queues, and chat teardown cleanup.
- **Data durability and consistency**: Verifies join-log pending mirrors, Anti-Raid task draining and verification recovery, duplex Worker respawn cancellation, SQLite startup row validation and shutdown close (remaining-write commit, WAL checkpoint), cold migrations, and Disk I/O Worker atomic write failures.
- **Interactive state machines**: Includes `test/workers/antiRaid/verificationWelcome.test.ts` (duplex protocol and temporary notice self-deletion) and `/wed` state machines (chat capacity cap `STATE_MANAGED_CHAT_LIMIT`, queue cancellation, avatar downloads, and shutdown drains).

---

## Hot-Path Gate

`bun run perf:hot-path-gate` is a hard requirement within the `bun run check` gate. It evaluates scenarios defined in `HOT_PATH_PROFILE_SCENARIOS` under `packages/consts/performance.ts`, running each across two independent child processes for `HOT_PATH_PROFILE_REPEATS` iterations:
- `steadyProfile`: Measures GC pause time percentage and JIT compilation tiers under `BUN_JSC_logGC=1` in steady-state loops.
- `retained`: Measures physical memory (RSS) peak, heapUsed peak, and retained memory after full GC without profiler overhead.

Gate children, along with the child processes of the full suite, `perf:review`, `perf:disk-transport`, `perf:identity-database`, and `perf:join-log`, all take their environment from `perfChildEnvironment` in `scripts/perf/childEnvironment.ts`: it inherits the parent environment, layers on variables such as the isolated roots, then removes the Bun debugger attach variables listed in `BUN_INSPECTOR_ENVS` (for example `BUN_INSPECT_CONNECT_TO`, which VS Code terminals inject), so each child has only the main-thread JSC heap. The GC log must contain exactly one `starting` handshake; when more than one heap appears, no GC reading is produced.

### Gate Metrics and Tiers

- **GC pause budget**: Tiered dynamically based on available CPU cores (`HOT_PATH_GC_CPU_BUDGETS`). If a single process exceeds the budget by `HOT_PATH_GC_SOFT_OVERRUN_PERCENT` percentage points, the gate fails immediately. Moderate increases below this threshold trigger soft warnings.
- **Hard gate thresholds**: Strict ceilings on GC pause percentage, sampled RSS peak, process RSS peak, heap growth, post-full-GC retained memory/objects, sample count minimums, and pre-warm entry into DFG JIT. Baseline numbers come from `calibration.limits` in [`performance-result.json`](../../performance-result.json).
- **Soft warning alerts**: If median execution time exceeds `calibration.medianNsPerOpReportThresholds`, or if baseline limits become significantly looser than real readings (`HOT_PATH_CALIBRATION_STALE_RATIO`), a warning is printed to stderr without failing the gate.
- **Calibration record management**: The `calibration` baseline must be updated manually on an idle machine and checked into version control. The gate treats this file as read-only, updating `lastRun` only when `--write-result` is passed.

---

## Join-Log Performance Benchmark

`bun run perf:join-log` aligns fixture sizes directly with production constants: daily group capacity `JOIN_LOG_MAX_USERS_PER_CHAT_DAY`, flush threshold `FLUSH_MAX_ENTRIES`, and append batch size `JOIN_LOG_MAX_BUFFERED_ENTRIES`. It tests three core paths—snapshots (`snapshot`), capacity (`capacity`), and append accounting (`append-accounting`)—comparing baseline and current implementations in independent child processes to verify data checksums, throughput, and heap behavior.

---

## Identity-Database Performance Benchmark

`bun run perf:identity-database` benchmarks end-to-end performance within a temporary data root and SQLite database. It covers main-thread LRU reads, main-thread write-through (Worker IPC, JSONB transactions, and ACKs), hot-connection reads/writes, and cold-connection reads/writes. Sample sizes are taken from production constants `IDENTITY_READ_CACHE_MAX_ENTRIES` and `IDENTITY_WRITE_BATCH_MAX_ENTRIES`. Operations run in isolated processes, with GC and integrity checks performed outside the measured timing window.

---

## Targeted Scenarios and Transport Stress Validation

`bun run perf:review` performs in-depth stress testing on system bottlenecks. Each test runs for `FULL_SUITE_ROUNDS` rounds in isolated child processes. By default, it runs `--hot-paths`, `--chains`, `--ai`, and `--worker` in sequence:
- `--hot-paths`: Covers sender resolution, message sliding windows, permission evaluations, AI active windows, pending verification snapshots, bounded streaming responses, and middleware pipelines.
- `--ai`: Tests reply admission gates, normal outbound sending, concurrent load handling, Base64 transcoding, and Opus audio encoding.
- `--chains`: Runs full end-to-end flows for ad detection (`ad-detect-command`), AI chat (`ai-reply-command`), and scheduled voice messages (`cron-send-voice`).
- `--worker`: Stress-tests batched writes, transaction ACKs, and Worker respawn recovery using the real Disk I/O Worker (with chat limit `STATE_MANAGED_CHAT_LIMIT`).
- `--cooldown` / `--text`: Targeted benchmarks for cooldown tracking and text sanitization (run on demand). Verifies hit rates, renewals, capacity limits, and batch expiries under production scales.
- `bun run perf:disk-transport`: Uses a mock Worker to measure queue overhead, ACK throughput, and latency in the main thread's business transport channel, isolating disk I/O latency.

---

## Full Performance Benchmark

`bun run perf:full` runs only during releases or upon explicit request. It does not enforce hard pass/fail thresholds. The suite runs six sections in independent child processes over `FULL_SUITE_ROUNDS` rounds, reporting averages, minimums, maximums, and coefficients of variation:
1. **Cold start**: Service boot and state recovery duration using fully populated fixtures.
2. **Production hot paths**: High-frequency path duration from message ingress to dispatch.
3. **End-to-end persistence**: Round-trip latency from main-thread trigger through Worker persistence to disk, alongside full command chains.
4. **SQLite and main-thread caches**: Interaction efficiency between SQLite and the main thread's hot LRU cache.
5. **Containers and algorithms**: CPU time spent in core state containers and high-frequency algorithms.
6. **Join-log capacity line**: Join-log processing throughput and memory stability at capacity limits.

Benchmark data is written to `performance/` at the repository root and purged immediately upon completion. Running with `--write-doc` writes results to all three `10-performance.md` docs and `performance-result.json`. The `--rounds <n>` option is reserved for local testing and must never be committed to documentation.

---

## Commit Workflow

1. **Branch policy**: The repository uses only `master` and `dev`. Feature branches are prohibited. All development occurs on `dev`; never commit directly to `master`.
2. **Pre-commit checks**:
   - Run `git diff --stat` to ensure no untracked files or deployment artifacts linger.
   - Run `git branch --show-current` to confirm you are on `dev`.
   - Run `bun run lint && bun run typecheck` or the full `bun run check`.
3. **Pre-merge gate**: All tests in `bun run check` must pass before merging into `master`. If changes touch persistence formats, shutdown sequences, or Worker lifecycles, `bun run test:fault-injection` must also pass. Never merge on a failing gate.
4. **Merge procedure**: Merge `dev` into `master` exclusively via `git merge --squash` to create a single clean commit.
5. **Commit message convention**: Messages must thoroughly describe changes and rationale using conventional prefixes (`feat:`, `fix:`, `perf:`, `docs:`, etc.). Release commits must use `release: <version>`.

### Updating README Metrics

Only update documentation metrics when explicitly requested by the user, using output from the local full test suite:
```bash
bun run test:coverage 2>&1 | tail -5          # Test count, file count, expect() count
bun run test:coverage 2>&1 | grep 'All files'  # Function and line coverage
```
- **Trilingual README badges** (Tests and Coverage figures).
- **Coverage vector badges**: `public/coverage_light.svg` and `public/coverage_dark.svg`.
- **`<img alt>` text in trilingual READMEs**.
- **The "Measurements for This Documentation Version" section across all trilingual docs**.

---

## Release

Every release produces a GitHub Release containing native binary packages built across all supported architectures:

1. **Version selection and gate verification**:
   - Synchronize remote tags and identify the current Latest Release via `gh release list`.
   - Select an incremented semantic version number without a `v` prefix (`MAJOR.MINOR.PATCH`).
   - Finalize development on `dev`, passing `bun run check` and running `bun run test:fault-injection` when relevant.
2. **Update performance benchmark readings**:
   - Stop background bot services and ensure the host system is idle.
   - Run `bun run perf:full -- --write-doc` with default rounds. Commit the updated readings in all three `10-performance.md` files and `performance-result.json` to `dev`.
3. **Native cross-platform builds**:
   - Target platforms are defined in `RELEASE_PLATFORMS` (`linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`).
   - In each platform's native environment, checkout the clean release commit and run `bun run release:build -- --version <tag>`.
   - Collect the generated archive and `.sha256` checksum files into a single staging directory.
4. **Release asset verification**:
   - On a clean working tree, verify all collected assets:
     ```bash
     bun run release:verify -- --version <tag> --platforms <comma-separated-platforms> --directory <staging-directory>
     ```
   - The script verifies SHA-256 checksums, version metadata, target architectures, dependency integrity, and confirms no `.map` files or `node_modules` were packaged.
5. **Merge and tag creation**:
   - Merge `dev` into `master` using `git merge --squash`, ensuring the Git tree hash matches the built binaries exactly.
   - Push `master`, then create and push an annotated version tag on that commit.
6. **Publish to GitHub**:
   - Draft English Release notes outlining Highlights, Compatibility / Migration Notes, and test coverage figures.
   - Run the publishing script to create a draft, upload assets, verify downloads, and publish as Latest:
     ```bash
     bun run release:publish -- --version <tag> --platforms <comma-separated-platforms> --notes-file <notes-file> --directory <staging-directory>
     ```
7. **Align `dev` branch**:
   - Once the release is published and verified, confirm `git diff dev master --quiet`.
   - Fast-forward `dev` via `git reset --hard master` and push with `git push --force-with-lease origin dev`.

---

<div align="center">

[← Prev: 04 Invariants](04-invariants.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#05-development-workflow-and-quality-gates) · [Next: 06 Recipes →](06-modification-guide.md)

</div>
