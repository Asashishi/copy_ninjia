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

**Latest full benchmark** · Bun 1.3.14 · 3-run mean · 2026-08-19T08:06:09Z · `ready-total` 392.5 ms · `incoming-message-spine` 1,983.8 ns/op · `identity-policy-write` 5,410 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-08-19T08:06:09Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 367,030,415 |
| Process reads | 89.15 MiB |
| Process writes | 169.60 MiB |
| Block-device reads | 0 B |
| Block-device writes | 184.80 MiB |
| Read syscalls | 36,309 |
| Write syscalls | 79,005 |
| Mock root on disk | 20.99 MiB |
| Mock root files | 140 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| `module-graph` | 143.2 ms | ±1.9% |
| `instance-lock` | 30.87 ms | ±19.3% |
| `orphan-cleanup` | 0.884 ms | ±11.1% |
| `state-load` | 1.91 ms | ±17.1% |
| `deployment-inputs` | 4.42 ms | ±13.7% |
| `disk-io-init` | 0.525 ms | ±13.2% |
| `persisted-load` | 163.3 ms | ±7.2% |
| `hydrate` | 0.940 ms | ±18.1% |
| `ready-total` | 392.5 ms | ±3.9% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 25 AI memory snapshots; process peak RSS 109.41 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Median latency | Throughput | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| `incoming-message-spine` | 1,983.8 ns/op | 504,162 ops/s | 114.67 MiB | 28.31 KiB | ±1.2% |
| `sender-no-username` | 13.7 ns/op | 73,582,912 ops/s | 80.41 MiB | 20.70 KiB | ±7.4% |
| `sender-stable-username` | 32.4 ns/op | 31,224,265 ops/s | 80.17 MiB | 21.15 KiB | ±10.8% |
| `self-sent-empty` | 0.7 ns/op | 1,392,133,368 ops/s | 78.04 MiB | 22.05 KiB | ±11.8% |
| `chat-state-read` | 4.4 ns/op | 228,497,199 ops/s | 79.08 MiB | 20.77 KiB | ±5.4% |
| `chat-state-map-read` | 16.3 ns/op | 61,533,830 ops/s | 80.05 MiB | 21.01 KiB | ±2.9% |
| `ai-activity-window` | 60.1 ns/op | 16,725,942 ops/s | 82.74 MiB | 20.44 KiB | ±7.9% |
| `ai-activity-lru-miss` | 10,438.3 ns/op | 96,198 ops/s | 158.12 MiB | 23.89 KiB | ±6.4% |
| `identity-permission-read` | 121.7 ns/op | 8,253,940 ops/s | 89.16 MiB | 20.00 KiB | ±6.7% |
| `flood-window-hit` | 54.0 ns/op | 18,594,936 ops/s | 83.87 MiB | 19.51 KiB | ±6.6% |
| `flood-window-growth` | 497.3 ns/op | 2,012,937 ops/s | 137.50 MiB | 5.78 MiB | ±3.1% |
| `flood-window-steady` | 563.2 ns/op | 1,779,972 ops/s | 143.27 MiB | 21.27 KiB | ±4.9% |
| `ad-empty-metadata` | 5.8 ns/op | 183,154,585 ops/s | 80.83 MiB | 20.88 KiB | ±21.7% |
| `ad-wire-clone` | 5,389.3 ns/op | 185,852 ops/s | 145.92 MiB | -1.86 MiB | ±4.0% |
| `ad-capacity-reject` | 214.3 ns/op | 4,718,897 ops/s | 146.18 MiB | 23.05 KiB | ±10.5% |
| `buffered-message-build` | 768.7 ns/op | 1,301,082 ops/s | 119.70 MiB | 23.25 KiB | ±1.0% |
| `transcript-render` | 74,319.5 ns/op | 13,458 ops/s | 126.58 MiB | -1.86 MiB | ±1.4% |
| `reply-reference` | 24.8 ns/op | 40,888,955 ops/s | 109.07 MiB | 22.91 KiB | ±12.0% |
| `mention-facts` | 114.8 ns/op | 8,726,816 ops/s | 124.02 MiB | 20.62 KiB | ±4.7% |
| `mention-facts-plain` | 4.0 ns/op | 247,441,531 ops/s | 86.58 MiB | 20.74 KiB | ±3.6% |
| `gag-speak-counter` | 38.7 ns/op | 25,878,997 ops/s | 107.37 MiB | 20.56 KiB | ±3.3% |
| `luck-receipt-fast-path` | 36.0 ns/op | 27,860,245 ops/s | 106.13 MiB | 20.89 KiB | ±5.6% |
| `luck-tier-table` | 13.8 ns/op | 72,839,280 ops/s | 84.58 MiB | 20.08 KiB | ±6.4% |
| `redact-clean-log` | 85.1 ns/op | 11,756,600 ops/s | 81.61 MiB | 21.41 KiB | ±1.7% |

## Chains · end-to-end durability

> Every chain is driven through its main-thread production entry against a real Disk I/O Worker, timed until the durable acknowledgement.

| Chain | Throughput | p50 | p95 | p99 | Max | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `join-log-append` | 313 ops/s | 2.24 ms | 10.14 ms | 15.31 ms | 29.77 ms | 3.91 MiB | ±5.5% |
| `identity-policy-write` | 5,410 ops/s | 25.76 ms | 41.66 ms | 49.77 ms | 60.26 ms | 20.53 MiB | ±1.8% |
| `chat-state-write` | 237 ops/s | 3.21 ms | 11.68 ms | 15.60 ms | 27.04 ms | 3.13 MiB | ±4.5% |
| `ai-memory-snapshot` | 33 ops/s | 31.55 ms | 66.98 ms | 94.65 ms | 108.7 ms | 7.03 MiB | ±8.2% |
| `diagnostic-log` | 298 ops/s | 2.38 ms | 10.96 ms | 14.82 ms | 31.86 ms | 4.16 MiB | ±1.8% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Throughput | Batch latency | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| `main-lru-read` | 24,380,841 ops/s | 0.000 ms | 0 B | 5.27 KiB | ±2.5% |
| `main-write-through-acked` | 5,747 ops/s | 22.27 ms | 61.91 MiB | -1.46 MiB | ±0.6% |
| `storage-read-hot-connection` | 27,450 ops/s | 0.292 ms | 4.83 MiB | -1.51 MiB | ±2.1% |
| `storage-read-cold-connection` | 10,890 ops/s | 0.736 ms | 2.67 MiB | 260.13 KiB | ±3.6% |
| `storage-write-hot-connection` | 6,245 ops/s | 20.50 ms | 67.68 MiB | -1.39 MiB | ±1.1% |
| `storage-write-cold-connection` | 5,617 ops/s | 22.87 ms | 8.91 MiB | 242.52 KiB | ±6.1% |

## Containers and algorithms

> The containers and algorithms production actually runs on: sliding windows use `LinkedQueue` + `trimSlidingWindow`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Median latency | Throughput | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| `linked-timestamp-window` | 35.0 ns/op | 28,769,422 ops/s | 155.39 MiB | 21.64 KiB | ±7.9% |
| `bounded-rolling-buffer` | 33.1 ns/op | 30,529,867 ops/s | 107.60 MiB | 24.53 KiB | ±9.9% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| `snapshot` | 183.8 ms | 1.39 MiB | 4.92 KiB | ±1.9% |
| `capacity` | 44.18 ms | 0 B | -9.71 KiB | ±4.6% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](conntent-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
