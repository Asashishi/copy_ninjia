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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-06T07:31:56Z · Process start to local recovery ready 477.0 ms · Route one group message through base dispatch 1.379 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.24 ms / 745 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.70 ms / 152 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-138-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-06T07:31:56Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 385,931,405 |
| Process reads | 121.27 MiB |
| Process writes | 178.32 MiB |
| Block-device reads | 0 B |
| Block-device writes | 197.80 MiB |
| Read syscalls | 39,953 |
| Write syscalls | 85,158 |
| Mock root on disk | 16.24 MiB |
| Mock root files | 163 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 136.4 ms | ±5.9% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 16.56 ms | ±1.2% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 763.6 µs | ±11.3% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.54 ms | ±10.4% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 6.73 ms | ±12.9% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 853.8 µs | ±4.4% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 287.7 ms | ±5.3% |
| Populate main-thread hot caches<br><code>hydrate</code> | 575.3 µs | ±7.7% |
| Process start to local recovery ready<br><code>ready-total</code> | 477.0 ms | ±4.8% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 111.30 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.379 µs | 733,269 ops/s | 82.04 MiB | 26.05 KiB | ±10.5% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 168.3 ns | 5,955,016 ops/s | 86.49 MiB | 23.20 KiB | ±4.8% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 11.3 ns | 89,046,511 ops/s | 72.54 MiB | 21.90 KiB | ±7.7% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 24.3 ns | 41,100,851 ops/s | 72.79 MiB | 21.63 KiB | ±1.6% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.7 ns | 1,482,498,941 ops/s | 71.46 MiB | 23.35 KiB | ±5.6% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 56.1 ns | 17,859,965 ops/s | 74.42 MiB | 23.19 KiB | ±3.4% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.2 ns | 238,264,288 ops/s | 72.59 MiB | 23.38 KiB | ±7.9% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 12.6 ns | 79,589,945 ops/s | 73.47 MiB | 22.91 KiB | ±0.1% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 52.6 ns | 19,337,169 ops/s | 74.27 MiB | 19.93 KiB | ±13.4% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 12.85 µs | 77,979 ops/s | 96.10 MiB | 24.52 KiB | ±4.2% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 110.8 ns | 9,025,855 ops/s | 79.81 MiB | 22.56 KiB | ±2.0% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 35.2 ns | 28,928,915 ops/s | 80.83 MiB | 23.80 KiB | ±13.5% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 53.0 ns | 18,885,108 ops/s | 74.76 MiB | 18.60 KiB | ±1.3% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 394.8 ns | 2,544,270 ops/s | 119.02 MiB | 5.63 MiB | ±6.5% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 445.1 ns | 2,254,845 ops/s | 133.70 MiB | 19.38 KiB | ±6.0% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.8 ns | 207,510,272 ops/s | 73.22 MiB | 21.06 KiB | ±7.2% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.199 µs | 192,566 ops/s | 82.33 MiB | 24.30 KiB | ±3.3% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 132.8 ns | 7,584,970 ops/s | 114.39 MiB | 24.49 KiB | ±8.5% |
| Build one AI context message<br><code>buffered-message-build</code> | 315.3 ns | 3,173,010 ops/s | 100.06 MiB | 27.10 KiB | ±2.3% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 54.83 µs | 18,240 ops/s | 95.55 MiB | 21.32 KiB | ±1.4% |
| Extract a reply reference<br><code>reply-reference</code> | 24.5 ns | 40,902,456 ops/s | 81.88 MiB | 23.37 KiB | ±4.7% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 74.5 ns | 13,428,641 ops/s | 84.17 MiB | 22.83 KiB | ±3.0% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 8.7 ns | 174,344,475 ops/s | 78.35 MiB | 21.57 KiB | ±71.8% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 33.3 ns | 30,363,652 ops/s | 80.71 MiB | 20.46 KiB | ±9.8% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 26.4 ns | 38,669,615 ops/s | 72.68 MiB | 21.64 KiB | ±15.2% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 12.1 ns | 82,577,468 ops/s | 75.68 MiB | 21.69 KiB | ±3.4% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 85.3 ns | 11,766,556 ops/s | 74.23 MiB | 23.29 KiB | ±5.7% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 391 ops/s | 2.56 ms | 2.00 ms | 5.22 ms | 24.02 ms | 391 records/s | 3.91 MiB | ±5.2% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 75 ops/s | 13.26 ms | 13.44 ms | 23.84 ms | 78.64 ms | 9,655 records/s | 20.53 MiB | ±2.1% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 309 ops/s | 3.25 ms | 2.59 ms | 7.58 ms | 19.04 ms | 309 records/s | 3.15 MiB | ±5.7% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 327 ops/s | 3.05 ms | 2.53 ms | 5.54 ms | 24.00 ms | 327 records/s | 3.13 MiB | ±2.8% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 308 ops/s | 3.26 ms | 2.66 ms | 6.51 ms | 18.21 ms | 308 records/s | 3.13 MiB | ±5.9% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 176 ops/s | 5.72 ms | 4.73 ms | 12.13 ms | 25.90 ms | 176 records/s | 11.72 MiB | ±7.7% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 390 ops/s | 2.56 ms | 2.08 ms | 4.38 ms | 24.18 ms | 390 records/s | 4.16 MiB | ±1.9% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 152 ops/s | 6.59 ms | 5.70 ms | 13.37 ms | 22.94 ms | 152 records/s | 1.83 MiB | ±2.7% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 745 ops/s | 1.33 ms | 1.24 ms | 2.29 ms | 2.65 ms | 745 records/s | 0 B | ±3.8% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 26,697,095 ops/s | 300.1 ns | 0 B | 7.26 KiB | ±3.8% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,735 ops/s | 11.92 ms | 61.90 MiB | 30.60 KiB | ±0.5% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 42,646 ops/s | 187.6 µs | 4.86 MiB | 58.21 KiB | ±0.7% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,005 ops/s | 615.5 µs | 2.70 MiB | 274.92 KiB | ±2.3% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 10,331 ops/s | 12.39 ms | 67.73 MiB | 149.87 KiB | ±1.9% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,851 ops/s | 14.47 ms | 9.00 MiB | 195.02 KiB | ±2.5% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.9 ns | 59,201,592 ops/s | 81.54 MiB | 23.39 KiB | ±2.1% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 40.8 ns | 24,749,007 ops/s | 74.41 MiB | 21.92 KiB | ±10.4% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 18.0 ns | 55,787,387 ops/s | 81.13 MiB | 24.66 KiB | ±5.8% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 151.6 ms | 2.00 MiB | 5.00 KiB | ±3.6% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 28.14 ms | 0 B | -4.94 KiB | ±2.0% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
