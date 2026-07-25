# 04 运行时权威约束

<p align="center">
  <b>简体中文</b> · <a href="en/04-invariants.md">English</a> · <a href="ja/04-invariants.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 开发者文档首页</a> · <a href="03-directory-map.md">← 上一页：03 目录导览</a> · <a href="05-dev-workflow.md">下一页：05 开发流程 →</a>
</p>

---

本页记录跨模块、跨生命周期的**权威约束**（前身为 `docs/architecture.md`）。源码注释应解释局部不变量并引用这里（`@see ../../docs/04-invariants.md`），不在多个模块重复维护整套启动或持久化叙述。改动涉及下列任何一条时，先改这里，再改代码。

导览版的架构讲解见 [02 架构总览](02-architecture.md)；触碰这些约束的修改步骤见 [06 常见修改配方](06-modification-guide.md)。

## 启动与 import 边界

- 生产模块 import 不启动 Worker、计时器、网络请求或共享目录写入。
- 主进程先递归创建并预检运行时数据根的写入、文件 fsync、hard link、原子 rename 与目录 fsync，再取得 `bot.lock`；随后校验 `config/`、清理顶层孤儿临时文件并严格恢复 `state.json`，这些步骤发生在任何联网和 Worker 创建之前。之后才初始化 Telegram 客户端与 Disk I/O Worker、恢复 `memory/` 数据、完成 handler/命令菜单/`bot.init()` 握手，最后初始化并 hydrate AI/Anti-Raid Worker、启动 acknowledgement-safe runner。
- 初始化失败和正常退出都由 `ApplicationLifecycle` 收口；只有已取得的资源才会释放或 flush。
- 配置解析器本身无 I/O；`getStickerConfig()` / `getReactionConfig()` / `getMoodConfig()` 在业务首次使用时惰性加载，主进程会在持锁后预热，以便部署错误在联网前暴露。
- `state.json`、`bot.lock`、`logs/` 与 `memory/` 全部从统一运行时数据根派生；生产缺省使用项目根目录，测试 preload 在任何生产模块 import 前注入逐隔离体的临时根，让真实文件 I/O 也不可能读写生产缓存。
- 命令菜单、`bot.init()`、Worker hydrate 与 acknowledgement-safe runner 就绪后，才启动低优先级群标题维护；标题 owner 当前最多并发 15 个 `getChat`，限制历史回填在共享 throttler 中造成的队头阻塞，并接受生命周期的 quiesce/abort 信号。
- 通用 JSON API 请求只允许访问 `JSON_API_ALLOWED_ORIGINS` 明列的 HTTPS origin，并禁用 redirect；新增调用方必须显式扩充白名单。Telegram 头像爬取使用独立入口，不得误接到该 JSON allowlist。

## Worker 与状态所有权

