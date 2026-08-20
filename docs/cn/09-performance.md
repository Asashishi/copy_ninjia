# 09 性能基准

<p align="center">
  <b>简体中文</b> · <a href="../en/09-performance.md">English</a> · <a href="../ja/09-performance.md">日本語</a>
</p>

<p align="center">
  <a href="conntent-table.md">📚 开发者文档首页</a> · <a href="08-commands.md">← 上一页：08 命令与行为参考</a> · <b>下一页：无 →</b>
</p>

---

本页的读数由 `bun run perf:full -- --write-doc` 生成，每次发布重跑一次并整块覆盖。
下面两个标记之间的内容不要手工编辑，也不要只更新三种语言中的一份。

基准本身只在发布和明确指令时运行，不属于 `bun run check`；热路径的 GC/RSS/JIT 硬门禁由
`bun run perf:hot-path-gate` 单独承担，见 [05 开发流程与质量门禁](05-dev-workflow.md)。

<!-- performance-benchmark:start -->

**最近一次全量基准** · Bun 1.3.14 · 3 轮取平均 · 2026-08-20T06:08:06Z · 进程启动到本地恢复就绪 398.4 ms · 单条群消息进入主干并完成基础分发 1.964 µs · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 1.21 ms / 723 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 8.46 ms / 100 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-08-20T06:08:06Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 367,030,605 |
| 进程读入 | 89.04 MiB |
| 进程写出 | 170.29 MiB |
| 块设备读 | 0 B |
| 块设备写 | 186.63 MiB |
| 读系统调用 | 36,024 |
| 写系统调用 | 80,508 |
| mock 根落盘 | 22.07 MiB |
| mock 根文件数 | 152 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 147.2 ms | ±7.0% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 35.39 ms | ±32.4% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 1.09 ms | ±7.4% |
| 读取并严格解析运行状态<br><code>state-load</code> | 2.32 ms | ±24.2% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 5.26 ms | ±22.9% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 540.6 µs | ±16.5% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 160.3 ms | ±10.5% |
| 填充主线程热缓存<br><code>hydrate</code> | 1.02 ms | ±25.4% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 398.4 ms | ±5.2% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 25 份 AI 记忆快照；进程峰值 RSS 111.75 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 1.964 µs | 509,241 次/s | 133.36 MiB | 27.67 KiB | ±0.3% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 14.3 ns | 70,022,581 次/s | 98.86 MiB | 21.43 KiB | ±3.3% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 27.5 ns | 36,525,409 次/s | 99.73 MiB | 20.46 KiB | ±7.1% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.7 ns | 1,526,206,288 次/s | 97.63 MiB | 22.61 KiB | ±4.3% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.5 ns | 223,039,628 次/s | 97.71 MiB | 20.78 KiB | ±10.3% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 16.9 ns | 59,192,754 次/s | 99.35 MiB | 20.13 KiB | ±4.8% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 60.7 ns | 16,818,034 次/s | 101.26 MiB | 21.10 KiB | ±15.0% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 10.77 µs | 93,018 次/s | 174.94 MiB | 22.58 KiB | ±4.0% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 97.3 ns | 10,288,440 次/s | 109.07 MiB | 17.46 KiB | ±4.0% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 59.8 ns | 16,971,664 次/s | 102.67 MiB | 18.97 KiB | ±12.3% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 513.9 ns | 1,946,601 次/s | 157.44 MiB | 5.78 MiB | ±1.8% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 517.2 ns | 1,937,448 次/s | 167.00 MiB | 19.87 KiB | ±4.4% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.6 ns | 219,582,112 次/s | 100.17 MiB | 21.30 KiB | ±5.4% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 5.354 µs | 186,855 次/s | 165.19 MiB | -1.86 MiB | ±1.9% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 186.5 ns | 5,431,470 次/s | 166.15 MiB | 22.49 KiB | ±10.8% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 715.8 ns | 1,397,132 次/s | 139.95 MiB | 22.30 KiB | ±0.8% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 78.22 µs | 12,785 次/s | 130.86 MiB | -1.85 MiB | ±0.2% |
| 提取回复引用<br><code>reply-reference</code> | 25.1 ns | 40,134,861 次/s | 128.92 MiB | 23.42 KiB | ±9.5% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 127.3 ns | 8,048,655 次/s | 143.31 MiB | 20.97 KiB | ±15.3% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.3 ns | 235,171,760 次/s | 104.67 MiB | 20.82 KiB | ±8.0% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 37.6 ns | 26,900,341 次/s | 126.81 MiB | 20.96 KiB | ±10.9% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 35.1 ns | 28,493,506 次/s | 124.45 MiB | 21.79 KiB | ±3.1% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 13.0 ns | 77,174,498 次/s | 103.62 MiB | 19.06 KiB | ±3.9% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 85.2 ns | 11,750,027 次/s | 100.24 MiB | 22.51 KiB | ±2.4% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前五行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 305 次/s | 3.28 ms | 2.37 ms | 9.37 ms | 28.23 ms | 305 条记录/s | 3.91 MiB | ±5.5% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 52 次/s | 19.36 ms | 19.18 ms | 36.23 ms | 60.28 ms | 6,670 条记录/s | 20.53 MiB | ±9.3% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 210 次/s | 4.75 ms | 3.64 ms | 12.77 ms | 25.05 ms | 210 条记录/s | 3.13 MiB | ±0.2% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 143 次/s | 7.05 ms | 5.23 ms | 15.53 ms | 45.94 ms | 143 条记录/s | 7.03 MiB | ±9.1% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 281 次/s | 3.55 ms | 2.63 ms | 10.56 ms | 25.60 ms | 281 条记录/s | 4.16 MiB | ±1.7% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 100 次/s | 9.97 ms | 8.46 ms | 20.70 ms | 30.63 ms | 100 条记录/s | 1.83 MiB | ±2.4% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 723 次/s | 1.37 ms | 1.21 ms | 2.23 ms | 4.27 ms | 723 条记录/s | 0 B | ±1.4% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 21,663,984 次/s | 371.8 ns | 0 B | 5.12 KiB | ±8.5% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 7,649 次/s | 16.73 ms | 61.91 MiB | -1.46 MiB | ±0.6% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 27,304 次/s | 293.3 µs | 4.83 MiB | -1.52 MiB | ±3.0% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 10,711 次/s | 750.3 µs | 2.67 MiB | 273.21 KiB | ±6.7% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 6,758 次/s | 18.94 ms | 67.68 MiB | -1.40 MiB | ±0.3% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 6,092 次/s | 21.03 ms | 8.91 MiB | 242.61 KiB | ±3.2% |

## 容器与算法

> 生产选用的容器与算法：滑动窗口用 `LinkedQueue` + `trimSlidingWindow`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 滑动时间窗口追加与过期淘汰<br><code>linked-timestamp-window</code> | 50.5 ns | 21,023,254 次/s | 172.62 MiB | 23.17 KiB | ±26.1% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 30.0 ns | 33,322,481 次/s | 127.10 MiB | 25.41 KiB | ±1.5% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 188.3 ms | 1.40 MiB | 3.50 KiB | ±5.0% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 52.53 ms | 0 B | -8.69 KiB | ±6.4% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：08 命令与行为参考](08-commands.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#09-性能基准)

</div>
