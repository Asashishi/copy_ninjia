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

**最近一次全量基准** · Bun 1.4.0 · 3 轮取平均 · 2026-08-27T16:54:00Z · 进程启动到本地恢复就绪 482.4 ms · 单条群消息进入主干并完成基础分发 1.307 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.01 ms / 878 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 5.56 ms / 148 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-08-27T16:54:00Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 376,131,005 |
| 进程读入 | 112.41 MiB |
| 进程写出 | 171.96 MiB |
| 块设备读 | 0 B |
| 块设备写 | 189.88 MiB |
| 读系统调用 | 37,981 |
| 写系统调用 | 82,284 |
| mock 根落盘 | 20.21 MiB |
| mock 根文件数 | 162 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 172.4 ms | ±6.9% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 20.99 ms | ±2.8% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 1.32 ms | ±46.6% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.74 ms | ±8.0% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 5.01 ms | ±5.5% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 909.3 µs | ±17.7% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 253.7 ms | ±3.5% |
| 填充主线程热缓存<br><code>hydrate</code> | 749.8 µs | ±15.4% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 482.4 ms | ±1.0% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 108.04 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.307 µs | 766,189 次/s | 78.39 MiB | 24.38 KiB | ±3.8% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 160.0 ns | 6,276,329 次/s | 80.82 MiB | 23.45 KiB | ±6.7% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 11.1 ns | 91,475,146 次/s | 67.77 MiB | 21.34 KiB | ±13.1% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 29.1 ns | 34,911,477 次/s | 68.42 MiB | 23.20 KiB | ±12.9% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,259,395,449 次/s | 67.34 MiB | 20.48 KiB | ±31.2% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.1 ns | 243,227,320 次/s | 67.60 MiB | 21.87 KiB | ±2.2% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 14.5 ns | 70,151,924 次/s | 68.39 MiB | 21.43 KiB | ±12.9% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 53.4 ns | 19,021,207 次/s | 70.33 MiB | 17.62 KiB | ±12.8% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 12.83 µs | 78,082 次/s | 88.70 MiB | 26.55 KiB | ±4.4% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 87.4 ns | 11,474,149 次/s | 75.41 MiB | 20.39 KiB | ±5.5% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 51.9 ns | 19,264,637 次/s | 70.30 MiB | 19.09 KiB | ±2.8% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 508.4 ns | 1,995,299 次/s | 106.49 MiB | 5.63 MiB | ±11.9% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 464.4 ns | 2,163,727 次/s | 123.97 MiB | 19.51 KiB | ±7.0% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.4 ns | 229,788,732 次/s | 69.35 MiB | 21.30 KiB | ±3.0% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.407 µs | 185,057 次/s | 76.62 MiB | -2.04 MiB | ±2.6% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 151.1 ns | 6,704,254 次/s | 108.96 MiB | 23.94 KiB | ±11.8% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 692.8 ns | 1,444,185 次/s | 80.27 MiB | 23.85 KiB | ±2.2% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 54.04 µs | 18,508 次/s | 87.85 MiB | -2.05 MiB | ±1.3% |
| 提取回复引用<br><code>reply-reference</code> | 28.7 ns | 35,711,855 次/s | 80.39 MiB | 22.96 KiB | ±16.3% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 110.1 ns | 9,135,570 次/s | 85.44 MiB | 21.42 KiB | ±7.8% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 13.9 ns | 119,853,152 次/s | 74.00 MiB | 22.65 KiB | ±50.7% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 33.7 ns | 29,879,352 次/s | 75.46 MiB | 19.07 KiB | ±8.6% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 31.1 ns | 32,224,109 次/s | 74.55 MiB | 22.80 KiB | ±5.0% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 12.7 ns | 79,430,019 次/s | 71.66 MiB | 21.37 KiB | ±8.4% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 77.9 ns | 12,859,516 次/s | 69.24 MiB | 20.20 KiB | ±4.0% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前五行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 438 次/s | 2.28 ms | 1.93 ms | 3.91 ms | 17.26 ms | 438 条记录/s | 3.91 MiB | ±0.7% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 77 次/s | 12.96 ms | 13.26 ms | 21.94 ms | 35.62 ms | 9,885 条记录/s | 20.53 MiB | ±3.2% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 336 次/s | 2.97 ms | 2.49 ms | 5.21 ms | 19.22 ms | 336 条记录/s | 3.13 MiB | ±2.3% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 321 次/s | 3.11 ms | 2.58 ms | 6.35 ms | 13.85 ms | 321 条记录/s | 3.13 MiB | ±0.4% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 178 次/s | 5.61 ms | 4.43 ms | 13.93 ms | 25.60 ms | 178 条记录/s | 7.03 MiB | ±2.9% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 407 次/s | 2.46 ms | 2.04 ms | 4.26 ms | 19.38 ms | 407 条记录/s | 4.16 MiB | ±1.7% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 148 次/s | 6.76 ms | 5.56 ms | 15.25 ms | 24.57 ms | 148 条记录/s | 1.83 MiB | ±0.9% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 878 次/s | 1.13 ms | 1.01 ms | 1.80 ms | 2.85 ms | 878 条记录/s | 0 B | ±2.6% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 24,540,468 次/s | 330.2 ns | 0 B | 4.48 KiB | ±11.0% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 10,580 次/s | 12.11 ms | 61.90 MiB | -1.65 MiB | ±3.0% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 41,755 次/s | 191.6 µs | 4.84 MiB | -1.68 MiB | ±1.0% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 13,789 次/s | 581.0 µs | 2.68 MiB | 257.51 KiB | ±3.8% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 9,849 次/s | 13.02 ms | 67.71 MiB | -1.54 MiB | ±4.7% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 8,945 次/s | 14.32 ms | 8.98 MiB | 229.64 KiB | ±2.8% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 21.4 ns | 48,682,441 次/s | 75.57 MiB | 22.96 KiB | ±19.6% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 38.5 ns | 26,061,759 次/s | 70.46 MiB | 22.94 KiB | ±5.6% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 19.0 ns | 52,950,511 次/s | 76.22 MiB | 24.52 KiB | ±7.4% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 160.4 ms | 3.26 MiB | 4.92 KiB | ±3.3% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 31.49 ms | 0 B | -5.39 KiB | ±11.8% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
