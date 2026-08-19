# 09 性能基准

<p align="center">
  <b>简体中文</b> · <a href="../en/09-performance.md">English</a> · <a href="../ja/09-performance.md">日本語</a>
</p>

<p align="center">
  <a href="conntent-table.md">📚 开发者文档首页</a> · <a href="08-commands.md">← 上一页：08 命令与行为参考</a> · <b>下一页：无 →</b>
</p>

---

本页的读数由 `bun run perf:full -- --write-doc` 生成，每次发布重跑一次并整块覆盖。
下面两个标记之间的内容不要手工编辑，也不要只更新三种语言中的一份。

基准本身只在发布和明确指令时运行，不属于 `bun run check`；热路径的 GC/RSS/JIT 硬门禁由
`bun run perf:hot-path-gate` 单独承担，见 [05 开发流程与质量门禁](05-dev-workflow.md)。

<!-- performance-benchmark:start -->

**最近一次全量基准** · Bun 1.3.14 · 3 轮取平均 · 2026-08-19T13:20:15Z · `ready-total` 349.0 ms · `incoming-message-spine` 1,893.5 ns/op · `identity-policy-write` 64 条完整链路/s（落盘）

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-08-19T13:20:15Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 367,030,605 |
| 进程读入 | 89.13 MiB |
| 进程写出 | 170.29 MiB |
| 块设备读 | 0 B |
| 块设备写 | 186.63 MiB |
| 读系统调用 | 35,211 |
| 写系统调用 | 80,515 |
| mock 根落盘 | 22.07 MiB |
| mock 根文件数 | 152 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
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

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 25 份 AI 记忆快照；进程峰值 RSS 110.04 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 中位延迟 | 吞吐 | 峰值 RSS | GC 后留存 | 波动 |
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

## 链路 · 端到端 durable 耗时

> 每条链路都由主线程生产入口驱动真实 Disk I/O Worker，计时到落盘 durable 回执为止。「完整链路/s」是每秒能把多少条命令送到落盘回执，是唯一可以跨行比较的吞吐；「记录/s」是其中承载的业务记录数，批量链路会成倍高于前者。`ad-detect-command` 与 `ai-reply-command` 量的是一条群消息走完整条命令：模型判定/生成与 Telegram 出站都由进程内罐头就地应答，因此读数里没有任何网络往返，只有进程内工作与磁盘——除网络之外的每一步都在计时窗口里。`ai-reply-command` 另外扣掉了发送前那段拟人停顿（1.5 秒起步、每字 55 毫秒、上限 7.5 秒）：它按群计、CPU 空转，同一时刻别的群照跑，算进来报出的就不是处理能力而是这段刻意设定的节奏。扣除量按每条实际发生的停顿实测，不是估算。

| 链路 | 完整链路/s | 记录/s | p50 | p95 | p99 | 最大 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `join-log-append` | 372 ops/s | 372 records/s | 2.08 ms | 5.34 ms | 11.87 ms | 29.56 ms | 3.91 MiB | ±5.1% |
| `identity-policy-write` | 64 ops/s | 8,143 records/s | 16.62 ms | 26.22 ms | 31.08 ms | 41.70 ms | 20.53 MiB | ±2.2% |
| `chat-state-write` | 310 ops/s | 310 records/s | 2.72 ms | 5.50 ms | 12.12 ms | 14.69 ms | 3.13 MiB | ±2.0% |
| `ai-memory-snapshot` | 193 ops/s | 193 records/s | 4.61 ms | 8.32 ms | 14.47 ms | 23.94 ms | 7.03 MiB | ±1.7% |
| `diagnostic-log` | 373 ops/s | 373 records/s | 2.19 ms | 4.78 ms | 11.54 ms | 16.90 ms | 4.16 MiB | ±2.0% |
| `ad-detect-command` | 142 ops/s | 142 records/s | 6.26 ms | 12.18 ms | 20.37 ms | 21.95 ms | 1.83 MiB | ±0.8% |
| `ai-reply-command` | 616 ops/s | 616 records/s | 1.50 ms | 2.49 ms | 3.07 ms | 3.07 ms | 0 B | ±4.3% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 吞吐 | 批次延迟 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| `main-lru-read` | 26,190,480 ops/s | 0.000 ms | 0 B | 7.82 KiB | ±7.3% |
| `main-write-through-acked` | 8,475 ops/s | 15.11 ms | 61.91 MiB | -1.46 MiB | ±1.2% |
| `storage-read-hot-connection` | 28,512 ops/s | 0.281 ms | 4.83 MiB | -1.51 MiB | ±4.7% |
| `storage-read-cold-connection` | 11,626 ops/s | 0.689 ms | 2.67 MiB | 268.13 KiB | ±2.5% |
| `storage-write-hot-connection` | 7,323 ops/s | 17.49 ms | 67.68 MiB | -1.39 MiB | ±2.4% |
| `storage-write-cold-connection` | 6,851 ops/s | 18.72 ms | 8.91 MiB | 249.53 KiB | ±4.4% |

## 容器与算法

> 生产选用的容器与算法：滑动窗口用 `LinkedQueue` + `trimSlidingWindow`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 中位延迟 | 吞吐 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| `linked-timestamp-window` | 43.0 ns/op | 24,003,425 ops/s | 154.72 MiB | 22.43 KiB | ±18.1% |
| `bounded-rolling-buffer` | 31.8 ns/op | 31,907,766 ops/s | 108.40 MiB | 26.79 KiB | ±12.8% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| `snapshot` | 171.3 ms | 1.39 MiB | 5.29 KiB | ±6.8% |
| `capacity` | 43.52 ms | 0 B | -5.67 KiB | ±4.7% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
