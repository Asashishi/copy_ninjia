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

**Latest full benchmark** · Bun 1.3.14 · 3-run mean · 2026-08-19T13:20:15Z · `ready-total` 349.0 ms · `incoming-message-spine` 1,893.5 ns/op · `identity-policy-write` 64 durable chains/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-08-19T13:20:15Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 367,030,605 |
| Process reads | 89.13 MiB |
| Process writes | 170.29 MiB |
| Block-device reads | 0 B |
| Block-device writes | 186.63 MiB |
| Read syscalls | 35,211 |
| Write syscalls | 80,515 |
| Mock root on disk | 22.07 MiB |
| Mock root files | 152 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| `module-graph` | 130.7 ms | ±3.0% |
| `instance-lock` | 22.68 ms | ±2.8% |
| `orphan-cleanup` | 0.791 ms | ±18.0% |
| `state-load` | 2.02 ms | ±19.5% |
| `deployment-inputs` | 4.85 ms | ±18.9% |
| `disk-io-init` | 0.614 ms | ±33.2% |
| `persisted-load` | 144.3 ms | ±6.6% |
| `hydrate` | 0.846 ms | ±29.0% |
| `ready-total` | 349.0 ms | ±3.4% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 25 AI memory snapshots; process peak RSS 110.04 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Median latency | Throughput | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| `incoming-message-spine` | 1,893.5 ns/op | 528,292 ops/s | 114.33 MiB | 28.79 KiB | ±1.8% |
| `sender-no-username` | 12.3 ns/op | 81,132,408 ops/s | 79.87 MiB | 20.41 KiB | ±0.6% |
| `sender-stable-username` | 27.0 ns/op | 37,039,262 ops/s | 80.70 MiB | 20.48 KiB | ±3.3% |
| `self-sent-empty` | 0.6 ns/op | 1,965,877,099 ops/s | 78.58 MiB | 21.19 KiB | ±28.6% |
| `chat-state-read` | 4.0 ns/op | 249,919,011 ops/s | 78.67 MiB | 22.41 KiB | ±2.8% |
| `chat-state-map-read` | 16.5 ns/op | 60,969,929 ops/s | 80.42 MiB | 21.45 KiB | ±7.2% |
| `ai-activity-window` | 57.1 ns/op | 17,529,288 ops/s | 82.79 MiB | 20.01 KiB | ±2.9% |
| `ai-activity-lru-miss` | 10,911.9 ns/op | 92,173 ops/s | 157.82 MiB | 24.13 KiB | ±7.7% |
| `identity-permission-read` | 95.8 ns/op | 10,444,193 ops/s | 90.43 MiB | 20.32 KiB | ±3.0% |
| `flood-window-hit` | 55.5 ns/op | 18,019,927 ops/s | 83.95 MiB | 21.39 KiB | ±2.4% |
| `flood-window-growth` | 521.1 ns/op | 1,927,093 ops/s | 139.85 MiB | 5.78 MiB | ±6.6% |
| `flood-window-steady` | 455.7 ns/op | 2,196,636 ops/s | 144.50 MiB | 20.81 KiB | ±3.1% |
| `ad-empty-metadata` | 4.8 ns/op | 211,088,445 ops/s | 80.71 MiB | 20.75 KiB | ±10.9% |
| `ad-wire-clone` | 5,603.6 ns/op | 179,035 ops/s | 146.06 MiB | -1.86 MiB | ±5.7% |
| `ad-capacity-reject` | 193.1 ns/op | 5,211,348 ops/s | 147.13 MiB | 23.85 KiB | ±7.9% |
| `buffered-message-build` | 707.5 ns/op | 1,413,860 ops/s | 121.86 MiB | 21.51 KiB | ±1.6% |
| `transcript-render` | 71,971.4 ns/op | 13,896 ops/s | 129.36 MiB | -1.87 MiB | ±1.2% |
| `reply-reference` | 23.4 ns/op | 42,862,473 ops/s | 109.53 MiB | 22.69 KiB | ±5.6% |
| `mention-facts` | 112.4 ns/op | 8,932,680 ops/s | 123.67 MiB | 19.39 KiB | ±6.5% |
| `mention-facts-plain` | 4.0 ns/op | 251,772,350 ops/s | 86.71 MiB | 22.14 KiB | ±2.2% |
| `gag-speak-counter` | 37.3 ns/op | 27,131,080 ops/s | 107.54 MiB | 20.32 KiB | ±11.0% |
| `luck-receipt-fast-path` | 36.6 ns/op | 27,390,926 ops/s | 105.83 MiB | 21.23 KiB | ±4.6% |
| `luck-tier-table` | 12.7 ns/op | 79,062,170 ops/s | 84.33 MiB | 21.01 KiB | ±3.2% |
| `redact-clean-log` | 83.1 ns/op | 12,049,184 ops/s | 81.50 MiB | 20.29 KiB | ±3.3% |

