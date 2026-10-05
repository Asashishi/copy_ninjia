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

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-10-05T12:21:36Z · 进程启动到本地恢复就绪 387.5 ms · 单条群消息进入主干并完成基础分发 148.9 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 201.3 µs / 4,249 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.89 ms / 470 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-10-05T12:21:36Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,453 |
| 进程读入 | 182.37 MiB |
| 进程写出 | 185.20 MiB |
| 块设备读 | 0 B |
| 块设备写 | 234.42 MiB |
| 读系统调用 | 53,124 |
| 写系统调用 | 243,671 |
| mock 根落盘 | 15.43 MiB |
| mock 根文件数 | 120 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 108.6 ms | ±9.2% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 13.43 ms | ±3.2% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 664.5 µs | ±0.5% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.23 ms | ±6.9% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.85 ms | ±1.2% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 669.6 µs | ±6.5% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 244.8 ms | ±1.5% |
| 填充主线程热缓存<br><code>hydrate</code> | 308.4 µs | ±14.1% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 387.5 ms | ±2.4% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 119.68 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 148.9 ns | 6,715,858 次/s | 97.63 MiB | 4.14 KiB | ±1.8% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 99.9 ns | 10,080,855 次/s | 97.14 MiB | 20.10 KiB | ±8.3% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 16.6 ns | 60,494,360 次/s | 82.96 MiB | 20.32 KiB | ±4.5% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 29.6 ns | 33,776,648 次/s | 83.94 MiB | 20.21 KiB | ±1.4% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 33.2 ns | 30,128,428 次/s | 85.17 MiB | 18.86 KiB | ±1.5% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,154,750,399 次/s | 82.41 MiB | 21.30 KiB | ±3.0% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 48.0 ns | 20,849,019 次/s | 84.67 MiB | 19.49 KiB | ±2.3% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 3.9 ns | 254,780,753 次/s | 82.93 MiB | 20.33 KiB | ±4.1% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 10.1 ns | 98,814,012 次/s | 83.38 MiB | 19.56 KiB | ±4.5% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 42.7 ns | 23,439,723 次/s | 85.35 MiB | 18.58 KiB | ±0.9% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.104 µs | 907,117 次/s | 109.31 MiB | 15.93 KiB | ±3.3% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 93.4 ns | 10,713,471 次/s | 90.89 MiB | 20.13 KiB | ±1.5% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 42.3 ns | 23,674,745 次/s | 93.00 MiB | 19.95 KiB | ±3.9% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 51.1 ns | 19,579,035 次/s | 84.96 MiB | 22.41 KiB | ±1.7% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 267.8 ns | 3,749,668 次/s | 121.86 MiB | 5.63 MiB | ±6.5% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 324.6 ns | 3,081,744 次/s | 148.67 MiB | 19.63 KiB | ±1.6% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.3 ns | 233,947,160 次/s | 83.11 MiB | 19.21 KiB | ±1.5% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.166 µs | 461,742 次/s | 95.28 MiB | 21.81 KiB | ±0.4% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 32.5 ns | 30,804,543 次/s | 90.48 MiB | 13.64 KiB | ±2.0% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 280.9 ns | 3,563,962 次/s | 97.09 MiB | 21.46 KiB | ±3.6% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 37.94 µs | 26,357 次/s | 109.11 MiB | 20.85 KiB | ±0.6% |
| 提取回复引用<br><code>reply-reference</code> | 26.8 ns | 37,396,089 次/s | 96.30 MiB | 22.04 KiB | ±2.1% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 47.4 ns | 21,097,084 次/s | 105.56 MiB | 19.57 KiB | ±2.5% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 7.8 ns | 150,486,838 次/s | 83.83 MiB | 20.54 KiB | ±33.9% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 37.5 ns | 26,698,332 次/s | 92.58 MiB | 19.20 KiB | ±1.4% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 22.0 ns | 45,572,333 次/s | 83.08 MiB | 19.42 KiB | ±6.0% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 17.0 ns | 58,920,008 次/s | 85.31 MiB | 20.84 KiB | ±3.4% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 74.0 ns | 13,558,883 次/s | 84.26 MiB | 20.28 KiB | ±5.4% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。cron.json 一行只量中途变更的开销，不执行任务：任务表取生产上限（128 个任务、每个 16 个动作，本地来源相对数据根），每次改动其中 1 个任务后按生产顺序读取并严格解析六份可热重载文件（含逐项核对本地来源）、替换快照并按任务名对账调度器；改写与写盘属于部署方，不计时；文件监听的防抖等待、随后的广告检测与 AI 闲聊可用性重算和热重载日志也不计入。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 755 次/s | 1.33 ms | 1.17 ms | 2.00 ms | 9.30 ms | 755 条记录/s | 3.91 MiB | ±8.3% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 293 次/s | 3.41 ms | 3.06 ms | 5.29 ms | 16.80 ms | 37,554 条记录/s | 21.42 MiB | ±3.1% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 604 次/s | 1.66 ms | 1.56 ms | 2.33 ms | 8.63 ms | 604 条记录/s | 3.15 MiB | ±4.7% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 473 次/s | 2.17 ms | 1.87 ms | 3.07 ms | 20.80 ms | 473 条记录/s | 3.13 MiB | ±15.6% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 478 次/s | 2.10 ms | 1.88 ms | 2.90 ms | 14.64 ms | 478 条记录/s | 3.13 MiB | ±7.0% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 264 次/s | 3.81 ms | 3.26 ms | 6.18 ms | 29.49 ms | 264 条记录/s | 5.55 MiB | ±7.0% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 665 次/s | 1.54 ms | 1.41 ms | 2.09 ms | 10.00 ms | 665 条记录/s | 4.16 MiB | ±16.4% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 470 次/s | 2.13 ms | 1.89 ms | 3.37 ms | 9.19 ms | 470 条记录/s | 1.20 MiB | ±2.4% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 4,249 次/s | 233.0 µs | 201.3 µs | 391.2 µs | 723.3 µs | 4,249 条记录/s | 0 B | ±4.1% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 5 次/s | 197.6 ms | 196.6 ms | 204.0 ms | 212.0 ms | 5 条记录/s | 0 B | ±1.1% |
| cron.json 中途改动 1 个任务：热重载并重排调度（满规格任务表）<br><code>cron-config-reload</code> | 7 次/s | 135.3 ms | 134.2 ms | 140.5 ms | 146.5 ms | 7 条记录/s | 7.31 MiB | ±0.6% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 30,023,058 次/s | 266.6 ns | 0 B | 5.65 KiB | ±2.0% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 34,847 次/s | 3.80 ms | 56.32 MiB | 42.21 KiB | ±17.4% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 75,231 次/s | 106.4 µs | 5.29 MiB | 71.72 KiB | ±1.3% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 13,533 次/s | 591.4 µs | 34.01 MiB | 290.40 KiB | ±2.1% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 41,103 次/s | 3.15 ms | 73.14 MiB | 134.49 KiB | ±10.5% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 14,640 次/s | 8.74 ms | 12.63 MiB | 419.49 KiB | ±1.0% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 18.2 ns | 54,990,615 次/s | 94.12 MiB | 21.67 KiB | ±4.3% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 36.8 ns | 27,157,169 次/s | 85.19 MiB | 22.17 KiB | ±0.8% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 18.6 ns | 53,998,715 次/s | 93.19 MiB | 23.78 KiB | ±6.1% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 123.7 ms | 1.40 MiB | 6.43 KiB | ±4.3% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 17.05 ms | 0 B | -3.60 KiB | ±6.2% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：09 命令与行为参考](09-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#10-性能基准) · [下一页：11 常见问题 →](11-faq.md)

</div>
