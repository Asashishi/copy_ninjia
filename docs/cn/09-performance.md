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

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-09-06T07:31:56Z · 进程启动到本地恢复就绪 477.0 ms · 单条群消息进入主干并完成基础分发 1.379 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.24 ms / 745 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 5.70 ms / 152 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-138-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-06T07:31:56Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 385,931,405 |
| 进程读入 | 121.27 MiB |
| 进程写出 | 178.32 MiB |
| 块设备读 | 0 B |
| 块设备写 | 197.80 MiB |
| 读系统调用 | 39,953 |
| 写系统调用 | 85,158 |
| mock 根落盘 | 16.24 MiB |
| mock 根文件数 | 163 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 136.4 ms | ±5.9% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 16.56 ms | ±1.2% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 763.6 µs | ±11.3% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.54 ms | ±10.4% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 6.73 ms | ±12.9% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 853.8 µs | ±4.4% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 287.7 ms | ±5.3% |
| 填充主线程热缓存<br><code>hydrate</code> | 575.3 µs | ±7.7% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 477.0 ms | ±4.8% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 111.30 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.379 µs | 733,269 次/s | 82.04 MiB | 26.05 KiB | ±10.5% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 168.3 ns | 5,955,016 次/s | 86.49 MiB | 23.20 KiB | ±4.8% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 11.3 ns | 89,046,511 次/s | 72.54 MiB | 21.90 KiB | ±7.7% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 24.3 ns | 41,100,851 次/s | 72.79 MiB | 21.63 KiB | ±1.6% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.7 ns | 1,482,498,941 次/s | 71.46 MiB | 23.35 KiB | ±5.6% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 56.1 ns | 17,859,965 次/s | 74.42 MiB | 23.19 KiB | ±3.4% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.2 ns | 238,264,288 次/s | 72.59 MiB | 23.38 KiB | ±7.9% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 12.6 ns | 79,589,945 次/s | 73.47 MiB | 22.91 KiB | ±0.1% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 52.6 ns | 19,337,169 次/s | 74.27 MiB | 19.93 KiB | ±13.4% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 12.85 µs | 77,979 次/s | 96.10 MiB | 24.52 KiB | ±4.2% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 110.8 ns | 9,025,855 次/s | 79.81 MiB | 22.56 KiB | ±2.0% |
| 推进临时白名单日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 35.2 ns | 28,928,915 次/s | 80.83 MiB | 23.80 KiB | ±13.5% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 53.0 ns | 18,885,108 次/s | 74.76 MiB | 18.60 KiB | ±1.3% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 394.8 ns | 2,544,270 次/s | 119.02 MiB | 5.63 MiB | ±6.5% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 445.1 ns | 2,254,845 次/s | 133.70 MiB | 19.38 KiB | ±6.0% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.8 ns | 207,510,272 次/s | 73.22 MiB | 21.06 KiB | ±7.2% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.199 µs | 192,566 次/s | 82.33 MiB | 24.30 KiB | ±3.3% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 132.8 ns | 7,584,970 次/s | 114.39 MiB | 24.49 KiB | ±8.5% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 315.3 ns | 3,173,010 次/s | 100.06 MiB | 27.10 KiB | ±2.3% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 54.83 µs | 18,240 次/s | 95.55 MiB | 21.32 KiB | ±1.4% |
| 提取回复引用<br><code>reply-reference</code> | 24.5 ns | 40,902,456 次/s | 81.88 MiB | 23.37 KiB | ±4.7% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 74.5 ns | 13,428,641 次/s | 84.17 MiB | 22.83 KiB | ±3.0% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 8.7 ns | 174,344,475 次/s | 78.35 MiB | 21.57 KiB | ±71.8% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 33.3 ns | 30,363,652 次/s | 80.71 MiB | 20.46 KiB | ±9.8% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 26.4 ns | 38,669,615 次/s | 72.68 MiB | 21.64 KiB | ±15.2% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 12.1 ns | 82,577,468 次/s | 75.68 MiB | 21.69 KiB | ±3.4% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 85.3 ns | 11,766,556 次/s | 74.23 MiB | 23.29 KiB | ±5.7% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 391 次/s | 2.56 ms | 2.00 ms | 5.22 ms | 24.02 ms | 391 条记录/s | 3.91 MiB | ±5.2% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 75 次/s | 13.26 ms | 13.44 ms | 23.84 ms | 78.64 ms | 9,655 条记录/s | 20.53 MiB | ±2.1% |
| 累计 1 条临时白名单活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 309 次/s | 3.25 ms | 2.59 ms | 7.58 ms | 19.04 ms | 309 条记录/s | 3.15 MiB | ±5.7% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 327 次/s | 3.05 ms | 2.53 ms | 5.54 ms | 24.00 ms | 327 条记录/s | 3.13 MiB | ±2.8% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 308 次/s | 3.26 ms | 2.66 ms | 6.51 ms | 18.21 ms | 308 条记录/s | 3.13 MiB | ±5.9% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 176 次/s | 5.72 ms | 4.73 ms | 12.13 ms | 25.90 ms | 176 条记录/s | 11.72 MiB | ±7.7% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 390 次/s | 2.56 ms | 2.08 ms | 4.38 ms | 24.18 ms | 390 条记录/s | 4.16 MiB | ±1.9% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 152 次/s | 6.59 ms | 5.70 ms | 13.37 ms | 22.94 ms | 152 条记录/s | 1.83 MiB | ±2.7% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 745 次/s | 1.33 ms | 1.24 ms | 2.29 ms | 2.65 ms | 745 条记录/s | 0 B | ±3.8% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 26,697,095 次/s | 300.1 ns | 0 B | 7.26 KiB | ±3.8% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 10,735 次/s | 11.92 ms | 61.90 MiB | 30.60 KiB | ±0.5% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 42,646 次/s | 187.6 µs | 4.86 MiB | 58.21 KiB | ±0.7% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 13,005 次/s | 615.5 µs | 2.70 MiB | 274.92 KiB | ±2.3% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 10,331 次/s | 12.39 ms | 67.73 MiB | 149.87 KiB | ±1.9% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 8,851 次/s | 14.47 ms | 9.00 MiB | 195.02 KiB | ±2.5% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 16.9 ns | 59,201,592 次/s | 81.54 MiB | 23.39 KiB | ±2.1% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 40.8 ns | 24,749,007 次/s | 74.41 MiB | 21.92 KiB | ±10.4% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 18.0 ns | 55,787,387 次/s | 81.13 MiB | 24.66 KiB | ±5.8% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 151.6 ms | 2.00 MiB | 5.00 KiB | ±3.6% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 28.14 ms | 0 B | -4.94 KiB | ±2.0% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
