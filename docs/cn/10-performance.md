# 10 性能基准

<p align="center">
  <b>简体中文</b> · <a href="../en/10-performance.md">English</a> · <a href="../ja/10-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="09-commands.md">← 上一页：09 命令与行为参考</a> · <a href="11-faq.md">下一页：11 常见问题 →</a>
</p>

---

本页的读数由 `bun run perf:full -- --write-doc` 生成，每次发布重跑一次并整块覆盖。
下面两个标记之间的内容不要手工编辑，也不要只更新三种语言中的一份。

同一次运行还会把**结构化报告全文**写进仓库根被跟踪的 `performance-result.json` 的
`fullSuite.lastRun`：本页是给人看的呈现，那份 JSON 是同一批读数可被程序读取的记录
（环境、分区、逐项均值与变异系数一项不少）。两者由同一个开关写出，不会各自过期。

基准本身只在发布和明确指令时运行，不属于 `bun run check`；热路径的 GC/RSS/JIT 硬门禁由
`bun run perf:hot-path-gate` 单独承担，见 [05 开发流程与质量门禁](05-dev-workflow.md)。

专项场景及 `bun run perf:disk-transport` 的复现方式与测量边界见 [05 开发流程与质量门禁](05-dev-workflow.md#专项场景与传输压力验证)。专项输出和热路径门禁分别记录，不替换下方全量基准的生成区块。

<!-- performance-benchmark:start -->

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-10-05T02:36:01Z · 进程启动到本地恢复就绪 396.4 ms · 单条群消息进入主干并完成基础分发 149.0 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 210.7 µs / 4,029 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.85 ms / 476 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-10-05T02:36:01Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,453 |
| 进程读入 | 182.45 MiB |
| 进程写出 | 185.20 MiB |
| 块设备读 | 0 B |
| 块设备写 | 234.41 MiB |
| 读系统调用 | 53,288 |
| 写系统调用 | 243,665 |
| mock 根落盘 | 14.77 MiB |
| mock 根文件数 | 121 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 119.3 ms | ±2.9% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 12.44 ms | ±7.4% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 863.2 µs | ±14.8% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.55 ms | ±17.5% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 5.28 ms | ±5.3% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 720.3 µs | ±1.7% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 241.6 ms | ±1.4% |
| 填充主线程热缓存<br><code>hydrate</code> | 292.1 µs | ±4.8% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 396.4 ms | ±1.0% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 119.05 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 149.0 ns | 6,715,225 次/s | 97.93 MiB | 6.56 KiB | ±3.0% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 103.1 ns | 9,778,867 次/s | 96.98 MiB | 20.11 KiB | ±8.9% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 16.4 ns | 61,227,459 次/s | 83.50 MiB | 20.41 KiB | ±3.9% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 29.5 ns | 33,914,683 次/s | 83.56 MiB | 20.16 KiB | ±3.3% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 35.1 ns | 28,460,229 次/s | 84.80 MiB | 20.15 KiB | ±0.7% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,158,199,066 次/s | 82.32 MiB | 21.30 KiB | ±1.8% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 52.4 ns | 19,087,141 次/s | 85.60 MiB | 18.74 KiB | ±1.5% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.1 ns | 245,262,975 次/s | 82.84 MiB | 21.12 KiB | ±4.8% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 11.1 ns | 90,593,710 次/s | 83.34 MiB | 18.43 KiB | ±6.7% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 42.1 ns | 23,749,318 次/s | 84.92 MiB | 18.43 KiB | ±1.1% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.208 µs | 828,490 次/s | 110.52 MiB | 19.39 KiB | ±2.8% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 92.3 ns | 10,848,127 次/s | 90.29 MiB | 21.25 KiB | ±3.7% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 44.8 ns | 22,315,330 次/s | 93.21 MiB | 19.79 KiB | ±0.9% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 52.7 ns | 19,113,733 次/s | 85.70 MiB | 20.43 KiB | ±8.4% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 265.1 ns | 3,781,861 次/s | 122.48 MiB | 5.63 MiB | ±4.9% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 361.6 ns | 2,772,113 次/s | 146.65 MiB | 18.60 KiB | ±5.0% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.5 ns | 223,482,953 次/s | 83.94 MiB | 19.41 KiB | ±6.0% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.297 µs | 435,516 次/s | 96.21 MiB | 22.22 KiB | ±1.6% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 33.3 ns | 30,032,747 次/s | 90.54 MiB | 13.60 KiB | ±3.5% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 305.6 ns | 3,280,176 次/s | 97.97 MiB | 21.29 KiB | ±4.8% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 44.06 µs | 22,697 次/s | 111.75 MiB | 20.46 KiB | ±0.4% |
| 提取回复引用<br><code>reply-reference</code> | 38.7 ns | 27,202,702 次/s | 96.28 MiB | 21.84 KiB | ±22.3% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 46.8 ns | 21,554,637 次/s | 106.47 MiB | 20.01 KiB | ±9.1% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 6.1 ns | 195,235,397 次/s | 83.37 MiB | 19.49 KiB | ±46.6% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 38.9 ns | 25,717,130 次/s | 92.97 MiB | 21.65 KiB | ±1.9% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 21.9 ns | 45,608,441 次/s | 82.77 MiB | 19.83 KiB | ±2.4% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 16.7 ns | 59,745,866 次/s | 86.07 MiB | 20.61 KiB | ±2.0% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 77.0 ns | 13,004,640 次/s | 84.45 MiB | 20.03 KiB | ±3.5% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。cron.json 一行只量中途变更的开销，不执行任务：任务表取生产上限（128 个任务、每个 16 个动作，本地来源相对数据根），每次改动其中 1 个任务后按生产顺序读取并严格解析六份可热重载文件（含逐项核对本地来源）、替换快照并按任务名对账调度器；改写与写盘属于部署方，不计时；文件监听的防抖等待、随后的广告检测与 AI 闲聊可用性重算和热重载日志也不计入。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 816 次/s | 1.24 ms | 1.08 ms | 1.88 ms | 10.95 ms | 816 条记录/s | 3.91 MiB | ±9.7% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 310 次/s | 3.23 ms | 3.12 ms | 6.01 ms | 15.50 ms | 39,616 条记录/s | 21.42 MiB | ±1.4% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 753 次/s | 1.33 ms | 1.20 ms | 1.91 ms | 6.07 ms | 753 条记录/s | 3.15 MiB | ±2.4% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 674 次/s | 1.48 ms | 1.33 ms | 2.40 ms | 6.38 ms | 674 条记录/s | 3.13 MiB | ±1.3% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 678 次/s | 1.47 ms | 1.35 ms | 2.04 ms | 7.12 ms | 678 条记录/s | 3.13 MiB | ±0.8% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 344 次/s | 2.91 ms | 2.64 ms | 4.23 ms | 11.86 ms | 344 条记录/s | 5.55 MiB | ±1.0% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 859 次/s | 1.16 ms | 1.08 ms | 1.58 ms | 7.12 ms | 859 条记录/s | 4.16 MiB | ±2.7% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 476 次/s | 2.10 ms | 1.85 ms | 3.18 ms | 11.32 ms | 476 条记录/s | 1.20 MiB | ±1.6% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 4,029 次/s | 246.1 µs | 210.7 µs | 388.9 µs | 647.0 µs | 4,029 条记录/s | 0 B | ±5.2% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 5 次/s | 199.3 ms | 197.1 ms | 209.6 ms | 215.2 ms | 5 条记录/s | 0 B | ±1.3% |
| cron.json 中途改动 1 个任务：热重载并重排调度（满规格任务表）<br><code>cron-config-reload</code> | 7 次/s | 143.9 ms | 143.3 ms | 151.2 ms | 153.9 ms | 7 条记录/s | 7.31 MiB | ±0.2% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 28,398,068 次/s | 283.4 ns | 0 B | 5.92 KiB | ±7.5% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 41,692 次/s | 3.07 ms | 56.31 MiB | 41.17 KiB | ±0.9% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 66,395 次/s | 120.6 µs | 5.29 MiB | 73.89 KiB | ±2.7% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 13,314 次/s | 600.9 µs | 34.01 MiB | 282.59 KiB | ±0.9% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 62,977 次/s | 2.03 ms | 73.14 MiB | 134.33 KiB | ±1.9% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 18,846 次/s | 6.79 ms | 12.63 MiB | 421.11 KiB | ±0.8% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 18.2 ns | 55,045,813 次/s | 94.80 MiB | 22.11 KiB | ±2.1% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 36.8 ns | 27,170,682 次/s | 85.64 MiB | 22.05 KiB | ±2.5% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 19.0 ns | 52,896,760 次/s | 93.30 MiB | 24.03 KiB | ±6.5% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 126.9 ms | 1.90 MiB | 4.96 KiB | ±2.2% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 25.45 ms | 0 B | -4.88 KiB | ±11.6% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：09 命令与行为参考](09-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#10-性能基准) · [下一页：11 常见问题 →](11-faq.md)

</div>
