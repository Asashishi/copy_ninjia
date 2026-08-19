# 09 Performance Benchmark

<p align="center">
  <a href="../cn/09-performance.md">简体中文</a> · <b>English</b> · <a href="../ja/09-performance.md">日本語</a>
</p>

<p align="center">
  <a href="conntent-table.md">📚 Documentation home</a> · <a href="08-commands.md">← Prev: 08 Command Reference</a> · <b>Next: none →</b>
</p>

---

The figures on this page are produced by `bun run perf:full -- --write-doc`, rerun once per release
and replaced as a whole. Do not hand-edit anything between the two markers below, and never update
only one of the three languages.

The benchmark runs on release and on explicit request only; it is not part of `bun run check`. The
hard GC/RSS/JIT gate for hot paths lives in `bun run perf:hot-path-gate` — see
[05 Development Workflow and Quality Gates](05-dev-workflow.md).

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.3.14 · 3-run mean · 2026-08-19T06:31:16Z · `ready-total` 432.6 ms · `incoming-message-spine` 2,001.0 ns/op · `identity-policy-write` 5,302 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU | Intel Xeon E312xx (Sandy Bridge) × 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-08-19T06:31:16Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 385,240,415 |
| Process reads | 89.15 MiB |
| Process writes | 169.60 MiB |
| Block-device reads | 0 B |
| Block-device writes | 184.80 MiB |
| Read syscalls | 36,369 |
| Write syscalls | 79,016 |
| Mock root on disk | 20.98 MiB |
| Mock root files | 140 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| `module-graph` | 154.6 ms | ±14.5% |
| `instance-lock` | 51.62 ms | ±61.8% |
| `orphan-cleanup` | 1.28 ms | ±24.7% |
| `state-load` | 2.23 ms | ±17.9% |
| `deployment-inputs` | 4.89 ms | ±13.2% |
| `disk-io-init` | 0.505 ms | ±12.4% |
| `persisted-load` | 164.6 ms | ±16.4% |
| `hydrate` | 1.03 ms | ±14.2% |
| `ready-total` | 432.6 ms | ±12.4% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 25 AI memory snapshots; process peak RSS 109.23 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Median latency | Throughput | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| `incoming-message-spine` | 2,001.0 ns/op | 499,819 ops/s | 114.79 MiB | 28.65 KiB | ±1.2% |
| `sender-no-username` | 12.3 ns/op | 81,458,512 ops/s | 79.96 MiB | 22.24 KiB | ±0.8% |
| `sender-stable-username` | 30.2 ns/op | 33,528,998 ops/s | 80.00 MiB | 19.31 KiB | ±10.8% |
| `self-sent-empty` | 0.7 ns/op | 1,796,194,987 ops/s | 78.41 MiB | 21.29 KiB | ±43.0% |
| `chat-state-read` | 4.2 ns/op | 237,882,699 ops/s | 79.04 MiB | 20.93 KiB | ±1.2% |
| `chat-state-map-read` | 15.8 ns/op | 63,348,198 ops/s | 80.39 MiB | 20.26 KiB | ±2.1% |
| `ai-activity-window` | 54.0 ns/op | 18,506,791 ops/s | 82.50 MiB | 20.29 KiB | ±0.5% |
| `ai-activity-lru-miss` | 9,876.2 ns/op | 101,266 ops/s | 159.17 MiB | 24.17 KiB | ±1.1% |
| `identity-permission-read` | 100.6 ns/op | 9,970,895 ops/s | 90.04 MiB | 17.55 KiB | ±5.2% |
| `flood-window-hit` | 53.9 ns/op | 18,541,049 ops/s | 83.48 MiB | 18.78 KiB | ±0.5% |
| `flood-window-growth` | 513.9 ns/op | 1,950,673 ops/s | 138.36 MiB | 5.78 MiB | ±4.9% |
| `flood-window-steady` | 537.7 ns/op | 1,860,591 ops/s | 168.40 MiB | 31.47 MiB | ±2.2% |
| `ad-empty-metadata` | 4.5 ns/op | 221,725,284 ops/s | 80.40 MiB | 20.66 KiB | ±7.9% |
| `ad-wire-clone` | 5,467.7 ns/op | 182,961 ops/s | 146.36 MiB | -1.87 MiB | ±1.9% |
| `ad-capacity-reject` | 213.2 ns/op | 4,827,879 ops/s | 146.67 MiB | 24.11 KiB | ±17.5% |
| `buffered-message-build` | 715.2 ns/op | 1,399,214 ops/s | 118.96 MiB | 22.97 KiB | ±2.7% |
| `transcript-render` | 77,497.5 ns/op | 12,906 ops/s | 130.49 MiB | -1.87 MiB | ±1.5% |
| `reply-reference` | 24.6 ns/op | 40,700,033 ops/s | 108.88 MiB | 22.93 KiB | ±2.2% |
| `mention-facts` | 109.1 ns/op | 9,164,019 ops/s | 124.09 MiB | 20.60 KiB | ±1.5% |
| `mention-facts-plain` | 4.0 ns/op | 253,182,260 ops/s | 87.38 MiB | 20.44 KiB | ±4.4% |
| `gag-speak-counter` | 37.3 ns/op | 26,902,630 ops/s | 107.53 MiB | 20.69 KiB | ±5.1% |
| `luck-receipt-fast-path` | 39.0 ns/op | 25,711,681 ops/s | 105.78 MiB | 20.67 KiB | ±6.0% |
| `luck-tier-table` | 13.3 ns/op | 75,615,641 ops/s | 83.71 MiB | 18.97 KiB | ±7.9% |
| `redact-clean-log` | 91.2 ns/op | 11,019,628 ops/s | 81.62 MiB | 22.10 KiB | ±6.9% |

