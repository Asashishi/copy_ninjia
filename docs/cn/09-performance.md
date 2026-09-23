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

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-09-23T15:04:08Z · 进程启动到本地恢复就绪 342.3 ms · 单条群消息进入主干并完成基础分发 136.9 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 800.7 µs / 1,164 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 2.91 ms / 323 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-23T15:04:08Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,405 |
| 进程读入 | 164.08 MiB |
| 进程写出 | 174.21 MiB |
| 块设备读 | 0 B |
| 块设备写 | 194.05 MiB |
| 读系统调用 | 51,567 |
| 写系统调用 | 86,233 |
| mock 根落盘 | 15.51 MiB |
| mock 根文件数 | 113 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 114.4 ms | ±7.0% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 15.40 ms | ±24.6% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 586.6 µs | ±1.1% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.51 ms | ±12.7% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 3.69 ms | ±1.3% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 649.8 µs | ±1.2% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 192.1 ms | ±4.3% |
| 填充主线程热缓存<br><code>hydrate</code> | 885.7 µs | ±95.6% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 342.3 ms | ±5.7% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 111.61 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 136.9 ns | 7,309,220 次/s | 91.41 MiB | 6.23 KiB | ±1.8% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 92.5 ns | 10,879,647 次/s | 89.15 MiB | 21.81 KiB | ±7.9% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 19.9 ns | 51,919,700 次/s | 75.94 MiB | 22.23 KiB | ±17.2% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 24.0 ns | 46,308,368 次/s | 76.26 MiB | 21.74 KiB | ±28.4% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 34.8 ns | 28,723,522 次/s | 77.58 MiB | 21.51 KiB | ±3.2% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,170,563,094 次/s | 74.55 MiB | 21.74 KiB | ±1.5% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 50.3 ns | 19,931,497 次/s | 77.54 MiB | 20.02 KiB | ±4.8% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.0 ns | 250,404,908 次/s | 75.71 MiB | 21.10 KiB | ±3.9% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 9.9 ns | 100,951,949 次/s | 76.13 MiB | 19.86 KiB | ±0.8% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 44.1 ns | 22,813,882 次/s | 77.38 MiB | 21.39 KiB | ±7.7% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 7.994 µs | 126,048 次/s | 99.69 MiB | 21.39 KiB | ±9.0% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 99.9 ns | 10,016,040 次/s | 83.00 MiB | 23.97 KiB | ±2.5% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 23.7 ns | 42,271,062 次/s | 85.08 MiB | 22.83 KiB | ±0.8% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 50.0 ns | 20,036,276 次/s | 78.07 MiB | 22.39 KiB | ±3.6% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 264.0 ns | 3,795,266 次/s | 116.14 MiB | 5.63 MiB | ±4.6% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 303.0 ns | 3,308,700 次/s | 141.16 MiB | 20.63 KiB | ±4.9% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.3 ns | 234,686,431 次/s | 76.05 MiB | 20.95 KiB | ±1.4% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 4.409 µs | 226,834 次/s | 86.42 MiB | 23.81 KiB | ±0.6% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 93.6 ns | 10,688,798 次/s | 120.95 MiB | 24.66 KiB | ±2.0% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 275.3 ns | 3,632,612 次/s | 87.01 MiB | 23.93 KiB | ±0.3% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 37.23 µs | 26,866 次/s | 99.16 MiB | 23.06 KiB | ±1.3% |
| 提取回复引用<br><code>reply-reference</code> | 18.1 ns | 55,414,814 次/s | 87.61 MiB | 23.74 KiB | ±2.2% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 47.3 ns | 21,127,220 次/s | 91.52 MiB | 21.96 KiB | ±1.6% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 6.2 ns | 192,321,544 次/s | 75.80 MiB | 21.71 KiB | ±46.1% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 37.3 ns | 26,834,238 次/s | 85.01 MiB | 20.50 KiB | ±4.1% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 22.5 ns | 44,493,817 次/s | 75.89 MiB | 20.35 KiB | ±5.6% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 16.5 ns | 60,777,220 次/s | 77.98 MiB | 22.24 KiB | ±4.5% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 73.2 ns | 13,690,025 次/s | 77.24 MiB | 21.89 KiB | ±3.9% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 915 次/s | 1.09 ms | 993.7 µs | 1.45 ms | 9.78 ms | 915 条记录/s | 3.91 MiB | ±2.4% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 141 次/s | 7.11 ms | 7.77 ms | 12.12 ms | 18.97 ms | 18,015 条记录/s | 21.42 MiB | ±3.3% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 673 次/s | 1.49 ms | 1.38 ms | 1.90 ms | 9.62 ms | 673 条记录/s | 3.15 MiB | ±3.8% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 609 次/s | 1.65 ms | 1.47 ms | 2.38 ms | 7.92 ms | 609 条记录/s | 3.13 MiB | ±6.2% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 596 次/s | 1.68 ms | 1.45 ms | 2.82 ms | 9.60 ms | 596 条记录/s | 3.13 MiB | ±4.5% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 346 次/s | 2.89 ms | 2.61 ms | 4.25 ms | 11.43 ms | 346 条记录/s | 5.55 MiB | ±2.3% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 828 次/s | 1.21 ms | 1.09 ms | 1.57 ms | 16.73 ms | 828 条记录/s | 4.16 MiB | ±5.6% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 323 次/s | 3.09 ms | 2.91 ms | 4.25 ms | 6.18 ms | 323 条记录/s | 1.83 MiB | ±2.4% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 1,164 次/s | 853.3 µs | 800.7 µs | 1.19 ms | 1.98 ms | 1,164 条记录/s | 1.33 KiB | ±4.6% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 29,671,829 次/s | 269.7 ns | 0 B | 5.73 KiB | ±2.1% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 20,019 次/s | 6.40 ms | 56.29 MiB | 43.67 KiB | ±2.1% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 76,788 次/s | 104.2 µs | 5.29 MiB | 79.55 KiB | ±0.8% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 16,649 次/s | 480.7 µs | 2.92 MiB | 296.44 KiB | ±2.2% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 17,699 次/s | 7.23 ms | 73.14 MiB | 185.46 KiB | ±1.9% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 14,691 次/s | 8.71 ms | 9.73 MiB | 211.48 KiB | ±0.8% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 17.6 ns | 56,722,649 次/s | 87.43 MiB | 22.40 KiB | ±1.5% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 36.2 ns | 27,617,311 次/s | 77.46 MiB | 23.36 KiB | ±1.5% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 18.2 ns | 55,199,165 次/s | 84.55 MiB | 25.27 KiB | ±4.6% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 116.4 ms | 1.70 MiB | 4.96 KiB | ±0.5% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 15.75 ms | 0 B | -5.01 KiB | ±9.2% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准) · [下一页：10 常见问题 →](10-faq.md)

</div>
