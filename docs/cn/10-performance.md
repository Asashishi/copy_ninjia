# 10 性能基准

<p align="center">
  <b>简体中文</b> · <a href="../en/10-performance.md">English</a> · <a href="../ja/10-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="09-commands.md">← 上一页：09 命令与行为参考</a> · <a href="11-faq.md">下一页：11 常见问题 →</a>
</p>

---

本页记录的性能基准数据由 `bun run perf:full -- --write-doc` 自动测算并生成，每次发版时会重新执行并整体替换数据区块。
**请勿手动编辑下方标记之间的内容**，发布时中、英、日三份文档由脚本统一同步覆盖。

执行该命令时，**结构化报告全文**会被同步写入项目根目录下的 `performance-result.json` 的 `fullSuite.lastRun` 节点（包含硬件环境、测试分区、逐项平均耗时与变异系数）。文档内的基准数据区块与该 JSON 数据由 `--write-doc` 参数原子写入。

全量基准测试仅在发版前或接到明确指令时按需执行，不包含在常规的 `bun run check` 持续集成门禁中；针对生产热路径的 GC 垃圾回收、物理驻留内存（RSS）与 JIT 编译硬门禁，由 `bun run perf:hot-path-gate` 命令独立保障，详见 [05 开发流程与质量门禁](05-dev-workflow.md)。

