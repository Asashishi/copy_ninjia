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

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-09-27T14:46:45Z · 进程启动到本地恢复就绪 392.8 ms · 单条群消息进入主干并完成基础分发 153.3 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 822.6 µs / 1,144 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.90 ms / 487 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-27T14:46:45Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,429 |
| 进程读入 | 167.27 MiB |
| 进程写出 | 174.17 MiB |
| 块设备读 | 0 B |
| 块设备写 | 193.43 MiB |
| 读系统调用 | 52,104 |
| 写系统调用 | 86,120 |
| mock 根落盘 | 14.17 MiB |
| mock 根文件数 | 104 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 160.1 ms | ±8.4% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 15.66 ms | ±21.2% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 691.6 µs | ±6.3% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.27 ms | ±11.1% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.56 ms | ±7.0% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 344.0 µs | ±8.9% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 197.8 ms | ±3.2% |
| 填充主线程热缓存<br><code>hydrate</code> | 284.8 µs | ±3.2% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 392.8 ms | ±2.4% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 117.60 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 153.3 ns | 6,567,743 次/s | 91.65 MiB | 6.67 KiB | ±8.1% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 107.2 ns | 9,359,660 次/s | 90.89 MiB | 20.33 KiB | ±5.5% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 15.4 ns | 64,873,966 次/s | 77.46 MiB | 21.69 KiB | ±0.4% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 29.0 ns | 34,528,297 次/s | 77.74 MiB | 20.80 KiB | ±2.3% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 34.7 ns | 28,831,816 次/s | 79.34 MiB | 21.88 KiB | ±3.2% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.8 ns | 1,179,564,321 次/s | 76.19 MiB | 23.08 KiB | ±0.7% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 51.1 ns | 19,604,560 次/s | 79.05 MiB | 20.30 KiB | ±2.9% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.0 ns | 252,194,565 次/s | 76.89 MiB | 20.80 KiB | ±3.8% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 9.8 ns | 102,123,697 次/s | 76.92 MiB | 20.11 KiB | ±0.4% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 42.0 ns | 23,837,416 次/s | 79.33 MiB | 22.79 KiB | ±1.0% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.063 µs | 942,477 次/s | 102.10 MiB | 20.88 KiB | ±3.7% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 93.0 ns | 10,760,412 次/s | 85.48 MiB | 24.11 KiB | ±1.5% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 32.6 ns | 33,539,232 次/s | 85.82 MiB | 21.56 KiB | ±32.1% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 49.3 ns | 20,291,476 次/s | 79.29 MiB | 23.50 KiB | ±2.6% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 280.9 ns | 3,581,666 次/s | 118.48 MiB | 5.63 MiB | ±8.0% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 304.5 ns | 3,286,420 次/s | 155.15 MiB | 20.14 KiB | ±2.4% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.3 ns | 234,918,761 次/s | 77.91 MiB | 21.25 KiB | ±0.7% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.431 µs | 411,377 次/s | 89.14 MiB | 23.60 KiB | ±1.4% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 97.7 ns | 10,240,051 次/s | 123.18 MiB | 23.72 KiB | ±2.9% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 270.4 ns | 3,700,496 次/s | 89.06 MiB | 24.58 KiB | ±2.5% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 37.68 µs | 26,542 次/s | 101.73 MiB | 21.58 KiB | ±0.3% |
| 提取回复引用<br><code>reply-reference</code> | 26.2 ns | 38,402,674 次/s | 91.02 MiB | 22.95 KiB | ±9.2% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 46.6 ns | 21,475,191 次/s | 97.01 MiB | 20.76 KiB | ±1.2% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 8.2 ns | 149,247,003 次/s | 77.46 MiB | 22.91 KiB | ±36.6% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 36.6 ns | 27,366,978 次/s | 86.18 MiB | 19.57 KiB | ±3.5% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 20.9 ns | 47,744,567 次/s | 77.15 MiB | 20.66 KiB | ±0.5% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 16.8 ns | 59,560,912 次/s | 79.43 MiB | 22.41 KiB | ±5.0% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 75.0 ns | 13,327,521 次/s | 78.46 MiB | 20.51 KiB | ±1.0% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 897 次/s | 1.12 ms | 984.5 µs | 1.50 ms | 8.70 ms | 897 条记录/s | 3.91 MiB | ±3.4% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 147 次/s | 6.82 ms | 7.80 ms | 11.14 ms | 18.52 ms | 18,758 条记录/s | 21.42 MiB | ±0.5% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 693 次/s | 1.44 ms | 1.33 ms | 1.90 ms | 8.42 ms | 693 条记录/s | 3.15 MiB | ±1.7% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 680 次/s | 1.47 ms | 1.36 ms | 1.98 ms | 6.12 ms | 680 条记录/s | 3.13 MiB | ±3.8% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 692 次/s | 1.45 ms | 1.36 ms | 1.93 ms | 5.33 ms | 692 条记录/s | 3.13 MiB | ±2.3% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 369 次/s | 2.71 ms | 2.47 ms | 4.01 ms | 9.88 ms | 369 条记录/s | 5.55 MiB | ±2.2% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 860 次/s | 1.16 ms | 1.06 ms | 1.57 ms | 8.78 ms | 860 条记录/s | 4.16 MiB | ±1.3% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 487 次/s | 2.05 ms | 1.90 ms | 2.98 ms | 5.87 ms | 487 条记录/s | 1.20 MiB | ±2.4% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 1,144 次/s | 866.7 µs | 822.6 µs | 1.16 ms | 1.49 ms | 1,144 条记录/s | 0 B | ±1.4% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 5 次/s | 189.6 ms | 188.4 ms | 194.2 ms | 202.6 ms | 5 条记录/s | 0 B | ±1.8% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 28,559,631 次/s | 280.2 ns | 0 B | 5.75 KiB | ±1.5% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 20,320 次/s | 6.30 ms | 56.29 MiB | 47.11 KiB | ±0.3% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 77,333 次/s | 103.5 µs | 5.29 MiB | 76.16 KiB | ±1.6% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 17,245 次/s | 464.6 µs | 2.92 MiB | 295.86 KiB | ±3.7% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 18,297 次/s | 7.00 ms | 73.14 MiB | 188.41 KiB | ±1.7% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 14,437 次/s | 8.87 ms | 9.73 MiB | 222.27 KiB | ±2.4% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 16.6 ns | 60,724,326 次/s | 87.73 MiB | 23.01 KiB | ±7.7% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 35.6 ns | 28,117,502 次/s | 78.95 MiB | 23.81 KiB | ±1.4% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 19.1 ns | 52,707,016 次/s | 85.72 MiB | 24.05 KiB | ±7.8% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 120.3 ms | 1.74 MiB | 4.96 KiB | ±1.7% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 18.47 ms | 0 B | -3.60 KiB | ±1.5% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准) · [下一页：10 常见问题 →](10-faq.md)

</div>