- 主线程持有 Telegram runner、Worker 监督句柄，并由 `StateStore` 独立维护 `state.json` 的内存镜像、latest-only 原子写、有限失败重试和退出 flush。有限重试耗尽是 fatal durability failure，必须停止 runner；不得继续确认 update。
- AI Worker 独占群聊记忆、回复准入、媒体描述流水线、群心情和贴纸目录生成的运行时状态。
- Anti-Raid Worker 独占验证/锁定状态机和对应计时器；主线程只持可恢复镜像。
- 状态机的 `State/Event/Effect/Transition/Decision` 契约统一由 `src/types/states/` 持有，`src/states/` 只实现无 I/O 的纯状态转移；解释器和 cache 直接依赖前者的类型。
- Disk I/O Worker 独占日志、AI 记忆、贴纸目录、运势和待验证数据的持久化，在单一 Worker 线程内串行读写这些共享目录；`state.json` 是明确的例外，由主线程 `StateStore` 异步维护。业务 Worker 不直接写共享目录。
- 长期 Map、Set、队列和 timer 必须由对应 `src/cache/<domain>/` 与业务生命周期模块共同给出容量、清理和 Worker 重建语义。
- 业务 Worker 与独立 Disk I/O 宿主都把同步 `postMessage` 拒绝统一收敛为显式失败；请求型投递立即清理 waiter/timer，日志只退回 console，关键业务投递触发 fatal。恢复重放再次拒绝时不得宣称 Worker writable。需要确认处理与落盘边界的调用方必须把 `false` 当作失败，不能确认对应 Telegram update。
- `/switch_mood` 采用主线程 request/waiter 与 AI Worker 回执握手。主线程必须先登记 waiter 再投递，并在超时、Worker 崩溃、放弃重启和停机时统一结算；请求携带绝对截止时刻，AI Worker 必须在重抽这一副作用之前拒绝已经过期的积压请求。只有 `moodSwitched` 回执能宣称重抽成功；后续 Telegram 成功回复发送失败不得被改写成「重抽失败」。
- AI 回复只把成功的文字、贴纸、反应和图片计入统一动作预算；模型提示上限为 8，执行侧硬顶为 11。贴纸、反应与生成图片各最多成功一次；其它动作工具不设单工具调用上限。贴纸包查看和 Google Search 分别保留独立查询上限，所有自定义函数调用另有整轮防循环硬顶。仅在零成功动作时，最终正文才经 `send_message` 兜底；所有有意展示的文字必须由模型显式调用该工具。
- AI 回复的初始 Gemini 输入必须保持一个 `user Content` 下的三个有序 `text Part`：只读参考记忆、只读当前会话、本轮回复任务。每段只由模型可见的首尾标签加一行段首职责标注包围；防注入总规则（数据 vs 指令、伪造边界无效、不暴露内部结构）统一只在 `systemInstruction` 声明一次，不逐段重复。工具调用后的历史再按真实 `model/user` 角色追加，不得把参考资料伪装成历史对话轮次。系统提示词只通过 `GenerateContentConfig.systemInstruction` 独立字段发送，不得拼入普通对话 `contents`。
- 群聊转录的行内标注（回复引用、转发来源）由 `src/consts/aiChat/prompts/transcript.ts` 的共享模板同时生成拼装文本与提示词说明里的占位形态，两侧不得各自手写同一格式；转发归属按标注层级区分：回复标注外层属于当前消息本身，内层属于被回复的原消息。多层回复链的逐跳格式、转发来源和 `[仅回复快照]` 标记也必须复用该领域模板；只有至少两层关系才向回复任务追加链路，快照链尾必须明确原消息已不在逐字转录中，不得暗示存在可供模型查阅的完整原文。
- Anti-Raid 对关联频道评论区的直属评论和楼中楼回复采用同一豁免语义；评论关联缓存只保存消息 ID 与观察时间，不把已无行为差异的来源标记泄漏进状态机。只有关联频道讨论组的评论线程才是候选：`message_thread_id` 同时也出现在论坛（topics）群的每一条话题消息上，必须用 `is_topic_message !== true` 把论坛话题排除，它们一律走普通待验证语义，不触发 barrier 加投与关联频道探测。冷缓存的 `message_thread_id` 只是异步确认候选：查询落定前先按普通待验证消息处理，仅在确认 `linked_chat_id` 且状态对象/代际仍一致时撤销；查询失败 fail closed 并允许后续重试。
- 真人的入群验证只接受本人点击：Worker 必须以可信的 `callback_query.from.id === callback_data` 目标 ID 计算本人关系，不能接受调用方直接声称。即使点击者在 `PRIVILEGED_USERS_ID` 中，也不得替真人通过；唯一代点例外是当前待验证快照明确 `isBot === true` 且点击者在该白名单中。无状态、已终结或目标不匹配的点击只能应答失败，不得改变验证记录。
- 验证提醒按成员只有一个投递 owner，发送失败有界退避。`reminderMessageId` / `replyReminderMessageId` 至少一个成功回填是超时踢人的前置不变量；从未落地时只续窗补发。恢复时尚无 reminder ID 的当前格式快照复用同一 owner，状态替换、离群、teardown 和 Worker 终止均会撤销它；这里是未成功发送提醒的业务状态，不是旧格式兼容分支。
- 发送者用户名缓存同时维护「归一化 username → identity」与「sender ID → 当前 username」；改名、去名、换绑和容量淘汰都在同一 owner 原子更新双向关系，解析器拒绝不一致别名。
- 匿名管理员本人仍按管理员身份豁免，但不能作为“可归属的管理员邀请人”为新成员继承邀请豁免。匿名管理员以当前群身份发言时，可见发送者必须保留当前群 identity，供 copy/头像爬取复用；破坏性的成员操作必须拒绝把当前群 identity 当作用户目标。
- chat runtime teardown 的三个固定 owner 回调由 `src/cache/chatTeardown.ts` 持有，上层领域经 `src/infra/chatTeardown.ts` 反向注册；`src/infra/botAdmin.ts` 不得静态依赖 `commands/`、AI 或 Anti-Raid 业务模块。

