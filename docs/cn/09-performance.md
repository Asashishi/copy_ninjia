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

**最近一次全量基准** · Bun 1.4.0 · 3 轮取平均 · 2026-09-01T15:29:18Z · 进程启动到本地恢复就绪 486.9 ms · 单条群消息进入主干并完成基础分发 1.316 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.07 ms / 826 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 5.29 ms / 161 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| 内核 | linux 6.8.0-138-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-01T15:29:18Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 385,931,405 |
| 进程读入 | 120.56 MiB |
| 进程写出 | 173.64 MiB |
| 块设备读 | 0 B |
| 块设备写 | 193.11 MiB |
| 读系统调用 | 40,326 |
| 写系统调用 | 84,034 |
| mock 根落盘 | 15.22 MiB |
| mock 根文件数 | 160 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 142.8 ms | ±8.1% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 21.83 ms | ±7.5% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 835.5 µs | ±27.2% |
| 读取并严格解析运行状态<br><code>state-load</code> | 2.10 ms | ±32.6% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 8.75 ms | ±14.4% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 1.00 ms | ±20.2% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 283.5 ms | ±5.8% |
| 填充主线程热缓存<br><code>hydrate</code> | 808.0 µs | ±18.6% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 486.9 ms | ±1.7% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 104.48 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.316 µs | 761,970 次/s | 77.22 MiB | 24.89 KiB | ±5.2% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 174.4 ns | 5,771,532 次/s | 80.47 MiB | 23.59 KiB | ±7.9% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 11.3 ns | 90,413,278 次/s | 67.49 MiB | 21.93 KiB | ±13.6% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 26.8 ns | 37,484,018 次/s | 68.27 MiB | 22.67 KiB | ±6.6% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.7 ns | 1,383,127,554 次/s | 67.02 MiB | 23.61 KiB | ±16.5% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 51.4 ns | 19,444,534 次/s | 69.67 MiB | 24.23 KiB | ±1.5% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.5 ns | 225,706,574 次/s | 67.44 MiB | 24.25 KiB | ±10.7% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 12.8 ns | 78,017,774 次/s | 68.39 MiB | 22.60 KiB | ±1.7% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 49.7 ns | 20,249,650 次/s | 70.04 MiB | 20.25 KiB | ±8.2% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 12.72 µs | 79,104 次/s | 88.24 MiB | 26.58 KiB | ±8.0% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 109.0 ns | 9,195,460 次/s | 75.57 MiB | 20.04 KiB | ±4.5% |
| 推进临时白名单日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 33.1 ns | 30,255,318 次/s | 75.22 MiB | 22.94 KiB | ±4.0% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 57.6 ns | 17,587,306 次/s | 70.38 MiB | 19.92 KiB | ±11.4% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 497.4 ns | 2,014,913 次/s | 102.20 MiB | 5.63 MiB | ±4.6% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 467.5 ns | 2,144,163 次/s | 124.46 MiB | 20.24 KiB | ±5.0% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.8 ns | 209,304,869 次/s | 68.32 MiB | 20.83 KiB | ±3.1% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.597 µs | 178,921 次/s | 75.98 MiB | -2.11 MiB | ±3.7% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 111.2 ns | 9,040,634 次/s | 107.33 MiB | 23.62 KiB | ±7.3% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 729.3 ns | 1,372,099 次/s | 80.87 MiB | 23.59 KiB | ±2.5% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 55.23 µs | 18,107 次/s | 88.50 MiB | -2.12 MiB | ±0.3% |
| 提取回复引用<br><code>reply-reference</code> | 31.3 ns | 34,084,764 次/s | 76.72 MiB | 23.98 KiB | ±27.4% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 104.5 ns | 9,566,962 次/s | 81.35 MiB | 22.22 KiB | ±1.5% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 10.7 ns | 127,783,599 次/s | 73.24 MiB | 22.77 KiB | ±61.4% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 32.9 ns | 30,638,815 次/s | 75.15 MiB | 20.51 KiB | ±8.3% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 31.6 ns | 31,680,826 次/s | 74.08 MiB | 22.92 KiB | ±2.9% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 11.2 ns | 88,958,153 次/s | 71.99 MiB | 20.03 KiB | ±0.5% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 75.9 ns | 13,198,279 次/s | 70.02 MiB | 21.73 KiB | ±4.6% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 446 次/s | 2.24 ms | 1.85 ms | 3.74 ms | 55.20 ms | 446 条记录/s | 3.91 MiB | ±4.3% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 79 次/s | 12.67 ms | 13.11 ms | 22.19 ms | 32.22 ms | 10,117 条记录/s | 20.53 MiB | ±3.9% |
| 累计 1 条临时白名单活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 343 次/s | 2.92 ms | 2.39 ms | 6.22 ms | 14.81 ms | 343 条记录/s | 3.15 MiB | ±6.3% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 343 次/s | 2.93 ms | 2.47 ms | 4.95 ms | 17.52 ms | 343 条记录/s | 3.13 MiB | ±7.0% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 310 次/s | 3.27 ms | 2.69 ms | 5.98 ms | 21.05 ms | 310 条记录/s | 3.13 MiB | ±11.6% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 213 次/s | 4.69 ms | 4.09 ms | 8.01 ms | 16.50 ms | 213 条记录/s | 7.03 MiB | ±4.3% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 406 次/s | 2.46 ms | 2.02 ms | 4.25 ms | 20.79 ms | 406 条记录/s | 4.16 MiB | ±3.0% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 161 次/s | 6.22 ms | 5.29 ms | 13.27 ms | 24.09 ms | 161 条记录/s | 1.83 MiB | ±4.7% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 826 次/s | 1.20 ms | 1.07 ms | 2.02 ms | 3.10 ms | 826 条记录/s | 0 B | ±1.3% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 23,937,633 次/s | 341.3 ns | 0 B | 9.53 KiB | ±14.2% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 10,521 次/s | 12.18 ms | 61.90 MiB | -1.69 MiB | ±2.9% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 41,881 次/s | 191.0 µs | 4.86 MiB | -1.70 MiB | ±0.6% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 12,438 次/s | 643.9 µs | 2.70 MiB | 273.76 KiB | ±3.4% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 9,665 次/s | 13.25 ms | 67.73 MiB | -1.56 MiB | ±2.3% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 8,700 次/s | 14.71 ms | 9.00 MiB | 199.84 KiB | ±0.9% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 16.8 ns | 59,802,821 次/s | 76.97 MiB | 22.91 KiB | ±6.8% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 44.4 ns | 22,981,852 次/s | 69.96 MiB | 23.25 KiB | ±13.8% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 18.6 ns | 54,084,831 次/s | 76.09 MiB | 26.05 KiB | ±7.7% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 158.9 ms | 1.81 MiB | 4.92 KiB | ±9.9% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 33.44 ms | 0 B | -4.95 KiB | ±4.4% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
