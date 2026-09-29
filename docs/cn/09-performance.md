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

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-09-29T07:27:46Z · 进程启动到本地恢复就绪 370.1 ms · 单条群消息进入主干并完成基础分发 159.5 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 233.1 µs / 3,767 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.97 ms / 444 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-29T07:27:46Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,429 |
| 进程读入 | 164.35 MiB |
| 进程写出 | 174.17 MiB |
| 块设备读 | 1.33 KiB |
| 块设备写 | 193.43 MiB |
| 读系统调用 | 51,722 |
| 写系统调用 | 86,117 |
| mock 根落盘 | 14.19 MiB |
| mock 根文件数 | 106 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 124.5 ms | ±9.6% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 15.12 ms | ±10.3% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 795.2 µs | ±8.2% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.32 ms | ±2.8% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 5.50 ms | ±4.8% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 707.8 µs | ±4.7% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 208.6 ms | ±4.3% |
| 填充主线程热缓存<br><code>hydrate</code> | 448.5 µs | ±45.2% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 370.1 ms | ±2.3% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 108.39 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 159.5 ns | 6,281,062 次/s | 90.65 MiB | 1.97 KiB | ±4.3% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 111.7 ns | 9,008,459 次/s | 90.70 MiB | 21.57 KiB | ±7.9% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 16.5 ns | 60,621,454 次/s | 76.43 MiB | 20.72 KiB | ±3.3% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 30.1 ns | 33,296,275 次/s | 76.41 MiB | 21.92 KiB | ±3.1% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 35.2 ns | 28,406,355 次/s | 78.05 MiB | 20.21 KiB | ±3.0% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,151,321,725 次/s | 75.00 MiB | 21.16 KiB | ±1.1% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 49.7 ns | 20,162,520 次/s | 77.59 MiB | 20.66 KiB | ±4.5% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.1 ns | 245,959,946 次/s | 75.52 MiB | 22.04 KiB | ±4.0% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 10.8 ns | 93,437,065 次/s | 76.26 MiB | 19.96 KiB | ±9.3% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 43.3 ns | 23,109,898 次/s | 77.70 MiB | 20.36 KiB | ±2.1% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.140 µs | 880,198 次/s | 102.87 MiB | 19.56 KiB | ±5.6% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 97.7 ns | 10,237,045 次/s | 83.24 MiB | 21.92 KiB | ±0.7% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 41.5 ns | 27,754,673 次/s | 84.35 MiB | 21.35 KiB | ±32.0% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 50.9 ns | 19,650,710 次/s | 77.96 MiB | 22.01 KiB | ±1.9% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 284.6 ns | 3,515,653 次/s | 116.39 MiB | 5.63 MiB | ±2.2% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 356.1 ns | 2,811,974 次/s | 136.62 MiB | 19.93 KiB | ±3.7% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.4 ns | 226,177,176 次/s | 76.82 MiB | 21.19 KiB | ±2.1% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.510 µs | 398,500 次/s | 87.58 MiB | 23.46 KiB | ±1.7% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 100.7 ns | 9,931,084 次/s | 121.46 MiB | 23.68 KiB | ±1.5% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 311.2 ns | 3,222,841 次/s | 87.17 MiB | 23.91 KiB | ±5.3% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 40.94 µs | 24,454 次/s | 100.10 MiB | 21.61 KiB | ±3.1% |
| 提取回复引用<br><code>reply-reference</code> | 36.9 ns | 29,083,285 次/s | 89.57 MiB | 21.84 KiB | ±28.8% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 50.9 ns | 19,660,904 次/s | 95.99 MiB | 21.87 KiB | ±2.5% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 8.2 ns | 146,341,229 次/s | 76.46 MiB | 22.74 KiB | ±35.3% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 40.2 ns | 24,898,824 次/s | 85.40 MiB | 19.18 KiB | ±3.9% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 22.2 ns | 44,951,097 次/s | 76.19 MiB | 21.25 KiB | ±1.2% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 16.5 ns | 60,654,788 次/s | 77.78 MiB | 22.16 KiB | ±2.9% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 77.6 ns | 12,925,251 次/s | 77.13 MiB | 22.22 KiB | ±5.0% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 758 次/s | 1.32 ms | 1.17 ms | 1.98 ms | 11.06 ms | 758 条记录/s | 3.91 MiB | ±2.7% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 122 次/s | 8.21 ms | 9.06 ms | 13.89 ms | 23.53 ms | 15,592 条记录/s | 21.42 MiB | ±0.6% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 582 次/s | 1.72 ms | 1.52 ms | 2.72 ms | 9.76 ms | 582 条记录/s | 3.15 MiB | ±5.9% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 565 次/s | 1.77 ms | 1.59 ms | 2.68 ms | 9.79 ms | 565 条记录/s | 3.13 MiB | ±3.1% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 536 次/s | 1.88 ms | 1.54 ms | 3.57 ms | 16.38 ms | 536 条记录/s | 3.13 MiB | ±10.1% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 334 次/s | 2.99 ms | 2.70 ms | 4.24 ms | 13.33 ms | 334 条记录/s | 5.55 MiB | ±2.6% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 693 次/s | 1.45 ms | 1.23 ms | 2.38 ms | 18.24 ms | 693 条记录/s | 4.16 MiB | ±5.5% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 444 次/s | 2.26 ms | 1.97 ms | 3.97 ms | 10.12 ms | 444 条记录/s | 1.20 MiB | ±8.0% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 3,767 次/s | 263.0 µs | 233.1 µs | 438.0 µs | 606.7 µs | 3,767 条记录/s | 0 B | ±3.6% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 5 次/s | 192.5 ms | 190.6 ms | 204.5 ms | 208.4 ms | 5 条记录/s | 0 B | ±1.7% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 28,766,674 次/s | 278.4 ns | 0 B | 3.98 KiB | ±3.3% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 16,120 次/s | 7.95 ms | 56.29 MiB | 48.50 KiB | ±3.5% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 60,700 次/s | 131.8 µs | 5.29 MiB | 76.42 KiB | ±1.3% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 14,305 次/s | 559.3 µs | 2.92 MiB | 296.27 KiB | ±1.0% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 14,632 次/s | 8.75 ms | 73.14 MiB | 188.63 KiB | ±2.8% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 11,744 次/s | 10.90 ms | 9.73 MiB | 201.59 KiB | ±0.6% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 19.5 ns | 52,280,193 次/s | 83.97 MiB | 21.54 KiB | ±14.5% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 38.7 ns | 25,990,038 次/s | 78.05 MiB | 23.05 KiB | ±7.3% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 20.7 ns | 48,479,249 次/s | 84.96 MiB | 25.26 KiB | ±3.7% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 143.1 ms | 1.94 MiB | 4.96 KiB | ±9.7% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 31.29 ms | 0 B | -4.94 KiB | ±4.5% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准) · [下一页：10 常见问题 →](10-faq.md)

</div>
