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

**最近一次全量基准** · Bun 1.4.0 · 3 轮取平均 · 2026-08-31T13:46:19Z · 进程启动到本地恢复就绪 470.4 ms · 单条群消息进入主干并完成基础分发 1.222 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.05 ms / 844 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 5.84 ms / 140 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| 内核 | linux 6.8.0-138-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-08-31T13:46:19Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 385,931,405 |
| 进程读入 | 120.38 MiB |
| 进程写出 | 173.64 MiB |
| 块设备读 | 1.33 KiB |
| 块设备写 | 193.11 MiB |
| 读系统调用 | 40,130 |
| 写系统调用 | 83,991 |
| mock 根落盘 | 14.55 MiB |
| mock 根文件数 | 163 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 131.4 ms | ±2.7% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 23.06 ms | ±6.3% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 730.1 µs | ±13.4% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.62 ms | ±7.0% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 8.09 ms | ±20.1% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 884.6 µs | ±2.6% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 281.6 ms | ±3.4% |
| 填充主线程热缓存<br><code>hydrate</code> | 819.5 µs | ±31.7% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 470.4 ms | ±2.1% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 103.44 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.222 µs | 821,346 次/s | 75.11 MiB | 25.39 KiB | ±5.9% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 156.0 ns | 6,494,178 次/s | 80.27 MiB | 23.11 KiB | ±11.7% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 10.4 ns | 96,412,899 次/s | 67.44 MiB | 22.14 KiB | ±1.1% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 28.2 ns | 35,600,850 次/s | 67.82 MiB | 22.14 KiB | ±6.1% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.7 ns | 1,412,634,107 次/s | 66.60 MiB | 21.78 KiB | ±9.3% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 52.6 ns | 19,125,549 次/s | 69.89 MiB | 23.00 KiB | ±7.8% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.6 ns | 218,826,607 次/s | 67.14 MiB | 23.01 KiB | ±8.6% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 14.0 ns | 71,759,559 次/s | 67.61 MiB | 21.18 KiB | ±4.6% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 53.4 ns | 18,756,354 次/s | 69.64 MiB | 21.58 KiB | ±3.1% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 13.23 µs | 75,632 次/s | 87.09 MiB | 24.14 KiB | ±1.8% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 110.8 ns | 9,040,905 次/s | 75.10 MiB | 17.33 KiB | ±4.5% |
| 推进临时白名单日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 44.5 ns | 25,651,705 次/s | 74.18 MiB | 23.34 KiB | ±40.0% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 51.9 ns | 19,273,868 次/s | 69.78 MiB | 22.13 KiB | ±1.8% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 516.1 ns | 1,945,808 次/s | 105.27 MiB | 5.63 MiB | ±6.5% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 451.4 ns | 2,216,695 次/s | 123.80 MiB | 21.36 KiB | ±2.6% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.4 ns | 225,268,586 次/s | 67.93 MiB | 21.91 KiB | ±3.3% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.519 µs | 181,274 次/s | 75.20 MiB | -2.07 MiB | ±2.2% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 134.4 ns | 7,458,547 次/s | 106.24 MiB | 24.08 KiB | ±4.9% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 718.7 ns | 1,391,686 次/s | 82.56 MiB | 22.93 KiB | ±1.5% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 57.20 µs | 17,535 次/s | 88.61 MiB | -2.08 MiB | ±5.6% |
| 提取回复引用<br><code>reply-reference</code> | 24.4 ns | 41,210,241 次/s | 79.18 MiB | 23.94 KiB | ±6.0% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 101.1 ns | 9,911,469 次/s | 82.43 MiB | 22.50 KiB | ±4.0% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 9.1 ns | 186,607,995 次/s | 72.38 MiB | 23.37 KiB | ±80.4% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 35.1 ns | 28,665,345 次/s | 74.63 MiB | 21.23 KiB | ±8.1% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 28.6 ns | 35,135,492 次/s | 73.36 MiB | 22.26 KiB | ±7.9% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 12.3 ns | 81,751,028 次/s | 70.29 MiB | 20.05 KiB | ±7.1% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 77.6 ns | 12,899,693 次/s | 69.53 MiB | 21.41 KiB | ±3.3% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 426 次/s | 2.35 ms | 1.90 ms | 4.09 ms | 19.52 ms | 426 条记录/s | 3.91 MiB | ±3.1% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 52 次/s | 19.98 ms | 17.07 ms | 47.28 ms | 88.66 ms | 6,668 条记录/s | 20.53 MiB | ±18.5% |
| 累计 1 条临时白名单活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 175 次/s | 6.15 ms | 5.38 ms | 14.77 ms | 43.77 ms | 175 条记录/s | 3.15 MiB | ±28.7% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 321 次/s | 3.12 ms | 2.47 ms | 7.03 ms | 22.56 ms | 321 条记录/s | 3.13 MiB | ±5.6% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 272 次/s | 3.70 ms | 2.79 ms | 8.80 ms | 23.00 ms | 272 条记录/s | 3.13 MiB | ±7.8% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 168 次/s | 6.06 ms | 4.57 ms | 12.82 ms | 24.48 ms | 168 条记录/s | 7.03 MiB | ±12.6% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 380 次/s | 2.67 ms | 2.15 ms | 5.01 ms | 19.87 ms | 380 条记录/s | 4.16 MiB | ±13.0% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 140 次/s | 7.17 ms | 5.84 ms | 14.74 ms | 29.44 ms | 140 条记录/s | 1.83 MiB | ±5.7% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 844 次/s | 1.17 ms | 1.05 ms | 1.94 ms | 3.17 ms | 844 条记录/s | 0 B | ±7.1% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 25,938,425 次/s | 309.8 ns | 0 B | 5.93 KiB | ±6.6% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 10,636 次/s | 12.04 ms | 61.90 MiB | -1.69 MiB | ±2.0% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 43,489 次/s | 184.0 µs | 4.86 MiB | -1.70 MiB | ±0.5% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 12,729 次/s | 628.7 µs | 2.70 MiB | 273.09 KiB | ±2.0% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 10,431 次/s | 12.27 ms | 67.73 MiB | -1.56 MiB | ±1.6% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 8,892 次/s | 14.42 ms | 9.00 MiB | 205.34 KiB | ±4.1% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 20.2 ns | 52,060,087 次/s | 74.86 MiB | 23.53 KiB | ±22.7% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 38.8 ns | 25,799,400 次/s | 69.78 MiB | 22.60 KiB | ±1.9% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 19.0 ns | 52,791,648 次/s | 75.48 MiB | 24.52 KiB | ±6.3% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 155.5 ms | 1.97 MiB | 4.92 KiB | ±7.9% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 29.43 ms | 0 B | -4.95 KiB | ±9.5% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
