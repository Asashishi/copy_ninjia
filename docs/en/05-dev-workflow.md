# 05 Development Workflow and Quality Gates

<p align="center">
  <a href="../05-dev-workflow.md">简体中文</a> · <b>English</b> · <a href="../ja/05-dev-workflow.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 Developer Docs Home</a> · <a href="04-invariants.md">← Prev: 04 Invariants</a> · <a href="06-modification-guide.md">Next: 06 Recipes →</a>
</p>

---

## Command Reference

| Command | Purpose |
| :--- | :--- |
| `bun run start` | Start long polling |
| `bun run lint` / `lint:fix` | Run ESLint / apply automatic fixes |
| `bun run typecheck` | Run `tsc --noEmit` in fully strict mode |
| `bun run test` | Run the complete test suite with forced file isolation |
| `bun run test:coverage` | Run tests and measure coverage across all source files |
| `bun run check:conventions` | Check repository conventions with `scripts/checkProjectConventions.ts` |
| `bun run check` | Run conventions + lint + typecheck + coverage; **required before every commit** |
| `bun run test:fault-injection` | Run the deterministic fault-injection suite |
| `bun run release:check` | Run frozen-lockfile install + check + fault injection; required before release |
| `bun run audit:release` | Audit dependencies for moderate-or-higher vulnerabilities |

## Quality-Gate Definitions

- **The coverage denominator includes all source code**: `bun run check` adds every production runtime module to the denominator. Modules untouched by any test count as 0% covered. Both function and line coverage must remain at least 90%, so adding an untested module directly lowers global coverage.
- **ESLint + fully strict tsc**: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, and `noUnusedParameters` are all enabled. `any` is forbidden in production code but exempted in tests.
- **Explicit type annotations are lint-enforced**: in production code (`index.ts`, `packages/`, `scripts/`), variables, parameters, and destructuring must be annotated via `@typescript-eslint/typedef`, and function and callback return types via `@typescript-eslint/explicit-function-return-type` — neither accepts contextual inference. TypeScript forbids annotating `for...of` / `for...in` loop variables, so the rule skips them automatically; consts whose initializer is already an arrow function are also exempt. Test files are not subject to this.
- **Convention checks**: `check:conventions` checks code placement, local Markdown targets, and executable permissions on tracked non-script files before lint runs.

### Measurements for This Documentation Version

`bun run test:coverage`: **1200 tests / 142 files / 9443 `expect()` calls**; full-source **function coverage 94.82% / line coverage 96.52%**. The root README's Coverage badge displays line coverage.

## Test Isolation

Tests must run through `bun run test`, which invokes `bun test --isolate`, with two layers of protection:

1. **File isolation**: Bun creates a fresh global object for every test file, so `mock.module` and module-level state do not contaminate other files. `--parallel` is not enabled, so this project does not claim that every file gets a separate process.
2. **Temporary data root**: before any production module loads, `test/preload.ts` injects an independent temporary data root for each isolate. Even real, unmocked file I/O can read or write only that temporary directory and never production `state.json`, `bot.lock`, `logs/`, or `memory/`. The directory is removed afterward.

Direct `bun test` runs are acceptable for debugging a single file, but the complete `bun run check` must pass before merge.

### Test-Writing Conventions

- Mirror `packages/` paths: `packages/foo/bar.ts` → `test/foo/bar.test.ts`.
- Shared helpers belong in `test/libs/helpers.ts`. Do not share mutable module state across tests; isolation can conceal such mistakes until someone runs without `--isolate`.
- Tests that exercise real file I/O are safe because the preload provides a temporary data root. Still, watch mock boundaries around `infra/storage`: mocking only `infra/diskIO` while leaving `infra/storage` real can reach the real `saveStateInBackground`, which is exactly the situation where [`AGENTS.md`](../../AGENTS.md) requires backing up runtime files first.

## Fault-Injection Suite

