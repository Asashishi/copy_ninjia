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

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-09-07T09:40:53Z · 进程启动到本地恢复就绪 521.5 ms · 单条群消息进入主干并完成基础分发 1.253 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.11 ms / 806 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 5.99 ms / 128 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-138-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-07T09:40:53Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,405 |
| 进程读入 | 121.29 MiB |
| 进程写出 | 178.32 MiB |
| 块设备读 | 0 B |
| 块设备写 | 197.80 MiB |
| 读系统调用 | 39,990 |
| 写系统调用 | 85,180 |
| mock 根落盘 | 17.50 MiB |
| mock 根文件数 | 160 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 149.2 ms | ±8.8% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 21.08 ms | ±21.9% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 736.7 µs | ±5.4% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.75 ms | ±6.0% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 8.37 ms | ±11.1% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 1.55 ms | ±38.9% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 319.1 ms | ±2.8% |
| 填充主线程热缓存<br><code>hydrate</code> | 2.81 ms | ±51.6% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 521.5 ms | ±5.2% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 112.24 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.253 µs | 800,273 次/s | 79.56 MiB | 25.97 KiB | ±5.2% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 131.9 ns | 7,794,342 次/s | 86.60 MiB | 21.89 KiB | ±17.5% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 15.7 ns | 63,810,719 次/s | 72.20 MiB | 22.16 KiB | ±5.6% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 35.5 ns | 28,221,345 次/s | 72.58 MiB | 20.72 KiB | ±5.3% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 48.5 ns | 20,861,687 次/s | 73.31 MiB | 21.11 KiB | ±10.9% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.7 ns | 1,378,443,448 次/s | 71.76 MiB | 21.90 KiB | ±12.0% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 54.0 ns | 18,564,501 次/s | 73.85 MiB | 22.90 KiB | ±5.2% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.4 ns | 230,410,421 次/s | 71.28 MiB | 23.56 KiB | ±8.4% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 15.6 ns | 64,279,124 次/s | 72.44 MiB | 22.25 KiB | ±6.9% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 43.2 ns | 23,207,847 次/s | 73.67 MiB | 17.70 KiB | ±4.0% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 13.25 µs | 75,608 次/s | 93.72 MiB | 22.66 KiB | ±4.3% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 122.7 ns | 8,160,298 次/s | 79.42 MiB | 21.97 KiB | ±4.0% |
| 推进临时白名单日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 41.7 ns | 26,626,996 次/s | 79.47 MiB | 23.35 KiB | ±34.8% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 51.3 ns | 19,558,569 次/s | 74.01 MiB | 21.22 KiB | ±6.0% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 447.2 ns | 2,240,059 次/s | 118.04 MiB | 5.63 MiB | ±4.1% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 463.0 ns | 2,162,609 次/s | 127.87 MiB | 21.45 KiB | ±3.4% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 5.6 ns | 182,278,739 次/s | 72.78 MiB | 21.54 KiB | ±12.0% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.153 µs | 194,096 次/s | 82.27 MiB | 23.78 KiB | ±1.0% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 144.2 ns | 6,950,551 次/s | 114.95 MiB | 24.18 KiB | ±4.7% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 336.8 ns | 2,972,284 次/s | 97.47 MiB | 26.09 KiB | ±3.2% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 57.40 µs | 17,425 次/s | 95.10 MiB | 23.12 KiB | ±1.5% |
| 提取回复引用<br><code>reply-reference</code> | 31.4 ns | 32,575,313 次/s | 81.13 MiB | 24.12 KiB | ±14.6% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 70.5 ns | 14,255,365 次/s | 85.00 MiB | 21.83 KiB | ±7.1% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 9.6 ns | 148,062,356 次/s | 76.02 MiB | 22.54 KiB | ±63.8% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 36.9 ns | 27,771,939 次/s | 80.40 MiB | 20.78 KiB | ±16.5% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 25.5 ns | 39,411,648 次/s | 71.93 MiB | 22.43 KiB | ±5.8% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 12.1 ns | 83,051,920 次/s | 74.96 MiB | 22.75 KiB | ±3.6% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 82.6 ns | 12,115,567 次/s | 72.69 MiB | 22.00 KiB | ±3.4% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 356 次/s | 2.81 ms | 1.98 ms | 7.33 ms | 54.71 ms | 356 条记录/s | 3.91 MiB | ±4.9% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 70 次/s | 14.25 ms | 14.44 ms | 25.09 ms | 41.99 ms | 8,988 条记录/s | 20.53 MiB | ±3.6% |
| 累计 1 条临时白名单活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 277 次/s | 3.62 ms | 2.76 ms | 9.80 ms | 22.00 ms | 277 条记录/s | 3.15 MiB | ±4.8% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 236 次/s | 4.58 ms | 3.47 ms | 12.63 ms | 23.94 ms | 236 条记录/s | 3.13 MiB | ±25.1% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 284 次/s | 3.53 ms | 2.69 ms | 9.98 ms | 21.32 ms | 284 条记录/s | 3.13 MiB | ±7.0% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 171 次/s | 5.85 ms | 4.67 ms | 14.22 ms | 25.40 ms | 171 条记录/s | 11.72 MiB | ±3.7% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 368 次/s | 2.71 ms | 2.10 ms | 5.48 ms | 26.51 ms | 368 条记录/s | 4.16 MiB | ±2.9% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 128 次/s | 7.85 ms | 5.99 ms | 19.36 ms | 42.69 ms | 128 条记录/s | 1.83 MiB | ±6.4% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 806 次/s | 1.23 ms | 1.11 ms | 1.87 ms | 2.93 ms | 806 条记录/s | 0 B | ±1.8% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 26,150,494 次/s | 306.2 ns | 0 B | 9.54 KiB | ±2.9% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 9,584 次/s | 13.37 ms | 61.90 MiB | 30.35 KiB | ±3.6% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 40,990 次/s | 195.2 µs | 4.86 MiB | 59.19 KiB | ±0.7% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 11,525 次/s | 694.3 µs | 2.70 MiB | 273.95 KiB | ±1.3% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 8,446 次/s | 15.36 ms | 67.73 MiB | 142.69 KiB | ±11.0% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 7,902 次/s | 16.26 ms | 9.00 MiB | 187.75 KiB | ±6.0% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 18.9 ns | 53,444,357 次/s | 79.20 MiB | 23.69 KiB | ±11.0% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 43.1 ns | 23,611,213 次/s | 73.19 MiB | 23.69 KiB | ±12.4% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 20.8 ns | 49,954,784 次/s | 80.42 MiB | 25.85 KiB | ±20.2% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 157.3 ms | 1.85 MiB | 4.89 KiB | ±5.0% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 35.49 ms | 0 B | -6.36 KiB | ±7.5% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
