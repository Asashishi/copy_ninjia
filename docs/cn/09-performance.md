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

同一次运行还会把**结构化报告全文**写进仓库根被跟踪的 `performance-result.json` 的
`fullSuite.lastRun`：本页是给人看的呈现，那份 JSON 是同一批读数可被程序读取的记录
（环境、分区、逐项均值与变异系数一项不少）。两者由同一个开关写出，不会各自过期。

基准本身只在发布和明确指令时运行，不属于 `bun run check`；热路径的 GC/RSS/JIT 硬门禁由
`bun run perf:hot-path-gate` 单独承担，见 [05 开发流程与质量门禁](05-dev-workflow.md)。

<!-- performance-benchmark:start -->

**最近一次全量基准** · Bun 1.4.0 · 3 轮取平均 · 2026-08-26T16:47:51Z · 进程启动到本地恢复就绪 480.7 ms · 单条群消息进入主干并完成基础分发 2.172 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.02 ms / 911 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 11.33 ms / 87 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-08-26T16:47:51Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 376,131,005 |
| 进程读入 | 115.86 MiB |
| 进程写出 | 171.96 MiB |
| 块设备读 | 0 B |
| 块设备写 | 189.88 MiB |
| 读系统调用 | 38,968 |
| 写系统调用 | 82,267 |
| mock 根落盘 | 17.70 MiB |
| mock 根文件数 | 162 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 147.9 ms | ±14.7% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 24.42 ms | ±18.9% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 818.1 µs | ±14.7% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.82 ms | ±16.8% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.32 ms | ±13.1% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 1.02 ms | ±20.9% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 270.0 ms | ±4.7% |
| 填充主线程热缓存<br><code>hydrate</code> | 2.11 ms | ±94.2% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 480.7 ms | ±1.9% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 105.61 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 2.172 µs | 461,076 次/s | 82.57 MiB | 20.98 KiB | ±3.9% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 153.6 ns | 6,530,347 次/s | 79.04 MiB | 23.21 KiB | ±5.4% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 10.4 ns | 96,077,894 次/s | 66.86 MiB | 20.97 KiB | ±0.6% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 28.1 ns | 36,214,657 次/s | 67.07 MiB | 22.71 KiB | ±13.4% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.7 ns | 1,497,459,119 次/s | 66.05 MiB | 21.54 KiB | ±4.9% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.2 ns | 238,065,467 次/s | 67.00 MiB | 22.92 KiB | ±3.4% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 13.4 ns | 74,876,913 次/s | 67.46 MiB | 20.51 KiB | ±5.0% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 53.6 ns | 19,020,079 次/s | 69.32 MiB | 19.01 KiB | ±14.4% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 12.55 µs | 79,664 次/s | 87.05 MiB | 25.00 KiB | ±0.6% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 93.1 ns | 10,749,959 次/s | 72.72 MiB | 20.92 KiB | ±2.9% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 52.8 ns | 19,063,814 次/s | 69.60 MiB | 21.02 KiB | ±7.7% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 442.9 ns | 2,267,762 次/s | 104.28 MiB | 5.63 MiB | ±6.5% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 499.5 ns | 2,003,994 次/s | 125.57 MiB | 21.20 KiB | ±3.3% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 7.1 ns | 159,442,909 次/s | 67.49 MiB | 20.28 KiB | ±34.8% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.543 µs | 180,470 次/s | 74.94 MiB | -2.06 MiB | ±1.9% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 117.1 ns | 8,626,892 次/s | 105.68 MiB | 23.52 KiB | ±10.1% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 702.0 ns | 1,424,567 次/s | 80.14 MiB | 22.95 KiB | ±0.9% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 54.97 µs | 18,193 次/s | 87.36 MiB | -2.07 MiB | ±0.6% |
| 提取回复引用<br><code>reply-reference</code> | 25.6 ns | 39,075,781 次/s | 78.80 MiB | 23.72 KiB | ±3.1% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 114.9 ns | 8,956,562 次/s | 81.81 MiB | 21.55 KiB | ±17.9% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 9.4 ns | 167,451,206 次/s | 71.78 MiB | 22.05 KiB | ±73.0% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 36.6 ns | 28,023,940 次/s | 74.27 MiB | 21.64 KiB | ±16.3% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 32.9 ns | 30,854,476 次/s | 73.21 MiB | 19.91 KiB | ±12.2% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 12.3 ns | 81,548,976 次/s | 69.10 MiB | 20.27 KiB | ±3.3% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 81.8 ns | 12,345,587 次/s | 68.89 MiB | 20.99 KiB | ±10.4% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前五行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 395 次/s | 2.57 ms | 1.96 ms | 4.95 ms | 78.45 ms | 395 条记录/s | 3.91 MiB | ±12.9% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 77 次/s | 12.97 ms | 13.38 ms | 21.89 ms | 41.71 ms | 9,869 条记录/s | 20.53 MiB | ±1.2% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 312 次/s | 3.24 ms | 2.55 ms | 7.14 ms | 26.98 ms | 312 条记录/s | 3.13 MiB | ±11.0% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 319 次/s | 3.18 ms | 2.55 ms | 6.82 ms | 20.94 ms | 319 条记录/s | 3.13 MiB | ±12.2% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 194 次/s | 5.15 ms | 4.31 ms | 9.60 ms | 27.33 ms | 194 条记录/s | 7.03 MiB | ±2.9% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 363 次/s | 2.78 ms | 2.08 ms | 6.62 ms | 33.47 ms | 363 条记录/s | 4.16 MiB | ±10.9% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 87 次/s | 11.63 ms | 11.33 ms | 25.05 ms | 45.52 ms | 87 条记录/s | 1.83 MiB | ±11.5% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 911 次/s | 1.09 ms | 1.02 ms | 1.85 ms | 2.37 ms | 911 条记录/s | 0 B | ±6.0% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 26,411,869 次/s | 303.3 ns | 0 B | 6.40 KiB | ±3.6% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 10,616 次/s | 12.06 ms | 61.90 MiB | -1.65 MiB | ±1.3% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 40,930 次/s | 195.6 µs | 4.84 MiB | -1.68 MiB | ±2.3% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 13,327 次/s | 600.8 µs | 2.68 MiB | 256.85 KiB | ±3.0% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 9,980 次/s | 12.83 ms | 67.71 MiB | -1.54 MiB | ±1.5% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 8,636 次/s | 14.82 ms | 8.98 MiB | 229.28 KiB | ±1.2% |

## 容器与算法

> 生产选用的容器与算法：有配额上限的滑动窗口用 `TimestampDeque`，没有上限的反刷群入群窗口用 `LinkedQueue` + `trimSlidingWindow`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 15.7 ns | 64,155,745 次/s | 76.05 MiB | 23.27 KiB | ±7.0% |
| 无配额上限的滑动时间窗口追加与过期淘汰<br><code>linked-timestamp-window</code> | 56.0 ns | 17,849,651 次/s | 102.23 MiB | 22.64 KiB | ±1.7% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 17.4 ns | 57,643,626 次/s | 75.15 MiB | 24.99 KiB | ±2.0% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 157.5 ms | 2.57 MiB | 4.88 KiB | ±3.1% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 29.58 ms | 0 B | -5.39 KiB | ±2.6% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
