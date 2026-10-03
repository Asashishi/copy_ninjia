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
| `bun run start` | Start long polling | Production environment entry point |
| `bun run lint`<br>`bun run lint:fix` | ESLint check / auto-fix | Strict code convention checks; quality gates always use uncached `lint` |
| `bun run lint:fast` | Local cached ESLint | With `--cache`, for local edit loop only |
| `bun run typecheck` | TypeScript type check | `tsc --noEmit --incremental`, fully strict mode, incremental cache in `tsconfig.tsbuildinfo` |
| `bun run test` | Full test suite | Forced file isolation (`bun test --isolate`) |
| `bun run test:random` | Random-order test suite | Fixed-seed random-order test suite to expose cross-test residue and mock leaks |
| `bun run test:coverage` | Tests + coverage | Run full test suite and measure all-source coverage metrics |
| `bun run check:install-script-syntax` | Install script syntax check | `bash -n` parses `install.sh` and its declared shell modules without executing them |
| `bun run check:install-isolation` | Installer isolation verification | Runs real `install.sh` fixtures in dedicated temporary root, verifying rollback, interrupted resumption, backup retention, and credential isolation |
| `bun run check:conventions` | Repository convention check | Runs `scripts/checkProjectConventions.ts`, validating constants, cache ownership, links, and architectural boundaries |
| `bun run check` | **Full integration gate** | Syntax + install isolation + conventions + lint + typecheck + coverage + random tests + hot-path gate (required before merge to `master`) |
| `bun run check:coverage` | Coverage metrics reconciliation | Verifies metrics across trilingual READMEs, docs, and SVG badges match real readings |
| `bun run test:fault-injection` | Deterministic fault-injection suite | Verifies recovery consistency across process crashes, abnormal exits, database interruptions, and Worker respawns |
| `bun run perf:hot-paths` | Hot-path standalone measurement | Measures individual hot-path scenario (supports `--profile` sampling analysis) |
| `bun run perf:hot-path-gate` | **Hot-path performance gate** | Memory/GC/JIT hard gate over 12 selected hot-path scenarios (included in `check`) |
| `bun run perf:join-log` | Join-log performance benchmark | Standalone process benchmark for 250k join-log capacity/snapshot/append accounting |
| `bun run perf:identity-database` | Identity database benchmark | Standalone process benchmark for 6 cold/hot read and write operations in identity database |
| `bun run perf:full` | Full performance benchmark suite | 6 sections × 3 rounds in independent child processes (`--write-doc` writes back to 09 benchmark doc) |
| `bun run perf:review` | Targeted performance review | Covers hot spots, AI reply/payload/voice encoding, full command chains, and Disk I/O Worker pressure |
| `bun run build -- --version <tag>` | Build binary package | Requires explicit version with no prefix; produces `dist/` archive and SHA-256 |
| `bun run release:check -- --version <tag>` | Pre-release full validation | frozen lockfile + check + coverage check + fault injection + binary build verification |
| `bun run release:build -- --version <tag>` | Build release package | Natively builds the current platform's binary on clean `dev`; build other platforms in their matching environments |
| `bun run release:verify -- --version <tag> --platforms <list>` | Release package verification | Verifies archives, SHA-256, version, and Git tree consistency across declared platforms |
| `bun run release:publish -- --version <tag> --platforms <list> --notes-file <file>` | Publish to GitHub | Verifies remote references, creates draft, uploads and verifies assets, publishes as Latest |
| `bun run audit:release` | Dependency security audit | Scans dependencies for vulnerabilities (moderate and above) |

---

## Quality-Gate Definitions