## 持久化

- `state.json` 使用最新值合并、临时文件、fsync 和原子 rename。命令开关、代理、copy 与权限/离群状态等权威变更必须等待对应 revision 依次写入主文件和 LKG 后才能反馈成功并返回 middleware；群标题等可重建元数据才允许后台最终一致保存。
- AI 记忆与贴纸目录按实体写原子快照；日志、运势和待验证状态使用可修复尾部截断的 JSON 追加文件。每批追加在成功回执前 fsync；待验证终结追加 tombstone，只保留东京当天文件，并在条数/字节阈值处收敛为 active 快照。截断修复必须按 JSON 字符串、转义与括号深度识别顶层成员边界，不能依赖对象值的收尾缩进；`null` tombstone 与其它基础类型都必须被视为完整的最后值。
- AI 记忆 upsert/delete 按 chat 使用运行时单调 revision。主线程持有未确认删除 tombstone，Disk I/O Worker 只有在 unlink 达到 durable 边界或删除已被更新 revision 覆盖时才回执；Worker 重建会重放 tombstone 与最新镜像，顺序不决定最终结果。一次已确认删除或 LRU 淘汰后的首份新快照必须立即写入，主线程在收到对应 durable upsert 回执前保留 revision 标记并在 Disk I/O Worker 重建后重放最新镜像。启动恢复以 `state.json` 为准，只 hydrate 明确启用 AI 的群，并为关闭群的残留快照安排删除。当前快照中的每条热区消息必须包含正数 `messageId`；回复链索引由这些消息重建，不单独持久化。
- 运势切换东京日 owner 前必须先 flush 旧日追加缓冲，失败则保持旧 owner 并拒绝轮换。目标日已有确认结果时，缺失密钥或密钥日期不一致属于不一致备份，必须拒绝启动/轮换，不能静默生成新密钥。
- AI 记忆恢复必须按当前 `AI_MEMORY_HYDRATE_BUFFER_MAX` 与 `MAX_SUMMARY_ROUNDS`（当前为 149 条逐字消息与 7 轮冷摘要）从快照尾部截取最新数据；调整容量常量部署前，应在旧进程停止后以同一恢复逻辑原子重写现有 `memory/ai/`，避免旧进程的停机 flush 覆盖迁移结果。
- 回复链索引（`chatReplyChainIndexes`）是滚动缓存的纯派生索引，不落盘、内层值与缓存共享对象引用；登记/删除只允许发生在消息进出热区的物理位置（`rollingMemory.ts` 的 push/轮换/hydrate），任何其它模块只读。索引因此永远只覆盖仍在热区的消息，容量受滚动缓存上限约束，无独立淘汰；机器人发送自录只按 Telegram 返回的实际 `reply_to_message` 建边，目标在生成/排队期间滑出热区时使用轮次开始前捕获的有界触发快照兜底，不扩张索引覆盖范围。模型可见的回溯深度、单个链节点正文和触发快照分别受 `REPLY_CHAIN_MAX_DEPTH`、`REPLY_CHAIN_NODE_MAX_CHARS`、`REPLY_REFERENCE_MAX_CHARS` 约束（当前为 15 跳、500 字、500 字）。
- Telegram update 只有在对应 middleware 完成后才可推进确认边界；Anti-Raid mailbox、反应/头像后台 owner 与 StateStore、AI Worker、Disk I/O Worker 的 flush 都有显式有界 drain。任一关键 flush 失败必须返回失败、阻止最终 offset 确认并以非零状态退出。
- 正常与异常停机都先 quiesce 标题/反应/头像/翻译入口并停止 runner，再有界 drain。四个 quiesce 调用必须逐项捕获失败：任一入口抛错时仍须尝试其余入口，未全部成功不得缓存静默完成，且该次失败必须阻止最终 offset 确认和实例锁释放；后续 `wait()`/`dispose()` 可重试所有幂等入口。翻译客户端只在首次真实请求时惰性构造，单次 RPC 有项目级短超时，drain 后显式 `close()` 并清理 project parent/客户端引用。翻译 drain 超时或 close 失败与其它关键 owner 一样阻止释放实例锁。正常路径必须在确认最终 Telegram offset 前依次 flush AI、Disk I/O 与 StateStore；最终 dispose 按「flush AI → 终止 AI → flush Disk I/O → 终止 Anti-Raid/Disk I/O → flush StateStore」收尾。若致命异常发生时普通 dispose 已在途，异常路径可以复用该 Promise，但必须另设当前 15 秒的绝对强制退出 deadline，不能被既有 drain 无限拖住。预算耗尽时 abort 仍在进行的 Telegram 请求、媒体下载和 429 sleep，结算尚未开始的队列；abort 后不得再发送消息、改头像或写入群标题。异常退出路径的维护预算为 0：drain 必须把「预算为 0」当成合法输入，空闲直接结算为 `flushed`，仍有在途工作则立即 abort 并结算为 `timedOut`，绝不能因参数校验抛错；未结束的标题刷新在跳过时同样必须 abort。dispose 的每个 owner 也要各自失败隔离，异常一律折算为 `failed` 参与结算，任何单点抛错都不得跳过其后的 owner、`flushStateToDisk` 与实例锁处置。
- Worker flush 与 mailbox barrier 统一使用 `src/libs/flushBarrier.ts` 管理 ID、等待表、超时、迟到回执和崩溃批量结算；领域缓存不得重新暴露 resolver Map。
- 当前部署基线是单租户云原生环境，开发工作区同时就是生产工作区；编辑器、自动化工具与运行时可能以不同容器 UID 共同维护同一挂载卷，因此项目目录和受管文件必须允许这些进程原地修改。隔离租户内的宽松 Unix mode 本身不视为越权暴露；若迁移到共享主机、共享卷或其它跨信任边界的部署形态，必须在上线前重新设计 owner、group 与权限。
- `memory/` 产物统一为 `0644`：属主可写、普通系统用户可读。敏感性由云实例的单租户边界、部署隔离和备份策略控制，不通过制造不可读文件解决。
- 持久化 schema 不做猜测式自动迁移；不兼容输入会阻止启动，避免空状态覆盖原数据。
- 当前 lockdown 镜像要求 `phase` 与正数 `intentId`；待验证 active 记录要求 `phase` 与 `trackedMessageTimes`。reminder ID 仍是业务可选字段：缺失只表示提醒尚未成功落地，恢复后走可靠补发。其它缺失或不兼容字段必须在旧进程停止期间人工迁移，生产读取路径不保留兼容逻辑。

## 兼容入口

大文件拆分时保留的顶层 barrel 只用于渐进迁移。新增生产代码应从所属领域文件导入；兼容入口不得重新持有状态、解析配置或引入 import 副作用。

运势回执不设旧格式兼容分支：验签要求回执内嵌日期等于当天东京日期、且日级密钥每天轮换，因此跨日回执一律验不过——旧格式回执在展示标签格式上线次日起就已不可能通过验证。识别、剥离与验签一律只认当前格式（标签前缀 + 定长 HMAC 摘要 + 同范围 `text_link` 实体携带的原回执）。

---

<div align="center">

[← 上一页：03 目录导览](03-directory-map.md) · [📚 开发者文档首页](README.md) · [⬆️ 回到顶部](#04-运行时权威约束) · [下一页：05 开发流程 →](05-dev-workflow.md)

</div>
