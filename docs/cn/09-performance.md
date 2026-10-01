# 09 性能基准

<p align="center">
  <b>简体中文</b> · <a href="../en/09-performance.md">English</a> · <a href="../ja/09-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="08-commands.md">← 上一页：08 命令与行为参考</a> · <a href="10-faq.md">下一页：10 常见问题 →</a>
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

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-10-01T01:09:44Z · 进程启动到本地恢复就绪 360.9 ms · 单条群消息进入主干并完成基础分发 148.3 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 216.6 µs / 4,227 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.86 ms / 492 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-10-01T01:09:44Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,453 |
| 进程读入 | 179.78 MiB |
| 进程写出 | 185.20 MiB |
| 块设备读 | 0 B |
| 块设备写 | 234.42 MiB |
| 读系统调用 | 52,556 |
| 写系统调用 | 243,644 |
| mock 根落盘 | 15.14 MiB |
| mock 根文件数 | 120 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 124.3 ms | ±9.1% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 12.49 ms | ±4.6% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 667.9 µs | ±4.8% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.24 ms | ±1.4% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 5.17 ms | ±7.4% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 649.7 µs | ±2.8% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 201.0 ms | ±2.2% |
| 填充主线程热缓存<br><code>hydrate</code> | 913.2 µs | ±85.2% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 360.9 ms | ±3.0% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 109.87 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 148.3 ns | 6,748,600 次/s | 93.08 MiB | 9.51 KiB | ±2.6% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 100.2 ns | 9,997,776 次/s | 91.81 MiB | 20.10 KiB | ±4.7% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 16.2 ns | 61,846,549 次/s | 78.47 MiB | 21.81 KiB | ±1.3% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 29.7 ns | 33,684,148 次/s | 79.30 MiB | 21.39 KiB | ±4.6% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 35.4 ns | 28,280,203 次/s | 80.57 MiB | 20.46 KiB | ±4.3% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,138,193,987 次/s | 77.26 MiB | 22.14 KiB | ±5.8% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 50.8 ns | 19,741,072 次/s | 79.94 MiB | 20.38 KiB | ±5.0% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.0 ns | 248,842,748 次/s | 77.69 MiB | 21.28 KiB | ±3.7% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 10.5 ns | 95,721,806 次/s | 78.46 MiB | 20.68 KiB | ±3.5% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 43.0 ns | 23,245,264 次/s | 80.17 MiB | 21.21 KiB | ±1.0% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.110 µs | 901,239 次/s | 104.43 MiB | 19.44 KiB | ±1.4% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 95.0 ns | 10,529,980 次/s | 85.53 MiB | 23.52 KiB | ±1.2% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 24.5 ns | 41,022,852 次/s | 87.90 MiB | 23.16 KiB | ±7.7% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 49.7 ns | 20,169,508 次/s | 80.64 MiB | 22.38 KiB | ±3.9% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 259.9 ns | 3,849,376 次/s | 117.42 MiB | 5.63 MiB | ±2.2% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 315.7 ns | 3,172,934 次/s | 147.18 MiB | 18.79 KiB | ±3.9% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.3 ns | 233,273,391 次/s | 78.67 MiB | 21.19 KiB | ±1.3% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.222 µs | 450,185 次/s | 89.93 MiB | 23.03 KiB | ±1.0% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 98.2 ns | 10,198,505 次/s | 124.30 MiB | 23.87 KiB | ±3.7% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 283.0 ns | 3,534,208 次/s | 91.38 MiB | 24.43 KiB | ±1.0% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 39.02 µs | 25,632 次/s | 104.15 MiB | 21.51 KiB | ±0.8% |
| 提取回复引用<br><code>reply-reference</code> | 38.5 ns | 26,964,399 次/s | 91.56 MiB | 22.59 KiB | ±18.8% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 50.1 ns | 20,032,401 次/s | 98.86 MiB | 22.19 KiB | ±5.3% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 8.1 ns | 144,719,433 次/s | 78.89 MiB | 23.00 KiB | ±33.3% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 38.2 ns | 26,206,089 次/s | 87.49 MiB | 19.14 KiB | ±0.9% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 21.9 ns | 45,634,244 次/s | 78.10 MiB | 21.11 KiB | ±2.3% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 16.4 ns | 61,246,674 次/s | 80.90 MiB | 20.79 KiB | ±5.7% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 76.5 ns | 13,083,837 次/s | 79.75 MiB | 21.52 KiB | ±1.7% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。cron.json 一行只量中途变更的开销，不执行任务：任务表取生产上限（128 个任务、每个 16 个动作，本地来源相对数据根），每次改动其中 1 个任务后按生产顺序读取并严格解析六份可热重载文件（含逐项核对本地来源）、替换快照并按任务名对账调度器；改写与写盘属于部署方，不计时；文件监听的防抖等待、随后的广告检测与 AI 闲聊可用性重算和热重载日志也不计入。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 953 次/s | 1.05 ms | 961.5 µs | 1.45 ms | 8.06 ms | 953 条记录/s | 3.91 MiB | ±2.2% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 317 次/s | 3.16 ms | 3.06 ms | 5.62 ms | 15.75 ms | 40,535 条记录/s | 21.42 MiB | ±4.1% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 790 次/s | 1.27 ms | 1.15 ms | 1.61 ms | 7.78 ms | 790 条记录/s | 3.15 MiB | ±0.7% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 663 次/s | 1.52 ms | 1.35 ms | 2.55 ms | 8.17 ms | 663 条记录/s | 3.13 MiB | ±10.2% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 725 次/s | 1.38 ms | 1.28 ms | 1.83 ms | 5.44 ms | 725 条记录/s | 3.13 MiB | ±2.0% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 363 次/s | 2.76 ms | 2.50 ms | 4.04 ms | 12.08 ms | 363 条记录/s | 5.55 MiB | ±3.1% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 866 次/s | 1.16 ms | 1.06 ms | 1.59 ms | 8.90 ms | 866 条记录/s | 4.16 MiB | ±4.6% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 492 次/s | 2.03 ms | 1.86 ms | 3.03 ms | 7.07 ms | 492 条记录/s | 1.20 MiB | ±2.5% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 4,227 次/s | 234.2 µs | 216.6 µs | 352.4 µs | 528.4 µs | 4,227 条记录/s | 0 B | ±2.1% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 5 次/s | 189.9 ms | 188.2 ms | 197.3 ms | 207.7 ms | 5 条记录/s | 0 B | ±1.3% |
| cron.json 中途改动 1 个任务：热重载并重排调度（满规格任务表）<br><code>cron-config-reload</code> | 7 次/s | 140.2 ms | 139.2 ms | 147.6 ms | 151.0 ms | 7 条记录/s | 7.31 MiB | ±0.7% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 29,941,728 次/s | 267.2 ns | 0 B | 5.75 KiB | ±1.1% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 44,446 次/s | 2.88 ms | 56.31 MiB | 44.35 KiB | ±0.4% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 73,782 次/s | 108.5 µs | 5.29 MiB | 79.92 KiB | ±2.0% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 12,797 次/s | 625.6 µs | 34.01 MiB | 296.33 KiB | ±2.6% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 63,172 次/s | 2.03 ms | 73.14 MiB | 137.35 KiB | ±2.9% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 18,579 次/s | 6.90 ms | 12.63 MiB | 433.79 KiB | ±4.0% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 16.3 ns | 61,541,088 次/s | 89.83 MiB | 22.81 KiB | ±6.7% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 36.4 ns | 27,474,121 次/s | 79.73 MiB | 23.09 KiB | ±0.9% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 19.4 ns | 52,222,344 次/s | 87.79 MiB | 24.57 KiB | ±10.8% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 132.6 ms | 1.92 MiB | 4.89 KiB | ±1.6% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 21.38 ms | 0 B | -3.56 KiB | ±3.3% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准) · [下一页：10 常见问题 →](10-faq.md)

</div>