- **Isolated installer startup**: Fixtures use separate temporary configuration and data roots, mock system management, dependency installation, and network outbound calls, and execute real `index.ts`, Workers, and shutdown persistence. Each Worker installs a network stub through Bun `preload`: weather receives a canned response, and other requests are rejected; tests verify stubs loaded, polling succeeded, SIGTERM drained work, and the lock file was cleaned up.
- **File length and scan scope**: Handwritten TS, JS, and shell files over 1,024 lines fail; files over 512 lines require a split review. Checks include tracked files and new unstaged files, while Git-ignored deployment data stays outside the scan. Installer syntax checks cover `install.sh` and all shell modules it declares.
- **The coverage denominator includes all source code**: `bun run check` adds every production runtime module to the denominator. Modules untouched by any test count as 0% covered; both function and line coverage thresholds are 95%. Adding an untested module directly lowers global coverage.
- **ESLint + fully strict tsc**: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, and `noUnusedParameters` are all enabled; `any` is forbidden in production code (exempted in tests).
- **Separate type imports**: Source code, scripts, and tests use standalone `import type` declarations; ESLint's `no-restricted-syntax` rejects inline type specifiers such as `import { value, type Shape }`.
- **Explicit type annotations are lint-enforced**: In production code (`index.ts`, `packages/`, `scripts/`), variables, parameters, and destructuring are enforced by `@typescript-eslint/typedef`, and function/callback return types by `@typescript-eslint/explicit-function-return-type` — neither accepts contextual inference. TypeScript forbids annotating `for...of` / `for...in` loop variables, so the rule skips them automatically; consts whose initializer is an arrow function are also exempt. Test files are not subject to this rule.
- **Convention checks (`check:conventions`)**:
  - **Structure and links**: Checks code placement, local Markdown links, existence of files listed in directory maps, and execution permissions of tracked files.
  - **Boundary isolation**: Verifies constant and cache ownership (`packages/cache/<owner>/` thread-single-property boundary), and validates Worker and Telegram capability isolation against the real module graph.
  - **Call safety**: Every timer in `packages/workers/` must be `unref()`ed; verifies Node API compatibility modules and `Buffer` allowlists; enforces `Bun.argv` for argument reading.
  - **Gate reconciliation**: Statically verifies Telegram prompt cleanup exemptions, active cold migration entries, fault-injection suite manifests, direct dependencies in `package.json`, 14 declared coverage metric locations, and performance records. Numeric constant assertions in tests cannot compare against raw literals.

---

### Dependency Release-Age Gate

Dependency installation always uses the 7-day release-age gate in `bunfig.toml` (`minimumReleaseAge = 604800`):
- Exact versions younger than 7 days may receive a temporary package-specific exemption only after informed user approval and verification of upstream source, npm integrity, and install scripts; the exemption is removed immediately after installation, recording package name, reason, and removal time.
- The Bun runtime and `@types/bun` are both pinned to 1.4.2; `packageManager` and `install.sh` jointly pin the runtime version.
- `bun run typecheck` uses the TypeScript 7.0.2 compiler provided by `@typescript/native` (`npm:typescript@~7.0.2`). The `typescript` dependency uses `npm:@typescript/typescript6@^6.0.2`, resolved in the lockfile to `@typescript/typescript6` 6.0.2; through `@typescript/old`, it provides the TypeScript 6.0.3 compiler API for ESLint and convention checks. Current `typescript-eslint` is 8.70.1.

---

### Bun Runtime Boundaries

- **Runtime mode**: The project sets `run.bun = true` in `bunfig.toml`, so dependency CLIs with a Node shebang also run under the current Bun.
- **Image transcoding**: Uses Bun's built-in `Bun.Image` for transcoding (`packages/infra/image.ts`):
  - JPEG/PNG pass through as-is; WebP/GIF convert to PNG with transparency preserved; GIF takes the first frame; animated WebP repackages its first `ANMF` frame as a static WebP before decoding.
  - Capped at `VISION_TRANSCODE_MAX_PIXELS` (8K UHD, 7680×4320); oversized images are rejected before allocation. Codecs ship with Bun runtime with no native C++ module dependencies.
- **Native file I/O**: File content writes and deletions prioritize `Bun.write` and `Bun.file`; exclusive writes use `Bun.write(Bun.file(handle.fd), content)` with fsync and atomic rename; directory traversal, paths, synchronous persistence, permissions, and hard links use `node:` compatibility modules.
- **Performance calibration**: After a runtime upgrade, performance calibrations must be remeasured against the same Bun version/revision.

---

### Measurements for This Documentation Version

`bun run test:coverage`: **5920 tests / 502 files / 320978 `expect()` calls**; full-source **function coverage 98.14% / line coverage 98.54%**. The Coverage badge in each project README displays line coverage.

---

## Test Isolation

Tests must run through `bun run test` (which invokes `bun test --isolate`), protected by four layers of automatic isolation:

1. **File context isolation**: Bun creates a fresh global object for every test file; `mock.module` and module-level global state never pollute across files.
2. **Temporary data root injection**: `test/preloadEnv.ts` injects an independent temporary data root (`mktemp -d`) for each isolate before any production module loads; real file I/O never touches production directories (`state.json`, `bot.lock`, `logs/`, `memory/`, `database/`), automatically cleaned up after tests.
3. **Dedicated configuration root**: Copies `config_example/` completely into `config/` under the temporary data root and directs `COPY_NINJIA_CONFIG_ROOT` to the copy; placeholder credentials are automatically replaced with test values.
4. **Configuration snapshots**: `test/preload.ts` adopts `agent.json`, `ad_samples.json`, `mood.json`, `stickers.json`, Bot atmosphere and time zone, and persona copies from the test root into the isolate's holders once, simulating main-thread message injection.

