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

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-09-25T11:22:07Z · 进程启动到本地恢复就绪 324.0 ms · 单条群消息进入主干并完成基础分发 155.4 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 814.0 µs / 1,148 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 2.89 ms / 322 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-25T11:22:07Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,429 |
| 进程读入 | 164.59 MiB |
| 进程写出 | 173.94 MiB |
| 块设备读 | 1.33 KiB |
| 块设备写 | 193.70 MiB |
| 读系统调用 | 52,077 |
| 写系统调用 | 86,199 |
| mock 根落盘 | 15.47 MiB |
| mock 根文件数 | 117 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 107.3 ms | ±3.9% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 13.11 ms | ±12.0% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 507.5 µs | ±2.6% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.37 ms | ±8.8% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 3.77 ms | ±4.7% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 706.3 µs | ±6.2% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 182.9 ms | ±1.3% |
| 填充主线程热缓存<br><code>hydrate</code> | 1.41 ms | ±55.7% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 324.0 ms | ±0.2% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 112.22 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 155.4 ns | 6,440,719 次/s | 91.12 MiB | 7.94 KiB | ±2.6% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 91.9 ns | 10,885,571 次/s | 93.11 MiB | 20.92 KiB | ±1.0% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 15.8 ns | 63,469,748 次/s | 77.68 MiB | 21.72 KiB | ±1.8% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 26.2 ns | 43,004,050 次/s | 77.79 MiB | 21.10 KiB | ±30.7% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 34.1 ns | 29,336,443 次/s | 79.17 MiB | 21.43 KiB | ±0.2% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,171,299,943 次/s | 76.62 MiB | 22.16 KiB | ±0.3% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 48.9 ns | 20,514,079 次/s | 78.57 MiB | 20.26 KiB | ±4.9% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 3.9 ns | 257,665,705 次/s | 76.90 MiB | 21.16 KiB | ±3.9% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 9.8 ns | 102,412,714 次/s | 77.94 MiB | 19.27 KiB | ±0.7% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 40.8 ns | 24,485,161 次/s | 78.59 MiB | 19.89 KiB | ±0.8% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 8.595 µs | 116,869 次/s | 101.02 MiB | 20.65 KiB | ±6.9% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 92.5 ns | 10,810,178 次/s | 84.67 MiB | 23.88 KiB | ±0.3% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 23.7 ns | 42,271,344 次/s | 86.58 MiB | 22.22 KiB | ±1.1% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 50.5 ns | 19,814,250 次/s | 79.49 MiB | 22.39 KiB | ±1.2% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 259.0 ns | 3,866,667 次/s | 124.25 MiB | 5.63 MiB | ±4.1% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 313.8 ns | 3,186,562 次/s | 138.71 MiB | 18.42 KiB | ±0.3% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.4 ns | 228,515,196 次/s | 77.32 MiB | 20.02 KiB | ±5.0% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 4.415 µs | 226,527 次/s | 88.02 MiB | 23.41 KiB | ±0.7% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 97.2 ns | 10,299,139 次/s | 122.58 MiB | 24.70 KiB | ±2.7% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 279.5 ns | 3,577,678 次/s | 89.61 MiB | 24.80 KiB | ±0.9% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 37.04 µs | 27,003 次/s | 100.18 MiB | 21.97 KiB | ±1.1% |
| 提取回复引用<br><code>reply-reference</code> | 28.4 ns | 35,431,581 次/s | 91.26 MiB | 23.69 KiB | ±7.4% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 46.6 ns | 21,446,550 次/s | 93.08 MiB | 21.99 KiB | ±1.2% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 7.9 ns | 151,801,355 次/s | 77.54 MiB | 22.04 KiB | ±35.7% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 35.3 ns | 28,321,246 次/s | 86.14 MiB | 18.48 KiB | ±0.8% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 20.4 ns | 48,928,062 次/s | 76.91 MiB | 21.62 KiB | ±0.5% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 15.7 ns | 63,817,799 次/s | 79.32 MiB | 21.68 KiB | ±2.8% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 71.8 ns | 13,987,453 次/s | 78.37 MiB | 21.85 KiB | ±6.1% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 885 次/s | 1.13 ms | 1.01 ms | 1.57 ms | 8.74 ms | 885 条记录/s | 3.91 MiB | ±5.1% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 145 次/s | 6.92 ms | 7.74 ms | 11.37 ms | 19.15 ms | 18,497 条记录/s | 21.42 MiB | ±1.1% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 585 次/s | 1.71 ms | 1.50 ms | 2.93 ms | 8.97 ms | 585 条记录/s | 3.15 MiB | ±6.0% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 619 次/s | 1.62 ms | 1.47 ms | 2.40 ms | 6.85 ms | 619 条记录/s | 3.13 MiB | ±6.2% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 650 次/s | 1.54 ms | 1.42 ms | 2.00 ms | 9.37 ms | 650 条记录/s | 3.13 MiB | ±2.3% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 360 次/s | 2.78 ms | 2.58 ms | 3.59 ms | 10.13 ms | 360 条记录/s | 5.55 MiB | ±0.8% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 829 次/s | 1.21 ms | 1.09 ms | 1.62 ms | 9.69 ms | 829 条记录/s | 4.16 MiB | ±0.9% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 322 次/s | 3.11 ms | 2.89 ms | 4.32 ms | 7.49 ms | 322 条记录/s | 1.83 MiB | ±1.2% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 1,148 次/s | 863.7 µs | 814.0 µs | 1.16 ms | 1.57 ms | 1,148 条记录/s | 0 B | ±1.1% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 5 次/s | 185.0 ms | 184.4 ms | 189.8 ms | 195.6 ms | 5 条记录/s | 0 B | ±0.2% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 29,684,622 次/s | 269.5 ns | 0 B | 6.76 KiB | ±1.0% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 20,172 次/s | 6.35 ms | 56.29 MiB | 44.94 KiB | ±1.7% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 75,114 次/s | 106.5 µs | 5.29 MiB | 72.96 KiB | ±1.1% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 17,103 次/s | 468.5 µs | 2.92 MiB | 294.27 KiB | ±4.1% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 17,842 次/s | 7.18 ms | 73.14 MiB | 163.28 KiB | ±1.5% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 14,865 次/s | 8.61 ms | 9.73 MiB | 210.90 KiB | ±1.7% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 16.8 ns | 60,047,595 次/s | 88.80 MiB | 23.13 KiB | ±8.6% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 37.0 ns | 27,050,257 次/s | 78.97 MiB | 23.84 KiB | ±2.2% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 17.1 ns | 58,738,068 次/s | 85.73 MiB | 25.38 KiB | ±5.4% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 117.4 ms | 1.68 MiB | 4.89 KiB | ±2.2% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 14.49 ms | 0 B | -4.94 KiB | ±6.5% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准) · [下一页：10 常见问题 →](10-faq.md)

</div>
