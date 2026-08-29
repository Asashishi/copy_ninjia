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

**最近一次全量基准** · Bun 1.4.0 · 3 轮取平均 · 2026-08-29T12:06:41Z · 进程启动到本地恢复就绪 498.0 ms · 单条群消息进入主干并完成基础分发 1.333 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.07 ms / 857 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 5.56 ms / 150 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-08-29T12:06:41Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 376,131,005 |
| 进程读入 | 112.92 MiB |
| 进程写出 | 171.97 MiB |
| 块设备读 | 0 B |
| 块设备写 | 189.90 MiB |
| 读系统调用 | 38,269 |
| 写系统调用 | 82,202 |
| mock 根落盘 | 15.29 MiB |
| mock 根文件数 | 162 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 134.2 ms | ±5.9% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 66.35 ms | ±65.9% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 952.9 µs | ±33.6% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.79 ms | ±19.8% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 3.72 ms | ±11.2% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 993.4 µs | ±12.1% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 260.5 ms | ±3.1% |
| 填充主线程热缓存<br><code>hydrate</code> | 664.7 µs | ±12.1% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 498.0 ms | ±9.2% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 107.02 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.333 µs | 751,524 次/s | 77.58 MiB | 25.38 KiB | ±4.4% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 171.3 ns | 5,841,445 次/s | 79.21 MiB | 22.61 KiB | ±2.0% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 7.4 ns | 411,452,905 次/s | 68.07 MiB | 20.63 KiB | ±61.7% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 27.8 ns | 36,455,257 次/s | 68.03 MiB | 21.93 KiB | ±12.0% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.7 ns | 1,456,577,729 次/s | 67.35 MiB | 22.55 KiB | ±2.8% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.4 ns | 229,831,358 次/s | 67.38 MiB | 22.83 KiB | ±4.4% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 13.4 ns | 74,456,255 次/s | 68.61 MiB | 20.10 KiB | ±3.4% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 48.8 ns | 20,509,195 次/s | 70.01 MiB | 16.97 KiB | ±1.6% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 12.76 µs | 78,725 次/s | 87.95 MiB | 26.28 KiB | ±6.7% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 92.9 ns | 10,800,578 次/s | 73.65 MiB | 20.18 KiB | ±5.8% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 54.9 ns | 18,288,945 次/s | 70.47 MiB | 22.55 KiB | ±6.0% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 512.0 ns | 1,957,764 次/s | 106.87 MiB | 5.63 MiB | ±4.7% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 422.7 ns | 2,365,970 次/s | 125.58 MiB | 21.23 KiB | ±1.2% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 6.9 ns | 173,950,284 次/s | 68.18 MiB | 19.61 KiB | ±46.4% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.519 µs | 181,337 次/s | 75.86 MiB | -2.06 MiB | ±2.7% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 120.6 ns | 8,309,028 次/s | 107.74 MiB | 24.56 KiB | ±4.9% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 733.4 ns | 1,364,001 次/s | 80.98 MiB | 23.02 KiB | ±1.9% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 54.46 µs | 18,397 次/s | 89.37 MiB | -2.07 MiB | ±4.3% |
| 提取回复引用<br><code>reply-reference</code> | 26.1 ns | 38,626,902 次/s | 79.09 MiB | 23.02 KiB | ±9.1% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 99.1 ns | 10,107,069 次/s | 82.46 MiB | 22.57 KiB | ±3.3% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.2 ns | 239,157,317 次/s | 71.70 MiB | 22.02 KiB | ±8.0% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 39.8 ns | 25,665,435 次/s | 74.75 MiB | 19.56 KiB | ±14.8% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 31.8 ns | 32,100,853 次/s | 73.90 MiB | 22.15 KiB | ±14.8% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 14.6 ns | 68,776,089 次/s | 72.02 MiB | 21.34 KiB | ±7.6% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 81.3 ns | 12,311,753 次/s | 69.51 MiB | 20.61 KiB | ±2.2% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前五行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 414 次/s | 2.42 ms | 1.96 ms | 4.13 ms | 24.35 ms | 414 条记录/s | 3.91 MiB | ±4.8% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 78 次/s | 12.87 ms | 13.04 ms | 22.51 ms | 34.10 ms | 9,949 条记录/s | 20.53 MiB | ±2.5% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 332 次/s | 3.01 ms | 2.50 ms | 5.00 ms | 18.65 ms | 332 条记录/s | 3.13 MiB | ±1.9% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 307 次/s | 3.26 ms | 2.60 ms | 6.03 ms | 36.46 ms | 307 条记录/s | 3.13 MiB | ±3.4% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 199 次/s | 5.03 ms | 4.22 ms | 10.26 ms | 23.35 ms | 199 条记录/s | 7.03 MiB | ±6.0% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 334 次/s | 3.16 ms | 2.29 ms | 7.12 ms | 34.57 ms | 334 条记录/s | 4.16 MiB | ±21.5% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 150 次/s | 6.67 ms | 5.56 ms | 13.82 ms | 28.82 ms | 150 条记录/s | 1.83 MiB | ±5.5% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 857 次/s | 1.15 ms | 1.07 ms | 1.90 ms | 2.11 ms | 857 条记录/s | 0 B | ±0.3% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 24,800,785 次/s | 326.6 ns | 0 B | 7.38 KiB | ±10.7% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 10,640 次/s | 12.04 ms | 61.91 MiB | -1.65 MiB | ±2.5% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 40,728 次/s | 196.5 µs | 4.84 MiB | -1.68 MiB | ±2.0% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 13,648 次/s | 589.1 µs | 2.68 MiB | 256.15 KiB | ±6.9% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 9,712 次/s | 13.20 ms | 67.71 MiB | -1.54 MiB | ±4.0% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 8,957 次/s | 14.30 ms | 8.98 MiB | 228.80 KiB | ±2.9% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 19.5 ns | 52,858,740 次/s | 76.22 MiB | 21.86 KiB | ±18.2% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 35.0 ns | 28,548,965 次/s | 70.09 MiB | 21.73 KiB | ±1.6% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 21.4 ns | 48,947,296 次/s | 76.38 MiB | 22.03 KiB | ±21.3% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 165.9 ms | 1.78 MiB | 4.84 KiB | ±2.0% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 28.23 ms | 0 B | -5.43 KiB | ±4.6% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
