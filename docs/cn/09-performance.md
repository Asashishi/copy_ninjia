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

**最近一次全量基准** · Bun 1.4.2 · 3 轮取平均 · 2026-09-09T15:22:44Z · 进程启动到本地恢复就绪 507.4 ms · 单条群消息进入主干并完成基础分发 1.256 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.13 ms / 794 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 5.97 ms / 151 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| 内核 | linux 6.8.0-138-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-09-09T15:22:44Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,405 |
| 进程读入 | 121.50 MiB |
| 进程写出 | 178.32 MiB |
| 块设备读 | 0 B |
| 块设备写 | 197.80 MiB |
| 读系统调用 | 40,107 |
| 写系统调用 | 85,190 |
| mock 根落盘 | 17.43 MiB |
| mock 根文件数 | 161 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 151.7 ms | ±1.3% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 21.44 ms | ±10.3% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 773.3 µs | ±12.9% |
| 读取并严格解析运行状态<br><code>state-load</code> | 2.05 ms | ±8.8% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 7.39 ms | ±5.4% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 978.5 µs | ±12.9% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 300.2 ms | ±2.0% |
| 填充主线程热缓存<br><code>hydrate</code> | 658.9 µs | ±17.6% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 507.4 ms | ±1.7% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 113.76 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.256 µs | 799,627 次/s | 79.44 MiB | 24.69 KiB | ±6.7% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 164.8 ns | 6,227,105 次/s | 86.06 MiB | 22.48 KiB | ±15.2% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 18.5 ns | 55,705,692 次/s | 72.80 MiB | 22.05 KiB | ±17.5% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 39.1 ns | 25,980,079 次/s | 72.97 MiB | 22.26 KiB | ±12.9% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 49.3 ns | 20,313,713 次/s | 74.14 MiB | 21.84 KiB | ±4.7% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,174,232,908 次/s | 71.76 MiB | 20.87 KiB | ±17.5% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 51.4 ns | 19,462,300 次/s | 74.03 MiB | 22.66 KiB | ±2.4% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.3 ns | 233,634,818 次/s | 72.33 MiB | 22.00 KiB | ±6.5% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 13.5 ns | 73,985,213 次/s | 72.89 MiB | 20.79 KiB | ±4.1% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 47.8 ns | 21,025,770 次/s | 74.22 MiB | 20.97 KiB | ±7.1% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 13.68 µs | 73,209 次/s | 97.52 MiB | 20.19 KiB | ±3.6% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 119.2 ns | 8,408,366 次/s | 79.55 MiB | 24.36 KiB | ±4.7% |
| 推进临时白名单日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 49.2 ns | 22,286,783 次/s | 79.53 MiB | 22.10 KiB | ±26.9% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 53.8 ns | 19,390,570 次/s | 74.54 MiB | 19.63 KiB | ±22.0% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 456.5 ns | 2,196,522 次/s | 118.25 MiB | 5.63 MiB | ±5.2% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 489.7 ns | 2,050,665 次/s | 133.60 MiB | 20.77 KiB | ±6.4% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.3 ns | 231,341,483 次/s | 73.00 MiB | 21.52 KiB | ±3.0% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.470 µs | 183,261 次/s | 82.61 MiB | 24.23 KiB | ±4.9% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 124.3 ns | 8,120,457 次/s | 114.88 MiB | 23.19 KiB | ±9.3% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 338.2 ns | 2,958,584 次/s | 98.59 MiB | 26.87 KiB | ±2.6% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 55.66 µs | 17,968 次/s | 95.36 MiB | 23.96 KiB | ±0.9% |
| 提取回复引用<br><code>reply-reference</code> | 34.4 ns | 30,777,383 次/s | 80.65 MiB | 23.28 KiB | ±25.0% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 68.1 ns | 14,714,536 次/s | 86.21 MiB | 21.36 KiB | ±5.3% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.5 ns | 221,366,798 次/s | 76.39 MiB | 22.10 KiB | ±4.1% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 33.2 ns | 30,231,285 次/s | 80.73 MiB | 20.14 KiB | ±7.2% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 26.7 ns | 37,469,522 次/s | 72.60 MiB | 21.56 KiB | ±2.7% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 12.9 ns | 77,744,168 次/s | 76.66 MiB | 20.73 KiB | ±3.5% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 80.4 ns | 12,525,216 次/s | 72.91 MiB | 21.02 KiB | ±8.4% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 364 次/s | 2.75 ms | 2.10 ms | 6.01 ms | 25.01 ms | 364 条记录/s | 3.91 MiB | ±2.3% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 72 次/s | 14.01 ms | 14.38 ms | 24.47 ms | 81.15 ms | 9,154 条记录/s | 20.53 MiB | ±4.4% |
| 累计 1 条临时白名单活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 306 次/s | 3.29 ms | 2.65 ms | 6.91 ms | 20.03 ms | 306 条记录/s | 3.15 MiB | ±8.9% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 182 次/s | 5.55 ms | 4.44 ms | 13.09 ms | 40.87 ms | 182 条记录/s | 3.13 MiB | ±10.6% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 307 次/s | 3.25 ms | 2.68 ms | 6.00 ms | 19.37 ms | 307 条记录/s | 3.13 MiB | ±3.1% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 175 次/s | 5.70 ms | 4.89 ms | 11.84 ms | 20.17 ms | 175 条记录/s | 11.72 MiB | ±2.4% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 376 次/s | 2.66 ms | 2.10 ms | 4.76 ms | 40.65 ms | 376 条记录/s | 4.16 MiB | ±1.9% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 151 次/s | 6.65 ms | 5.97 ms | 11.59 ms | 20.92 ms | 151 条记录/s | 1.83 MiB | ±5.3% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 794 次/s | 1.25 ms | 1.13 ms | 1.86 ms | 3.48 ms | 794 条记录/s | 0 B | ±2.8% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 25,270,116 次/s | 316.9 ns | 0 B | 7.75 KiB | ±3.0% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 10,193 次/s | 12.60 ms | 61.90 MiB | 29.25 KiB | ±6.0% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 42,787 次/s | 187.1 µs | 4.86 MiB | 77.45 KiB | ±2.3% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 12,499 次/s | 641.5 µs | 2.70 MiB | 285.15 KiB | ±4.7% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 10,291 次/s | 12.45 ms | 67.73 MiB | 176.09 KiB | ±2.3% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 8,820 次/s | 14.52 ms | 9.00 MiB | 220.52 KiB | ±1.9% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 16.8 ns | 59,812,011 次/s | 82.29 MiB | 23.51 KiB | ±5.3% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 37.1 ns | 27,068,489 次/s | 73.84 MiB | 23.26 KiB | ±5.7% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 18.3 ns | 54,935,568 次/s | 80.72 MiB | 24.50 KiB | ±7.9% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 154.1 ms | 2.21 MiB | 4.96 KiB | ±3.2% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 33.18 ms | 0 B | -4.97 KiB | ±3.9% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
