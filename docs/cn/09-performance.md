# 09 性能基准

<p align="center">
  <b>简体中文</b> · <a href="../en/09-performance.md">English</a> · <a href="../ja/09-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="08-commands.md">← 上一页：08 命令与行为参考</a> · <b>下一页：无 →</b>
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

**最近一次全量基准** · Bun 1.4.1 · 3 轮取平均 · 2026-09-05T06:46:26Z · 进程启动到本地恢复就绪 486.4 ms · 单条群消息进入主干并完成基础分发 1.260 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.03 ms / 844 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 5.56 ms / 140 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.1 (`4661e494f052c83c80dade1318e5710238340be6`) |
| 内核 | linux 6.8.0-138-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-05T06:46:26Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 385,931,405 |
| 进程读入 | 121.13 MiB |
| 进程写出 | 178.31 MiB |
| 块设备读 | 1.33 KiB |
| 块设备写 | 197.80 MiB |
| 读系统调用 | 40,280 |
| 写系统调用 | 84,067 |
| mock 根落盘 | 16.58 MiB |
| mock 根文件数 | 161 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 154.3 ms | ±17.6% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 20.08 ms | ±6.9% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 677.9 µs | ±2.1% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.54 ms | ±4.5% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 7.71 ms | ±14.5% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 965.5 µs | ±10.7% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 279.7 ms | ±1.8% |
| 填充主线程热缓存<br><code>hydrate</code> | 727.9 µs | ±16.8% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 486.4 ms | ±7.0% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 108.33 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.260 µs | 794,393 次/s | 74.67 MiB | 24.70 KiB | ±2.4% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 185.6 ns | 5,429,534 次/s | 77.87 MiB | 23.26 KiB | ±9.0% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 11.1 ns | 90,169,256 次/s | 66.28 MiB | 21.69 KiB | ±4.0% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 24.3 ns | 41,335,417 次/s | 66.05 MiB | 22.60 KiB | ±6.8% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.7 ns | 1,357,729,548 次/s | 65.45 MiB | 22.07 KiB | ±11.1% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 60.6 ns | 16,569,641 次/s | 67.86 MiB | 23.88 KiB | ±6.5% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.1 ns | 242,859,778 次/s | 65.32 MiB | 21.74 KiB | ±3.5% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 13.3 ns | 75,250,886 次/s | 66.57 MiB | 23.62 KiB | ±1.9% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 49.1 ns | 20,428,947 次/s | 68.24 MiB | 19.49 KiB | ±4.6% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 12.91 µs | 77,580 次/s | 85.94 MiB | 26.71 KiB | ±3.9% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 108.8 ns | 9,209,352 次/s | 74.52 MiB | 21.74 KiB | ±4.0% |
| 推进临时白名单日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 40.8 ns | 26,752,103 次/s | 72.95 MiB | 22.94 KiB | ±32.1% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 62.3 ns | 16,295,393 次/s | 68.73 MiB | 21.83 KiB | ±12.3% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 453.6 ns | 2,262,881 次/s | 102.07 MiB | 5.63 MiB | ±15.3% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 449.9 ns | 2,223,497 次/s | 124.33 MiB | 19.36 KiB | ±2.1% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.6 ns | 219,081,833 次/s | 67.03 MiB | 21.45 KiB | ±0.6% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.268 µs | 189,987 次/s | 74.47 MiB | 23.76 KiB | ±2.9% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 131.7 ns | 7,655,928 次/s | 104.53 MiB | 24.27 KiB | ±9.0% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 338.9 ns | 2,950,963 次/s | 91.20 MiB | 26.30 KiB | ±1.5% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 55.62 µs | 17,983 次/s | 86.53 MiB | 21.93 KiB | ±1.7% |
| 提取回复引用<br><code>reply-reference</code> | 24.5 ns | 40,849,823 次/s | 75.53 MiB | 23.07 KiB | ±2.0% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 74.0 ns | 13,553,325 次/s | 76.95 MiB | 21.90 KiB | ±4.7% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.4 ns | 229,576,133 次/s | 71.59 MiB | 20.49 KiB | ±6.6% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 36.5 ns | 27,797,167 次/s | 73.12 MiB | 20.90 KiB | ±11.8% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 29.1 ns | 34,456,703 次/s | 66.33 MiB | 22.36 KiB | ±3.8% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 12.3 ns | 81,098,688 次/s | 69.18 MiB | 20.18 KiB | ±1.0% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 76.8 ns | 13,042,050 次/s | 67.52 MiB | 21.31 KiB | ±4.2% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 338 次/s | 2.95 ms | 2.03 ms | 9.44 ms | 34.41 ms | 338 条记录/s | 3.91 MiB | ±1.5% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 72 次/s | 13.91 ms | 14.03 ms | 24.18 ms | 57.96 ms | 9,218 条记录/s | 20.53 MiB | ±4.5% |
| 累计 1 条临时白名单活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 260 次/s | 4.02 ms | 2.65 ms | 10.49 ms | 44.49 ms | 260 条记录/s | 3.15 MiB | ±21.3% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 248 次/s | 4.03 ms | 2.80 ms | 12.16 ms | 42.74 ms | 248 条记录/s | 3.13 MiB | ±0.9% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 285 次/s | 3.50 ms | 2.61 ms | 9.06 ms | 30.15 ms | 285 条记录/s | 3.13 MiB | ±3.5% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 194 次/s | 5.17 ms | 4.27 ms | 11.59 ms | 18.64 ms | 194 条记录/s | 11.72 MiB | ±6.1% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 362 次/s | 2.76 ms | 2.07 ms | 6.30 ms | 26.42 ms | 362 条记录/s | 4.16 MiB | ±0.6% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 140 次/s | 7.17 ms | 5.56 ms | 16.08 ms | 31.44 ms | 140 条记录/s | 1.83 MiB | ±3.9% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 844 次/s | 1.18 ms | 1.03 ms | 1.95 ms | 3.33 ms | 844 条记录/s | 0 B | ±4.5% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 23,847,525 次/s | 348.0 ns | 0 B | 7.77 KiB | ±17.8% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 10,381 次/s | 12.33 ms | 61.90 MiB | 8.58 KiB | ±0.5% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 41,658 次/s | 192.1 µs | 4.86 MiB | 58.44 KiB | ±1.2% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 12,510 次/s | 640.1 µs | 2.70 MiB | 278.17 KiB | ±3.1% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 9,750 次/s | 13.14 ms | 67.73 MiB | 151.30 KiB | ±2.7% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 8,805 次/s | 14.59 ms | 9.00 MiB | 190.64 KiB | ±6.1% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 15.9 ns | 63,130,363 次/s | 74.40 MiB | 23.97 KiB | ±5.9% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 37.1 ns | 26,950,922 次/s | 67.67 MiB | 23.22 KiB | ±2.1% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 17.9 ns | 56,115,704 次/s | 73.26 MiB | 24.66 KiB | ±7.0% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 169.5 ms | 1.96 MiB | 4.96 KiB | ±3.8% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 29.67 ms | 0 B | -4.94 KiB | ±1.9% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
