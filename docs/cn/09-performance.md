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

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-09-22T14:15:02Z · 进程启动到本地恢复就绪 326.7 ms · 单条群消息进入主干并完成基础分发 139.2 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 800.6 µs / 1,180 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 2.98 ms / 309 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-22T14:15:02Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,405 |
| 进程读入 | 164.38 MiB |
| 进程写出 | 173.94 MiB |
| 块设备读 | 2.67 KiB |
| 块设备写 | 193.70 MiB |
| 读系统调用 | 51,843 |
| 写系统调用 | 86,196 |
| mock 根落盘 | 14.80 MiB |
| mock 根文件数 | 113 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 105.9 ms | ±3.4% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 13.59 ms | ±21.0% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 536.0 µs | ±2.5% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.42 ms | ±1.5% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 3.57 ms | ±2.8% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 668.1 µs | ±0.3% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 185.6 ms | ±3.5% |
| 填充主线程热缓存<br><code>hydrate</code> | 1.55 ms | ±53.5% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 326.7 ms | ±3.9% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 110.23 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 139.2 ns | 7,186,143 次/s | 90.30 MiB | 6.08 KiB | ±1.5% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 82.9 ns | 12,089,854 次/s | 89.73 MiB | 19.81 KiB | ±4.6% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 15.8 ns | 63,210,611 次/s | 76.21 MiB | 22.30 KiB | ±3.8% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 28.4 ns | 35,160,035 次/s | 76.44 MiB | 23.25 KiB | ±0.4% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 34.1 ns | 29,375,348 次/s | 78.15 MiB | 22.01 KiB | ±3.2% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,159,581,653 次/s | 74.98 MiB | 21.38 KiB | ±0.3% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 48.8 ns | 20,519,641 次/s | 77.78 MiB | 20.74 KiB | ±4.8% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.0 ns | 251,547,571 次/s | 76.07 MiB | 21.59 KiB | ±3.7% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 11.7 ns | 85,670,503 次/s | 76.65 MiB | 20.08 KiB | ±3.5% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 41.8 ns | 23,944,810 次/s | 77.69 MiB | 19.52 KiB | ±1.4% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 8.254 µs | 121,193 次/s | 99.12 MiB | 21.86 KiB | ±1.9% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 93.5 ns | 10,701,453 次/s | 83.33 MiB | 24.13 KiB | ±2.8% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 24.0 ns | 41,662,601 次/s | 84.84 MiB | 22.63 KiB | ±4.4% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 49.4 ns | 20,262,698 次/s | 78.27 MiB | 21.95 KiB | ±1.2% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 260.7 ns | 3,838,114 次/s | 121.74 MiB | 5.63 MiB | ±2.2% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 306.7 ns | 3,261,361 次/s | 135.60 MiB | 20.66 KiB | ±1.6% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.3 ns | 230,359,538 次/s | 76.07 MiB | 20.05 KiB | ±3.8% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 4.529 µs | 220,920 次/s | 86.39 MiB | 23.12 KiB | ±2.4% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 99.7 ns | 10,084,019 次/s | 120.65 MiB | 24.96 KiB | ±7.3% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 280.2 ns | 3,570,726 次/s | 88.68 MiB | 24.82 KiB | ±2.3% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 37.09 µs | 26,962 次/s | 101.60 MiB | 22.66 KiB | ±0.4% |
| 提取回复引用<br><code>reply-reference</code> | 18.2 ns | 55,040,254 次/s | 87.33 MiB | 24.41 KiB | ±0.6% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 46.9 ns | 21,327,809 次/s | 91.33 MiB | 22.78 KiB | ±2.2% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.1 ns | 247,120,911 次/s | 75.52 MiB | 20.18 KiB | ±3.9% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 39.8 ns | 25,148,949 次/s | 84.76 MiB | 20.83 KiB | ±3.6% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 21.9 ns | 45,621,105 次/s | 76.18 MiB | 19.84 KiB | ±2.3% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 16.4 ns | 61,039,145 次/s | 78.40 MiB | 22.55 KiB | ±2.2% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 72.0 ns | 13,887,285 次/s | 77.18 MiB | 21.20 KiB | ±1.8% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 784 次/s | 1.28 ms | 1.09 ms | 1.98 ms | 11.30 ms | 784 条记录/s | 3.91 MiB | ±5.2% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 146 次/s | 6.85 ms | 7.67 ms | 11.30 ms | 21.14 ms | 18,686 条记录/s | 21.42 MiB | ±0.6% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 676 次/s | 1.48 ms | 1.38 ms | 1.91 ms | 6.22 ms | 676 条记录/s | 3.15 MiB | ±0.7% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 586 次/s | 1.72 ms | 1.51 ms | 3.32 ms | 7.47 ms | 586 条记录/s | 3.13 MiB | ±9.0% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 631 次/s | 1.59 ms | 1.43 ms | 2.33 ms | 8.66 ms | 631 条记录/s | 3.13 MiB | ±6.7% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 349 次/s | 2.87 ms | 2.58 ms | 4.21 ms | 14.70 ms | 349 条记录/s | 5.55 MiB | ±2.8% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 852 次/s | 1.17 ms | 1.08 ms | 1.54 ms | 8.68 ms | 852 条记录/s | 4.16 MiB | ±1.4% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 309 次/s | 3.24 ms | 2.98 ms | 5.27 ms | 8.44 ms | 309 条记录/s | 1.83 MiB | ±1.5% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 1,180 次/s | 839.2 µs | 800.6 µs | 1.09 ms | 1.58 ms | 1,180 条记录/s | 0 B | ±0.9% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 30,475,261 次/s | 262.5 ns | 0 B | 5.57 KiB | ±0.3% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 19,833 次/s | 6.46 ms | 56.29 MiB | 30.50 KiB | ±1.6% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 74,149 次/s | 107.9 µs | 5.29 MiB | 85.92 KiB | ±1.7% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 17,086 次/s | 468.6 µs | 2.92 MiB | 295.55 KiB | ±2.9% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 17,807 次/s | 7.19 ms | 73.14 MiB | 188.86 KiB | ±0.1% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 14,608 次/s | 8.76 ms | 9.73 MiB | 220.40 KiB | ±1.1% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 16.9 ns | 59,122,864 次/s | 88.01 MiB | 23.22 KiB | ±3.4% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 38.6 ns | 26,080,144 次/s | 77.64 MiB | 23.90 KiB | ±8.8% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 19.6 ns | 51,243,931 次/s | 84.19 MiB | 25.26 KiB | ±6.5% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 122.0 ms | 1.65 MiB | 5.04 KiB | ±1.2% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 15.75 ms | 0 B | -5.74 KiB | ±9.8% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准) · [下一页：10 常见问题 →](10-faq.md)

</div>