### Key Test Suite Distribution

- **Installation and upgrade tests**: `test/scripts/installStartup.test.ts`, `test/scripts/installMigration.test.ts` verify install scripts, new database initialization, and major-version upgrades.
- **Cold migration tests**: `test/scripts/migrateChatPersonaRemoval.test.ts` verifies that only the 16.3.2 schema v11 lineages are accepted, the v11 → v13 database migration (including the Asia/Tokyo time-zone marker), and production startup validation before and after migration.
- **Media and outbound tests**: `test/aiChat/ai/mediaAdmission.test.ts`, `test/aiChat/ai/imageDescription.test.ts`, and `test/infra/telegramWorkerCapabilities.test.ts` verify multimodal recognition and Telegram duplex outbound gates.
- **Unified outbound integration tests**: `test/infra/telegramOutboundIntegration.test.ts` uses real client initialization, throttling, and outbound gates, replacing only the innermost network responses. It verifies same-chat FIFO across the main thread, contexts, both Workers, and cron; category-local 429 replays; target queries; shared backoff for default-avatar and file downloads; cancellation; and shutdown drains.
- **Security and logger tests**: `test/infra/loggerSecurity.test.ts` verifies credential redaction.

---

## Fault-Injection Suite

`bun run test:fault-injection` covers application/Worker lifecycles, lockdown recovery, reply capacity and cancellation, credential snapshots, Telegram outbound and delayed deletion shutdown drains, chat teardown, join-log unacknowledged mirrors and disposal receipts, Anti-Raid task draining and verification recovery, duplex Worker respawn cancellation, SQLite startup row validation, cold migrations, and Disk I/O inspection, atomic writes, and recovery faults; see [`package.json`](../../package.json) for the complete manifest.

- **Convention checks**: `check:conventions` checks registered harnesses and production recovery/lifecycle boundaries against real reference paths.
- **Welcome copy and notices**: `test/workers/antiRaid/verificationWelcome.test.ts` exercises the real duplex protocol, main-thread ephemeral messages, and deletion boundaries.
- **`/wed` interaction state machine**: Verifies the 25-group capacity ceiling, teardown queue cancellation, avatar fetching, and shutdown draining.

---

## Hot-Path Gate

`bun run perf:hot-path-gate` is a hard gate in `bun run check`. It launches two independent child processes per scenario in `HOT_PATH_PROFILE_SCENARIOS` under `packages/consts/performance.ts`:
- `steadyProfile`: Measures GC pause time percentage and JIT tiers under `BUN_JSC_logGC=1` in formal loops.
- `retained`: Measures real RSS peak, heapUsed peak, and post-full-GC retained memory without profiler interference.

### Gate Metrics and Tiers

- **GC pause budget**: Automatically tiered by CPU core count (25% for >= 4 cores, 30% for 2–3 cores, 35% for single-core). Exceeding budget by 5 percentage points fails the gate.
- **Hard metric gates**: GC pause time ratio, sampled RSS peak and lifecycle RSS high watermark, sampled heapUsed growth, post-full-GC heap/object retention, DFG/FTL compilation stability.
- **Recording results**: Baseline calibration records are saved in [`performance-result.json`](../../performance-result.json). Use `--write-result` to write back current readings.

---

## Join-Log Performance Benchmark

`bun run perf:join-log` benchmarks 250,000 capacity, `FLUSH_MAX_ENTRIES` (256) overflow, and 10,000 warmup entries; snapshot (`snapshot`), capacity (`capacity`), and append-accounting (`append-accounting`) paths run 5 independent Bun processes per baseline/current, comparing checksums and verifying throughput and heap behavior.

---

## Identity-Database Performance Benchmark

`bun run perf:identity-database` benchmarks six real operations in temporary data roots and SQLite: dual-table reads (cold/hot), 128-row transaction writes (cold/hot), main-thread 8,192-item LRU hot reads, and write-through pipelines. The write-through scenario runs 65,536 operations with a 4,096 primary-key working set.

---

## Targeted Scenarios and Transport Stress Validation

`bun run perf:review` provides targeted in-depth review of specific system bottlenecks:
- `--hot-paths`: Covers 12 scenarios including senders, message sliding windows, permission reads, AI active windows, pending verification snapshots.
- `--ai`: Measures reply admission decisions, normal sending, capacity stress, Base64 transcoding, and Opus voice encoding.
- `--chains`: Runs `ad-detect-command`, `ai-reply-command`, and `cron-send-voice` complete command chains.
- `--worker`: Stress-tests batched writes, graceful shutdown, and 25-group recovery via real Disk I/O Worker.
- `--cooldown` / `--text`: Dedicated benchmarks for cooldown tables and text sanitization. Cooldown scenarios distribute identities across `STATE_MANAGED_CHAT_LIMIT` chats, use production capacity and windows, and cover hits, renewal, growth, saturated rejection, and batch expiry.
- `bun run perf:disk-transport`: Measures single-batch ACKs, normal draining, and capacity rejection mechanisms.

