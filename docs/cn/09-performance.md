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

**最近一次全量基准** · Bun 1.3.14 · 3 轮取平均 · 2026-08-19T06:31:16Z · `ready-total` 432.6 ms · `incoming-message-spine` 2,001.0 ns/op · `identity-policy-write` 5,302 ops/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU | Intel Xeon E312xx (Sandy Bridge) × 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-08-19T06:31:16Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 385,240,415 |
| 进程读入 | 89.15 MiB |
| 进程写出 | 169.60 MiB |
| 块设备读 | 0 B |
| 块设备写 | 184.80 MiB |
| 读系统调用 | 36,369 |
| 写系统调用 | 79,016 |
| mock 根落盘 | 20.98 MiB |
| mock 根文件数 | 140 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
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

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 25 份 AI 记忆快照；进程峰值 RSS 109.23 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 中位延迟 | 吞吐 | 峰值 RSS | GC 后留存 | 波动 |
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

## 链路 · 端到端 durable 耗时

> 每条链路都由主线程生产入口驱动真实 Disk I/O Worker，计时到落盘 durable 回执为止。

| 链路 | 吞吐 | p50 | p95 | p99 | 最大 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `join-log-append` | 337 ops/s | 2.13 ms | 8.63 ms | 14.08 ms | 25.59 ms | 3.91 MiB | ±5.3% |
| `identity-policy-write` | 5,302 ops/s | 26.08 ms | 43.09 ms | 60.36 ms | 93.42 ms | 20.53 MiB | ±2.3% |
| `chat-state-write` | 201 ops/s | 3.42 ms | 14.10 ms | 20.01 ms | 27.45 ms | 3.13 MiB | ±15.3% |
| `ai-memory-snapshot` | 28 ops/s | 35.76 ms | 82.62 ms | 105.0 ms | 111.7 ms | 7.03 MiB | ±18.3% |
| `diagnostic-log` | 257 ops/s | 2.72 ms | 12.21 ms | 17.93 ms | 34.16 ms | 4.16 MiB | ±15.4% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 吞吐 | 批次延迟 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| `main-lru-read` | 20,684,355 ops/s | 0.000 ms | 0 B | 8.30 KiB | ±19.2% |
| `main-write-through-acked` | 5,597 ops/s | 22.87 ms | 61.91 MiB | -1.46 MiB | ±0.5% |
| `storage-read-hot-connection` | 26,872 ops/s | 0.298 ms | 4.83 MiB | -1.51 MiB | ±4.1% |
| `storage-read-cold-connection` | 9,983 ops/s | 0.807 ms | 2.67 MiB | 276.96 KiB | ±8.1% |
| `storage-write-hot-connection` | 5,789 ops/s | 22.28 ms | 67.68 MiB | -1.39 MiB | ±8.5% |
| `storage-write-cold-connection` | 5,729 ops/s | 22.35 ms | 8.91 MiB | 243.39 KiB | ±1.9% |

## 实现对照 · 容器与算法选型

> 同一件事的两种实现对照，只在选型时有意义；这些不是线上跑的代码。

| 实现 | 中位延迟 | 吞吐 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| `array-timestamp-window` | 23.4 ns/op | 43,009,728 ops/s | 82.48 MiB | 23.71 KiB | ±6.8% |
| `float64-timestamp-window` | 21.2 ns/op | 47,312,909 ops/s | 82.29 MiB | 26.24 KiB | ±6.6% |
| `array-timestamp-cold` | 152.6 ns/op | 6,634,511 ops/s | 93.33 MiB | 691.32 KiB | ±11.5% |
| `float64-timestamp-cold` | 174.2 ns/op | 5,944,271 ops/s | 95.13 MiB | 769.29 KiB | ±19.6% |
| `linked-timestamp-window` | 42.9 ns/op | 23,587,150 ops/s | 152.98 MiB | 22.76 KiB | ±11.0% |
| `linked-rolling-buffer` | 66.6 ns/op | 15,009,074 ops/s | 134.64 MiB | 20.97 KiB | ±1.2% |
| `bounded-rolling-buffer` | 30.5 ns/op | 32,786,499 ops/s | 108.06 MiB | 25.14 KiB | ±1.6% |

## 入群日志 · 25 万容量线

> `current` 是当前实现，`baseline` 固化优化前的整表复制与排序，只作测量参照。

| 对照点 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| `snapshot:current` | 192.7 ms | 1.40 MiB | 4.92 KiB | ±3.6% |
| `snapshot:baseline` | 424.0 ms | 9.91 MiB | -384.47 KiB | ±1.5% |
| `capacity:current` | 50.32 ms | 0 B | -6.57 KiB | ±5.3% |
| `capacity:baseline` | 64.84 ms | 26.72 MiB | 702 B | ±10.0% |

> 复现：`bun run perf:full`（仅发布与明确指令时运行）。数据全部落在仓库 `performance/` 下且不进 Git，配置读 `config_example/`，跑完即删。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