## Chains · end-to-end durability

> Every chain is driven through its main-thread production entry against a real Disk I/O Worker, timed until the durable acknowledgement.

| Chain | Throughput | p50 | p95 | p99 | Max | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `join-log-append` | 337 ops/s | 2.13 ms | 8.63 ms | 14.08 ms | 25.59 ms | 3.91 MiB | ±5.3% |
| `identity-policy-write` | 5,302 ops/s | 26.08 ms | 43.09 ms | 60.36 ms | 93.42 ms | 20.53 MiB | ±2.3% |
| `chat-state-write` | 201 ops/s | 3.42 ms | 14.10 ms | 20.01 ms | 27.45 ms | 3.13 MiB | ±15.3% |
| `ai-memory-snapshot` | 28 ops/s | 35.76 ms | 82.62 ms | 105.0 ms | 111.7 ms | 7.03 MiB | ±18.3% |
| `diagnostic-log` | 257 ops/s | 2.72 ms | 12.21 ms | 17.93 ms | 34.16 ms | 4.16 MiB | ±15.4% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Throughput | Batch latency | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| `main-lru-read` | 20,684,355 ops/s | 0.000 ms | 0 B | 8.30 KiB | ±19.2% |
| `main-write-through-acked` | 5,597 ops/s | 22.87 ms | 61.91 MiB | -1.46 MiB | ±0.5% |
| `storage-read-hot-connection` | 26,872 ops/s | 0.298 ms | 4.83 MiB | -1.51 MiB | ±4.1% |
| `storage-read-cold-connection` | 9,983 ops/s | 0.807 ms | 2.67 MiB | 276.96 KiB | ±8.1% |
| `storage-write-hot-connection` | 5,789 ops/s | 22.28 ms | 67.68 MiB | -1.39 MiB | ±8.5% |
| `storage-write-cold-connection` | 5,729 ops/s | 22.35 ms | 8.91 MiB | 243.39 KiB | ±1.9% |

## Implementation comparison · containers and algorithms

> Two implementations of the same job, meaningful only when choosing between them; this is not production code.

| Implementation | Median latency | Throughput | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| `array-timestamp-window` | 23.4 ns/op | 43,009,728 ops/s | 82.48 MiB | 23.71 KiB | ±6.8% |
| `float64-timestamp-window` | 21.2 ns/op | 47,312,909 ops/s | 82.29 MiB | 26.24 KiB | ±6.6% |
| `array-timestamp-cold` | 152.6 ns/op | 6,634,511 ops/s | 93.33 MiB | 691.32 KiB | ±11.5% |
| `float64-timestamp-cold` | 174.2 ns/op | 5,944,271 ops/s | 95.13 MiB | 769.29 KiB | ±19.6% |
| `linked-timestamp-window` | 42.9 ns/op | 23,587,150 ops/s | 152.98 MiB | 22.76 KiB | ±11.0% |
| `linked-rolling-buffer` | 66.6 ns/op | 15,009,074 ops/s | 134.64 MiB | 20.97 KiB | ±1.2% |
| `bounded-rolling-buffer` | 30.5 ns/op | 32,786,499 ops/s | 108.06 MiB | 25.14 KiB | ±1.6% |

## Join log · 250k capacity line

> `current` is today's implementation; `baseline` freezes the pre-optimisation whole-table copy and sort as a reference.

| Case | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| `snapshot:current` | 192.7 ms | 1.40 MiB | 4.92 KiB | ±3.6% |
| `snapshot:baseline` | 424.0 ms | 9.91 MiB | -384.47 KiB | ±1.5% |
| `capacity:current` | 50.32 ms | 0 B | -6.57 KiB | ±5.3% |
| `capacity:baseline` | 64.84 ms | 26.72 MiB | 702 B | ±10.0% |

> Reproduce with `bun run perf:full` (release and explicit request only). All data lives under the untracked `performance/` directory, configuration is read from `config_example/`, and the tree is removed afterwards.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](conntent-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
