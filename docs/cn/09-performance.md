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

**最近一次全量基准** · Bun 1.3.14 · 3 轮取平均 · 2026-08-19T08:06:09Z · `ready-total` 392.5 ms · `incoming-message-spine` 1,983.8 ns/op · `identity-policy-write` 5,410 ops/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-08-19T08:06:09Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 367,030,415 |
| 进程读入 | 89.15 MiB |
| 进程写出 | 169.60 MiB |
| 块设备读 | 0 B |
| 块设备写 | 184.80 MiB |
| 读系统调用 | 36,309 |
| 写系统调用 | 79,005 |
| mock 根落盘 | 20.99 MiB |
| mock 根文件数 | 140 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
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

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 25 份 AI 记忆快照；进程峰值 RSS 109.41 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 中位延迟 | 吞吐 | 峰值 RSS | GC 后留存 | 波动 |
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

## 链路 · 端到端 durable 耗时

> 每条链路都由主线程生产入口驱动真实 Disk I/O Worker，计时到落盘 durable 回执为止。

| 链路 | 吞吐 | p50 | p95 | p99 | 最大 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `join-log-append` | 313 ops/s | 2.24 ms | 10.14 ms | 15.31 ms | 29.77 ms | 3.91 MiB | ±5.5% |
| `identity-policy-write` | 5,410 ops/s | 25.76 ms | 41.66 ms | 49.77 ms | 60.26 ms | 20.53 MiB | ±1.8% |
| `chat-state-write` | 237 ops/s | 3.21 ms | 11.68 ms | 15.60 ms | 27.04 ms | 3.13 MiB | ±4.5% |
| `ai-memory-snapshot` | 33 ops/s | 31.55 ms | 66.98 ms | 94.65 ms | 108.7 ms | 7.03 MiB | ±8.2% |
| `diagnostic-log` | 298 ops/s | 2.38 ms | 10.96 ms | 14.82 ms | 31.86 ms | 4.16 MiB | ±1.8% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 吞吐 | 批次延迟 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| `main-lru-read` | 24,380,841 ops/s | 0.000 ms | 0 B | 5.27 KiB | ±2.5% |
| `main-write-through-acked` | 5,747 ops/s | 22.27 ms | 61.91 MiB | -1.46 MiB | ±0.6% |
| `storage-read-hot-connection` | 27,450 ops/s | 0.292 ms | 4.83 MiB | -1.51 MiB | ±2.1% |
| `storage-read-cold-connection` | 10,890 ops/s | 0.736 ms | 2.67 MiB | 260.13 KiB | ±3.6% |
| `storage-write-hot-connection` | 6,245 ops/s | 20.50 ms | 67.68 MiB | -1.39 MiB | ±1.1% |
| `storage-write-cold-connection` | 5,617 ops/s | 22.87 ms | 8.91 MiB | 242.52 KiB | ±6.1% |

## 容器与算法

> 生产选用的容器与算法：滑动窗口用 `LinkedQueue` + `trimSlidingWindow`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 中位延迟 | 吞吐 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| `linked-timestamp-window` | 35.0 ns/op | 28,769,422 ops/s | 155.39 MiB | 21.64 KiB | ±7.9% |
| `bounded-rolling-buffer` | 33.1 ns/op | 30,529,867 ops/s | 107.60 MiB | 24.53 KiB | ±9.9% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| `snapshot` | 183.8 ms | 1.39 MiB | 4.92 KiB | ±1.9% |
| `capacity` | 44.18 ms | 0 B | -9.71 KiB | ±4.6% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