专项测试场景以及 `bun run perf:disk-transport` 的测量边界与复现步骤，请参阅 [05 开发流程与质量门禁](05-dev-workflow.md#专项场景与传输压力验证)。专项测试输出与热路径门禁数据独立记录，不会覆盖下方的全量基准区块。

<!-- performance-benchmark:start -->

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-10-07T10:56:42Z · 进程启动到本地恢复就绪 389.5 ms · 单条群消息进入主干并完成基础分发 137.5 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 205.6 µs / 4,309 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.93 ms / 475 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-10-07T10:56:42Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,453 |
| 进程读入 | 180.03 MiB |
| 进程写出 | 185.44 MiB |
| 块设备读 | 2.67 KiB |
| 块设备写 | 234.66 MiB |
| 读系统调用 | 51,981 |
| 写系统调用 | 244,036 |
| mock 根落盘 | 14.49 MiB |
| mock 根文件数 | 103 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 114.0 ms | ±0.4% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 11.44 ms | ±2.6% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 673.2 µs | ±5.2% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.27 ms | ±5.8% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.89 ms | ±4.3% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 783.5 µs | ±2.6% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 241.1 ms | ±3.4% |
| 填充主线程热缓存<br><code>hydrate</code> | 279.2 µs | ±1.8% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 389.5 ms | ±2.0% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 122.58 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 137.5 ns | 7,297,025 次/s | 100.45 MiB | 10.98 KiB | ±5.5% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 99.8 ns | 10,082,399 次/s | 103.93 MiB | 19.88 KiB | ±7.5% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 16.0 ns | 62,663,881 次/s | 90.24 MiB | 21.15 KiB | ±1.7% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 29.2 ns | 34,226,269 次/s | 90.85 MiB | 20.17 KiB | ±1.7% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 33.9 ns | 29,535,874 次/s | 91.65 MiB | 20.43 KiB | ±0.6% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,167,516,588 次/s | 88.23 MiB | 21.21 KiB | ±1.3% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 47.0 ns | 21,285,673 次/s | 91.83 MiB | 18.44 KiB | ±0.7% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.1 ns | 242,041,617 次/s | 89.97 MiB | 21.42 KiB | ±1.0% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 9.8 ns | 101,603,331 次/s | 88.90 MiB | 19.56 KiB | ±0.8% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 43.7 ns | 22,881,871 次/s | 89.38 MiB | 20.02 KiB | ±0.3% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.116 µs | 897,169 次/s | 111.29 MiB | 18.15 KiB | ±3.9% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 92.1 ns | 10,859,485 次/s | 96.22 MiB | 22.68 KiB | ±1.9% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 42.4 ns | 23,597,982 次/s | 97.48 MiB | 19.92 KiB | ±2.6% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 51.8 ns | 19,383,512 次/s | 90.30 MiB | 20.76 KiB | ±6.8% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 260.5 ns | 3,839,666 次/s | 128.78 MiB | 5.63 MiB | ±0.8% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 309.0 ns | 3,239,355 次/s | 147.84 MiB | 19.93 KiB | ±3.2% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.3 ns | 232,027,183 次/s | 89.48 MiB | 20.10 KiB | ±2.1% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.214 µs | 451,724 次/s | 98.63 MiB | 21.98 KiB | ±0.4% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 32.8 ns | 30,515,808 次/s | 98.05 MiB | 15.22 KiB | ±2.6% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 281.4 ns | 3,554,846 次/s | 102.93 MiB | 21.21 KiB | ±1.8% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 38.82 µs | 25,771 次/s | 111.38 MiB | 21.56 KiB | ±1.9% |
| 提取回复引用<br><code>reply-reference</code> | 29.9 ns | 33,468,340 次/s | 100.48 MiB | 21.97 KiB | ±2.2% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 49.0 ns | 20,495,086 次/s | 108.90 MiB | 20.86 KiB | ±5.9% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 7.9 ns | 151,984,549 次/s | 88.50 MiB | 21.80 KiB | ±35.5% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 38.1 ns | 26,324,898 次/s | 96.79 MiB | 17.63 KiB | ±4.1% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 21.7 ns | 46,081,431 次/s | 88.77 MiB | 20.07 KiB | ±3.1% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 16.4 ns | 60,899,545 次/s | 91.55 MiB | 21.19 KiB | ±3.8% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 73.5 ns | 13,634,417 次/s | 91.73 MiB | 20.05 KiB | ±5.0% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。cron.json 一行只量中途变更的开销，不执行任务：任务表取生产上限（128 个任务、每个 16 个动作，本地来源相对数据根），每次改动其中 1 个任务后按生产顺序读取并严格解析六份可热重载文件（含逐项核对本地来源）、替换快照并按任务名对账调度器；改写与写盘属于部署方，不计时；文件监听的防抖等待、随后的广告检测与 AI 闲聊可用性重算和热重载日志也不计入。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 892 次/s | 1.12 ms | 1.00 ms | 1.58 ms | 9.21 ms | 892 条记录/s | 3.91 MiB | ±2.3% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 317 次/s | 3.15 ms | 3.00 ms | 5.65 ms | 12.99 ms | 40,607 条记录/s | 21.42 MiB | ±3.3% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 773 次/s | 1.30 ms | 1.19 ms | 1.85 ms | 7.75 ms | 773 条记录/s | 3.15 MiB | ±9.4% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 730 次/s | 1.37 ms | 1.25 ms | 1.93 ms | 7.52 ms | 730 条记录/s | 3.13 MiB | ±4.4% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 740 次/s | 1.35 ms | 1.26 ms | 1.80 ms | 8.48 ms | 740 条记录/s | 3.13 MiB | ±3.0% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 354 次/s | 2.82 ms | 2.57 ms | 4.37 ms | 12.59 ms | 354 条记录/s | 5.55 MiB | ±4.1% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 850 次/s | 1.18 ms | 1.08 ms | 1.50 ms | 13.87 ms | 850 条记录/s | 4.16 MiB | ±3.9% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 475 次/s | 2.11 ms | 1.93 ms | 3.18 ms | 6.82 ms | 475 条记录/s | 1.20 MiB | ±3.5% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 4,309 次/s | 229.6 µs | 205.6 µs | 359.4 µs | 541.3 µs | 4,309 条记录/s | 0 B | ±3.1% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 5 次/s | 193.4 ms | 193.2 ms | 196.5 ms | 197.1 ms | 5 条记录/s | 0 B | ±0.7% |
| cron.json 中途改动 1 个任务：热重载并重排调度（满规格任务表）<br><code>cron-config-reload</code> | 7 次/s | 139.7 ms | 139.6 ms | 144.9 ms | 149.7 ms | 7 条记录/s | 7.31 MiB | ±0.7% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 29,605,673 次/s | 270.5 ns | 0 B | 5.51 KiB | ±3.1% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 44,506 次/s | 2.88 ms | 56.55 MiB | 31.41 KiB | ±0.7% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 74,958 次/s | 106.7 µs | 5.29 MiB | 78.65 KiB | ±1.3% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 13,348 次/s | 599.5 µs | 34.01 MiB | 281.68 KiB | ±1.4% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 63,789 次/s | 2.01 ms | 73.14 MiB | 132.89 KiB | ±1.4% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 20,558 次/s | 6.23 ms | 12.63 MiB | 417.38 KiB | ±2.9% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 17.1 ns | 58,692,807 次/s | 100.86 MiB | 21.54 KiB | ±5.9% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 36.3 ns | 27,533,476 次/s | 90.94 MiB | 22.61 KiB | ±1.2% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 17.8 ns | 56,647,878 次/s | 98.19 MiB | 23.77 KiB | ±8.2% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 121.6 ms | 1.42 MiB | 6.39 KiB | ±0.4% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 20.68 ms | 0 B | -3.56 KiB | ±8.0% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：09 命令与行为参考](09-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#10-性能基准) · [下一页：11 常见问题 →](11-faq.md)

</div>