`bun run test:fault-injection` concentrates on crash recovery and persistence boundaries: lifecycle failure, update-runner acknowledgement boundaries, StateStore and cleanup, AI/Anti-Raid Worker mirrors and lifecycles, Disk I/O append/snapshot/log files, flush barriers, and more. See the scripts in [`package.json`](../../package.json) for the complete list. This suite must pass whenever a changed path is covered by [04 Authoritative Runtime Invariants](04-invariants.md).

## Commit Workflow

1. Develop on the `dev` branch and never commit straight to `master`; merge into `master` with a squash so one change set becomes one commit. See “分支与提交” in [`AGENTS.md`](../../AGENTS.md) for the branch rules, which are not repeated here.
2. Users may adjust parameters while development is in progress. Reread files before editing so uncommitted work is not overwritten.
3. Review the complete `git diff --stat` before committing, and keep unrelated files out of the commit.
4. Make sure `bun run check` passes.
5. Use Conventional Commits style—`feat(ai): ...`, `fix(runtime): ...`, `docs: ...`—with an English subject line.
6. Every commit is stored only after joint human/AI review, following the project convention described in the root README's “Pure AI Development” section.

### Updating README Metrics

The root README badges and the test, assertion, and coverage figures above are measured values. Update them after changes to tests, production modules, or the coverage definition:

```bash
bun run test:coverage 2>&1 | tail -5           # test count, file count, expect() count
bun run test:coverage 2>&1 | grep 'All files'  # function and line coverage
```

Synchronize the Tests/Coverage badges in all three READMEs; [`docs/assets/coverage_light.svg`](../assets/coverage_light.svg) and [`coverage_dark.svg`](../assets/coverage_dark.svg), referenced from the “Project Quality” block in each README's “Pure AI Development” section—one pair is shared by all three READMEs (like the banner), so both theme files need the new figures, as does the equivalent `<img alt>` text in all three READMEs (the graphic loads as an image, so the SVG's own `<title>`/`aria-label` never reaches a screen reader and the alt is the only accessible path); and “Measurements for This Documentation Version” in all three workflow documents. These all carry the same measured figures, so updating one obliges updating every one. The Coverage badge always uses the `All files` line-coverage value. Behavioral figures such as probabilities, capacities, and durations must stay aligned with `packages/consts/`; see [06 Common Modification Recipes](06-modification-guide.md#adjusting-behavioral-parameters).

## Release

This repository does not rely on GitHub Actions. Release environments should make `bun run release:check` an explicit build or pre-deploy step. Networked environments should additionally run `bun run audit:release`; network failure means the audit was not completed, not that there are zero vulnerabilities. Any ignored CVE needs a recorded reason and expiration date. For releases with persistence-structure changes, first follow the migration process in [06 Common Modification Recipes](06-modification-guide.md#changing-a-persistence-schema).

Every squash merge into `master` must produce one GitHub Release:

1. Synchronize remote tags and read the current Latest Release tag through `gh release list`. Tags must use `MAJOR.MINOR.PATCH` without a `v` prefix. Select the version from the highest semantic impact in the complete change set: increment `MAJOR` for a breaking change (`1.0.9` → `2.0.0`), `MINOR` for backward-compatible functionality (`1.0.9` → `1.1.0`), and `PATCH` only for fixes, performance work, refactoring, or documentation (`1.0.9` → `1.0.10`).
2. After pushing the `master` squash commit, create and push an immutable annotated version tag for that commit. Never overwrite, move, or reuse an existing tag.
3. Create an English Release with `gh release create <tag> --verify-tag --target master ...`. Release notes must cover only the delta from the previous Latest Release tag to the current `master`, with at least Highlights, Compatibility / Migration Notes, and Validation. Gate metrics must come from the current run.
4. If the tag push succeeded but Release creation failed, retry the same tag instead of incrementing again. Align `dev` with `master` as described in [`AGENTS.md`](../../AGENTS.md) only after `master`, the tag, and the Release are all confirmed.

---

<div align="center">

[← Prev: 04 Invariants](04-invariants.md) · [📚 Developer Docs Home](README.md) · [⬆️ Back to Top](#05-development-workflow-and-quality-gates) · [Next: 06 Recipes →](06-modification-guide.md)

</div>
