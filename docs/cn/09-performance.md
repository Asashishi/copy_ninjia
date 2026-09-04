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

**最近一次全量基准** · Bun 1.4.0 · 3 轮取平均 · 2026-09-04T09:28:52Z · 进程启动到本地恢复就绪 541.0 ms · 单条群消息进入主干并完成基础分发 1.452 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 986.7 µs / 924 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 6.21 ms / 129 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| 内核 | linux 6.8.0-138-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-04T09:28:52Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 385,931,405 |
| 进程读入 | 121.30 MiB |
| 进程写出 | 178.31 MiB |
| 块设备读 | 0 B |
| 块设备写 | 197.80 MiB |
| 读系统调用 | 40,320 |
| 写系统调用 | 84,094 |
| mock 根落盘 | 14.94 MiB |
| mock 根文件数 | 163 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 159.2 ms | ±9.4% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 25.20 ms | ±15.7% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 909.4 µs | ±4.7% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.70 ms | ±14.9% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 7.14 ms | ±12.1% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 896.8 µs | ±11.3% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 316.9 ms | ±9.2% |
| 填充主线程热缓存<br><code>hydrate</code> | 704.5 µs | ±1.8% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 541.0 ms | ±2.0% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 110.51 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.452 µs | 690,168 次/s | 76.59 MiB | 24.78 KiB | ±4.8% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 200.2 ns | 5,004,909 次/s | 80.72 MiB | 23.69 KiB | ±4.4% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 15.5 ns | 69,356,402 次/s | 67.70 MiB | 22.27 KiB | ±24.4% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 28.9 ns | 34,605,867 次/s | 67.98 MiB | 23.03 KiB | ±1.7% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,107,862,947 次/s | 66.96 MiB | 22.48 KiB | ±8.9% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 50.8 ns | 19,703,589 次/s | 69.89 MiB | 24.37 KiB | ±3.7% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.8 ns | 209,271,438 次/s | 67.23 MiB | 23.50 KiB | ±9.2% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 13.3 ns | 74,978,903 次/s | 68.00 MiB | 23.27 KiB | ±2.8% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 55.1 ns | 18,706,425 次/s | 69.46 MiB | 21.38 KiB | ±17.6% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 14.46 µs | 69,328 次/s | 87.01 MiB | 25.72 KiB | ±4.6% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 133.2 ns | 7,600,057 次/s | 75.10 MiB | 22.55 KiB | ±11.0% |
| 推进临时白名单日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 50.3 ns | 20,690,601 次/s | 73.86 MiB | 22.58 KiB | ±18.6% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 59.8 ns | 16,812,196 次/s | 69.98 MiB | 20.33 KiB | ±7.5% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 496.7 ns | 2,066,343 次/s | 108.04 MiB | 5.63 MiB | ±15.3% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 589.5 ns | 1,712,594 次/s | 122.41 MiB | 20.82 KiB | ±9.8% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.9 ns | 212,392,920 次/s | 68.45 MiB | 22.32 KiB | ±18.3% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 6.000 µs | 166,882 次/s | 75.60 MiB | -2.11 MiB | ±3.6% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 124.4 ns | 8,065,939 次/s | 106.89 MiB | 23.76 KiB | ±5.9% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 342.8 ns | 2,917,472 次/s | 96.89 MiB | 27.70 KiB | ±1.2% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 61.18 µs | 16,348 次/s | 88.23 MiB | -2.12 MiB | ±1.5% |
| 提取回复引用<br><code>reply-reference</code> | 31.3 ns | 32,092,176 次/s | 78.57 MiB | 24.03 KiB | ±6.0% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 78.4 ns | 12,807,437 次/s | 79.09 MiB | 22.36 KiB | ±6.4% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.9 ns | 209,679,722 次/s | 71.59 MiB | 22.07 KiB | ±13.9% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 40.4 ns | 24,770,714 次/s | 74.89 MiB | 20.61 KiB | ±1.9% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 28.9 ns | 34,943,882 次/s | 68.07 MiB | 22.53 KiB | ±10.0% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 13.2 ns | 76,595,485 次/s | 70.38 MiB | 20.12 KiB | ±11.5% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 89.7 ns | 11,289,593 次/s | 68.65 MiB | 23.48 KiB | ±10.7% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 376 次/s | 2.66 ms | 2.03 ms | 5.97 ms | 21.89 ms | 376 条记录/s | 3.91 MiB | ±5.0% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 69 次/s | 14.45 ms | 14.44 ms | 25.48 ms | 38.61 ms | 8,858 条记录/s | 20.53 MiB | ±1.6% |
| 累计 1 条临时白名单活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 287 次/s | 3.49 ms | 2.67 ms | 8.42 ms | 24.78 ms | 287 条记录/s | 3.15 MiB | ±6.8% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 274 次/s | 3.69 ms | 3.08 ms | 8.01 ms | 24.28 ms | 274 条记录/s | 3.13 MiB | ±10.9% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 286 次/s | 3.50 ms | 2.84 ms | 7.75 ms | 18.45 ms | 286 条记录/s | 3.13 MiB | ±5.6% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 177 次/s | 5.68 ms | 4.54 ms | 13.48 ms | 25.93 ms | 177 条记录/s | 11.72 MiB | ±6.4% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 344 次/s | 2.91 ms | 2.26 ms | 7.16 ms | 19.46 ms | 344 条记录/s | 4.16 MiB | ±5.1% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 129 次/s | 7.73 ms | 6.21 ms | 17.48 ms | 31.97 ms | 129 条记录/s | 1.83 MiB | ±0.7% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 924 次/s | 1.07 ms | 986.7 µs | 1.56 ms | 2.15 ms | 924 条记录/s | 0 B | ±2.3% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 24,371,926 次/s | 330.3 ns | 0 B | 7.71 KiB | ±7.9% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 9,428 次/s | 13.58 ms | 61.90 MiB | -1.69 MiB | ±1.9% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 38,274 次/s | 209.3 µs | 4.86 MiB | -1.70 MiB | ±3.9% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 11,092 次/s | 721.4 µs | 2.70 MiB | 273.93 KiB | ±1.4% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 8,722 次/s | 14.72 ms | 67.73 MiB | -1.57 MiB | ±5.5% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 6,772 次/s | 19.00 ms | 9.00 MiB | 200.32 KiB | ±7.5% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 18.1 ns | 55,248,820 次/s | 76.18 MiB | 23.47 KiB | ±4.2% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 36.4 ns | 27,659,635 次/s | 69.97 MiB | 22.80 KiB | ±7.6% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 22.4 ns | 44,802,041 次/s | 75.46 MiB | 25.84 KiB | ±4.3% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 157.7 ms | 1.98 MiB | 4.96 KiB | ±7.2% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 36.32 ms | 0 B | -4.99 KiB | ±4.7% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
