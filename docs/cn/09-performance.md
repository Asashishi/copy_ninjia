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

专项场景及 `diskTransport` 的复现方式与测量边界见 [05 开发流程与质量门禁](05-dev-workflow.md#专项场景与传输压力验证)。专项输出和热路径门禁分别记录，不替换下方全量基准的生成区块。

<!-- performance-benchmark:start -->

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-09-07T06:24:08Z · 进程启动到本地恢复就绪 569.9 ms · 单条群消息进入主干并完成基础分发 1.348 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.12 ms / 817 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 9.93 ms / 88 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-138-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-07T06:24:08Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,405 |
| 进程读入 | 121.33 MiB |
| 进程写出 | 178.32 MiB |
| 块设备读 | 0 B |
| 块设备写 | 197.80 MiB |
| 读系统调用 | 40,034 |
| 写系统调用 | 85,110 |
| mock 根落盘 | 16.80 MiB |
| mock 根文件数 | 161 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 173.1 ms | ±4.1% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 27.70 ms | ±6.7% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 1.34 ms | ±30.0% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.82 ms | ±7.1% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 8.01 ms | ±0.8% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 1.12 ms | ±9.6% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 332.3 ms | ±5.2% |
| 填充主线程热缓存<br><code>hydrate</code> | 723.2 µs | ±14.8% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 569.9 ms | ±3.0% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 112.33 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.348 µs | 742,336 次/s | 80.88 MiB | 25.70 KiB | ±2.8% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 157.1 ns | 6,377,241 次/s | 88.81 MiB | 21.30 KiB | ±4.0% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 17.6 ns | 57,201,207 次/s | 72.41 MiB | 21.79 KiB | ±7.4% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 46.3 ns | 21,959,464 次/s | 73.24 MiB | 23.24 KiB | ±12.9% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 51.5 ns | 19,696,952 次/s | 73.58 MiB | 23.33 KiB | ±12.2% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,150,684,806 次/s | 71.61 MiB | 22.83 KiB | ±19.5% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 58.4 ns | 17,171,336 次/s | 73.87 MiB | 22.87 KiB | ±5.3% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 5.6 ns | 185,266,057 次/s | 72.14 MiB | 21.61 KiB | ±18.1% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 15.7 ns | 64,145,373 次/s | 72.20 MiB | 21.43 KiB | ±7.1% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 57.6 ns | 17,394,594 次/s | 73.76 MiB | 22.25 KiB | ±4.9% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 13.65 µs | 73,786 次/s | 94.71 MiB | 22.09 KiB | ±8.3% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 194.3 ns | 5,151,342 次/s | 80.44 MiB | 24.61 KiB | ±2.8% |
| 推进临时白名单日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 44.3 ns | 23,933,877 次/s | 80.34 MiB | 22.98 KiB | ±24.1% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 47.9 ns | 21,020,127 次/s | 74.51 MiB | 18.84 KiB | ±8.6% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 519.9 ns | 1,923,477 次/s | 118.11 MiB | 5.63 MiB | ±0.3% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 597.3 ns | 1,679,472 次/s | 128.10 MiB | 20.65 KiB | ±5.6% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 5.7 ns | 175,232,379 次/s | 72.79 MiB | 21.67 KiB | ±1.4% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 6.173 µs | 162,275 次/s | 83.01 MiB | 23.98 KiB | ±4.1% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 145.1 ns | 6,998,129 次/s | 115.00 MiB | 24.61 KiB | ±12.7% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 389.5 ns | 2,571,504 次/s | 96.08 MiB | 26.96 KiB | ±4.0% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 65.54 µs | 15,266 次/s | 96.34 MiB | 23.58 KiB | ±2.3% |
| 提取回复引用<br><code>reply-reference</code> | 35.1 ns | 28,838,223 次/s | 80.96 MiB | 24.86 KiB | ±10.6% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 85.6 ns | 11,784,309 次/s | 85.46 MiB | 22.41 KiB | ±9.9% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 11.7 ns | 157,624,234 次/s | 78.26 MiB | 23.05 KiB | ±85.2% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 44.0 ns | 23,384,876 次/s | 80.57 MiB | 19.47 KiB | ±15.9% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 31.9 ns | 31,394,852 次/s | 72.22 MiB | 21.91 KiB | ±2.4% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 14.1 ns | 71,328,213 次/s | 74.64 MiB | 21.39 KiB | ±6.7% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 93.3 ns | 10,847,505 次/s | 72.99 MiB | 22.53 KiB | ±11.3% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 248 次/s | 4.05 ms | 2.74 ms | 12.03 ms | 37.38 ms | 248 条记录/s | 3.91 MiB | ±5.9% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 55 次/s | 18.39 ms | 18.10 ms | 33.89 ms | 48.28 ms | 7,011 条记录/s | 20.53 MiB | ±8.7% |
| 累计 1 条临时白名单活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 244 次/s | 4.11 ms | 3.12 ms | 10.66 ms | 30.34 ms | 244 条记录/s | 3.15 MiB | ±6.4% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 199 次/s | 5.15 ms | 3.77 ms | 13.08 ms | 29.56 ms | 199 条记录/s | 3.13 MiB | ±15.7% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 206 次/s | 4.92 ms | 3.48 ms | 13.74 ms | 31.29 ms | 206 条记录/s | 3.13 MiB | ±12.8% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 128 次/s | 7.88 ms | 6.00 ms | 18.73 ms | 34.00 ms | 128 条记录/s | 11.72 MiB | ±9.9% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 267 次/s | 3.75 ms | 2.65 ms | 11.51 ms | 27.14 ms | 267 条记录/s | 4.16 MiB | ±6.0% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 88 次/s | 11.63 ms | 9.93 ms | 23.68 ms | 43.34 ms | 88 条记录/s | 1.83 MiB | ±17.4% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 817 次/s | 1.21 ms | 1.12 ms | 1.86 ms | 2.66 ms | 817 条记录/s | 0 B | ±0.3% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 19,606,319 次/s | 408.9 ns | 0 B | 8.34 KiB | ±4.7% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 5,870 次/s | 22.10 ms | 61.90 MiB | 30.85 KiB | ±11.0% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 31,726 次/s | 252.3 µs | 4.86 MiB | 61.83 KiB | ±2.4% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 9,790 次/s | 818.2 µs | 2.70 MiB | 274.18 KiB | ±3.7% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 7,392 次/s | 17.34 ms | 67.73 MiB | 154.03 KiB | ±3.9% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 6,554 次/s | 19.58 ms | 9.00 MiB | 189.05 KiB | ±5.0% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 17.1 ns | 58,449,590 次/s | 79.64 MiB | 23.89 KiB | ±1.9% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 49.5 ns | 20,214,169 次/s | 74.03 MiB | 23.13 KiB | ±2.2% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 22.4 ns | 45,095,505 次/s | 80.19 MiB | 25.22 KiB | ±10.7% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 206.4 ms | 1.90 MiB | 4.89 KiB | ±5.6% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 40.90 ms | 0 B | -7.73 KiB | ±1.9% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
