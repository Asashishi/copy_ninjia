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

**最近一次全量基准** · Bun 1.4.0 · 3 轮取平均 · 2026-08-23T16:09:38Z · 进程启动到本地恢复就绪 345.3 ms · 单条群消息进入主干并完成基础分发 2.125 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.12 ms / 780 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 5.62 ms / 144 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-08-23T16:09:38Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 369,130,605 |
| 进程读入 | 91.10 MiB |
| 进程写出 | 170.33 MiB |
| 块设备读 | 0 B |
| 块设备写 | 186.71 MiB |
| 读系统调用 | 32,553 |
| 写系统调用 | 80,649 |
| mock 根落盘 | 11.37 MiB |
| mock 根文件数 | 146 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 131.8 ms | ±2.1% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 31.34 ms | ±47.5% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 772.2 µs | ±17.7% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.72 ms | ±20.0% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.02 ms | ±10.3% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 862.7 µs | ±10.8% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 146.9 ms | ±11.8% |
| 填充主线程热缓存<br><code>hydrate</code> | 720.7 µs | ±15.8% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 345.3 ms | ±5.1% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 25 份 AI 记忆快照；进程峰值 RSS 92.42 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 2.125 µs | 471,119 次/s | 82.52 MiB | 24.46 KiB | ±3.1% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 166.5 ns | 6,011,697 次/s | 78.16 MiB | 23.10 KiB | ±2.7% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 11.0 ns | 91,340,639 次/s | 67.09 MiB | 21.90 KiB | ±6.3% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 26.2 ns | 38,217,476 次/s | 66.82 MiB | 22.38 KiB | ±5.4% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.8 ns | 1,316,472,830 次/s | 66.10 MiB | 22.73 KiB | ±9.0% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.3 ns | 230,580,656 次/s | 66.17 MiB | 22.81 KiB | ±3.8% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 13.4 ns | 74,843,257 次/s | 67.18 MiB | 22.06 KiB | ±2.9% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 53.2 ns | 18,804,280 次/s | 69.09 MiB | 17.81 KiB | ±1.6% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 12.70 µs | 78,781 次/s | 86.83 MiB | 26.18 KiB | ±2.5% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 91.3 ns | 10,986,864 次/s | 72.10 MiB | 22.78 KiB | ±5.8% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 53.1 ns | 19,002,578 次/s | 69.22 MiB | 20.93 KiB | ±9.7% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 488.0 ns | 2,049,711 次/s | 109.06 MiB | 5.63 MiB | ±1.4% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 424.6 ns | 2,357,835 次/s | 121.73 MiB | 19.19 KiB | ±3.4% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 8.8 ns | 136,773,940 次/s | 67.28 MiB | 20.54 KiB | ±35.9% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.489 µs | 182,260 次/s | 75.00 MiB | -2.05 MiB | ±1.8% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 133.6 ns | 7,776,757 次/s | 106.17 MiB | 24.07 KiB | ±18.4% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 717.5 ns | 1,395,471 次/s | 82.49 MiB | 23.13 KiB | ±3.5% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 53.63 µs | 18,650 次/s | 86.86 MiB | -2.06 MiB | ±1.4% |
| 提取回复引用<br><code>reply-reference</code> | 26.4 ns | 38,228,560 次/s | 77.12 MiB | 23.42 KiB | ±9.1% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 110.3 ns | 9,115,181 次/s | 83.57 MiB | 22.86 KiB | ±7.5% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.0 ns | 247,850,740 次/s | 71.83 MiB | 21.61 KiB | ±3.5% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 39.1 ns | 25,915,920 次/s | 73.57 MiB | 20.68 KiB | ±10.6% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 31.3 ns | 32,074,978 次/s | 72.82 MiB | 20.53 KiB | ±7.3% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 12.0 ns | 83,348,012 次/s | 69.09 MiB | 21.55 KiB | ±5.0% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 76.2 ns | 13,138,367 次/s | 68.58 MiB | 21.62 KiB | ±4.2% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前五行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 405 次/s | 2.47 ms | 1.98 ms | 4.47 ms | 69.99 ms | 405 条记录/s | 3.91 MiB | ±5.6% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 77 次/s | 12.96 ms | 13.09 ms | 22.47 ms | 31.07 ms | 9,879 条记录/s | 20.53 MiB | ±2.7% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 318 次/s | 3.14 ms | 2.60 ms | 5.63 ms | 19.18 ms | 318 条记录/s | 3.13 MiB | ±3.0% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 99 次/s | 14.76 ms | 12.88 ms | 43.16 ms | 67.98 ms | 99 条记录/s | 7.03 MiB | ±53.0% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 378 次/s | 2.66 ms | 2.15 ms | 4.85 ms | 22.22 ms | 378 条记录/s | 4.16 MiB | ±6.2% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 144 次/s | 6.95 ms | 5.62 ms | 15.41 ms | 26.52 ms | 144 条记录/s | 1.83 MiB | ±2.2% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 780 次/s | 1.27 ms | 1.12 ms | 1.94 ms | 3.15 ms | 780 条记录/s | 0 B | ±1.5% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 26,683,046 次/s | 300.1 ns | 0 B | 9.74 KiB | ±2.8% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 10,593 次/s | 12.09 ms | 61.90 MiB | -1.62 MiB | ±2.1% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 41,072 次/s | 194.8 µs | 4.84 MiB | -1.65 MiB | ±1.9% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 12,915 次/s | 622.5 µs | 2.68 MiB | 238.40 KiB | ±6.9% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 10,170 次/s | 12.59 ms | 67.69 MiB | -1.51 MiB | ±1.5% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 8,257 次/s | 15.54 ms | 8.96 MiB | 239.77 KiB | ±5.1% |

## 容器与算法

> 生产选用的容器与算法：滑动窗口用 `LinkedQueue` + `trimSlidingWindow`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 滑动时间窗口追加与过期淘汰<br><code>linked-timestamp-window</code> | 53.1 ns | 18,847,548 次/s | 102.56 MiB | 23.81 KiB | ±2.3% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 24.0 ns | 41,627,871 次/s | 74.72 MiB | 23.99 KiB | ±3.2% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 160.5 ms | 2.34 MiB | 4.34 KiB | ±6.0% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 29.08 ms | 0 B | -5.39 KiB | ±6.5% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
