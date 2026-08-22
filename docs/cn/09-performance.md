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

**最近一次全量基准** · Bun 1.4.0 · 3 轮取平均 · 2026-08-22T14:39:18Z · 进程启动到本地恢复就绪 353.2 ms · 单条群消息进入主干并完成基础分发 2.167 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.13 ms / 785 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 5.41 ms / 157 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-08-22T14:39:18Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 369,130,605 |
| 进程读入 | 90.92 MiB |
| 进程写出 | 170.29 MiB |
| 块设备读 | 0 B |
| 块设备写 | 186.66 MiB |
| 读系统调用 | 32,465 |
| 写系统调用 | 80,529 |
| mock 根落盘 | 11.30 MiB |
| mock 根文件数 | 149 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 136.2 ms | ±3.4% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 28.13 ms | ±43.9% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 768.8 µs | ±19.7% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.72 ms | ±12.2% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.20 ms | ±18.6% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 1.08 ms | ±18.3% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 157.2 ms | ±28.8% |
| 填充主线程热缓存<br><code>hydrate</code> | 1.45 ms | ±77.8% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 353.2 ms | ±16.0% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 25 份 AI 记忆快照；进程峰值 RSS 91.51 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 2.167 µs | 462,296 次/s | 83.17 MiB | 24.63 KiB | ±4.1% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 160.2 ns | 6,252,976 次/s | 79.05 MiB | 22.98 KiB | ±3.8% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 7.6 ns | 404,171,266 次/s | 67.13 MiB | 21.78 KiB | ±61.7% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 26.1 ns | 38,309,172 次/s | 67.78 MiB | 21.32 KiB | ±1.4% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.7 ns | 1,480,919,574 次/s | 66.44 MiB | 21.85 KiB | ±1.8% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.7 ns | 214,288,242 次/s | 67.09 MiB | 21.31 KiB | ±10.9% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 13.7 ns | 73,210,417 次/s | 67.46 MiB | 21.59 KiB | ±4.7% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 52.6 ns | 19,015,660 次/s | 69.75 MiB | 18.30 KiB | ±0.5% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 13.06 µs | 76,759 次/s | 88.25 MiB | 24.83 KiB | ±5.1% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 90.0 ns | 11,140,720 次/s | 72.71 MiB | 22.71 KiB | ±5.0% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 50.0 ns | 20,106,215 次/s | 69.79 MiB | 19.91 KiB | ±7.0% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 492.9 ns | 2,029,437 次/s | 110.05 MiB | 5.63 MiB | ±1.5% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 412.7 ns | 2,425,309 次/s | 120.96 MiB | 20.47 KiB | ±3.0% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 6.6 ns | 175,361,311 次/s | 67.44 MiB | 20.63 KiB | ±41.7% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 6.178 µs | 163,623 次/s | 74.72 MiB | -2.04 MiB | ±10.4% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 113.0 ns | 8,872,010 次/s | 105.79 MiB | 23.57 KiB | ±5.0% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 731.4 ns | 1,367,221 次/s | 82.21 MiB | 23.63 KiB | ±0.6% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 56.19 µs | 17,801 次/s | 87.14 MiB | -2.05 MiB | ±1.2% |
| 提取回复引用<br><code>reply-reference</code> | 26.9 ns | 37,639,667 次/s | 77.81 MiB | 24.18 KiB | ±10.0% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 109.2 ns | 9,189,245 次/s | 79.82 MiB | 22.89 KiB | ±5.8% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 9.3 ns | 166,314,117 次/s | 72.29 MiB | 22.56 KiB | ±71.9% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 37.2 ns | 27,155,746 次/s | 74.10 MiB | 19.25 KiB | ±10.0% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 28.4 ns | 35,185,317 次/s | 73.29 MiB | 22.84 KiB | ±3.1% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 12.4 ns | 81,619,808 次/s | 70.81 MiB | 21.59 KiB | ±11.9% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 77.4 ns | 12,956,192 次/s | 69.35 MiB | 21.43 KiB | ±4.8% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前五行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 315 次/s | 4.46 ms | 4.48 ms | 9.22 ms | 61.86 ms | 315 条记录/s | 3.91 MiB | ±44.5% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 76 次/s | 13.25 ms | 12.89 ms | 24.56 ms | 40.83 ms | 9,707 条记录/s | 20.53 MiB | ±7.1% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 322 次/s | 3.10 ms | 2.54 ms | 5.28 ms | 19.73 ms | 322 条记录/s | 3.13 MiB | ±4.2% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 34 次/s | 29.70 ms | 32.95 ms | 54.43 ms | 72.73 ms | 34 条记录/s | 7.03 MiB | ±1.7% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 391 次/s | 2.56 ms | 2.08 ms | 4.68 ms | 34.40 ms | 391 条记录/s | 4.16 MiB | ±4.2% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 157 次/s | 6.37 ms | 5.41 ms | 13.91 ms | 23.16 ms | 157 条记录/s | 1.83 MiB | ±5.1% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 785 次/s | 1.26 ms | 1.13 ms | 1.99 ms | 2.84 ms | 785 条记录/s | 0 B | ±5.0% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 24,492,161 次/s | 328.9 ns | 0 B | 8.54 KiB | ±8.4% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 10,977 次/s | 11.68 ms | 61.90 MiB | -1.62 MiB | ±3.5% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 42,359 次/s | 189.0 µs | 4.83 MiB | -1.64 MiB | ±2.6% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 13,378 次/s | 600.2 µs | 2.67 MiB | 257.12 KiB | ±6.2% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 10,206 次/s | 12.54 ms | 67.68 MiB | -1.51 MiB | ±1.6% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 8,598 次/s | 14.92 ms | 8.95 MiB | 225.04 KiB | ±4.5% |

## 容器与算法

> 生产选用的容器与算法：滑动窗口用 `LinkedQueue` + `trimSlidingWindow`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 滑动时间窗口追加与过期淘汰<br><code>linked-timestamp-window</code> | 54.0 ns | 18,528,761 次/s | 102.40 MiB | 23.21 KiB | ±1.0% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 27.7 ns | 37,584,778 次/s | 74.02 MiB | 25.82 KiB | ±21.0% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 188.2 ms | 2.17 MiB | 4.88 KiB | ±6.6% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 33.02 ms | 0 B | -4.88 KiB | ±7.6% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
