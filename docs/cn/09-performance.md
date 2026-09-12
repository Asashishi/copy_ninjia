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

专项场景及 `bun run perf:disk-transport` 的复现方式与测量边界见 [05 开发流程与质量门禁](05-dev-workflow.md#专项场景与传输压力验证)。专项输出和热路径门禁分别记录，不替换下方全量基准的生成区块。

<!-- performance-benchmark:start -->

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-09-12T11:30:34Z · 进程启动到本地恢复就绪 313.7 ms · 单条群消息进入主干并完成基础分发 138.4 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 793.1 µs / 1,207 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 2.90 ms / 323 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-12T11:30:34Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,405 |
| 进程读入 | 121.42 MiB |
| 进程写出 | 178.32 MiB |
| 块设备读 | 0 B |
| 块设备写 | 197.80 MiB |
| 读系统调用 | 40,002 |
| 写系统调用 | 85,067 |
| mock 根落盘 | 13.35 MiB |
| mock 根文件数 | 161 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 92.79 ms | ±3.1% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 12.17 ms | ±10.2% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 506.0 µs | ±2.1% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.33 ms | ±3.5% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.56 ms | ±6.1% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 642.1 µs | ±1.2% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 186.8 ms | ±1.4% |
| 填充主线程热缓存<br><code>hydrate</code> | 1.60 ms | ±52.7% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 313.7 ms | ±1.6% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 110.27 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 138.4 ns | 7,233,324 次/s | 93.16 MiB | 10.81 KiB | ±3.1% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 81.3 ns | 12,294,833 次/s | 95.08 MiB | 21.67 KiB | ±0.4% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 15.8 ns | 63,367,872 次/s | 80.17 MiB | 23.13 KiB | ±2.5% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 29.0 ns | 34,486,670 次/s | 80.36 MiB | 22.06 KiB | ±1.5% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 36.7 ns | 27,281,099 次/s | 79.81 MiB | 22.28 KiB | ±2.5% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,143,098,829 次/s | 77.93 MiB | 21.93 KiB | ±1.1% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 53.0 ns | 18,893,426 次/s | 82.11 MiB | 21.67 KiB | ±3.8% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.2 ns | 237,563,609 次/s | 77.65 MiB | 22.06 KiB | ±3.2% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 11.7 ns | 85,330,921 次/s | 78.73 MiB | 21.59 KiB | ±3.0% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 42.0 ns | 23,831,048 次/s | 82.13 MiB | 20.15 KiB | ±2.7% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 7.998 µs | 125,911 次/s | 99.98 MiB | 21.99 KiB | ±8.6% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 94.8 ns | 10,558,695 次/s | 86.38 MiB | 24.67 KiB | ±3.0% |
| 推进临时白名单日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 27.6 ns | 36,191,486 次/s | 85.77 MiB | 23.05 KiB | ±1.1% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 49.6 ns | 20,210,065 次/s | 80.30 MiB | 22.89 KiB | ±5.7% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 265.4 ns | 3,772,284 次/s | 125.88 MiB | 5.63 MiB | ±3.6% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 296.4 ns | 3,374,880 次/s | 139.89 MiB | 19.36 KiB | ±1.6% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.2 ns | 237,427,178 次/s | 80.81 MiB | 21.08 KiB | ±1.0% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 4.400 µs | 227,339 次/s | 87.03 MiB | 24.39 KiB | ±1.7% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 94.6 ns | 10,569,960 次/s | 121.43 MiB | 44.48 KiB | ±1.0% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 253.3 ns | 3,951,750 次/s | 103.11 MiB | 28.23 KiB | ±3.5% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 38.30 µs | 26,118 次/s | 105.36 MiB | 23.64 KiB | ±1.7% |
| 提取回复引用<br><code>reply-reference</code> | 18.3 ns | 54,532,917 次/s | 91.24 MiB | 24.46 KiB | ±2.0% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 51.5 ns | 19,420,230 次/s | 91.99 MiB | 21.26 KiB | ±1.5% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.4 ns | 225,858,992 次/s | 85.14 MiB | 22.22 KiB | ±6.4% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 33.9 ns | 29,614,930 次/s | 86.06 MiB | 20.10 KiB | ±6.0% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 21.3 ns | 46,943,013 次/s | 80.54 MiB | 22.06 KiB | ±1.4% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 15.5 ns | 64,469,873 次/s | 78.56 MiB | 23.04 KiB | ±0.2% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 73.9 ns | 13,561,516 次/s | 79.45 MiB | 22.12 KiB | ±4.4% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 925 次/s | 1.09 ms | 941.1 µs | 1.45 ms | 8.87 ms | 925 条记录/s | 3.91 MiB | ±7.1% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 145 次/s | 6.87 ms | 7.70 ms | 11.38 ms | 18.26 ms | 18,624 条记录/s | 20.53 MiB | ±2.1% |
| 累计 1 条临时白名单活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 614 次/s | 1.63 ms | 1.42 ms | 2.35 ms | 10.60 ms | 614 条记录/s | 3.15 MiB | ±2.7% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 616 次/s | 1.63 ms | 1.44 ms | 2.47 ms | 9.97 ms | 616 条记录/s | 3.13 MiB | ±5.5% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 650 次/s | 1.54 ms | 1.43 ms | 2.00 ms | 9.81 ms | 650 条记录/s | 3.13 MiB | ±3.8% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 349 次/s | 2.87 ms | 2.64 ms | 4.34 ms | 9.84 ms | 349 条记录/s | 11.72 MiB | ±4.9% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 841 次/s | 1.19 ms | 1.09 ms | 1.55 ms | 8.68 ms | 841 条记录/s | 4.16 MiB | ±3.1% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 323 次/s | 3.09 ms | 2.90 ms | 4.19 ms | 7.53 ms | 323 条记录/s | 1.83 MiB | ±1.3% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 1,207 次/s | 821.0 µs | 793.1 µs | 1.11 ms | 1.38 ms | 1,207 条记录/s | 0 B | ±0.7% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 29,790,260 次/s | 268.8 ns | 0 B | 6.86 KiB | ±2.9% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 19,925 次/s | 6.43 ms | 61.90 MiB | 31.71 KiB | ±1.5% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 75,908 次/s | 105.4 µs | 4.86 MiB | 81.29 KiB | ±0.9% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 18,323 次/s | 436.8 µs | 2.70 MiB | 273.05 KiB | ±2.2% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 17,888 次/s | 7.16 ms | 67.73 MiB | 187.01 KiB | ±1.0% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 14,475 次/s | 8.85 ms | 9.00 MiB | 220.54 KiB | ±1.7% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 15.6 ns | 64,775,792 次/s | 85.81 MiB | 23.30 KiB | ±11.8% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 35.8 ns | 27,960,985 次/s | 81.16 MiB | 24.05 KiB | ±0.9% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 18.8 ns | 53,309,406 次/s | 87.85 MiB | 25.53 KiB | ±2.2% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 118.8 ms | 1.73 MiB | 4.96 KiB | ±0.9% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 16.38 ms | 0 B | -4.98 KiB | ±5.0% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
