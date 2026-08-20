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

**最近一次全量基准** · Bun 1.3.14 · 3 轮取平均 · 2026-08-20T15:31:50Z · 进程启动到本地恢复就绪 376.3 ms · 单条群消息进入主干并完成基础分发 1.901 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.35 ms / 640 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 6.55 ms / 129 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-08-20T15:31:50Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 369,130,605 |
| 进程读入 | 89.13 MiB |
| 进程写出 | 170.30 MiB |
| 块设备读 | 0 B |
| 块设备写 | 186.63 MiB |
| 读系统调用 | 35,050 |
| 写系统调用 | 80,533 |
| mock 根落盘 | 22.07 MiB |
| mock 根文件数 | 152 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 136.3 ms | ±5.4% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 50.25 ms | ±60.3% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 962.0 µs | ±3.2% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.97 ms | ±6.1% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.83 ms | ±5.1% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 497.6 µs | ±4.0% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 139.2 ms | ±1.1% |
| 填充主线程热缓存<br><code>hydrate</code> | 791.7 µs | ±24.1% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 376.3 ms | ±7.0% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 25 份 AI 记忆快照；进程峰值 RSS 110.25 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.901 µs | 526,529 次/s | 115.28 MiB | 27.17 KiB | ±3.0% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 127.0 ns | 7,896,694 次/s | 114.50 MiB | 22.54 KiB | ±5.1% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 12.1 ns | 82,505,033 次/s | 79.79 MiB | 20.21 KiB | ±2.6% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 28.4 ns | 35,320,305 次/s | 80.71 MiB | 20.17 KiB | ±4.5% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.7 ns | 1,467,711,548 次/s | 78.28 MiB | 21.90 KiB | ±1.9% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.1 ns | 242,386,719 次/s | 79.58 MiB | 20.79 KiB | ±4.0% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 15.5 ns | 64,644,089 次/s | 80.79 MiB | 20.18 KiB | ±2.3% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 54.0 ns | 18,517,749 次/s | 82.83 MiB | 18.48 KiB | ±1.2% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 10.35 µs | 96,660 次/s | 156.42 MiB | 24.61 KiB | ±1.6% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 95.4 ns | 10,503,117 次/s | 89.89 MiB | 17.20 KiB | ±4.1% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 60.1 ns | 16,821,325 次/s | 83.74 MiB | 17.05 KiB | ±10.2% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 544.3 ns | 1,842,806 次/s | 137.71 MiB | 5.78 MiB | ±5.6% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 499.8 ns | 2,002,639 次/s | 145.72 MiB | 19.80 KiB | ±3.0% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 6.2 ns | 189,749,829 次/s | 80.13 MiB | 18.40 KiB | ±43.3% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.526 µs | 181,025 次/s | 145.95 MiB | -1.87 MiB | ±1.8% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 197.3 ns | 5,101,735 次/s | 147.69 MiB | 23.29 KiB | ±7.9% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 729.7 ns | 1,372,996 次/s | 121.70 MiB | 23.09 KiB | ±4.3% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 60.53 µs | 16,523 次/s | 121.63 MiB | -1.87 MiB | ±1.5% |
| 提取回复引用<br><code>reply-reference</code> | 26.7 ns | 38,677,652 次/s | 109.54 MiB | 22.41 KiB | ±19.1% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 113.9 ns | 8,819,218 次/s | 124.26 MiB | 22.61 KiB | ±6.2% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.5 ns | 229,724,537 次/s | 86.63 MiB | 21.21 KiB | ±16.1% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 35.8 ns | 28,010,807 次/s | 107.94 MiB | 22.31 KiB | ±4.0% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 36.3 ns | 27,623,974 次/s | 106.41 MiB | 20.91 KiB | ±4.3% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 13.2 ns | 76,052,966 次/s | 83.17 MiB | 19.24 KiB | ±2.1% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 84.6 ns | 11,828,044 次/s | 81.71 MiB | 21.22 KiB | ±2.3% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前五行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 400 次/s | 2.50 ms | 1.98 ms | 4.65 ms | 27.44 ms | 400 条记录/s | 3.91 MiB | ±3.2% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 61 次/s | 16.31 ms | 17.02 ms | 27.96 ms | 35.30 ms | 7,848 条记录/s | 20.53 MiB | ±1.8% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 308 次/s | 3.28 ms | 2.62 ms | 5.77 ms | 21.56 ms | 308 条记录/s | 3.13 MiB | ±9.6% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 197 次/s | 5.09 ms | 4.46 ms | 10.20 ms | 16.58 ms | 197 条记录/s | 7.03 MiB | ±3.1% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 390 次/s | 2.57 ms | 2.05 ms | 4.38 ms | 23.13 ms | 390 条记录/s | 4.16 MiB | ±3.0% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 129 次/s | 7.80 ms | 6.55 ms | 16.67 ms | 30.56 ms | 129 条记录/s | 1.83 MiB | ±7.9% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 640 次/s | 1.55 ms | 1.35 ms | 3.14 ms | 3.99 ms | 640 条记录/s | 0 B | ±3.0% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 24,287,521 次/s | 329.4 ns | 0 B | 4.90 KiB | ±0.6% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 8,403 次/s | 15.23 ms | 61.91 MiB | -1.46 MiB | ±1.4% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 28,573 次/s | 280.4 µs | 4.83 MiB | -1.52 MiB | ±4.0% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 11,225 次/s | 712.9 µs | 2.67 MiB | 268.72 KiB | ±1.6% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 7,198 次/s | 17.79 ms | 67.68 MiB | -1.40 MiB | ±2.4% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 6,539 次/s | 19.69 ms | 8.91 MiB | 241.29 KiB | ±7.4% |

## 容器与算法

> 生产选用的容器与算法：滑动窗口用 `LinkedQueue` + `trimSlidingWindow`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 滑动时间窗口追加与过期淘汰<br><code>linked-timestamp-window</code> | 41.1 ns | 26,276,317 次/s | 153.88 MiB | 22.89 KiB | ±30.0% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 29.4 ns | 34,014,629 次/s | 108.24 MiB | 25.56 KiB | ±2.0% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 172.1 ms | 1.39 MiB | 3.39 KiB | ±6.5% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 40.09 ms | 0 B | -5.60 KiB | ±4.7% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