---

## Full Performance Benchmark

`bun run perf:full` runs only during releases and on explicit instruction, with no failure thresholds, averaging three independent child process rounds across six sections:
1. **Cold start**: Startup recovery duration on full-database fixtures.
2. **Production hot paths**: High-frequency path duration for messages entering ingress and completing dispatch.
3. **End-to-end persistence**: Receipt duration from main thread through Worker to disk flush.
4. **SQLite and main-thread caches**: Database and LRU cache interactions.
5. **Containers and algorithms**: Core state containers and computation time.
6. **Join-log capacity line**: Join-log processing performance at 250,000 entries scale.

All data is written to `performance/` at the repository root (automatically cleaned up); `--write-doc` writes results back to `docs/{cn,en,ja}/10-performance.md` and `performance-result.json`.

---

## Commit Workflow

1. **Branch principle**: Development must occur on `dev`; direct commits to `master` are strictly prohibited.
2. **Pre-commit checks**: Run `git diff --stat` to confirm no unintended files; run `git branch --show-current` to confirm current branch.
3. **Local full gate**: Before merge, run and pass `bun run check`; when touching persistence, shutdown, or Worker lifecycles, `bun run test:fault-injection` must pass.
4. **Commit message conventions**: Follow Conventional Commits style (e.g. `feat(ai): ...`, `fix(runtime): ...`, `docs: ...`).

### Updating README Metrics

Only when the user explicitly requests documentation or metric synchronization, update the following locations from the current gate's measured output:
```bash
bun run test:coverage 2>&1 | tail -5          # test count, file count, expect() count
bun run test:coverage 2>&1 | grep 'All files'  # function/line coverage
```
- **Trilingual README badge lines** (Tests / Coverage).
- **Coverage vector images**: `public/coverage_light.svg` and `public/coverage_dark.svg`.
- **`<img alt>` text in trilingual READMEs**.
- **The "Measurements for This Documentation Version" paragraph in trilingual copies of this document**.

---

## Release

Every release creates a GitHub Release with binary assets in this order:

1. **Version and gates**: Synchronize remote tags and read the Latest Release with `gh release list`. Choose an unused `MAJOR.MINOR.PATCH` tag without a `v` prefix. Finish development on `dev` and pass `bun run check`; also run `bun run test:fault-injection` when persistence, shutdown, or Worker lifecycles change.
2. **Benchmark readings**: Stop this repository's service process and other heavy workloads on the machine. After the gate finishes and the machine is idle, run `bun run perf:full -- --write-doc`. Commit the readings in all three 09 performance pages and `performance-result.json` together with the code on `dev`.
3. **Native build for each platform**: On **each platform declared for this release**, use the same Git tree and Bun version/revision, and run `bun run release:build -- --version <tag>` on clean, committed `dev`. Each run produces only that host platform's archive and `.sha256` file. Collect them in one directory.
4. **Verify collected assets**: On a clean checkout of the same Git tree, verify the complete list of declared platforms. Stop if an asset for any declared platform is missing:
   ```bash
   bun run release:verify -- --version <tag> --platforms <comma-separated-platforms> --directory <collected-directory>
   ```
5. **Merge and remote refs**: Complete the deployment-protection Git checks, merge into `master` with `git merge --squash`, and create one commit. Confirm its Git tree matches the build tree. Push `master`, then create and separately push an annotated version tag on that commit.
6. **Publish and confirm**: Write English notes covering the changes since the previous Latest Release, with Highlights, Compatibility / Migration Notes, and Validation. Run the command below; confirm Latest status, remote refs, and downloaded checksums for every declared asset:
   ```bash
   bun run release:publish -- --version <tag> --platforms <comma-separated-platforms> --notes-file <notes-file> --directory <collected-directory>
   ```
7. **Align `dev`**: Only after the Release is fully confirmed, run `git diff dev master --quiet`, then on `dev` run `git reset --hard master` and `git push --force-with-lease origin dev`. Confirm local and remote `dev` and `master` all point to the same commit.

---

<div align="center">

[← Prev: 04 Invariants](04-invariants.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#05-development-workflow-and-quality-gates) · [Next: 06 Recipes →](06-modification-guide.md)

</div>
