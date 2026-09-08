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

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-09-08T13:33:04Z · 进程启动到本地恢复就绪 529.4 ms · 单条群消息进入主干并完成基础分发 1.230 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.16 ms / 779 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 5.69 ms / 146 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-138-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-08T13:33:04Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,405 |
| 进程读入 | 121.45 MiB |
| 进程写出 | 178.32 MiB |
| 块设备读 | 0 B |
| 块设备写 | 197.80 MiB |
| 读系统调用 | 40,077 |
| 写系统调用 | 85,286 |
| mock 根落盘 | 15.55 MiB |
| mock 根文件数 | 163 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 147.4 ms | ±14.1% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 33.27 ms | ±19.5% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 903.5 µs | ±7.4% |
| 读取并严格解析运行状态<br><code>state-load</code> | 2.34 ms | ±20.4% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 9.57 ms | ±32.1% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 1.04 ms | ±21.8% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 312.3 ms | ±6.8% |
| 填充主线程热缓存<br><code>hydrate</code> | 3.02 ms | ±55.2% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 529.4 ms | ±5.4% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 111.56 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.230 µs | 813,757 次/s | 77.97 MiB | 25.77 KiB | ±3.0% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 134.0 ns | 7,502,813 次/s | 84.90 MiB | 21.35 KiB | ±7.6% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 15.4 ns | 64,930,702 次/s | 72.70 MiB | 22.05 KiB | ±2.4% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 34.9 ns | 28,643,257 次/s | 73.07 MiB | 22.99 KiB | ±2.3% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 46.4 ns | 21,696,857 次/s | 74.61 MiB | 22.00 KiB | ±7.8% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.8 ns | 1,290,536,328 次/s | 71.84 MiB | 23.49 KiB | ±22.2% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 73.7 ns | 14,137,783 次/s | 74.21 MiB | 22.54 KiB | ±21.5% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.3 ns | 234,035,791 次/s | 71.75 MiB | 23.47 KiB | ±2.7% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 12.7 ns | 78,681,547 次/s | 72.76 MiB | 19.95 KiB | ±1.7% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 45.4 ns | 22,039,234 次/s | 74.14 MiB | 17.94 KiB | ±2.4% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 11.45 µs | 87,855 次/s | 96.36 MiB | 21.24 KiB | ±7.2% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 112.5 ns | 8,892,968 次/s | 79.79 MiB | 24.59 KiB | ±2.6% |
| 推进临时白名单日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 53.5 ns | 21,143,458 次/s | 79.86 MiB | 21.62 KiB | ±31.2% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 53.3 ns | 18,818,722 次/s | 74.75 MiB | 21.46 KiB | ±4.7% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 392.5 ns | 2,588,290 次/s | 117.82 MiB | 5.64 MiB | ±13.0% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 451.4 ns | 2,216,075 次/s | 136.42 MiB | 21.38 KiB | ±1.8% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.9 ns | 208,258,516 次/s | 73.05 MiB | 21.20 KiB | ±13.8% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.260 µs | 190,713 次/s | 82.86 MiB | 24.61 KiB | ±5.7% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 115.9 ns | 8,631,271 次/s | 115.25 MiB | 24.30 KiB | ±1.5% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 333.1 ns | 3,002,949 次/s | 98.83 MiB | 25.60 KiB | ±1.4% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 54.47 µs | 18,363 次/s | 95.48 MiB | 22.45 KiB | ±1.6% |
| 提取回复引用<br><code>reply-reference</code> | 25.6 ns | 39,057,901 次/s | 81.72 MiB | 23.08 KiB | ±3.7% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 68.7 ns | 14,627,149 次/s | 83.40 MiB | 22.34 KiB | ±6.6% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 3.9 ns | 255,823,611 次/s | 76.49 MiB | 21.95 KiB | ±3.2% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 33.1 ns | 30,682,382 次/s | 80.75 MiB | 22.82 KiB | ±12.8% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 24.4 ns | 41,027,695 次/s | 72.49 MiB | 21.89 KiB | ±5.6% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 12.3 ns | 81,779,946 次/s | 75.57 MiB | 21.33 KiB | ±7.1% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 91.3 ns | 11,047,670 次/s | 73.74 MiB | 21.75 KiB | ±9.2% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 364 次/s | 2.78 ms | 2.04 ms | 6.86 ms | 21.35 ms | 364 条记录/s | 3.91 MiB | ±11.3% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 74 次/s | 13.45 ms | 13.47 ms | 23.80 ms | 39.88 ms | 9,515 条记录/s | 20.53 MiB | ±2.5% |
| 累计 1 条临时白名单活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 285 次/s | 3.63 ms | 3.02 ms | 7.79 ms | 19.10 ms | 285 条记录/s | 3.15 MiB | ±17.9% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 274 次/s | 3.73 ms | 3.03 ms | 8.51 ms | 22.16 ms | 274 条记录/s | 3.13 MiB | ±14.1% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 318 次/s | 3.15 ms | 2.55 ms | 6.10 ms | 21.71 ms | 318 条记录/s | 3.13 MiB | ±5.4% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 175 次/s | 5.77 ms | 4.66 ms | 11.73 ms | 29.82 ms | 175 条记录/s | 11.72 MiB | ±10.9% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 380 次/s | 2.64 ms | 2.08 ms | 4.97 ms | 22.64 ms | 380 条记录/s | 4.16 MiB | ±5.9% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 146 次/s | 6.89 ms | 5.69 ms | 14.94 ms | 30.23 ms | 146 条记录/s | 1.83 MiB | ±7.7% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 779 次/s | 1.27 ms | 1.16 ms | 2.31 ms | 2.92 ms | 779 条记录/s | 0 B | ±4.2% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 25,797,027 次/s | 310.2 ns | 0 B | 5.81 KiB | ±1.9% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 10,583 次/s | 12.11 ms | 61.90 MiB | 31.05 KiB | ±3.0% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 39,481 次/s | 202.9 µs | 4.86 MiB | 87.03 KiB | ±3.7% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 12,105 次/s | 662.0 µs | 2.70 MiB | 290.02 KiB | ±4.1% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 9,277 次/s | 13.80 ms | 67.73 MiB | 173.25 KiB | ±1.7% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 8,807 次/s | 14.56 ms | 9.00 MiB | 203.04 KiB | ±4.2% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 20.8 ns | 50,166,073 次/s | 79.36 MiB | 22.50 KiB | ±21.6% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 39.0 ns | 25,757,920 次/s | 73.69 MiB | 22.96 KiB | ±6.5% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 21.7 ns | 48,238,469 次/s | 80.56 MiB | 25.24 KiB | ±22.7% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 177.9 ms | 1.92 MiB | 4.96 KiB | ±10.1% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 31.66 ms | 0 B | -4.97 KiB | ±3.4% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