## Chains · end-to-end durability

> Every chain is driven through its main-thread production entry against a real Disk I/O Worker, timed until the durable acknowledgement. "Full chains/s" is how many commands per second reach that durable acknowledgement and is the only throughput comparable across rows; "Records/s" counts the business records they carry, which batched chains multiply. `ad-detect-command` and `ai-reply-command` time one group message through the whole command: model calls and Telegram traffic are answered by in-process canned replies, so these numbers contain no network round trip at all — only in-process work and disk, with every step except the network inside the timing window. `ai-reply-command` additionally subtracts the human-like pause before sending (1.5s base, 55ms per character, capped at 7.5s): it is per-chat pacing that burns no CPU and blocks no other chat, so counting it would report that deliberate rhythm rather than processing capacity. The subtracted `ai-memory-snapshot` throughput is tail-dominated: every operation rewrites a ~46 KiB snapshot in full with two fsyncs, and a single write differs by an order of magnitude depending on whether it lands in page cache or hits a filesystem writeback stall. It runs after the earlier sections and inherits their accumulated writeback pressure, so its round means can differ severalfold (about 185 ops/s when run alone on an idle machine) while its p50 stays steady — read the variation column first and compare that row by p50 rather than throughput. The subtracted amount is measured per operation, not estimated. That chain ends when the reply is sent and carries no durable write: production flushes memory snapshots on a 30-second timer in batches, not once per reply, and that cost is priced separately by `ai-memory-snapshot`.

| Chain | Full chains/s | Records/s | p50 | p95 | p99 | Max | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `join-log-append` | 372 ops/s | 372 records/s | 2.08 ms | 5.34 ms | 11.87 ms | 29.56 ms | 3.91 MiB | ±5.1% |
| `identity-policy-write` | 64 ops/s | 8,143 records/s | 16.62 ms | 26.22 ms | 31.08 ms | 41.70 ms | 20.53 MiB | ±2.2% |
| `chat-state-write` | 310 ops/s | 310 records/s | 2.72 ms | 5.50 ms | 12.12 ms | 14.69 ms | 3.13 MiB | ±2.0% |
| `ai-memory-snapshot` | 193 ops/s | 193 records/s | 4.61 ms | 8.32 ms | 14.47 ms | 23.94 ms | 7.03 MiB | ±1.7% |
| `diagnostic-log` | 373 ops/s | 373 records/s | 2.19 ms | 4.78 ms | 11.54 ms | 16.90 ms | 4.16 MiB | ±2.0% |
| `ad-detect-command` | 142 ops/s | 142 records/s | 6.26 ms | 12.18 ms | 20.37 ms | 21.95 ms | 1.83 MiB | ±0.8% |
| `ai-reply-command` | 616 ops/s | 616 records/s | 1.50 ms | 2.49 ms | 3.07 ms | 3.07 ms | 0 B | ±4.3% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Throughput | Batch latency | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| `main-lru-read` | 26,190,480 ops/s | 0.000 ms | 0 B | 7.82 KiB | ±7.3% |
| `main-write-through-acked` | 8,475 ops/s | 15.11 ms | 61.91 MiB | -1.46 MiB | ±1.2% |
| `storage-read-hot-connection` | 28,512 ops/s | 0.281 ms | 4.83 MiB | -1.51 MiB | ±4.7% |
| `storage-read-cold-connection` | 11,626 ops/s | 0.689 ms | 2.67 MiB | 268.13 KiB | ±2.5% |
| `storage-write-hot-connection` | 7,323 ops/s | 17.49 ms | 67.68 MiB | -1.39 MiB | ±2.4% |
| `storage-write-cold-connection` | 6,851 ops/s | 18.72 ms | 8.91 MiB | 249.53 KiB | ±4.4% |

## Containers and algorithms

> The containers and algorithms production actually runs on: sliding windows use `LinkedQueue` + `trimSlidingWindow`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Median latency | Throughput | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| `linked-timestamp-window` | 43.0 ns/op | 24,003,425 ops/s | 154.72 MiB | 22.43 KiB | ±18.1% |
| `bounded-rolling-buffer` | 31.8 ns/op | 31,907,766 ops/s | 108.40 MiB | 26.79 KiB | ±12.8% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| `snapshot` | 171.3 ms | 1.39 MiB | 5.29 KiB | ±6.8% |
| `capacity` | 43.52 ms | 0 B | -5.67 KiB | ±4.7% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](conntent-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
