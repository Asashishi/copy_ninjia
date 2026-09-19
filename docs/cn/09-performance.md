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

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-09-18T07:42:14Z · 进程启动到本地恢复就绪 328.6 ms · 单条群消息进入主干并完成基础分发 151.0 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 825.1 µs / 1,143 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 2.98 ms / 303 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-18T07:42:14Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,405 |
| 进程读入 | 164.13 MiB |
| 进程写出 | 173.94 MiB |
| 块设备读 | 0 B |
| 块设备写 | 193.70 MiB |
| 读系统调用 | 51,566 |
| 写系统调用 | 86,157 |
| mock 根落盘 | 14.19 MiB |
| mock 根文件数 | 113 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 101.0 ms | ±0.4% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 13.84 ms | ±6.8% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 559.8 µs | ±11.8% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.41 ms | ±3.1% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.83 ms | ±2.1% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 719.6 µs | ±2.5% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 193.1 ms | ±2.3% |
| 填充主线程热缓存<br><code>hydrate</code> | 925.1 µs | ±86.2% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 328.6 ms | ±1.7% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 110.58 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 151.0 ns | 6,711,983 次/s | 87.59 MiB | 7.95 KiB | ±12.1% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 88.8 ns | 11,295,580 次/s | 89.67 MiB | 20.77 KiB | ±5.8% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 16.4 ns | 60,812,575 次/s | 75.39 MiB | 21.21 KiB | ±1.0% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 28.8 ns | 34,794,594 次/s | 75.67 MiB | 21.21 KiB | ±1.9% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 33.9 ns | 29,499,407 次/s | 76.60 MiB | 21.07 KiB | ±1.1% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,174,397,249 次/s | 74.15 MiB | 22.01 KiB | ±0.8% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 52.5 ns | 19,237,200 次/s | 76.79 MiB | 20.79 KiB | ±10.5% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.1 ns | 243,763,986 次/s | 74.67 MiB | 21.65 KiB | ±4.3% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 11.6 ns | 86,037,955 次/s | 75.62 MiB | 20.28 KiB | ±0.3% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 41.7 ns | 24,059,897 次/s | 76.98 MiB | 20.08 KiB | ±6.6% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 9.131 µs | 109,990 次/s | 98.24 MiB | 22.45 KiB | ±6.5% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 98.6 ns | 10,156,584 次/s | 82.06 MiB | 23.67 KiB | ±3.8% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 27.0 ns | 37,024,994 次/s | 83.35 MiB | 22.56 KiB | ±2.2% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 51.6 ns | 19,370,920 次/s | 77.07 MiB | 21.91 KiB | ±0.7% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 278.3 ns | 3,594,521 次/s | 120.81 MiB | 5.63 MiB | ±2.2% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 331.1 ns | 3,022,166 次/s | 138.33 MiB | 21.14 KiB | ±2.5% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.3 ns | 232,705,462 次/s | 75.09 MiB | 20.97 KiB | ±0.8% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 4.521 µs | 221,221 次/s | 85.16 MiB | 23.02 KiB | ±1.0% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 99.7 ns | 10,046,900 次/s | 119.21 MiB | 24.52 KiB | ±3.6% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 283.0 ns | 3,534,651 次/s | 86.61 MiB | 25.14 KiB | ±1.5% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 40.42 µs | 24,768 次/s | 97.76 MiB | 22.76 KiB | ±3.3% |
| 提取回复引用<br><code>reply-reference</code> | 19.9 ns | 50,439,977 次/s | 86.37 MiB | 24.33 KiB | ±5.3% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 58.4 ns | 17,120,564 次/s | 87.73 MiB | 20.94 KiB | ±1.2% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.3 ns | 233,134,511 次/s | 81.59 MiB | 21.88 KiB | ±0.3% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 38.5 ns | 26,048,841 次/s | 83.73 MiB | 19.62 KiB | ±4.8% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 21.6 ns | 46,416,243 次/s | 75.15 MiB | 22.68 KiB | ±3.1% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 16.4 ns | 61,074,477 次/s | 77.17 MiB | 22.70 KiB | ±1.6% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 75.0 ns | 13,340,005 次/s | 76.07 MiB | 22.81 KiB | ±0.8% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 892 次/s | 1.12 ms | 1.03 ms | 1.55 ms | 6.83 ms | 892 条记录/s | 3.91 MiB | ±1.2% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 129 次/s | 7.74 ms | 8.66 ms | 12.98 ms | 20.02 ms | 16,535 条记录/s | 21.42 MiB | ±2.7% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 610 次/s | 1.64 ms | 1.43 ms | 2.65 ms | 11.57 ms | 610 条记录/s | 3.15 MiB | ±1.9% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 600 次/s | 1.67 ms | 1.51 ms | 2.50 ms | 8.33 ms | 600 条记录/s | 3.13 MiB | ±0.7% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 606 次/s | 1.65 ms | 1.52 ms | 2.36 ms | 7.82 ms | 606 条记录/s | 3.13 MiB | ±0.8% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 342 次/s | 2.92 ms | 2.68 ms | 4.08 ms | 11.17 ms | 342 条记录/s | 5.55 MiB | ±1.5% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 840 次/s | 1.19 ms | 1.10 ms | 1.54 ms | 8.01 ms | 840 条记录/s | 4.16 MiB | ±1.9% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 303 次/s | 3.30 ms | 2.98 ms | 4.90 ms | 11.12 ms | 303 条记录/s | 1.83 MiB | ±2.2% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 1,143 次/s | 867.1 µs | 825.1 µs | 1.19 ms | 1.52 ms | 1,143 条记录/s | 0 B | ±1.0% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 28,138,314 次/s | 284.4 ns | 0 B | 7.41 KiB | ±1.8% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 17,991 次/s | 7.12 ms | 56.29 MiB | 31.47 KiB | ±1.3% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 68,405 次/s | 117.0 µs | 5.29 MiB | 80.15 KiB | ±1.5% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 14,957 次/s | 535.9 µs | 2.92 MiB | 296.99 KiB | ±4.3% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 16,144 次/s | 7.93 ms | 73.14 MiB | 187.46 KiB | ±1.2% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 13,723 次/s | 9.33 ms | 9.73 MiB | 224.01 KiB | ±1.0% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 18.1 ns | 55,257,361 次/s | 86.41 MiB | 22.47 KiB | ±0.7% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 36.6 ns | 27,345,325 次/s | 76.41 MiB | 23.02 KiB | ±4.7% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 18.1 ns | 56,148,988 次/s | 83.29 MiB | 24.44 KiB | ±11.7% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 126.7 ms | 1.78 MiB | 4.89 KiB | ±1.5% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 22.67 ms | 0 B | -4.98 KiB | ±6.7% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准) · [下一页：10 常见问题 →](10-faq.md)

</div>
