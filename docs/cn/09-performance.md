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

**最近一次全量基准** · Bun 1.4.0 · 3 轮取平均 · 2026-08-30T07:08:35Z · 进程启动到本地恢复就绪 458.7 ms · 单条群消息进入主干并完成基础分发 1.297 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.06 ms / 837 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 5.52 ms / 156 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| 内核 | linux 6.8.0-138-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-08-30T07:08:35Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 385,931,405 |
| 进程读入 | 120.35 MiB |
| 进程写出 | 173.64 MiB |
| 块设备读 | 0 B |
| 块设备写 | 193.11 MiB |
| 读系统调用 | 40,111 |
| 写系统调用 | 83,981 |
| mock 根落盘 | 13.91 MiB |
| mock 根文件数 | 161 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 133.2 ms | ±4.0% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 21.70 ms | ±6.1% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 718.5 µs | ±7.4% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.68 ms | ±8.6% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.18 ms | ±13.8% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 873.8 µs | ±13.7% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 271.8 ms | ±2.5% |
| 填充主线程热缓存<br><code>hydrate</code> | 748.1 µs | ±10.3% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 458.7 ms | ±2.6% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 105.88 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.297 µs | 771,400 次/s | 77.88 MiB | 25.33 KiB | ±2.7% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 157.2 ns | 6,422,467 次/s | 81.60 MiB | 22.49 KiB | ±9.8% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 7.5 ns | 532,558,074 次/s | 66.44 MiB | 21.75 KiB | ±64.3% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 25.9 ns | 38,651,942 次/s | 67.20 MiB | 20.56 KiB | ±3.9% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.8 ns | 1,271,163,082 次/s | 66.01 MiB | 22.05 KiB | ±17.0% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 54.7 ns | 18,320,317 次/s | 69.09 MiB | 22.11 KiB | ±5.0% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.1 ns | 242,100,823 次/s | 66.54 MiB | 22.20 KiB | ±1.8% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 13.4 ns | 74,944,892 次/s | 67.56 MiB | 21.18 KiB | ±4.8% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 48.3 ns | 20,747,805 次/s | 69.12 MiB | 16.99 KiB | ±3.4% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 12.39 µs | 80,826 次/s | 86.87 MiB | 23.91 KiB | ±4.2% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 129.9 ns | 7,707,585 次/s | 76.40 MiB | 19.24 KiB | ±3.2% |
| 推进临时白名单日内活动与授权边沿<br><code>temporary-whitelist-activity</code> | 72.6 ns | 14,066,238 次/s | 76.63 MiB | 20.40 KiB | ±15.1% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 52.8 ns | 19,074,332 次/s | 69.39 MiB | 19.48 KiB | ±8.5% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 481.9 ns | 2,103,407 次/s | 104.30 MiB | 5.63 MiB | ±11.5% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 459.9 ns | 2,177,657 次/s | 124.42 MiB | 20.17 KiB | ±3.8% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.6 ns | 219,409,199 次/s | 67.39 MiB | 21.91 KiB | ±7.3% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.415 µs | 184,723 次/s | 74.90 MiB | -2.07 MiB | ±1.3% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 117.4 ns | 8,593,907 次/s | 105.66 MiB | 23.77 KiB | ±9.5% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 707.7 ns | 1,415,560 次/s | 80.88 MiB | 22.78 KiB | ±4.3% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 54.40 µs | 18,384 次/s | 88.47 MiB | -2.08 MiB | ±1.0% |
| 提取回复引用<br><code>reply-reference</code> | 27.6 ns | 36,517,279 次/s | 75.98 MiB | 24.09 KiB | ±8.0% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 107.8 ns | 9,283,499 次/s | 85.01 MiB | 21.86 KiB | ±2.8% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.1 ns | 246,999,051 次/s | 70.82 MiB | 22.38 KiB | ±2.7% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 38.5 ns | 25,995,875 次/s | 73.93 MiB | 19.37 KiB | ±2.0% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 29.4 ns | 34,331,840 次/s | 73.01 MiB | 21.94 KiB | ±10.5% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 11.5 ns | 87,021,115 次/s | 70.08 MiB | 19.60 KiB | ±1.9% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 75.7 ns | 13,214,417 次/s | 68.15 MiB | 19.15 KiB | ±2.2% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 406 次/s | 2.46 ms | 1.97 ms | 4.40 ms | 54.69 ms | 406 条记录/s | 3.91 MiB | ±4.5% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 75 次/s | 13.28 ms | 13.47 ms | 23.07 ms | 43.90 ms | 9,663 条记录/s | 20.53 MiB | ±5.3% |
| 累计 1 条临时白名单活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 329 次/s | 3.06 ms | 2.47 ms | 6.17 ms | 16.79 ms | 329 条记录/s | 3.15 MiB | ±8.6% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 312 次/s | 3.21 ms | 2.44 ms | 6.97 ms | 43.21 ms | 312 条记录/s | 3.13 MiB | ±6.4% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 329 次/s | 3.05 ms | 2.43 ms | 5.89 ms | 18.22 ms | 329 条记录/s | 3.13 MiB | ±5.1% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 187 次/s | 5.34 ms | 4.51 ms | 10.33 ms | 17.16 ms | 187 条记录/s | 7.03 MiB | ±2.3% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 415 次/s | 2.41 ms | 2.02 ms | 4.06 ms | 17.15 ms | 415 条记录/s | 4.16 MiB | ±3.5% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 156 次/s | 6.45 ms | 5.52 ms | 11.58 ms | 26.35 ms | 156 条记录/s | 1.83 MiB | ±8.2% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 837 次/s | 1.19 ms | 1.06 ms | 1.83 ms | 3.44 ms | 837 条记录/s | 0 B | ±5.9% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 25,807,307 次/s | 310.1 ns | 0 B | 7.08 KiB | ±2.1% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 10,581 次/s | 12.10 ms | 61.90 MiB | -1.66 MiB | ±1.1% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 42,406 次/s | 189.0 µs | 4.86 MiB | -1.70 MiB | ±4.1% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 11,340 次/s | 706.4 µs | 2.70 MiB | 273.61 KiB | ±3.7% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 10,263 次/s | 12.48 ms | 67.73 MiB | -1.56 MiB | ±1.7% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 8,064 次/s | 15.89 ms | 9.00 MiB | 201.28 KiB | ±3.1% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 16.7 ns | 59,810,662 次/s | 75.86 MiB | 23.00 KiB | ±2.5% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 39.7 ns | 25,721,459 次/s | 69.16 MiB | 22.24 KiB | ±15.4% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 18.1 ns | 55,368,867 次/s | 74.80 MiB | 23.79 KiB | ±5.0% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 163.3 ms | 2.72 MiB | 4.41 KiB | ±3.3% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 33.26 ms | 0 B | -4.88 KiB | ±23.2% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
