# 09 Performance Benchmark

<p align="center">
  <a href="../cn/09-performance.md">简体中文</a> · <b>English</b> · <a href="../ja/09-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Documentation home</a> · <a href="08-commands.md">← Prev: 08 Command Reference</a> · <b>Next: none →</b>
</p>

---

The figures on this page are produced by `bun run perf:full -- --write-doc`, rerun once per release
and replaced as a whole. Do not hand-edit anything between the two markers below, and never update
only one of the three languages.

The same run also writes the **complete structured report** into `fullSuite.lastRun` of the
version-tracked `performance-result.json` at the repository root: this page is the human-facing
rendering, that JSON is the machine-readable record of the same readings (environment, sections,
per-item means and coefficients of variation, all of it). One switch writes both, so they cannot go
stale independently.

The benchmark runs on release and on explicit request only; it is not part of `bun run check`. The
hard GC/RSS/JIT gate for hot paths lives in `bun run perf:hot-path-gate` — see
[05 Development Workflow and Quality Gates](05-dev-workflow.md).

See [05 Development Workflow](05-dev-workflow.md#targeted-scenarios-and-transport-stress-validation) for targeted scenarios, `diskTransport`, and their measurement boundaries. Targeted outputs and the hot-path gate are recorded separately and do not replace the generated full-suite block below.

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-09T15:22:44Z · Process start to local recovery ready 507.4 ms · Route one group message through base dispatch 1.256 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.13 ms / 794 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.97 ms / 151 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-138-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-09T15:22:44Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,405 |
| Process reads | 121.50 MiB |
| Process writes | 178.32 MiB |
| Block-device reads | 0 B |
| Block-device writes | 197.80 MiB |
| Read syscalls | 40,107 |
| Write syscalls | 85,190 |
| Mock root on disk | 17.43 MiB |
| Mock root files | 161 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 151.7 ms | ±1.3% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 21.44 ms | ±10.3% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 773.3 µs | ±12.9% |
| Read and strictly parse runtime state<br><code>state-load</code> | 2.05 ms | ±8.8% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 7.39 ms | ±5.4% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 978.5 µs | ±12.9% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 300.2 ms | ±2.0% |
| Populate main-thread hot caches<br><code>hydrate</code> | 658.9 µs | ±17.6% |
| Process start to local recovery ready<br><code>ready-total</code> | 507.4 ms | ±1.7% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 113.76 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.256 µs | 799,627 ops/s | 79.44 MiB | 24.69 KiB | ±6.7% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 164.8 ns | 6,227,105 ops/s | 86.06 MiB | 22.48 KiB | ±15.2% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 18.5 ns | 55,705,692 ops/s | 72.80 MiB | 22.05 KiB | ±17.5% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 39.1 ns | 25,980,079 ops/s | 72.97 MiB | 22.26 KiB | ±12.9% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 49.3 ns | 20,313,713 ops/s | 74.14 MiB | 21.84 KiB | ±4.7% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,174,232,908 ops/s | 71.76 MiB | 20.87 KiB | ±17.5% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 51.4 ns | 19,462,300 ops/s | 74.03 MiB | 22.66 KiB | ±2.4% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.3 ns | 233,634,818 ops/s | 72.33 MiB | 22.00 KiB | ±6.5% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 13.5 ns | 73,985,213 ops/s | 72.89 MiB | 20.79 KiB | ±4.1% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 47.8 ns | 21,025,770 ops/s | 74.22 MiB | 20.97 KiB | ±7.1% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 13.68 µs | 73,209 ops/s | 97.52 MiB | 20.19 KiB | ±3.6% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 119.2 ns | 8,408,366 ops/s | 79.55 MiB | 24.36 KiB | ±4.7% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 49.2 ns | 22,286,783 ops/s | 79.53 MiB | 22.10 KiB | ±26.9% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 53.8 ns | 19,390,570 ops/s | 74.54 MiB | 19.63 KiB | ±22.0% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 456.5 ns | 2,196,522 ops/s | 118.25 MiB | 5.63 MiB | ±5.2% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 489.7 ns | 2,050,665 ops/s | 133.60 MiB | 20.77 KiB | ±6.4% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.3 ns | 231,341,483 ops/s | 73.00 MiB | 21.52 KiB | ±3.0% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.470 µs | 183,261 ops/s | 82.61 MiB | 24.23 KiB | ±4.9% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 124.3 ns | 8,120,457 ops/s | 114.88 MiB | 23.19 KiB | ±9.3% |
| Build one AI context message<br><code>buffered-message-build</code> | 338.2 ns | 2,958,584 ops/s | 98.59 MiB | 26.87 KiB | ±2.6% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 55.66 µs | 17,968 ops/s | 95.36 MiB | 23.96 KiB | ±0.9% |
| Extract a reply reference<br><code>reply-reference</code> | 34.4 ns | 30,777,383 ops/s | 80.65 MiB | 23.28 KiB | ±25.0% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 68.1 ns | 14,714,536 ops/s | 86.21 MiB | 21.36 KiB | ±5.3% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.5 ns | 221,366,798 ops/s | 76.39 MiB | 22.10 KiB | ±4.1% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 33.2 ns | 30,231,285 ops/s | 80.73 MiB | 20.14 KiB | ±7.2% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 26.7 ns | 37,469,522 ops/s | 72.60 MiB | 21.56 KiB | ±2.7% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 12.9 ns | 77,744,168 ops/s | 76.66 MiB | 20.73 KiB | ±3.5% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 80.4 ns | 12,525,216 ops/s | 72.91 MiB | 21.02 KiB | ±8.4% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 364 ops/s | 2.75 ms | 2.10 ms | 6.01 ms | 25.01 ms | 364 records/s | 3.91 MiB | ±2.3% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 72 ops/s | 14.01 ms | 14.38 ms | 24.47 ms | 81.15 ms | 9,154 records/s | 20.53 MiB | ±4.4% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 306 ops/s | 3.29 ms | 2.65 ms | 6.91 ms | 20.03 ms | 306 records/s | 3.15 MiB | ±8.9% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 182 ops/s | 5.55 ms | 4.44 ms | 13.09 ms | 40.87 ms | 182 records/s | 3.13 MiB | ±10.6% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 307 ops/s | 3.25 ms | 2.68 ms | 6.00 ms | 19.37 ms | 307 records/s | 3.13 MiB | ±3.1% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 175 ops/s | 5.70 ms | 4.89 ms | 11.84 ms | 20.17 ms | 175 records/s | 11.72 MiB | ±2.4% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 376 ops/s | 2.66 ms | 2.10 ms | 4.76 ms | 40.65 ms | 376 records/s | 4.16 MiB | ±1.9% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 151 ops/s | 6.65 ms | 5.97 ms | 11.59 ms | 20.92 ms | 151 records/s | 1.83 MiB | ±5.3% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 794 ops/s | 1.25 ms | 1.13 ms | 1.86 ms | 3.48 ms | 794 records/s | 0 B | ±2.8% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 25,270,116 ops/s | 316.9 ns | 0 B | 7.75 KiB | ±3.0% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,193 ops/s | 12.60 ms | 61.90 MiB | 29.25 KiB | ±6.0% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 42,787 ops/s | 187.1 µs | 4.86 MiB | 77.45 KiB | ±2.3% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 12,499 ops/s | 641.5 µs | 2.70 MiB | 285.15 KiB | ±4.7% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 10,291 ops/s | 12.45 ms | 67.73 MiB | 176.09 KiB | ±2.3% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,820 ops/s | 14.52 ms | 9.00 MiB | 220.52 KiB | ±1.9% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.8 ns | 59,812,011 ops/s | 82.29 MiB | 23.51 KiB | ±5.3% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 37.1 ns | 27,068,489 ops/s | 73.84 MiB | 23.26 KiB | ±5.7% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 18.3 ns | 54,935,568 ops/s | 80.72 MiB | 24.50 KiB | ±7.9% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 154.1 ms | 2.21 MiB | 4.96 KiB | ±3.2% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 33.18 ms | 0 B | -4.97 KiB | ±3.9% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
