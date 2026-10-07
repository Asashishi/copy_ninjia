# 04 运行时权威约束

<p align="center">
  <b>简体中文</b> · <a href="../en/04-invariants.md">English</a> · <a href="../ja/04-invariants.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="03-directory-map.md">← 上一页：03 目录导览</a> · <a href="05-dev-workflow.md">下一页：05 开发流程 →</a>
</p>

---

本页记录跨模块、跨生命周期的**权威约束**。源码注释应解释局部不变量并引用这里（例如 `@see ../../docs/cn/04-invariants.md`；按源码深度调整 `../`），不在多个模块重复维护整套启动或持久化叙述。改动涉及下列任何一条时，先改这里，再改代码。

导览版的架构讲解见 [02 架构总览](02-architecture.md)；触碰这些约束的修改步骤见 [06 常见修改配方](06-modification-guide.md)。

> [!TIP]
> 本页是供实现与审查时查阅的约束全集，不必从头顺序通读。先从下方导航进入领域；长条目按段落阅读，段首的粗体文字通常是该段必须守住的结论。

## 快速导航

| 范围 | 主题 |
| --- | --- |
| [启动与 import 边界](#启动与-import-边界) | [启动顺序与资源获取](#启动顺序与资源获取) · [可选凭据与严格配置预检](#可选凭据与严格配置预检) · [数据根与后台任务](#数据根与后台任务) · [出站请求与消息安全](#出站请求与消息安全) |
| [Worker 与状态所有权](#worker-与状态所有权) | [线程与状态归属](#线程与状态归属) · [状态机契约](#状态机契约) · [AI 闲聊运行时](#ai-闲聊运行时) · [AI 提示词与转录](#ai-提示词与转录) · [入群验证与终态处置](#入群验证与终态处置) · [刷屏禁言与自身权限缓存](#刷屏禁言与自身权限缓存) · [身份解析与运行时清理](#身份解析与运行时清理) |
| [持久化](#持久化) | [落盘与快照契约](#落盘与快照契约) · [群状态与 `chat_states`](#群状态与-chat_states) · [群问答与 `chat_qa`](#群问答与-chat_qa) · [黑名单与广告检测](#黑名单与广告检测) · [运势与 AI 记忆恢复](#运势与-ai-记忆恢复) · [确认边界与停机](#确认边界与停机) · [文件权限与 schema](#文件权限与-schema) · [锁定镜像与终态标志](#锁定镜像与终态标志) |
| [兼容入口](#兼容入口) | 顶层 barrel 与运势回执格式 |

## 启动与 import 边界

### 启动顺序与资源获取

- **默认时区为进程启动时的只读快照**：
  - `config/static/bot.json` 中的可选字段 `time_zone` 使用标准 IANA 时区名称，缺省值为 `DEFAULT_BOT_TIME_ZONE`（即 `Asia/Tokyo`）。
  - 去除首尾空白后，系统会严格校验 Intl、Temporal 及 Bun 原生 cron 是否均支持此时区，并取 Temporal 规范化后的大小写名称（如 `asia/tokyo` 规范化为 `Asia/Tokyo`；`Japan` 等别名原样保留）。若时区为空字符串、类型非法或操作系统不支持，将在建立任何外部连接前报错退出。
  - 主线程持有该时区的权威快照，在启动时分别通过 `init`、`agentConfig` 和 `load` 消息分发给 AI、Anti-Raid 与 Disk I/O Worker；Worker 崩溃重建时重放同一份快照。
  - 每个线程的 `cache/perThread/time.ts` 独立维护此时区、格式化器与当前处于的 UTC 偏移区间：在相邻两次夏令时/冬令时转换之间，UTC 偏移恒定不变；日序号、日期字符串、本地时间串和小时计算在此区间内仅进行整数运算与对比，未命中区间时才由 Temporal 重新计算。
  - 机器人的运势抽签、日志记录、广告频次累计、入群日志、AI 时间感知及每日维护共用此时区。东京天气查询工具仅在基准时区为 `Asia/Tokyo` 时启用，其他时区下不注册该工具。

- **数据根永久绑定时区**：
  - 首次初始化数据库时，`initializeStorageDatabase` 会将当前配置的时区写入 `storage_metadata` 表中的 `time-zone` 记录（如 `{"timeZone":"Asia/Tokyo"}`）。
  - Disk I/O Worker 在启动时、以及安装脚本在注册服务前，均会核对数据库记录的时区与 `bot.json` 的 `time_zone` 是否一致；若不一致则直接拒绝启动并提示 `storage_metadata.time-zone`。已有数据根不支持直接更换时区。

- **模块 Import 禁止产生副作用**：
  - 源码模块在被 `import` 时，禁止启动 Worker、注册计时器、发起网络请求或向磁盘写入数据。

- **数据根目录预检与排他单实例锁**：
  - 主进程在启动时，会递归创建并预检运行时数据根目录的写权限、文件 fsync、同目录 hard link、原子 rename 与目录 fsync 能力；全部通过后才尝试竞争获取 `bot.lock` 单实例文件锁。
  - **路径与权限约束**：数据根目录以及 `memory/`、`logs/`、`database/` 必须是真实的物理目录，若检测到符号链接将报错退出。显式配置 `COPY_NINJIA_DATA_ROOT` 时，数据根、`memory/` 与 `logs/` 的权限不得放开 group/other 写权限；`database/` 则允许协作组具备写入权限以支持 SQLite 旁路文件。
  - **冷启动清理与恢复**：启动时自动清理上一次异常中断残留的临时文件；若在数据根根目录下发现未迁移的旧版 `state.json` 或 `state.json.bak`，则直接拒绝启动。在建立网络连接或启动 Worker 之前，必须先恢复 `memory/global/state.json`。
  - **单实例锁边界**：同一数据根在同一时刻只允许一个运行中的进程实例；锁状态基于 `/proc/<pid>/stat` 与内核 boot ID 进行活跃性校验。

- **生命周期的严格推进顺序**：
  1. 对所有已存在的部署配置文件进行严格校验。
  2. 启动 Disk I/O Worker 并完整加载恢复持久化状态。
  3. 初始化 Telegram 客户端，挂载中间件、注册命令菜单并完成 `bot.init()` 握手。
  4. 启动并填充 AI Worker 与 Anti-Raid Worker 的运行时数据。
  5. 启动确认式 Runner 开始长轮询拉取并消费 updates。
- **统一生命周期收口**：初始化失败与正常退出均由 `ApplicationLifecycle` 统一收口，严格按照依赖反序清理与释放已成功取得的资源。

### 可选凭据与严格配置预检

- **启动时配置严格校验**：
  - 配置文件解析器本身不执行 I/O 操作。主线程在创建 Worker 与建立网络连接前，会通过 `validateExistingDeploymentInputs` 对所有已存在的部署配置文件进行完整语法与 schema 校验；未开启某功能不能作为配置文件内容非法的豁免理由。
  - 若可选配置文件真正不存在，系统不会阻止启动，而是由各功能的可用性判定机制将相应功能置为禁用。主线程持有各项配置的权威快照，`config/dynamic/` 下的文件在运行期修改后支持热重载，其余文件修改后必须重启生效。
  - `config/dynamic/agent.json` 中，广告检测读取 `agent.ad_detect`，AI 闲聊读取 `text`、`summary`、`media` 及可选工具；启动校验会覆盖文件中填写的所有能力项。

- **身份权限以 SQLite 数据库为唯一权威源**：
  - 白名单、黑名单、临时广告免检与待处置记录统一存储于 `database/storage.sqlite` 中；运行时不读写任何名单 JSON 文件。
  - Disk I/O Worker 在启动时会核验 SQLite 完整性、JSONB 存储类、迁移版本、数据库时区标记、每行数据的编解码以及黑白名单的互斥性，任何一项校验失败都会终止启动，防止系统以部分损坏的状态运行。

- **主线程通过有界 LRU 缓存进行同步鉴权**：
  - 为了避免高频消息处理在鉴权时频繁发起跨线程请求，主线程维护了容量有限的 LRU 缓存（永久白名单、黑名单与临时广告免检各最多保存 `IDENTITY_READ_CACHE_MAX_ENTRIES` 项）。缓存中为 `null` 表示明确不在名单中（负缓存）。
  - **按需批量预热**：每条消息在进入具体业务逻辑前，前置中间件会收集本条消息涉及的所有用户和频道身份，单次向 Disk I/O Worker 批量预取策略状态（单次最多 `IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES` 个）。后续的命令执行与权限判定直接同步读取主线程内存缓存，无需反复进行跨线程往返请求。
  - **冷读失败安全处理**：若跨线程预热读取失败，普通业务将安全降级（按未授权处理）；对于踢人、拉黑等破坏性批量操作，则直接取消执行，绝不把未知状态当成无保护状态。
  - **批量踢人例外（`/batch_kick`）**：批量踢人不依赖缓存是否常驻，而是在每个批次开始前直接冷读本批全部身份的永久策略并在局部持有。

- **临时广告免检的跨群累计机制**：
  - 仅当广告检测功能可用且当前群已显式开启广告检测时，普通用户或频道马甲的正常发言才会参与免检累计；机器人自身、自动转发、匿名管理员与永久白名单成员均不参与累计。
  - 在配置时区的自然日内，发言次数严格超过 `TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD` 时，记录本日达标（同一天只记一次）；首个达标日立即授予临时广告免检权限。
  - 连续 `TEMPORARY_AD_BYPASS_REQUIRED_DAYS` 个自然日均达标后，系统会自动将其升级写入永久白名单（仍仅持有广告免检权限）。
  - 累计严格按配置时区的自然日计算，不使用滚动的 24 小时：若某一天未达标，次日零点维护时将删除该条临时累计记录；若用户被检测出广告违规或被管理员手动拉黑，其临时累计记录将被立即清除。

- **写入采用容量准入、写透（write-through）与精确版本号确认（revision ACK）**：
  - 身份策略变更时，主线程先核查未确认的条目数与载荷预算，随后更新本地 LRU 缓存、记录 revision 版本号并投递给 Disk I/O Worker。
  - 只有收到 Disk I/O Worker 对该 revision 的成功确认回执（ACK）后，主线程才释放对应的待办预算。
  - Disk I/O Worker 在待写条目累积达到上限、或等待超过刷新间隔（`IDENTITY_WRITE_FLUSH_INTERVAL_MS`）时，通过单一数据库事务统一提交所有变更。
  - 事务成功后向主线程发送精确 ACK；若事务失败则保留待写数据并进行退避重试，连续重试失败达到上限时将通知主线程暂停接收新业务。

- **超级管理员权限直接来自身份本身**：
  - 超级管理员（`SUPER_ADMIN_USER_ID`）在代码层享有白名单的全部权限，该权限在读取时直接生效，不写入 SQLite 数据库中。
  - `/white` 与 `/permission` 命令禁止将当前群本身的 identity 作为操作目标；超级管理员可委托他人使用 `/white enable` 添加成员，但受委托人只能按默认权限添加，删除成员与权限调整仍必须由超级管理员执行。

- **Telegram 机器人身份与 AI 配置的读取边界**：
  - 机器人的 `bot_token` 与 `super_admin_user_id` 严格来自于 `config/static/bot.json`；启动连接 Telegram 前必须校验通过。
  - AI 密钥统一在 `config/dynamic/agent.json` 中配置，每项能力独立指定 provider、api_key、base_url 和 model，不存在跨能力的默认回退。
  - **AI 配置文件仅由主线程读取**：主线程在启动及动态热重载时解析 `agent.json`，并将生效的只读快照推送给各 Worker。Worker 线程内部绝不直接读取配置文件，保证内存配置的一致性。
  - 核心能力（`text` 文本、`summary` 记忆压缩、`media` 媒体理解）必须全部配置齐备，AI 闲聊功能方可启用；缺少生图或语音能力仅摘除对应工具，缺少 `ad_detect` 则仅禁用广告自动检测。

- **媒体支持度动态探测机制**：
  - 不同的模型供应商或 API 端点对图片和音频的支持各不相同。系统不会仅凭供应商名称硬编码判断，而是通过每种模态的首次真实请求进行动态探测。
  - 探测结论分为三种：`supported`（支持）、`unsupported`（端点明确不支持此模态）、`misconfigured`（模型或地址配置错误，404/405）。
  - 若探测结果为不支持或配置错误，系统将停止下载该模态的新媒体，避免浪费网络流量与调用配额。当修改配置文件触发热重载时，探测状态会重置并重新探测。

- **配置目录结构检查**：
  - 在读取任何配置文件前，系统会首先检查 `config/` 的目录结构：所有配置文件必须放在 `config/static/` 或 `config/dynamic/` 子目录中，禁止在 `config/` 根目录下直接存放配置文件。

- **`config/dynamic/` 动态热重载机制**：
  - 主线程在业务 Worker 启动后，使用文件监听监听 `config/dynamic/` 目录变动（`config/static/` 下的文件修改后必须重启）。
  - 监听到变动后，系统通过防抖计时器（`CONFIG_RELOAD_DEBOUNCE_MS`）合并短时间内的频繁变动，然后串行执行配置重载。
  - 热重载采用与启动时相同的严格校验器：如果新文件存在格式或语法错误，该次改动将被整体拒绝，系统继续沿用当前的有效配置并记录错误日志；如果配置文件内容与当前快照一致，则不会进行多余更新。
  - 跨文件依赖核对：若 `cron.json` 中的任务用到了语音合成或摘要生成，但 `agent.json` 中缺少相应能力，系统会阻止配置更新并报错，保证配置在任何时刻都完整有效。
  - AI Worker 接管新的 `agent.json` 快照后丢弃旧的能力门面与 SDK 客户端，下一次取用按新快照重建。一轮 AI 回复在创建会话时固定 text 能力的模型与客户端，整轮工具往返（含 Anthropic `pause_turn` 续发）都沿用它们，热重载只影响之后开始的回复；Gemini 会话在第一次请求前若配置已被替换，不引用共用显式缓存。

  每次配置更新生效后，`packages/app/configReload.ts` 会重新计算 AI 闲聊与广告检测的功能就绪状态（readiness）。若功能转为可用，将按需唤醒或恢复对应 Worker；若转为不可用，则停止新任务投递，并关闭对应的开启命令，但已持久化的群开关和对话记忆依然安全保留。
  
  所有凭据（Token、API Key 等）在日志记录时均受脱敏系统保护，确保任何日志与错误报告中都不会泄露敏感密钥。

### 数据根与后台任务

- **数据根路径派生**：
  - 机器人的所有运行时数据（`bot.lock` 单实例锁、`logs/` 运行日志、`database/` 数据库以及 `memory/` 对话记忆与状态）均派生自统一的运行时数据根目录（通过环境变量 `COPY_NINJIA_DATA_ROOT` 配置，默认为项目根目录）。
  - 在测试环境中，测试沙盒会在模块导入前自动注入独立的临时数据根，确保真实的测试文件读写绝不会污染或覆盖生产数据。
- **低优先级群标题维护**：
  - 在系统启动就绪、命令菜单与长轮询 Runner 完全运转后，主线程会启动低优先级的群组标题异步更新任务。
  - 通过 `runBoundedSettledBatch` 逐个调用 `getChat` 获取最新群名，各群独立处理，支持在收到停机信号时平滑中止。

### 出站请求与消息安全

- **主线程独占 Telegram 网络连接**：
  - 真实的 grammY Bot 实例、底层 HTTP 请求与文件 CDN 下载能力仅归主线程独占。
  - AI Worker 与 Anti-Raid Worker 内部不包含 Bot Token 和网络客户端，需要调用 Telegram 接口时，必须通过进程内双工通道向主线程申请白名单允许的受限动作，由主线程出站总闸统一代理执行。

- **统一的出站请求闸门与 429 智能退避**：
  - 所有发往 Telegram 的请求统一由出站网关管理，并根据请求类型（普通群消息、查询、删除、禁言、踢人等）划分独立的调度车道。
  - **基于令牌桶的限流控制**：对于发送消息类请求，系统根据 Telegram 官方建议的频率上限主动控速（包含单群频次、多群聚合频次与全局突发限制）。
  - **429 智能退避与故障隔离**：
    - 若某个群的消息发送触发了 Telegram 429 限流，出站调度器仅将**该群**的消息队列暂停指定的 `retry_after` 时长，其他群的消息发送完全不受影响。
    - 非消息类请求（如删除、查询、禁言等）按类别各自维护独立的退避窗口，某一类请求受限不会阻塞其他类别的执行。

- **防止机器人消息自发自收与死循环回环**：
  - 机器人自身发出的消息在出站代理边界会自动打上标识并登记。
  - 对于容易收到频道自动转发的群组，在处理可能引发自动回复的消息前，系统会等待在途的自发请求结算，彻底避免因处理自身历史消息而引发死循环复读或误触发。

- **富文本格式安全（防解析失败与注入）**：
  - 出站消息的富文本格式严格遵循二选一原则：
    1. **显式 Entities**：由调用方自行计算 UTF-16 偏移量并传递实体数组。
    2. **MarkdownV2 模式**：所有拼入消息正文的动态内容（包括群友昵称、大模型生成的文字、配置内容等）必须全部经过 [`libs/telegramMarkdown.ts`](../../packages/libs/telegramMarkdown.ts) 转义，严禁直接拼接未转义的原始字符串；若 Telegram 仍拒绝解析，则作为普通错误记录日志，坚决不降级为纯文本重发。
  - 纯文本消息则按纯文本原样发送，禁止任何可能被 Telegram 误解析为格式实体的字符注入。

- **命令守卫（防止恶意诱导执行命令）**：
  - 在复读、AI 闲聊、生图图注以及定时摘要等所有由机器人向群内发出的文本出口，均必须经过命令守卫检查（`containsRenderableCommand`）。
  - 特别地，复读模式在反转文字后，检查的是**实际最终发出的文本**而非变换前的原文；若检测到文本内容构成了可被群友点击触发的 Telegram 命令，系统将整条丢弃，防止被恶意利用作为命令跳板。

- **禁言时长与截止时间的严格校验**：
  - 使用 `/mute` 临时禁言时，时长必须严格留出安全余量，避免因时间临界点被 Telegram 误判为永久禁言；若请求在出站队列中排队等待过久导致实际截止时间已过，系统会自动放弃执行该次禁言，避免产生脏状态。

- **群内非功能性提示的 30 秒自动删除**：
  - 机器人在群内发送的非功能性提示（如命令参数错误、权限拒绝、用法说明与操作成功回执等），在发送成功 30 秒（`COMMAND_MESSAGE_AUTO_DELETE_MS`）后必须自动从群内删除，避免污染群聊天记录。
  - **长期保留的例外项**：用户明确授权的权限看板（`/permission query/help`）、问答看板（`/qa query`）、问答直接命中的答案、成功的中文动作命令结果（如 `/咬`）、`/h_image` 随机图片以及 AI 和翻译等会话性消息。
  - 状态机拥有的交互消息（如入群验证按钮卡片、`/qa set` 录入表单、`/wed` 结果卡片、口球管教公告等）不由固定定时器删除，而是由用户点击按钮、状态机流转或机器人退群时主动清理。

- **论坛话题群（Topics）的消息落点规则**：
  - **交互触发的消息**：用户命令或群友交互所触发的所有回复（无论是长期保留的消息还是 30 秒自删的回执），均自动发送到触发消息所在的具体话题线程（`message_thread_id`）。
  - **主动广播的消息**：机器人主动发出的系统性公告（如防刷屏禁言播报、广告封禁提醒、防冲群私密模式公告等）以及 `cron.json` 定时任务，在开启了话题的群组中统一发送到通用（General）话题。

- **开关命令状态反馈的一致性**：
  - 执行 `/init`、`/ai_chat`、`/ad_detect`、`/antiraid` 等开关命令时，系统在写入前均会核对当前实际状态；若重复执行已处于的状态，回执必须明确说明「当前已是该状态」，不得谎报状态发生变更。
  - 执行 `/init disable` 关闭群组时，系统会先安全持久化关闭标志，随后清理该群在各模块中的运行时数据与记忆，确保数据清理彻底且逻辑严谨。

<p align="right"><a href="#快速导航">↑ 返回快速导航</a></p>

## Worker 与状态所有权

### 线程与状态归属

- **各线程明确划分状态职责，严禁跨线程内存共享**：
  - **主线程**：持有 Telegram runner、各 Worker 监督句柄，以及 `cache/main/storage.ts` 中的 `memory/global/state.json` 权威内存镜像。
    - `infra/storage/stateStore.ts` 是业务门面，负责在恢复时填充内存镜像、构建领域快照并提供访问器。
    - `infra/storage/statePersistence.ts` 的 `StateStore` 负责底层严格解码、latest-only 原子落盘、有限失败重试与退出时的 flush。
    - 有限重试耗尽属于致命持久化故障（fatal durability failure），系统必须立刻停止 runner，绝不能继续确认 Telegram update。
  - **AI Worker**：独占群聊滚动记忆、回复准入判断、多模态媒体描述流水线、全局心情以及贴纸包目录生成的运行时状态。
  - **Anti-Raid Worker**：独占入群验证与防冲群私密模式（Lockdown）的状态机及其关联计时器。主线程仅保存用于崩溃恢复的镜像。
  - **Disk I/O Worker**：独占日志、AI 记忆、贴纸目录、运势以及待验证数据的磁盘 I/O，并在单一专用线程内串行读写这些共享目录。
    - `memory/global/` 是唯一的例外：由主线程通过 `stateStore.ts` 门面调用 `statePersistence.ts` 的 `StateStore` 异步落盘。业务 Worker 严禁直接读写共享存储目录。
  - **长期容器管理**：长生命周期的 Map、Set、队列和 timer 必须在 `packages/cache/` 模块与业务生命周期模块中，明确定义其容量上限、清理时机以及 Worker 重建后的恢复语义。

- **缓存文件的线程归属由目录名决定，并通过门禁静态核验**：
  - `packages/cache/` 的一级子目录代表该缓存的权威所有者（Owner）：
    - `main/`：主线程独占。
    - `workers/aiChat/`、`workers/antiRaid/`、`workers/diskIO/`：对应 Worker 线程独占。
    - `perThread/`：每条线程各自持有一份独立状态（如 Telegram 能力持有者、Worker 双工 waiter、部署配置单例、自发消息登记、update 取消上下文存储）。
  - 每个缓存文件首行必须使用 `/** owner: <main|perThread|workers/<线程>>。` 标注，内容需与所在目录严格一致。
  - 线程间仅通过消息通信。`bun run check:conventions` 从各线程入口（`index.ts` 及各 `*Worker.ts`）计算运行时 import 闭包，发现跨线程非法 import 会直接中断并输出完整引入链。
  - **豁免登记**：跨线程引入只能登记在 `CACHE_OWNER_EXEMPTIONS`，当前为空。`infra/logger.ts` 不静态依赖 `infra/diskIO.ts`：主线程的 error 日志经 `cache/perThread/logger.ts` 的 `logRelaySink`（由 `initDiskIO` 装上 `relayLogMessage`）转投落盘线程，Worker 线程的 error 日志按批转发回主线程再转投。

- **Worker 模块如果需要主线程数据，必须由主线程预先求值后作为最终字段传入**：
  - 例如，AI 识别超级管理员身份所需的信息，由主线程在发送 `init` 消息时直接注入，AI Worker 禁止 import `config/bot.ts`。
  - Worker 执行涉及 Telegram API 的操作时，只向主线程发送包含最小白名单参数的消息由其代理，绝不向 Worker 镜像 Bot token、Telegram 客户端或出站队列。
  - 高频群聊消息处理中严禁为此增加双工 request/reply，只有天然需要远端调用结果的场景才走双工等待。

- **进程间通信（IPC）故障处理与日志转发**：
  - 业务 Worker 与 Disk I/O 宿主将同步 `postMessage` 拒绝统一收敛为显式失败：请求型投递立即清理关联的 waiter/timer，关键业务投递则触发致命故障（fatal）。
  - **已接纳的错误日志采用「两跳确认（Two-hop ACK）」机制**：
    1. 第一跳：业务 Worker → 主线程（在途上限 `LOGGER_FORWARD_BATCH_MAX_MESSAGES` 条）。
    2. 第二跳：主线程 → Disk I/O Worker（在途上限 `DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES` 条）。
    - 生产方保留批次直至收到下游 ACK；若 Worker 重建（代际替换），原批次会被重新发送，允许在故障边界内少量重复。主线程仅在日志文件真正 flush 落盘成功后才回复 ACK；若写盘失败，主线程按日志文件重开窗口进行指数退避，新日志不得绕过该退避窗口。
  - **流控与熔断**：
    - 业务 Worker 每线程的排队与在途总上限为 `LOGGER_FORWARD_MAX_PENDING_MESSAGES` 条或 `LOGGER_FORWARD_MAX_SERIALIZED_BYTES` 字节。
    - 主线程到 Disk I/O 的上限为 `DISK_DIAGNOSTIC_MAX_PENDING_MESSAGES` 条或 `DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES` 字节。
    - 超出上限的日志不会驻留内存，系统仅累计丢弃的条数与字节数，待容量恢复后补发统计摘要。Worker 产生的 error 日志同时输出至当前线程的 stderr。
    - 已经进入传输通道的批次不会因同步拒收或实例重建被抛弃。若系统遭遇强杀（SIGKILL），尚未落盘的日志可能丢失；Disk I/O 在完成初始化前仅输出至 journal。

- **并发批处理原则**：
  - 严禁对并发批处理直接使用 `Promise.all`。
  - 互不依赖的固定任务必须使用 `Promise.allSettled`，等待全部操作完成后逐项汇总失败。
  - 动态输入列表必须通过 `runBoundedSettledBatch` 限制并发 worker 数量，每个元素只执行一次，返回结果需保留原始 `item/index`。
  - 当底层（如 Telegram 出站总闸）已经内置重试机制时，调用方不得在外层对带副作用的请求盲目重试。
  - 等待已登记在途任务排空（Drain）时，可以直接对任务快照执行 `allSettled`，但前提是各任务本身已有明确的错误捕获归宿，不得将 settlement 用作吞掉未处理异常的出口。

- **Disk I/O 运行时恢复握手**：
  - 恢复流程是一段不可中断的握手协议：底层数据 load 成功后，各领域必须仅使用本代际的 scoped transport 按预定顺序重放状态，并等待全部异步逻辑完成。随后按 FIFO 顺序排空恢复窗口内的有界业务缓冲，最后才将实例标记为可写（writable）。
  - 在镜像重放开始前与结束后，分别发送一对 `storageFlushHold` 开合标记：在开启标记期间，Worker 的满批与定时自动提交仅排入计时器；标记关闭时，系统汇总阈值一次性提交共享事务。显式调用的 flush 不受该标记限制；AI 记忆上下文的删除与 purge 后的首次快照在标记期间仅排队，标记关闭时立即提交。
  - 任何 listener 返回 `false`、抛出异常、reject、超时或遇到 scoped post 拒绝，都必须立即终止当前代际并触发 fatal。旧代际 listener 的迟到回调严禁写入或激活新实例。
  - 需要落盘确认的调用方必须将 `false` 视为失败，严禁确认对应的 Telegram update。
  - 排空恢复 FIFO 前后另发一对 `recoveryReplay` 开合标记（`RecoveryReplayRequest`）：共享 SQLite 在线写入被拒收时，Worker 记录领域拒收标记，调用方随后通过领域屏障获取失败回执并拒绝确认 update（触发 Telegram 重投）；而在恢复 FIFO 内部的消息没有后续屏障查询，因此该区间内的写入拒收会额外回传 `recoveryReplayFailed`，主线程据此统一触发 fatal 停机，让 Telegram 从上一个已落盘确认点重投。

- **主线程到 Disk I/O 的业务传输有界约束**：
  - 待发送与在途的业务载荷，共同受限于 `DEFAULT_MAX_PENDING_BUSINESS_MESSAGES` 条和 `DISK_BUSINESS_MAX_RETAINED_BYTES` 的估算字节预算。控制消息另享 `DISK_OPERATION_CONTROL_RESERVE` 个独立预留槽位。
  - 每批最多传输 `DISK_BUSINESS_BATCH_MAX_MESSAGES` 条，且同一时刻只允许一批处于在途状态。
  - Worker 本地串行操作队列上限为 `DISK_WORKER_MAX_QUEUED_OPERATIONS` 项。其入队来源严格有界：主线程业务批与诊断批各至多一批在途，load 与每日维护 cron 各占一项，Worker 内部各领域定时 flush 到期后经 `workers/diskIO/timedFlush.ts` 合并为单项调度（未执行前重复到期不重复排队），其余模块不可直接入队。
  - 批消费 ACK 仅代表传输通道窗口释放；只有领域持久化 ACK 才代表数据安全落盘（durable）。在 `DISK_BUSINESS_ACK_TIMEOUT_MS` 内未收到批 ACK 或遭遇容量拒绝，将触发系统 fatal，但保留最终退出 flush 通道。
  - Worker 重建时保留业务 FIFO，已有的读取 waiter 以失败结算；在新代际完成镜像重放并排空 FIFO 之后，才重新公开 writable。恢复期间通过 revision 水位以及贴纸/成员操作的对象标记，仅过滤被镜像覆盖的旧写入，绝不丢弃后续到达的新增更新。

- **Worker 产生的非功能性群提示由主线程统一收发与清理**：
  - AI 触发限流/话题错误、解除锁定通知、入群验证欢迎语/终态播报、刷屏禁言通知等消息，在成功发送后均按 `COMMAND_MESSAGE_AUTO_DELETE_MS` 倒计时删除。
  - 通过 `sendTemporaryMessageFromMain` 发起的 `notice` 请求，统一使用标准群提示清理期限，可选携带 `replyToMessageId` 透传回复锚点。
  - 主线程在发送成功的 `onSent` 回调中就地登记定时删除任务，先于向 Worker 返回消息 ID；后续的回执丢失、请求取消或 Worker 崩溃重建，均不会丢失这笔清理责任。
  - 发送失败不会建立删除任务。欢迎语的发送与传输错误由统一的 Telegram 动作边界归一化，后续验证副作用照常按序执行。删除 timer 必须调用 `unref()`，删除失败输出统一的 Telegram 错误日志。
  - 入群验证按钮与 `/qa set` 表单由各自的状态机显式删除；inline 运势由 Telegram inline API 原生生成，不挂载延迟删除。

- **其他 Bot 的群消息在主线程入口限流**：
  - `app/registerHandlers.ts` 在记录 update ID 之后、确认回执和派发业务之前，统一调用 `shouldPassBotMessage`（`infra/botMessageGate.ts`）。
  - 仅拦截识别为真实机器人的发言（`message.from.is_bot === true` 且不包含 `sender_chat` 频道马甲）。频道身份、非 message 更新以及本 Bot 自己的消息均放行且不记录。
  - 其余 Bot 的发言按 ID 进行全局跨群计数：前 `BOT_MESSAGE_ACTIVITY_LIMIT` 条正常放行，之后的消息静默丢弃。
  - 该 Bot 每发送一条消息（含已超额的消息），其记录的独立超时计时器都会续期至该发言之后的 `BOT_MESSAGE_ACTIVITY_TTL_MS`。
  - 主线程 Map 最多容纳 `BOT_MESSAGE_ACTIVITY_MAX_ENTRIES` 个 Bot 记录。满载时直接拒绝记录新 ID 且不分配 timer；已存在的 ID 继续按频次阈值判定，不淘汰旧记录。
  - 每个记录至多持有一个 `unref()` 计时器。进程重启后计数重置，Worker 重建不影响该流控。

- **Update 分发链路与外闸设计**：
  - **命令外闸聚合**：所有斜杠命令必须收敛在单个 `:entities:bot_command` 外闸背后的子 Composer 中，严禁逐条直接挂载在 `bot` 根实例上。外闸使用 grammY 的 `matchFilter(":entities:bot_command")`，不带 `bot_command` 实体的消息能在一瞬间跳过整组命令匹配。
  - **前置链批量注入**：从 update_id 记账到兜底消息处理的前置链（包含 Anti-Raid、gag、`/qa set` 投递的消息 ingress、命令外闸、中文动作命令外闸与消息兜底），按顺序放入数组并通过 `bot.use(...preamble)` 批量注册，执行顺序与认领生命周期由 grammY 统一调度。
  - **消息入口判据统一**：`message` 与 `channel_post` 的 ingress 与兜底处理不调用 `bot.on`，而是直接校验统一判据（`allowed_updates` 不含 `edited_*`，且 `ctx.msg` 等于 `message ?? channelPost`）。中文动作命令收敛在「原文首字符是 `/`」外闸下的子 Composer，该外闸是 `CJK_ACTION_COMMAND_PATTERN` 的严格超集。
  - **同步 vs 异步 Promise 契约**：每条群消息前置的各 ingress 及其自身的管理员权限判定，统一返回 `boolean | Promise<boolean>`。稳定状态下同步返回布尔值（不分配 Promise 内存）；仅在需要现查网络权限、实际删除消息或等待落盘 barrier 时才返回 Promise，由 `app/registerHandlers.ts` 的 `claimOrContinue` 统一接管。
  - **必须严格遵守 Promise 返回语义**：等待持久化确认的入口（如入群/离群服务消息、验证按钮交互）必须返回 Promise，若误写为同步返回，会导致 Telegram update 在数据尚未安全落盘前就被提前确认；相反，恒为假值的同步逻辑严禁声明为 `async`。测试中对这两种情况均有断言覆盖。

- **`packages/workers/` 内自持的 Timer 必须调用 `unref()`**：
  - Worker 内部自行持有的 timer 句柄绝不能单独阻止 isolate 事件循环退出；有序停机由内部的 drain/flush 流程主动触发，之后由主线程终止 Worker 进程。
  - 共享工具库中的短生命周期等待 timer（例如 `libs/sleep.ts` 中携带 signal 的分支、`libs/drainWaiter.ts`）由调用方的 abort 或 `finally` 中的 `clearTimeout` 主动释放，因而无需 `unref()`。
  - `bun run check:conventions` 通过静态 AST 分析逐一核对 `packages/workers/` 中的 timer：对每次 `setTimeout`/`setInterval` 的赋值变量，要求在同一函数体内、该调用之后且早于下一次覆写之前，必须出现 `<变量>.unref()`；直接 `return setTimeout(...)` 等未捕获句柄的写法同样会被检查拦截。主线程不适用此规则。

### 状态机契约

- **状态机与业务逻辑严格解耦**：
  - 状态机的 `State / Event / Effect / Transition / Decision` 类型由 `packages/types/states/` 集中管理。
  - `packages/states/` 仅包含没有任何 I/O 操作的纯状态转移函数；具体解释器和缓存直接依赖上述类型。
  - **两种实现形态**：
    - **离散状态机**：针对存在需要持久化离散状态的场景（如 `verification`、`lockdown`，需要将 PENDING / ACTIVE 等状态保存在 Map 中供后续事件查询），采用标准的 `transition(state, event) → {next, effects}` 形态。
    - **纯函数规则集**：针对没有独立生命周期状态的场景（如 `replyAdmission`、`adDetectAdmission`，仅根据调用方传入的标量做准入判定，容器与计时器留在外部），采用纯函数判定集合的形态。

- **私密模式（Lockdown）群默认权限更新必须包含独立标识**：
  - 修改群默认权限时，每一次读改写都必须带上 `use_independent_chat_permissions: true`。
  - 进入锁定、到期恢复、迟到回执校正与主线程 `onGiveUp` 紧急恢复，均统一复用 `packages/workers/antiRaid/lockdownApi.ts` 与 `packages/infra/telegram/lockdownPermissions.ts`。
  - 这两处边界在执行时会重新获取 `getChat().permissions`，仅修改其中的 `can_invite_users`，其余权限和未知字段原样回传 Telegram。

- **锁定封锁公告生命周期与轮次严格绑定**：
  - 封锁公告的状态记录在当前轮次的 `LockdownState.announced` 与 `announcementMessageId` 中。
  - 进入 `APPLYING` 阶段占位后，公告发送任务先于权限预查询进入该群的串行队列。
  - 在实际发送前和应用回执时，系统会校验 `LockdownEntry` 对象是否属于当前轮次：已废弃轮次的未发送任务直接丢弃；若已发出，则沿同一串行队列清理该消息 ID，绝不占用新轮次的公告位。
  - `onSent` 在向外传播取消信号前登记远端消息 ID。当前轮次的公告 ID 会持久化存储，在权限成功恢复后定向删除；删除失败仅输出日志，不破坏权限恢复流程。

- **解锁解除公告判定**：
  - 仅当本轮封锁确实发送过锁定公告（`announced === true`）时，才在恢复权限后发送解除提示。
  - 锁定到期、管理员手动解除、提交结果不确定以及持久化失败，均统一进入恢复状态；权限恢复成功后，根据本轮的公告标志决定是否播发解锁公告。
  - 公告状态记录沿 `APPLYING → ACTIVE → RESTORING → RECONCILING` 阶段透传；`RESTORING` 期间若再次超过入群阈值，仍保持恢复意图，不开启新的一轮。
  - `announced` 与 `announcementMessageId` 随 `{phase, intentId, originalPermissions, announced, announcementMessageId?, expiresAt}` 持久化。ID 必须来自成功的发送回执，未发送公告却持有 ID 的记录视为非法。
  - Worker 重建后若需要接管并继续锁定，且尚未发送过公告，会触发补发；处于 `RESTORING` 阶段时不再补发公告。本轮恢复完成时向主线程发送 `reportUnlock`，由主线程清理持久化记录。

- **私密模式到期恢复机制**：
  - 锁定进入 `ACTIVE` 状态时，即固定 `LOCKDOWN_MS` 倒计时截止时间，期间新成员加入不重置该倒计时。
  - 倒计时到期后，系统首先将恢复意图落盘，收到 durable ACK 后调用 Telegram API 恢复权限。
  - `RESTORING` 阶段收到新的入群阈值事件，仅预热管理员缓存，绝不倒退回 `ACTIVE`。
  - 若权限恢复失败，系统按 `RESTORE_RETRY_MS` 进行退避重试。若连续因权限不足（如机器人被踢出群或被撤销管理员）失败超过 `RESTORE_PERMANENT_FAILURE_LOG_LIMIT` 次，错误日志降级为 warn，重试间隔自 `RESTORE_RETRY_MS` 起成倍增加，上限为 `RESTORE_PERMANENT_RETRY_MAX_MS`。记录始终保留，一旦确证机器人重新获得限制成员权限，立即恢复重试。
  - 因 Worker 停机被撤销的恢复请求按普通失败处理，不累加连续被拒计数，也不记录错误日志。
  - 权限成功恢复后，清空本群入群滑动窗口；公告删除失败仅记录日志，后续的入群计数从下一轮重新累计。

- **持久化权限副本的数据清洗**：
  - 权限数据仅接受 schema 中声明的已知字段（由 `packages/libs/chatPermissions.ts` 的 `normalizeChatPermissions` 保证）。
  - 准备查询在入口处收敛 `ChatState.lockdown.originalPermissions`，解码器继续严格校验该副本。
  - 恢复权限时，仅从副本中读取原有的 `can_invite_users`。回写 Telegram 时，系统使用重新查询到的完整权限对象，仅覆盖邀请权限，绝不用持久化副本直接替换群的其他权限字段。

- **持久化失败时的安全补偿（Fail-safe）**：
  - 当锁定持久化失败（`persistFailed`）时，系统必须继续对可能已经生效的权限限制承担恢复责任。
  - 若处于 `APPLYING` 阶段且尚未派发提交，直接撤销占位；若已经派发，按可能在途中处理，自动转入 `RESTORING` 并沿 API 串行链执行补偿恢复。
  - 处于 `ACTIVE` 或 `RECONCILING` 阶段遭遇持久化失败，同样生成恢复意图并立即尝试恢复权限，不等待新的落盘回执；处于等待回执的 `RESTORING` 直接执行恢复，在途的恢复任务不重复派发。
  - 主线程保留通过 schema 校验的恢复镜像供 Worker 重建接管，仅在 `unlock` 确认后清理。不合法的 Worker 记录在进入镜像前直接拒绝。
  - 失败转移后进入 `LOCKDOWN_RETRIGGER_COOLDOWN_MS` 冷却期，迟到或重复的失败回执必须匹配当前的 phase 和 intent。恢复失败继续由状态机计时器调度重试。

- **内存写入前必须执行持久化断言**：
  - Worker 事件中的 lockdown 记录在更新内存 `ChatState` 之前，必须先通过 `assertPersistableLockdown` 进行落盘可行性自检。
  - `ChatState` 遵循「先更新内存、再持久化落盘」的顺序，自检必须在修改内存前完成，绝不能推迟到 `encodeChatStateData` 阶段。

- **同一申请意图（Applying Intent）仅派发一次提交**：
  - 对同一份意图，`commitApply` 仅派发一次（由 `commitStarted` 标记保护）。
  - 派发不代表 Telegram 已经执行完毕：该任务可能仍在串行队列排队或等待权限查询。在实际执行前、权限查询返回后以及应用回执前，均需严格核验当前条目、阶段和 intent；已被取消的任务绝不能继续收紧群权限。
  - 重复的落盘确认不重复派发任务；接管已确认落盘的意图时，随派发同步置位。
  - `lockdownRuntime.ts` 负责解释状态与计时器，`lockdownApi.ts` 负责执行具体的串行 API 副作用。

### AI 闲聊运行时

- **东京天气刷新机制**：
  - 天气数据的定时刷新由 AI Worker 独占。
  - 仅在收到 `init` 初始化消息且配置的时区严格等于 `TOKYO_TIME_ZONE` 时才会启动（与 `get_tokyo_weather` 工具的挂载条件一致）。
  - 若配置为其他时区，系统不会发送天气 HTTP 请求，全局心情抽取也不会包含天气加权。
  - 停止运行时，必须清除定时 interval、取消在途的 HTTP 请求并撤销写回资格。Worker 重建后的缓存只接受新循环的结果。HTTP 请求严格遵守调用方取消信号、超时限制与响应体大小上限。

- **全局心情管理（`/mood query` 与 `/mood switch`）**：
  - 两个命令均通过主线程的 request/waiter 与 AI Worker 的回执进行握手：
    - `/mood query`：允许任意群成员查询当前全局心情，不触发重新抽取。
    - `/mood switch`：必须先校验操作者是否持有 `isCanSwitchMood` 权限，确认后触发重抽。
  - 主线程在投递请求前先登记 waiter，并在超时、Worker 崩溃、放弃重启或系统停机时统一结算。请求携带绝对截止时间戳，AI Worker 在处理前会主动丢弃已超时的积压请求。
  - 只有 request ID 和预期事件类型均严格匹配的 `moodQueried` / `moodSwitched` 回执才能确认操作成功；后续向群内发送 Telegram 消息失败不得反向改写为查询或重抽失败。
  - 心情状态在 AI Worker 内全局仅有一份、所有群共用，请求与回执均不带 `chat_id`。任意群切换心情对全局立即生效；`/clear_context`、`/ai_chat disable`、群 teardown 或群记忆容量淘汰均不影响全局心情。

- **AI 对话上下文清理与销毁（Teardown 与 Invalidate）**：
  - **Teardown 终态清理跨超时保留**：
    - 主线程通过 `pendingAiMemoryTeardowns` 跟踪需要彻底删除的群记忆，等待底层 durable 删除与匹配的 `chatInvalidated` 回执。Worker 重建、放弃或终止时可结算旧请求。
    - 等待超时仅释放主线程 waiter，迟到的回执继续执行收尾；若 Worker 的 `memoryDeleted` 再次触发删除，继续等待该删除墓碑（tombstone）确认。
    - 当群重新启用或有新快照接管时，撤销旧收尾流程。普通的 `/ai_chat disable` 不触发彻底清理。
    - 确认无新快照、首份落盘标志、墓碑与 waiter 后，释放主线程的受管群计数，并按 FIFO 发送 `forgetAiMemory`；全局 revision 下界标量确保新生命周期不会复用已释放的编号。
    - 未完成的 teardown 上限为 `STATE_MANAGED_CHAT_LIMIT`，超额触发持久化致命错误（fatal）。Disk I/O 重建时由主线程重放待删记录；进程重启不恢复纯内存状态。
  - **Invalidate 取消边界与 Epoch 隔离**：
    - 每个群在首次接纳依赖代际的工作时，分配当前 isolate 内永不重复的唯一 `epoch`。
    - 收到 Invalidate 请求时，Worker 同步删除当前 epoch、abort 旧代际任务并清空未启动任务，随后等待该 epoch 下已登记的回复轮次、限流提示、媒体描述与记忆压缩完全 settle，最后根据 request ID 回传 `chatInvalidated`。
    - **等待设有硬超时**：`AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS`（严格小于主线程的 `AI_CHAT_INVALIDATE_TIMEOUT_MS`）。压缩与媒体描述请求均传递本代 `AbortSignal`；用于 `Promise.race` 的 unref 计时器必须在 `finally` 中清理。超时后降级放行并输出错误日志，失效任务在完成后因 generation 自检不写回任何数据。
    - 主线程必须同时等待 `chatInvalidated` 回执与记忆持久化删除完成，才能宣布 `/ai_chat disable` 或 `/clear_context` 执行成功（两命令共用 `invalidateAiChat(chatId)` 清空记忆并将 `chat_states.ai_context` 置空，区别仅在于前者修改开关持久化字段）。

- **清除上下文权限**：
  - `/clear_context` 仅根据发起者的 `isCanClearContext` 权限执行清除。超级管理员恒为 true；白名单新成员默认为 false。授权与撤销由 `/permission` 命令管理。

- **模型供应商请求、超时与重试规范**：
  - 网络传输、429 与 5xx 重试完全由供应商官方 SDK 自行处理（Gemini 使用 `@google/genai` 的 `retryOptions`，OpenAI 与 Anthropic 使用各 SDK 的 `maxRetries`，对应预算常量分别为 `GEMINI_REQUEST_RETRY_ATTEMPTS`、`OPENAI_REQUEST_MAX_RETRIES`、`ANTHROPIC_REQUEST_MAX_RETRIES`）。
  - 各 SDK 的内置超时为**单次尝试**的期限；底层的封装层（`aiChat/gemini/client.ts`、`openai/client.ts`、`anthropic/client.ts`）使用 `signalWithTimeout` 合成一个覆盖整次调用（含全部重试与退避）的全局 deadline。一旦该 deadline 到期，SDK 立即短路重试，最长挂起时间由 `GEMINI_REQUEST_TIMEOUTS_MS` / `OPENAI_REQUEST_TIMEOUTS_MS` / `ANTHROPIC_REQUEST_TIMEOUTS_MS` 严格界定。
  - 调用方的 invalidate signal 与该 deadline 合成生效。当请求已明确以 `failureKind: "request"` 失败时，外层严禁再套一层整次重试；业务级重采样仅允许在 HTTP 成功但模型响应不可用或异常结束（`failureKind: "response"`）以及规范化文本为空时触发。
  - `aiChat/openai/image.ts` 同样使用 `OPENAI_IMAGE_REQUEST_TIMEOUT_MS` 统筹生图的单次尝试与整次调用。

- **模型调用配额与车道隔离（Lane Isolation）**：
  - AI 请求不占用 Telegram 出站总闸，而是根据 provider、`base_url` 与 API key 聚合到对应的模型配额 lane（模型名与自定义 headers 不拆分车道）。
  - 每条 lane 最多允许 `AI_PROVIDER_MAX_CONCURRENT` 个在途真实请求、`AI_PROVIDER_MAX_PENDING` 个未启动任务（其中后台任务最多占 `AI_PROVIDER_BACKGROUND_MAX_PENDING` 个等待位）。交互式请求连续派发 `AI_PROVIDER_INTERACTIVE_BURST` 项后，若后台有排队任务，必须至少让步一项。
  - SDK 内部重试始终占用原车道槽位。队列满载时请求立即显式失败，严禁无限制暂存整轮提示词或图片数据。
  - 当 Telegram 发送队列在途达到软高水位（`AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER`）或遭遇真实 429 退避时，系统仅暂停随机搭话，并将同群直接触发的并发度降为 1，绝不将 AI 队列与 Telegram 队列合并阻塞。

- **回复行动工具（Reply Toolset）与串行动作链**：
  - **同步准入与预算预占**：行动工具在被模型调用时，同步完成参数校验、冷却占位与额度消耗（`send_voice` 仅预留每日额度，TTS 合成成功才正式记账）。校验未通过直接返回错误。
  - 接纳后立即向模型返回 `{"success": true, "queued": true, "actions_used": ...}`。该回执不含 Telegram 真实消息 ID，模型往返无需等待拟人停顿、音频合成或实际网络发送。
  - **串行动作链（`actionChains.ts`）**：
    - 每轮回复拥有唯一一条串行动作链，所有接纳的动作严格按工具调用顺序排队执行。
    - 文本生成、拟人打字停顿、语音合成与 Telegram 出站排队均在动作链内依次运行。
    - 有序并行轮次需等待发送顺位放行，直接轮次（Direct Round）不设门闸。链上每步执行完成后自动切回 idle 状态。
    - 后台异步合成的语音不阻塞动作链，合成完成后追加到链尾补发。
    - 整轮发送按用户消息入站顺序交割，后一轮回复的内容绝不能插入前一轮的文本、纠错或图注之间。
  - **聊天状态指示器（Chat Action Heartbeat）**：
    - 「正在输入」、「选择贴纸」、「正在录音」等状态统一由 `aiChat/ai/chatActionHeartbeat.ts` 管理。
    - 状态档位仅由动作链中正在执行的当前步骤切换，执行器在调用阶段不切换状态。
    - 直接轮次通过 `createDirectPacing` 提前点亮状态：若尚未接纳动作，在模型生成期间显示「正在输入」；若首个动作为 `send_message`，直接沿用该输入状态发送，不额外插入拟人停顿。
    - 状态切换至 idle 代表本段状态结束，同群在此后 `CHAT_ACTION_REST_MS` 内进入静默期，期间不重复发送状态心跳。
    - 发生打字手滑（错字纠正）时，错字消息落地后先静默 `TYPO_QUICK_CORRECTION_MIN_MS`～`TYPO_QUICK_CORRECTION_MAX_MS`，随后显示 `TYPO_QUICK_CORRECTION_TYPING_MS` 的「正在输入」，再将纠正消息发出。
  - **贴纸包查看（`view_sticker_pack`）**：
    - 同步返回当前菜单的真实编号、简介与名称，并记录查看意图；每轮最多查看 `MAX_STICKER_PACK_VIEWS_PER_REPLY` 个不同贴纸包，同一包只允许查看一次，后续 `send_sticker` 必须引用已查看的菜单。
  - **并发控制与交付队列**：
    - `activeReplyCounts` 统计未完成轮次：有序并行轮次单群最多 `REPLY_ROUND_MAX_CONCURRENT` 轮；直接轮次独立占用 1 个模型槽；Telegram 高压时同群收敛至 1 轮。
    - `pendingReplyTriggers` 单群最多保留 `REPLY_TRIGGER_QUEUE_MAX` 个未启动的直接触发任务。
    - `replyDelivery.ts` 维护群级别的 FIFO 交付窗口，受到跨代际存活预算限制：单群上限 `REPLY_DELIVERY_MAX_PER_CHAT`，Worker 全局上限 `REPLY_DELIVERY_MAX_TOTAL`。
    - 队列满时丢弃随机触发、排队直接触发，若队满则登记临时溢出提示；占位失败不消耗限流额度。
    - 真实发送与心跳收尾后才释放存活容量；只有 Telegram 确认发送成功的消息才写入自录记忆。

- **动作预算硬顶与文本去重**：
  - 模型提示词中的推荐上限为 `AI_MAX_ACTIONS_PER_REPLY`，执行侧的绝对硬顶为 `HARD_MAX_ACTIONS_PER_REPLY`。
  - 贴纸、表情反应（Reaction）、生图与语音，每轮回复最多各接纳一次。
  - 仅在整轮未接纳任何动作时，模型最终生成的正文才会通过 `send_message` 兜底发送；所有有意呈现的文字必须通过显式工具调用产出。
  - **可见文字出口仅有两个**：独立消息走 `send_message`，为图片配的说明走 `generate_image` 的 `caption` 字段。
    - 图注生图在 Telegram 中是一条消息、占用一个动作预算。若图注超出 `TELEGRAM_CAPTION_MAX_CHARS`，降级为「无图注图片 + 独立文本」两条消息，预占两个动作预算；若剩余预算不足两格，则仅发送图片，图注回执标记为 `caption_delivery: "no_action_budget"`。
  - **同轮文本重复检测与静默跳过**：
    - `send_message` 正文与 `generate_image` 的 caption 统一经过 `modelAuthoredTextPolicyResult` 校验。
    - 文本在比较时合并多余空白并执行 Unicode NFC 归一化，与本轮已接纳的正文、caption 和纠正文本进行整串比对。
    - 命中重复时直接返回 `{"success": true, "skipped": "duplicate", "actions_used": 0}`，不触发输入状态、不扣除冷却、不发送消息，也不写入自录记忆。

- **工具声明恒定性与语言规范**：
  - 工具列表在每轮构造时严格由配置条件决定，与当前触发类型、本群问答或是否抽中手滑无关：
    - 基础工具恒定挂载：`send_message`、`add_reaction`、`group_qa_query`、`group_qa_answer`。
    - `generate_image`：仅在配置了图片生成供应商时挂载。
    - `send_voice`：仅在配置了 `agent.tts` 且具备语音合成能力时挂载。
    - `view_sticker_pack`、`send_sticker`：仅在贴纸菜单非空时挂载。
    - `get_tokyo_weather`：仅在启动时区为 `TOKYO_TIME_ZONE` 时挂载。
    - `web_search`：配置了独立 `agent.web_search` 时挂载本地函数工具；未配置时不挂载该函数，由 text 模型调用服务端内建检索。
  - **台词语言一次性求值**：工具声明与系统提示词中的台词规则，统一根据 `agent.tts.bot_language` 从 `VOICE_LANGUAGE_PROMPTS` 取出唯一文案（缺省为 `TTS_DEFAULT_BOT_LANGUAGE`），保证回复内所有语音要求完全一致。
  - **本轮工具状态（Tool Status）**：运行时状态区块中的【本轮工具状态】包含客观事实快照（生图可用/冷却秒数、语音剩余次数、群问答登记条数、联网检索上限），各执行器在调用时再次校验真实可用性。

- **语音合成执行细节（`send_voice`）**：
  - **准入校验**：检查本轮有效性、未超 `MAX_VOICES_PER_REPLY`、TTS 支持及参数合法性，并在内存中预留一次每日额度（`reserveAiTtsUsage`）。超额直接返回 `SEND_VOICE_DAILY_LIMIT_TOOL_ERROR`。
  - **参数清洗**：`text` 必填，单行清洗后上限 `VOICE_TEXT_MAX_CHARS`；`tone` 可选，上限 `VOICE_TONE_MAX_CHARS`；`reply_to_trigger` 仅接受布尔值。
  - **投递与前后台切换**：
    - 轮到发送时，若音频尚未合成完毕且未满 `VOICE_FOREGROUND_WAIT_MS`，显示「正在录音」等待。
    - 超过等待窗口仍未完成，收回录音状态并将发送转入后台（`chains.defer`），动作链继续向下执行；后台合成完毕后追加到链尾发送。
    - 合成失败不发送语音，仅输出英文日志 `AI reply voice was not sent`，不向模型暴露失败。
    - 发送成功后在自录记忆中追加 `（发送了一条语音：…）` 标记。
  - **额度统计**：
    - 预留额度仅存在于 AI Worker 内存（`pendingAiTtsReservations`），不持久化。
    - 仅在 TTS 供应商调用成功后才正式记入 `agentCount`（`settleAiTtsReservation`）；若合成前取消或失败，释放预留额度；合成成功后的编码或网络发送失败不退回额度。
    - 每日配额由 `agent.tts.daily_limit` 减去 `daily_reserve_quota` 算出，与运维入口独立。
  - **音频编码管线**：
    - WAV：单声道 PCM 分块重采样至 `OPUS_RATE`（分块大小 `VOICE_OPUS_ENCODE_CHUNK_SECONDS`），编码为 OGG/Opus，块间主动让出事件循环。
    - OGG/Opus 与 MP3：校验容器结构完整性（Ogg 页结构与 OpusHead，或 MPEG Layer III 帧序列）并计算时长，校验通过后原样封装。
    - 响应体读取上限为 `VOICE_SPEECH_MAX_BYTES`。

- **运维语音借用（`/send` 与 `cron.json`）**：
  - 主线程通过 `requestVoiceSynthesis` 异步委托 AI Worker 执行合成，通过 requestId 回执接收语音二进制 buffer。
  - 超时时限为 `VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS`；超时或取消后发送 `cancelVoiceSynthesis` 中止 Worker 内部合成。
  - 运维口径的每日额度由主线程 tts 门面（`createSpeechFacade`）独立记入 `reserveCount`，上限为 `daily_reserve_quota`，与 AI 闲聊额度严格互不挤占。

- **Anthropic 模型响应处理**：
  - 命中 `max_tokens`、`refusal` 或 `model_context_window_exceeded` 结束原因时，响应正文视为不可用。
  - 广告检测在正文为空时最多重采样 `AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS` 次。
  - 对话与检索遇到 `pause_turn` 时，原样延续 assistant 历史继续交互，最多续发 `ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS` 次并合并检索次数。

- **Token 与用量核算**：
  - 用量统计以供应商 SDK 返回的权威 `usage` 为准，由 `packages/infra/aiCacheUsage.ts` 集中校验上报。
  - 取消或中断时，若 SDK 依然返回了有效用量，仍计入统计；SDK 未返回则不进行估算。
  - Gemini 正文 token 与 thinking token 校验后累加；OpenAI 输出不重复累加 reasoning token。
  - 仅返回费用的模型（如 xAI 生图的 `cost_in_usd_ticks`）单独记录为费用指标，不折算 token。
  - 联网检索次数与模型 token 合并记录，日度聚合只算一次请求；独立检索调用记录为 search usage。Anthropic 以 `server_tool_use.web_search_requests` 为准，OpenAI 仅统计 `action.type === "search"` 且状态完成的动作。

- **两阶段回复准入机制**：
  - **并发闸（`admitTrigger`）**：触发事件到达时执行，判定当前并发度是否允许进入。
  - **限频闸（`isReplyRoundRateLimited`）**：在真正开启轮次前，校验 `RATE_LIMIT_LONG_WINDOW_MS` 滑动窗口内的频次限制。限频拦截时，仅直接触发（`directInvokerId` 存在）才会发送限流提示，随机搭话直接静默丢弃。
  - **FIFO 保证**：排队队列非空时，新到达的触发必须进入队尾排队，绝不能插队。
  - 模型计算完成（`onModelFinished`）、发送收尾（`onFinished`）、新任务入队及周期维护节拍均会推动队列排空（`drainReplyQueueIfWindowAllows`）。溢出提示补发走独立路径，不受频次窗口限制。

- **群活跃度概率层与 JIT 性能保障**：
  - 记录可见消息以提高随机插话概率，达到热群上限后不再增长；各群独立计算，重启后从冷群开始。直接触发完全绕过该概率闸。
  - 该表是每条群消息都会命中的热路径：已有群仅原地更新固定 shape 的 `AiReplyActivityEntry`，禁止 `Map.delete` + `Map.set` 重排，禁止创建复合 key 或临时对象。仅在满载且插入新群时才扫描 LRU。
  - 随机回复冷却按 `[chatId][userId]` 两层 Map 存储，避免拼接字符串。条目总数集中维护，使用单个 unref 清扫 timer。
  - **单条群消息仅读取一次系统时间**：中间件入口处调用一次 `Date.now()`，随后将其通过上下文透传至活跃度、静默期、防刷屏等所有子模块，确保判定时刻绝对一致。

- **多模态媒体解析管线（图片、贴纸、GIF、语音）**：
  - 统一采用「占位入缓存 → 异步解析 → 原位回填」架构。
  - `transientDescriptionCache` 基于 `file_unique_id` 缓存 Promise，容量上限 `MEDIA_DESCRIPTION_CACHE_MAX`，按 LRU 淘汰失败结果即时摘除。在途相同文件合并至同一个 Promise。
  - 并发执行器限制最多 `MEDIA_DESCRIPTION_MAX_CONCURRENCY` 个真实并发解析任务，排队与冷探测上限为 `MEDIA_DESCRIPTION_MAX_PENDING`。
  - 通过 `libs/sharedResult.ts` 实现可取消的共享订阅：单个调用方取消不影响其他消费者，最后一个消费者离开时才真正中止底层下载或解析任务。

- **机器人自发图片的记忆回填**：
  - 滚动记忆中的自发图片分为**占位态**（正文为占位记号与图注，持有 `pendingImage`）与**内容态**（记号替换为实际识图描述，`pendingImage` 清空）。
  - 命令与定时任务发出的图片（如 `/wed`、`/h_image`、`cron.json`）以占位态写入，不主动识图。
  - `generate_image` 发送后先写入带提示词的占位态，随后使用返回的图片异步识图，成功后回填为画面描述。
  - 当群友引用回复机器人的图片时，主线程在引用中附带图片元数据；若原条目仍为占位态，触发异步识图并回填至原记忆条目及当前引用上下文。
  - **语音下载硬前置校验**：语音的时长（上限 `VOICE_MAX_DURATION_SECONDS`）与文件体积（上限 `VOICE_MAX_DOWNLOAD_BYTES`）必须在下载前校验。超限语音直接退回带时长的 `[语音 N 秒]` 纯文本，跳过语音转写，但不阻断后续回复。转写文本截断上限为 `VOICE_TRANSCRIPT_MAX_CHARS`。

- **白名单贴纸包维护与镜像**：
  - AI Worker 在启动和定期维护时，通过 `retryIncompleteStickerCatalogs` 对账贴纸包。
  - 失败条目与失败包分别通过 `STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS` 和 `STICKER_SET_FAILURE_RETRY_MS` 设置负缓存退避。
  - 贴纸配置热重载后，Worker 立即清理退出白名单的贴纸缓存。
  - 主线程 `stickerMirror.ts` 为目录快照分配单调递增版本号，Disk I/O 在原子落盘并完成父目录 fsync 后返回 `stickerCatalogPersisted` 确认；主线程仅接收匹配当前 Worker 的回执，版本号不持久化到文件内。

### AI 提示词与转录

- **机器人自我身份与发言人标识**：
  - 在 AI 自录、转录名册、回复引用及对话摘要输入中，机器人自身的发言统一使用 `SELF_SPEAKER_NAME`（`自己（也就是你）`）标记，不展示 Telegram 上的 `first_name`、`last_name` 或 `username`。
  - 回复提示词的只读参考记忆中，会附带一句包含当前部署 `@username` 的自我身份说明：主线程在每次启动时通过 `bot.init()` 的 `getMe` 获取自身账号信息，并在 `initAiChat` 中注入 AI Worker；Worker 重建时重放此启动快照，不随逐条消息重复查询。
  - 名册中机器人固定使用编号 `me`，其余群成员保留账号 ID 与姓名原貌，历史逐字快照在渲染时遵循相同规则。

- **联网查证（Web Search）提示词规范与双模态切换**：
  - **通用查证原则**：采用供应商中立的固定说明，同一回复的每次模型调用复用完全相同的 system prompt。遇到实时变动或未确证的事实时，若本轮挂载了检索工具，必须「先检索、再行动」；主观聊天、文学创作或转录中已给出的事实不发起检索；搜索结论优先于模糊记忆，工具不可用时诚实表达不确定，且不向群友暴露搜索的技术过程。
  - **双模态检索实现**：
    - **内建检索（未配置 `agent.web_search`）**：在系统提示词中使用 `WEB_SEARCH_INSTRUCTION`，挂载 `text` 模型的服务端内建检索。软预算通过 `MAX_WEB_SEARCH_CALLS_PER_REPLY` 约束，真实调用次数由 `replyModel.ts` 统计，超额时仅记录，不动态篡改系统提示词，也不卸载检索工具。
    - **独立函数检索（配置了 `agent.web_search`）**：在系统提示词中使用 `WEB_SEARCH_FUNCTION_INSTRUCTION`，挂载本地函数工具 `web_search`。每轮初始化时锁定调用上限（缺省 `WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE`）；每次函数调用扣除一次额度，超额后直接拒绝。该工具由 `aiChat/ai/tools/webSearch.ts` 异步执行，使用具备检索能力的小模型单轮查证，将结果整理为「提示语 + 结论 + 编号来源」并限制在 `WEB_SEARCH_RESULT_MAX_CHARS` 与 `WEB_SEARCH_MAX_SOURCES` 条来源内喂回。若入参非法、请求超时、未执行检索或结果为空，工具统一返回「模型搜索失败」，避免将幻觉当成检索结论。
  - **时区核对**：涉及「今天」「最新」等时间词时，查证规则依据配置时区的时间核实事实适用日期，不将网页发布时间误判为事件发生时间。
  - 只要触发了检索（服务端或本地），后续请求即打上 `grounded: true` 标记，Gemini 据此自动降低采样温度以收敛幻觉。

- **输入区块（Blocks）固定顺序与防注入**：
  - **四层输入区块恒定有序**：
    1. 【只读参考记忆】（稳定组 `stableBlocks`：历史背景、人设记忆）
    2. 【只读当前会话】（易变组 `volatileBlocks`：分层对话转录）
    3. 【本轮运行时状态】（易变组：当前时间、今日心情、【本轮工具状态】）
    4. 【本轮回复任务】（易变组：本次触发原因与目标指令）
  - 无论回复是由直接 @ 唤起还是随机触发，区块数量与结构保持恒定。直接唤起仅在【本轮回复任务】开头增加一句唤起者声明（`directInvokerSentence`），严禁动态增删 Part 或重复复制成员消息。
  - **供应商适配层映射**：
    - Gemini：使用相邻的两个 `user Content` 分别承载稳定组与易变组，每个区块为一个 `text Part`。
    - OpenAI：使用单条 user message，下含多个 `input_text`。
    - Anthropic：使用单条 user message 下的多个 `text` 块，当前会话按已定切点切分。
  - **防注入边界**：防注入总原则（区分数据与指令、伪造边界无效、不暴露内部结构）在系统提示词中声明一次，不逐段重复。转录数据中出现的同名标签或状态声明一律视为纯文本，不产生控制效果。
  - **系统提示词严格逐字恒定**：系统提示词仅通过独立的系统字段传入，动态的状态数据（时间、心情、工具状态）必须放入 user 内容中的运行时状态区块，严禁混入系统提示词。

- **Gemini 显式上下文缓存（Explicit Context Cache）**：
  - **两套请求结构**：每轮回复的第 1 次请求若缓存就绪，直接引用显式缓存（`cachedContent`），且请求体只包含 `contents`，不再携带 `systemInstruction`、`tools`、`toolConfig`；若缓存未就绪，则发送包含完整配置的请求。第 2 次及后续往返携带静态 `systemInstruction` 与工具配置，由服务端隐式前缀缓存接管。
  - **显式缓存内容**：仅缓存「系统提示词 + 工具声明 + toolConfig」，不缓存参考记忆、转录与运行时状态。
  - **分槽管理**：按系统提示词指纹分槽，全群共享同一槽位。槽数上限为 `GEMINI_TEXT_CACHE_MAX_SLOTS`，超出时按 `lastUsedAt` 淘汰最久未用的槽及服务端条目。`displayName` 格式为 `copy-ninjia:text:<槽指纹>:<内容指纹>`。
  - **非阻塞取用**：调用 `acquireGeminiContextCache` 时从不等待创建完成。首次使用时当前请求直接发送完整配置，并在后台启动扫描与创建；命中缓存时刷新 `lastUsedAt`；若剩余生命周期不足 `GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS`，在后台静默续期回完整 TTL。
  - **失败退避**：端点报 400 拒绝时记录指纹并进入冷却；达到 `GEMINI_CONTEXT_CACHE_MAX_REJECTIONS` 次后放弃为该内容建缓存，回退为全量请求。

- **提示词缓存断点（Prompt Cache Breakpoints）**：
  - OpenAI 协议请求确保稳定内容在前、动态内容在后，并携带按群分桶的 `prompt_cache_key`；对于官方端点且模型名以 `OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX` 开头的模型，在最后一个稳定区块后设置显式 `prompt_cache_breakpoint`。
  - Anthropic 会话依次在以下边界设置缓存断点：系统提示词末尾、最后一个稳定区块末尾、当前会话最后一个已定段末尾，以及请求顶层的自动断点。

- **直接唤起时的阅读顺序与防混淆**：
  - 系统提示词中的 `DIRECT_INVOCATION_READING_INSTRUCTION` 规定了模型的标准推理步骤：
    1. 首先阅读【最热记忆】，掌握当前群聊的背景与话题走向；
    2. 根据回复任务给出的唤起者编号，定位对方具体说了什么；
    3. 结合上下文与对方诉求组织回复。
  - 防混淆规则：识别成员仅以编号背后的 `[id:]` 为准；转发消息不等于转发者本人的亲口陈述；较早的发言仅作理解语境参考。

- **记忆分层机制静默原则**：
  - `MEMORY_MECHANISM_SILENCE_INSTRUCTION` 严禁模型在群聊中提及或影射任何内部记忆机制（包括【最热记忆】、【较早逐字记录】、【冷记忆】、【发言人名册】、【转发来源名册】等区块名，`me`/`uN`/`fN` 编号，`#消息号`，`[已滑出]`，以及滑动窗口、token、压缩、上下文、系统提示词等技术名词）。
  - 面对群友的试探或关于记忆机制的追问，模型一律不予确认、不予否认，仅使用自然口吻带过，绝不暴露内部实现。

- **紧凑分层逐字转录格式（`buildTieredVerbatimTranscript`）**：
  - **名册 + 编号体系**：身份与转发来源集中在末尾的【发言人名册】与【转发来源名册】中呈现一次，逐字记录行内仅展示编号（机器人固定为 `me`，群友为 `u1`、`u2` 等）。
  - 日期仅在跨天或分层交界处输出单行分隔，消息行内仅保留时分秒。
  - `#消息号` 仅标注在被回复过的消息与当前触发消息上；被回复消息若在当前段内，使用 `（回复 #编号）` 指针指引模型查阅原行；若原消息已滑出窗口，退化为附带 `[已滑出]` 的内嵌摘要。
  - **分层边界对齐**：【较早逐字记录】长度按 `TIER_BOUNDARY_ALIGNMENT` 向上对齐取整，消息每增加该整数倍边界才移动一次，保证上一轮的逐字内容在当前轮中属于纯追加，最大化命中前缀缓存。
  - **已定切点（Settled Offsets）**：以 `TRANSCRIPT_SETTLED_SEGMENT_SIZE` 为步长切分已稳定的历史段落，切点仅落在格边界的消息末尾，供 Anthropic 等按块缓存的供应商使用。
  - 同一个 `message_id` 在热区内存在多条记录时（如快照加载与 Telegram 重投），仅渲染最新的一份。

- **单跳回复与转录一致性**：
  - 在转录外部点名成员或消息时，必须沿用名册编号，严禁臆造不存在的编号。
  - 上下文仅保留单跳回复、转发来源与 Telegram 精确引用片段，回复任务不递归展开多层引用树。

- **冷历史压缩格式（`summarizeBatch`）**：
  - 批次压缩使用自包含格式（`formatBufferedMessageLine`），每行自带发言人，不使用名册。
  - 压缩链路系统提示词使用恒定的 `SUMMARY_SYSTEM_PROMPT`，当前时间追加在 userContent 的最末尾。

- **自发动作记号的执行侧硬拦截**：
  - 群聊转录中用于记录机器人行为的记号（如 `（发了一枚贴纸：…）`、`（…生成并发送了一张图片：…）`、`（发送了一条语音：…）`）统一来自 `transcript.ts` 模板，**且只能由系统执行侧在动作实际成功发送后追加写入**。
  - 这些记号是「该动作确实发生过」的唯一凭据，模型在输入中可以看到，但绝不允许在模型生成的文本中伪造。
  - **执行侧防御**：
    - `send_message` 执行器在发送前对包含伪造动作记号的正文执行拦截，要求模型重新生成。
    - `generate_image` 的 `caption` 走相同的拦截逻辑，图注拦截发生在占用冷却之前。
    - 拦截匹配采用全局模块单例正则 `SELF_ACTION_TAG_PATTERNS`（严格匹配全角括号包裹且以 `：` 或 `）` 结尾的动作模板结构，严禁带 `g`/`y` 标志），避免误伤日常中文表述。

### 入群验证与终态处置

- **验证终态重试与落盘保障**：
  - 单个进程内验证终态操作最多重试 `VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS` 次。
  - 终态操作完成后，必须等待最终 revision 的落盘回执，确认安全持久化后再清理内存记录。在等待回执期间若 revision 递增，需继续确认新 revision，绝不因达到重试次数上限而推迟已成功的终态。
  - 取得终态许可的那批副作用中途 reject（如 Worker→主线程请求失败）时，`retryRejectedTerminal` 在条目仍是同一终态对象的前提下复位 Worker 本地执行门，并按该条目的退避序列排一次重试（`kickPending` 投递 `kickRetry`，`checkingInviter` 与 `expelling` 投递 `terminalPersisted`），错误照常记日志；条目已换状态时不动。超时踢人的战报经 `runTelegramAction` 发送，请求 reject 按「没发出去」走同一退避。
  - 主线程紧急恢复私密模式（Lockdown）时，在清理记录前先根据公告 ID 触发删除；删除失败仅输出 Telegram 日志，恢复主流程不等待删除结果。

- **超时验证复核邀请人身份（`checkingInviter`）**：
  - 验证超时后，在 `checkingInviter` 阶段调用 `isChatAdmin` 复核邀请人身份：
    - 确认为管理员：授予受邀成员豁免；
    - 确认为非管理员：转入超时踢出阶段 `expelling`；
    - 身份未能确证（网络超时或查询失败）：保持原有终态与磁盘快照，释放本地执行占用，并按照既定的指数退避策略重新复核，每次重试仍计入主线程核批的终态预算。

- **执行许可生命周期与延后机制**：
  - 终态执行许可仅对状态对象、generation 与 revision 均匹配且业务未取消的任务生效。
  - 当许可申请被拒绝、返回 `stale` 或预算耗尽时，卸载内存运行态并登记精确延后索引，不推进 revision 也不写入删除墓碑（tombstone）。
  - 主线程在内存中保留磁盘快照与进程级延后闩锁；Worker 重建不重置该闩锁，同 key 的新事件不重复建验证，直至完整进程重启后才从磁盘重新加载恢复。旧 token、旧代际、旧 revision 或取消的任务结果直接丢弃。

- **退避计时器与落盘回调安全**：
  - 重复收到的持久化 ACK 不得绕过当前终态的退避计时器。
  - Timer 回调执行时必须同时匹配条目、状态对象与当前句柄，清除句柄后才派发重试；已被重排、替换或 teardown 的旧回调不再执行。
  - `expelling.successNoticeSent` 的精确落盘回执立即完成收尾，不受退避计时器阻碍。

- **Worker 运行态容量硬顶**：
  - Anti-Raid Worker 运行态受 `VERIFICATION_RUNTIME_CAPACITY` 容量硬顶保护（涵盖持久阶段以及 `exempt` / `kicked` 去重记录）。
  - 当新 key 导致容量满额时，在入群计数、状态转移及副作用执行前予以拒收，并在当前代际报告一次致命错误（fatal），同时锁住后续入群事件，直至新代际接管（adopt）或停止。已有 key 的更新、验证解除和终态结算仍正常处理。
  - 新代际接管时先清空旧运行态再恢复持久镜像；若增量恢复遇满额，仅释放非持久的去重槽位以保障持久责任，拒收闩锁持续生效。
  - revision 表同样对活跃键与保留期内的终结键执行 `VERIFICATION_REVISION_CAPACITY` 容量限制。新键遇满载先清理过期墓碑，仍超额则触发系统停机。Worker 重建仅重放活跃与延后记录。

- **入群验证与防冲群私密模式的统一开关**：
  - 两项功能共用按群开关，默认关闭。仅当 `ChatState.isAntiRaidEnabled === true` 时才开启验证窗口与入群计数。
  - 持有 `isCanControllAntiRaidPermission` 的权限者（超级管理员恒持有）可通过 `/antiraid enable|disable` 修改并持久化。
  - 两条链路共用入群事件流；Anti-Raid Worker 内运行的 `/ad_detect`（广告检测）、`/flood_control`（刷屏禁言）、永久黑名单秒踢以及 `/batch_kick` 所依赖的入群日志**均不受此开关影响**，各自拥有独立边界。
  - **主线程入口过滤**：关闭防冲群的群在 `updateIngress.ts` 处直接阻断，不向 Worker 发送 `join`、`left` 或验证相关的消息/回调。但**邀请者管理员变更（`adminsChanged`）不受拦截**：作为低频缓存维护消息，该事件仅更新 Worker 侧的管理员缓存，不触碰状态机。黑名单秒踢在未开启防冲群时照常投递，但**不带 `joinedAt`**，不计入反刷群滑动窗口。

- **关闭防冲群（`/antiraid disable`）的收尾清理**：
  - 核心语义为「立即停用并撤除所有交互残留」：
    - `deactivateJoinGuard` 将该群所有验证记录推入 `guardDisabled` 状态转移，全部重置为 ABSENT。
    - 删除机器人发出的入群验证提醒与按钮（按钮已失效，不可留存于群内）。入群公告与成员自身发言不删，也不再执行踢人操作（未决的超时踢人与终态任务直接作废）。
    - 已落盘的待踢任务由 dispatcher 发出墓碑，重启后不会被重放踢人。
    - 针对私密模式（Lockdown）同步发送 `deactivate`：未生效的 `APPLYING` 阶段直接撤销，其余阶段转入 `RESTORING` 流程将群邀请权限（`can_invite_users`）归还，撤销封锁公告，并清空入群滑动窗口。
  - 仅在管理员主动关闭或执行 `/init disable` 时才调用 Telegram API 清理消息；若机器人失去管理员权限或退群，仅在本地紧急拆除状态，不再调用无权执行的删除接口。
  - 若 Worker 临时不可用导致清理异常，开关仍会持久化关闭，清理残留将在进程重启或 Worker 重建后由 `purgeDisabledJoinGuards` 彻底兜底清空。

- **关联频道讨论组评论区豁免**：
  - 关联频道评论区直接评论或楼中楼回复共享相同的豁免逻辑；评论关联缓存仅记录消息 ID 与观察时间。
  - 候选范围严格限定在关联频道的讨论线程内：论坛超级群（Topics）的常规话题消息虽同样携带 `message_thread_id`，但通过 `is_topic_message !== true` 予以排除，走普通待验证逻辑。
  - 冷缓存中的 `message_thread_id` 仅作为异步确认候选：在查询结果落地前暂按普通消息处理，一旦确认为 `linked_chat_id` 且状态代际一致，立即撤销验证责任；查询失败时 fail closed，保留后续重试。

- **Worker 侧管理员缓存的在途与代际管理**：
  - 管理员列表异步拉取通过 `libs/keyedTask.ts` 集中去重，`.finally()` 中仅在当前 promise 仍然是表内记录时才执行清理。
  - 每次重置缓存（`resetAdminCache()`）均自增表世代号（Generation）；在途请求返回时若世代号不符，仅将结果返回给当前等待者，不写回 `cacheAdminIds`，丢弃过期的待定变更。

- **验证按钮交互权限独立性**：
  - **「我是良民」按钮**：仅允许待验证新人本人点击。Worker 严格通过 `callback_query.from.id === callback_data` 校验目标关系，绝不接受前端直接声明。
  - **「通过」按钮**：仅允许本群**非匿名管理员**代点（真人与机器人目标一致）。资格由 Worker 侧的管理员缓存（`isChatAdmin`）判定，缓存未命中时拉取 `getChatAdministrators`，查询失败时提示稍后重试，不变更记录。
  - **白名单完全无关**：白名单成员或超级管理员若在当前群并非管理员，无权代点「通过」；待验证成员本人点「通过」一律拒绝。拉人豁免同样只认非匿名管理员，白名单拉人不免除验证。

- **终态踢人与群组类型适配**：
  - 执行 `kickChatMember` 前必须通过 `probeChatMembership` 现查成员状态：确认仍在群内才执行踢人；若成员已主动离群，直接结算收工且不发战报；查询失败保留终态并进入退避。
  - 确证机器人缺 `can_restrict_members`（`botCanRestrictIn === false`）时照常做成员探测，只不发踢人请求：成员已离群即结算，仍在群内则保留终态并退避；`expelling` 在失败提示已发、清理已完成后，每轮重试只发一次探测。
  - **首发请求无豁免**：超级群的「踢人且不封禁」底层映射为未带 `only_if_banned` 的 `unbanChatMember`，该调用会**解封已有封禁**。因此主线程每次执行该操作前，必须先获取 `getChatMember` 确认成员当前仍在群内，若已是 `left` 或 `kicked` 则立即取消。显式解封操作携带 `only_if_banned: true`，不受此限制。
  - **群类型精确分流**：普通群使用 `banChatMember`（普通群中只移除成员）；超级群使用 `unbanChatMember`。群类型由主线程对已受管群进行 update 监听并镜像维护，冷启动无镜像时以群为键调用 `getChat`（受 `VERIFICATION_CHAT_KIND_FETCH_MAX` 限流）。

- **私密模式秒踢与不可逆令牌（`kickPending`）**：
  - 秒踢先进入 `kickPending`（状态快照 write-ahead 先落盘，重启后能继续探测踢出；对象本体与 `executionStarted` 仅保存在内存）。
  - 在前置清理完成后、真正调用 `kickChatMember` 前，必须复核内存条目仍持有同一状态对象，且两者之间严禁插入任何 `await`。若期间管理员豁免、退群或新一代入群覆盖了该对象，操作在此截断。
  - 仅在 Telegram 请求成功且令牌仍匹配时，才将状态转为 `kicked` 并开启去重窗口。
  - **入群计数撤销口径**：仅对真正执行过 `recordJoin` 的物理入群记录（`joinCreatesNewRecord === true`）撤销计数，踢出后重新申请补建的记录不带 `countedJoinAt`，不参与撤销。
  - 误踢管理员的诊断（`logUncancelableKickExemption`）必须输出至 `logger.error`，作为人工召回排查的唯一凭证。

- **验证提醒发送与成员发言保护**：
  - 验证提醒每个成员仅分配一个投递 owner。成功发送 `reminderMessageId` 或 `replyReminderMessageId` 是超时踢人的前置必要条件；从未成功发送时仅续期窗口补发。
  - 续期设有绝对上限：入群超过 `VERIFICATION_REMINDER_UNDELIVERED_MAX_MS` 仍无法送达提醒，按普通超时结算（只踢不封）。
  - **严禁清理成员个人发言**：验证记录仅在 `trackedMessageTimes` 中记录成员入群滑窗内的时间戳，超过 `ANTI_RAID_PER_MINUTE_LIMIT` 时直接转入刷屏终态踢出；处置时仅清理机器人自身发出的提醒与公告，绝不记录或删除成员个人的常规发言（抹除消息仅属于 `/block` 及广告秒踢路径）。

### 刷屏禁言与自身权限缓存

本节依次说明 [计数与执行边界](#计数与执行边界)、[命中抑制与并发安全](#命中抑制与并发安全)、[动手前的权限闸](#动手前的权限闸)及[机器人自身权限镜像](#机器人自身权限镜像)。

#### 计数与执行边界

- **防刷屏禁言完全由 Anti-Raid Worker 独立计算并执行**：
  - 功能按群默认关闭，仅当 `ChatState.isFloodControlEnabled === true` 时才生效；持有 `isCanControllFloodControlPermission` 权限者可通过 `/flood_control enable|disable` 修改并持久化，关闭时清空该群现有窗口。
  - 仅针对**超级群**生效：同一成员在 1 分钟内发言达到 `FLOOD_MESSAGE_LIMIT` 条，立即触发禁言 `FLOOD_MUTE_DURATION_MS`（`restrictChatMember` 在 Telegram 底层仅对超级群有效）。
  - **主线程同步过滤**：在创建候选对象前，主线程依次核验群开关、超级群类型、真实用户身份以及防刷屏豁免权限（`isCanBypassFloodControl`）。频道马甲与匿名管理员无真实成员 ID，不计入统计；白名单默认持有豁免；超级管理员恒免检。通过门禁后以常规 `post` 投递给 Worker（不阻塞主线程 update 循环）。
  - 窗口状态存储在 Worker 的 `cache/workers/antiRaid/flood.ts` 中，条目上限为 `FLOOD_WINDOW_MAX_MEMBERS`，采用 LRU 淘汰与定期扫除。禁言解除依赖 Telegram 到期自动恢复，Worker 不维护恢复定时器，也不写持久化磁盘。

#### 命中抑制与并发安全

- **命中即就地打上抑制标记**：
  - 规则命中瞬间立即就地置位抑制标记，不等待禁言网络请求返回。
  - 确定性结局（禁言成功、目标实为管理员、机器人无禁言权限）**保留**抑制标记，避免反复重试；临时网络抖动或身份未查清等瞬态故障，则**回滚**抑制标记为 0，留待下一个满窗口再次触发。
  - 在每个 `await` 之后（如等待权限查询或网络请求），均通过对象同一性复核条目仍处于受管状态（`stillManaged`）：若在异步等待期间群被停管或该成员已被 LRU 淘汰，立即中止整段处置，不写回抑制标记也不发送禁言播报。

#### 动手前的权限闸

- **前置双重权限核验**：
  - 在发起禁言前必须同时通过两道闸门：
    1. 机器人自身的 `canRestrictMembers` 权限位；
    2. 通过热缓存（`freshAdminIds`，冷则现查）确认目标**不是本群管理员**。
  - 采用三态判定逻辑（`true` = 是管理员 / `false` = 确认不是 / `undefined` = 尚未查清）：**确证不了目标身份时一律不动手**；机器人自身权限若为 `undefined`（未观测到），则允许继续交由 Telegram 接口判定。
  - 禁言网络请求由 `muteChatMemberWithOutcome` 执行，同样返回三态：`muted`（成功）、`forbidden`（明确被拒，保留抑制标记不再重试）、`failed`（限流或网络故障，回滚标记待下次重试）。
  - 禁言请求带有 `FLOOD_MUTE_DISPATCH_TIMEOUT_MS` 超时限制；群内通知仅在禁言成功后发出，通过主线程挂载 `COMMAND_MESSAGE_AUTO_DELETE_MS` 定时自毁。所有在途任务均订阅 `antiRaidDispatchSignal` 停机信号。

#### 机器人自身权限镜像

- **机器人自身权限位由主线程镜像至 Worker**：
  - 权限快照持久化保存在 `ChatState.botPermissions` 中，由 `packages/infra/botAdmin.ts` 集中管理。
  - 仅在主线程发生权限变动（接收到 `my_chat_member` 更新，或主动通过 `getChatMember` 现查）时，通过 `botPermissionsChanged` 广播给 Worker。
  - **去重策略**：落盘时比对所有权限字段，而跨线程广播仅比对下游核心关注的 `canRestrictMembers` 与 `canDeleteMessages` 两位。
  - 他人触发的 `chat_member` 更新仅能推导「我是管理员」，不能推导具体权限位，因此绝不能凭此写入不完整的权限记录。
  - 当快照缺失或状态相悖时，触发一次 `getChatMember` 现查。**该现查必须带退避闸（`BOT_PERMISSION_PROBE_RETRY_MS`），且严禁 `await`**，绝不能阻塞 update 取数主循环。
  - 镜像读出的权限必须保持三态（`true` / `false` / `undefined`），严禁压缩为二元布尔值：所有破坏性动作（踢人、禁言、删消息）仅在权限**确证为 `false`** 时才短路放弃，对于 `undefined` 照常派发请求。
  - 消息删除操作返回多态（`deleted` / `gone` / `forbidden` / `failed`），其中 `gone`（消息已被删除）与 `deleted` 均视为清理成功。

### 身份解析与运行时清理

- **用户名双向缓存一致性**：
  - 发送者缓存同时维护「归一化 username → identity」与「sender ID → 当前 username」的双向映射。
  - 用户改名、去名、换绑与 LRU 容量淘汰由同一 owner 原子更新双向关系；解析器严格拒绝别名冲突或不一致记录。
- **匿名管理员与群身份处理**：
  - 匿名管理员本人仍享有管理员身份豁免，但不能作为“可归属的管理员邀请人”为新入群成员继承免验证等特权。
  - 匿名管理员代表当前群发言时，可见发送者保留当前群 identity，供 `/copy` 及头像抓取复用；但破坏性管理命令必须拒绝将当前群 identity 作为目标用户。
- **用户 ID 参数支持（`acceptUserId`）**：
  - `/block … enable` 与 `/block … disable` 额外支持传入纯数字用户 ID（匹配 `USER_ID_ARG_PATTERN` 且必须为安全整数 `Number.isSafeInteger`）。
  - 若在缓存中查不到该 ID，解析不会失败（`resolveIdTarget` 会退化生成仅包含 ID 的最小 identity 对象），仅影响操作回执中的文本标签。
  - 裸 ID 参数为逐命令主动开启（`acceptUserId`），并非全局默认行为；`/copy` 与中文动作命令均不接受裸 ID。
  - **参数与回复冲突判定**：若同时提供了回复消息和命令行参数，且两者指向不同用户，必须直接报错拒绝，严禁静默偏向任一方；参数无法解析出目标时同样按冲突报错。若两者指向同一用户，则视为无害重复，正常放行。
- **会话 ID 参数支持（`acceptChatId`）**：
  - 针对负数频道/群组 ID（匹配 `CHAT_ID_ARG_PATTERN`）设立独立的 `acceptChatId` 开关。
  - 仅 `/gag`、`/ungag`、`/block disable`、`/permission`、`/white`、`/translate`（指定停止翻译目标）与 `/info` 支持会话 ID：
    - `/gag` 与 `/ungag` 仅负责创建或解除临时可逆的发言拦截；
    - `/block disable` 属于恢复操作；
    - `/permission` 与 `/white` 用于维护允许存在的频道白名单配置；
    - `/info` 属于纯只读查询。
    - 其余命令严禁将负数会话 ID 当作普通用户目标执行操作。
  - 频道马甲 ID 同样会进入黑名单（例如针对频道消息回复 `/block`，或广告检测命中 `sender_chat`）：
    - `/block enable` 必须拒绝传入负数会话 ID；
    - `/block disable` 允许传入负数会话 ID 进行解封。
  - **负数 ID 标记 `isChannel`**：`resolveIdTarget` 生成最小身份时会根据符号标记 `isChannel`，下游与 `workers/antiRaid/blocklistEffects.ts` 保持同源派发：`/block disable` 根据该标志选择调用 `unbanChatSenderChat` 而非 `unbanChatMemberIfBanned`。
- **`/gag` 禁言状态机与消息生命周期**：
  - **权威会话管理**：主线程按群维护目标会话列表，全局硬上限为 `GAG_SESSION_MAX`。同一群内同一 identity 从 `starting`、`active` 到 `ending` 始终独占同一槽位。
  - **提示消息发送流程**：
    - 所有目标均先发送一条群内公开提示。
    - 普通用户：群内公开提示不带按钮，随后再发送一条通过 `ephemeral_message_parameters.receiver_user_id` 限定、仅目标可见且包含解除/发言按钮的临时入口。
    - 频道身份：由于没有接收用户，直接发送带按钮的群内公开提示。
    - 只有当必需消息全部发送成功，且同步登记了公开 `message_id` 与经核验的 `ephemeral_message_id` 后，会话才可切换至 `active` 状态并安装 `unref` 定时器。若第二条消息发送失败，必须先删除已落地的第一条公开提示，再释放占用的槽位。
  - **解除与资源回收**：
    - 超时、主动 `/ungag` 或群 runtime teardown 触发清理时，必须先同步认领 `ending` 状态并注销定时器，再依次调用 Telegram 删除 API。
    - 仅当所有关联消息的删除结果确证为 `deleted` 或 `gone`，且所需的解除回执消息完成结算后，方可按身份释放槽位。
    - 若删除遇到 `failed` 或 `forbidden`，继续保留 `ending` 归属，执行有限次数的 `unref` 退避重试；重试耗尽后挂起，等待后续 `/ungag`、teardown 或停机时再次清理。旧会话清理未完前，严禁同目标新会话穿插插入或误删新消息，未决债务受 `GAG_SESSION_MAX` 约束。
    - 启动阶段状态由 gag 会话直接持有，不进入常规命令提示的 30 秒自毁队列；解除回执则走统一命令删除边界。停机时 gag owner 必须在 Telegram 闸门前完成排空（quiesce/drain），未清理完毕将阻止最终 offset 确认与实例锁释放。
  - **发言提示入口的刷新机制**：
    - 刷新由当前会话 owner 统一调度：`commands/gag/counter.ts` 统计群消息数量，达到 `GAG_SPEAK_NOTICE_MESSAGE_INTERVAL` 阈值时触发。若未达阈值或已有刷新任务（`speakNoticeRefreshTask`）在途，不生成待刷新任务。
    - `commands/gag/refresh.ts` 为就绪会话认领任务并登记至 `gagBackgroundTasks`，各会话独立启动，出站并发由 Telegram 统一边界兜底。群消息积压、跨话题移动或定时补发均复用已有任务，最多并发 `GAG_SESSION_MAX` 个刷新任务。
    - 普通用户在激活与每次刷新完成后，挂载唯一的 `speakNoticeRefreshTimer`（间隔 `GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS`，必须 `unref`）；频道公开入口不设置此定时器。定时器仅在会话仍处于 `active` 且剩余有效期大于刷新间隔时允许安装；刷新开始、会话结束、quiesce 或测试重置时立即注销。
    - 刷新步骤：先在独占任务内清理废弃（`retired`）槽位，再发送新入口；收到 `onSent` 回调后同步登记 `pending`，确认提交后切换当前入口与话题、重置计数，最后删除旧入口。若发送或删除失败，不丢弃现有 ID，等待下一轮阈值或定时重试。
  - **沉默后的发言补发**：
    - `lastTargetMessageAt` 在会话激活时初始化，此后仅在目标用户于本群发言时更新。
    - `refreshGagSpeakNoticeOnSpeech` 比对前次发言时间戳；若用户连续闲置超过 `GAG_SPEAK_NOTICE_IDLE_INTERVAL_MS` 后再次发言，立即触发同刷新任务进行补发。他人发言或定时任务不重置沉默起点。
    - 沉默补发会重置定时器；未达到沉默阈值的发言只刷新发言时间戳，不重置定时器。频道入口仅在消息计数达标或跨话题移动时换新。
  - **Inline 分发隔离与鉴权**：
    - gag 与运势的 inline 查询协议严格隔离：无 `gag:` 前缀的普通 `@机器人` 查询即使由被 gag 用户发出，也完全跳过 gag 逻辑交给运势处理。
    - gag 按钮预填内容格式严格固定为 `gag:<目标 Telegram ID> `（用户为正数 ID，频道为负数 ID）。首个空格前只允许解析该安全整数，禁止添加哈希摘要、随机 Token 或群 ID 等附加参数；`ParsedGagInlineQuery` 严禁扩展此类 scope 字段，`GagSession.chatId` 仅保留命令入口确定的权威群 ID。
    - 任何带 `gag:` 前缀的查询均由 gag 入口全权处理；若参数非法、会话过期或用户身份不匹配，直接返回空结果，禁止回退给运势。
    - 查询应答后记录的源文本（`recordInlineResultSources`）仅供广告检测比对，不得作为身份放行或群绑定的凭证。消息落群时，必须严格校验 bot 身份、前缀、marker、活跃会话及发送者/群组 ID。
    - 精确 marker 固定格式为 `<目标主页>#<会话群 ID>`，仅作为公开校验载荷；消息落群后若任意校验不匹配或跨群，立即删除并终止处理。
- **`/icon steal` 头像抓取兜底**：
  - 通过 t.me 主页抓取头像时，**必须以 `getChat(targetId)` 现查返回的 username 为准**，禁止直接使用上下文传入的 username（如回复上下文或身份缓存）来跳过该查询；传入的 username 仅作为诊断日志线索。
- **群 Runtime Teardown（拆除）规范**：
  - 各领域清理回调（`copy`、`translate`、`gag`、`qa`、`wed`、`aiChat`、`antiRaid`、`joinLog`）集中由 `packages/cache/main/chatTeardown.ts` 维护，上层领域通过叶子模块 `packages/infra/chatTeardownRegistry.ts` 进行反向注册。`packages/infra/chatTeardown.ts` 仅负责组合调用，禁止静态依赖各具体业务。
  - **清理原因与数据保留判定（`ChatTeardownReason`）**：
    - `explicitDisable`（主动执行 `/init disable`）与 `departed`（机器人被移出群）：表示彻底停管，必须清除本群 `/wed` 成员集合、入群日志、问答库及 `chat_states` 记录。
    - `lostAuthority`（机器人在群内但失去管理员权限）：仅暂停运行态，保留所有持久化数据，待权限恢复后可继续使用。
    - 各领域必须通过统一工具函数 `packages/libs/chatTeardown.ts` 的 `purgesChatData` 判定，禁止自行比对 reason 字符串。
    - 特殊例外：AI 记忆在任何 teardown 原因下均清除；入群验证等残留按钮消息仅在 `explicitDisable` 时主动发 API 删除，`departed` 时因机器人已退群不发 Telegram 请求。
  - **严格按序同步派发**：`teardownChatRuntime` 遍历 `packages/consts/chatTeardown.ts` 中的 `CHAT_TEARDOWN_ORDER` 常量（类型系统强制穷尽 `ChatRuntimeOwner`）。一次 teardown 必须按此顺序同步启动所有清理逻辑，最后统一等待异步收尾。
- **成员在群复查边界**：
  - 异步查询 `probeChatMembership` 返回“仍在群”到真正调用 `kickChatMember` 之前，必须再次核对当前终态对象引用未发生变更，且该确认步骤与踢人 API 调用之间严禁插入任何 `await`。
- **`/block` 跨群封禁无结果缓存**：
  - 每次执行 `/block` 都必须向受管群列表重新派发 `banChatMember`（以触发 Telegram `revoke_messages` 撤回历史消息）；仅在权限快照已确证缺乏 `canRestrictMembers` 时才跳过请求并按失败记账。`/block disable` 同样不维护命令层封禁缓存。

### `/wed` 成员持久化与交互

- **每日成员复核机制**：
  - 复核流程由 Disk I/O Worker 独占的 Bun 原生 cron 在配置时区的 00:00 发起 `midnightMaintenance` 通知触发，主线程不创建独立 cron。
  - `commands/wed/memberReview.ts` 串行遍历所有已恢复的受管群（即便群当前无活跃交互），每群截取至多 `WED_MEMBER_LIMIT` 个 ID 快照。
  - 跨群复核共享 `WED_MEMBER_REVIEW_INTERVAL_MS` 请求间隔，单次查询预算为 `WED_OPERATION_TIMEOUT_MS`。
  - 仅当 Telegram 明确返回已离群，或返回 400 `PARTICIPANT_ID_INVALID` 时，才调用 `removeWedMember` 剔除成员并标脏（不计入 API 错误）；其他临时网络错误保留成员。若复核期间观察到该用户发言、在群 `chat_member` 或入群服务消息，可否决迟到的离群判定。
  - 若机器人在群内不是管理员，`getChatMember` 将因权限被拒绝（403 或 400 `CHAT_ADMIN_REQUIRED`），此时记录错误并直接结束本群检查，保留现有成员列表。**在非管理员群中，抽中已退群成员属于已知预期行为**。
- **权限与准入网关**：
  - `/wed` 命令与回调均置于统一 `/init` 网关之后；记录新成员要求 `isInitEnabled === true`。未开启初始化的群发生退群时，仅在已有集合中剔除 ID，不创建群状态也不放行业务。
- **缓存与持久化架构**：
  - **成员权威缓存**：`packages/cache/main/wedMembers.ts` 为每个群长期复用单一 `Set<number>`，上限 `WED_MEMBER_LIMIT` 人；满额后不再接纳新 ID，退群腾出空间后恢复。频道、回复/转发来源、匿名身份发言不计入候选。
  - **交互会话缓存**：`packages/cache/main/wed.ts` 管理交互状态与头像探测，每人每群仅占 1 个会话，每群上限 `WED_SESSION_LIMIT` 个会话。群列表受 `STATE_MANAGED_CHAT_LIMIT` 约束，不执行 LRU 淘汰。
  - **落盘策略**：仅在实际增删成员时自增 revision 并标脏。复用 Disk I/O 的 `FLUSH_MAX_ENTRIES` 与 `FLUSH_INTERVAL_MS` 阈值，通过临时文件、fsync 与原子 rename 写入 `memory/wed/<chatId>.json`。
  - **整群清空保证**：`purgeWedMembers` 移除内存集合后，向 `pendingWedMemberDeletes` 登记单调递增编号并向 Worker 投递。只有收到精确持久化确认后才注销待决任务。停机或重建时重放最新状态。
- **启动只读校验门禁**：
  - 启动阶段严格校验 `memory/wed/` 下所有文件名（规范负整数群 ID）、用户 ID（正安全整数）、单群上限及总群数；出现任何非法数据立即拒绝启动并保留原文件。缺失文件则视为无记录按需新建。
- **抽取与头像流程**：
  - 候选人信源完全取自 `memory/wed` 的 ID 集合。抽中后仅通过 `readCurrentAvatar` 获取头像（复用 `getChat` 私聊资料），无需机器人具备管理员权限。
  - 若 `getChat` 返回 400 `Bad Request: chat not found`，判定该 ID 彻底失效，从所有受管群的奖池中剔除。
  - 抽取执行器复用 `createPrioritizedBoundedTaskRunner`，共享全局 `WED_MAX_CONCURRENT` 执行槽与 `WED_MAX_PENDING` FIFO 等待队列。
  - **结果发送与替换**：`commands/wed/messages.ts` 的 `sendWedResult` 为唯一发图边界，结果长期保留，不挂 30 秒延迟自毁。发起人重抽时，仅在新结果成功发出后才删除旧图；若发送失败，保留旧图与会话状态。机器人已离群（`departed`）时，重抽中的会话收尾时不为新旧结果发删除请求。

### `/info` 资料查询

- **参数解析与预算**：
  - `commands/info.ts` 开启 `acceptUserId`、`acceptChatId` 以及 `allowSelfTarget`（允许查询机器人自身，其余命令默认禁止）。
  - 任务提交至延迟命令执行器的 `interactive` 档，全局受 `INFO_TASK_BUDGET_MS` 约束；超时则根据已获取到的信息返回，停机时静默收场。
- **资料与头像获取**：
  - 用户目标优先调用 `readChatMemberUser` 获取本群成员身份；频道/群组调用 `getChat`；机器人自身使用 `ctx.me`；均查不到时退回缓存。
  - 用户名使用 `sanitizeDisplayName` 清洗双向控制字符，ID 使用 `code` 实体展示。头像复用 `readCurrentAvatar`（群组不获取头像）。
- **回执发送规则**：
  - 带头像回执经 `infra/telegram/commandPhotos.ts` 的 `sendCommandPhoto` 发送，群聊中挂载 30 秒自毁，私聊不删除。若带图发送失败，自动降级为 `sendCommandMessage` 纯文本回执。

### `/h_image` 随机图片

- **图库目录校验与热重载**：
  - 图库路径来自 `config/dynamic/assets.json` 的 `onlyPath.random_h_image_dir`（默认 `./h_image`）。
  - 启动阶段在外部连接建立前通过 `infra/randomImage.ts` 的 `ensureRandomImageDirectory` 检查目录有效性：必须存在且可读写；子目录、软链接文件、隐藏文件或未按 64 位小写 SHA-256 命名的文件均直接拒绝启动。
  - 热重载更改目录时执行相同严格检查；若新目录不合规，则拒绝变更并保持原目录运行。运行期间若目录被删，不自动重建。
- **抽图算法（`pickRandomImage`）**：
  - 每次重新枚举目录（不常驻文件列表），仅筛选合法扩展名且小于等于 `RANDOM_IMAGE_MAX_BYTES` 的普通文件进行均匀随机抽取。
  - 抽中的文件若超限或在读取前被删改，剔除后在剩余候选列表中重新抽取。若无可发送文件且曾抽中超限文件，报错 `tooLarge`；若列表为空则报错 `empty`。
- **限流与延迟任务调度**：
  - `/h_image` 与 `/h_image add` 共用全局滑动窗口限流（`H_IMAGE_RATE_LIMIT_WINDOW_MS` 内至多 `H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW` 次），超额调用直接丢弃，不排队也不报错。
  - 命令解析后提交至延迟命令执行器（`commands/deferredCommands.ts`）：
    - 抽图进入 `interactive` 优先级；
    - 收图（add）、`/batch_kick` 与 `/block` 扇出进入 `background` 优先级。
    - 队列满载时直接返回忙碌提示，停机时在 Telegram 总闸前排空。
- **发图边界与相册收录（add）**：
  - `commands/hImage/draw.ts` 的 `sendHImageResult` 是发图唯一边界。结果图片属于长期保留例外，不挂 30 秒自毁，论坛群中附带话题并回复触发消息；各类提示信息则挂 30 秒自毁。
  - `/h_image add` 要求具备 `isCanAddHImage` 权限。候选图片来自回复消息以及主线程相册缓存（`mediaGroups.ts`）中相同 `media_group_id` 的图片。
  - 下载在 `H_IMAGE_ADD_TASK_BUDGET_MS` 预算内按 `H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE` 分页并发抓取。下载后计算 SHA-256 并使用 UUIDv7 临时文件写入，再通过原子 rename 落盘。若已存在相同哈希文件则跳过，实现全局内容去重。

### `cron.json` 定时任务

- **配置解析与源文件校验**（`packages/config/cron.ts`）：
  - 任务文件缺省表示无定时任务；若存在且任意字段非法，整份拒绝生效。诊断信息仅输出文件路径、字段路径与期望形态。
  - `parseCronConfig` 仅作词法、形态与取值校验，不做磁盘 I/O；`loadCronConfig` 在读盘后核对本地文件真实存在且类型相符（跟随符号链接）：固定图片与文件的 `path` 必须为普通文件，随机图片目录必须为真实目录。
  - **任务表规范**：
    - 顶层必须为数组。任务总数上限 `CRON_MAX_TASKS`，每任务动作数上限 `CRON_MAX_ACTIONS_PER_TASK`，任务名限长 `CRON_TASK_NAME_MAX_CHARS`（超出直接拒绝，严禁截断）。
    - 任务名去首尾空白后必须非空且全表唯一。禁止出现未声明的未知键。
    - 动作 `type` 仅允许：`send_message`、`send_image`、`send_file`、`send_voice`、`send_web_digest`；`just_once`、`rand_image`、`is_blurred` 仅接受布尔值。
  - **载荷与时区规则**：
    - `payload.path` 接受绝对路径或相对于运行时数据根（`RUNTIME_DATA_ROOT`）的路径；去除首尾空白后拒绝空串与 NUL 字符，解析后一律规范化为绝对路径。
    - `time_zone` 默认采用服务启动时区，显式指定非法值（含 `null`）直接拒绝，由 `parseTimeZone` 校验（要求 IANA 标准名，日历与 Bun cron 双向支持）。
    - `cron` 表达式由 `Bun.cron.parse` 按对应时区解析，无将来触发时间的表达式同样拒绝。
    - `rand_cron` 选填，格式为 `"<min>-<max>"` 或单值（以下界 `CRON_RANDOM_INTERVAL_MIN_MS` 起步），单位支持 `m` / `h` / `d`，取值必须落在 `CRON_RANDOM_INTERVAL_MIN_MS` 至 `CRON_RANDOM_INTERVAL_MAX_MS` 之间且 min ≤ max；`just_once` 为 `true` 时禁止配置 `rand_cron`。
  - **各动作字段约束**：
    - `send_message`：`content` 去除首尾空白后非空，不超过 `TELEGRAM_MESSAGE_MAX_CHARS`。
    - `send_image` 与 `send_file`：`content`（图注）选填，不超过 `TELEGRAM_CAPTION_MAX_CHARS`。`send_file` 的来源恰好二选一：`url`（绝对 HTTP(S) 地址）或 `path`。固定图片要求 1 至 `CRON_MAX_IMAGES` 项；单张调用 `sendPhoto`，多张调用 `sendMediaGroup`（仅首项附带 caption）。随机图片模式限制单张。
    - `send_voice`：`content` 必填，`tone` 选填；去首尾空白后分别不超过 `VOICE_OPERATOR_TEXT_MAX_CHARS` 与 `VOICE_TONE_MAX_CHARS`，清洗为单行且非空。
    - `send_web_digest`：`topic` 必填，单行且不超过 `WEB_DIGEST_TOPIC_MAX_CHARS`；`language` 选填（`zh` / `ja` / `en`，默认 `zh`）；`max_items` 选填整数（范围 `WEB_DIGEST_MIN_ITEMS`–`WEB_DIGEST_MAX_ITEMS`，默认 `WEB_DIGEST_DEFAULT_MAX_ITEMS`）；`instructions` 选填，不超过 `WEB_DIGEST_INSTRUCTIONS_MAX_CHARS`。
  - **依赖契约与群列表**：
    - 任务使用 `send_voice` 时必须在配置中启用 `agent.tts`；使用 `send_web_digest` 时必须启用核心对话能力。`assertCronAgentSupported` 在启动总闸与热重载中严格核验。
    - `chat_id` 必须为非空数组：仅允许单元素 `["all"]`（`CRON_ALL_CHATS`）、首项为排除标记的 `["except", <id>, ...]`（`CRON_EXCEPT_CHATS`），或显式列出的正负安全整数 ID 列表（去重且至多 `CRON_MAX_CHAT_IDS_PER_TASK` 个）。禁止标量写法。
- **热重载与调度对账**：
  - 启动阶段调度器在 `startConfigReload` 之前启动；热重载整份生效或整份拒绝，配置非法时继续沿用上一份任务表。删除配置文件时切换为空任务表。
  - 调度器位于主线程 `packages/cron/scheduler.ts`，状态保存在 `cache/main/cron.ts`。每个任务分配一个 Bun 原生进程内 cron（指定任务时区，标记 `unref`）。
  - 执行 handler 负责捕获所有内部异常，严禁逸出未捕获的 rejection 触发崩溃。同一任务在前序动作未结算前不重叠调度。
  - **对账规则**：深相等的任务保留原调度句柄；变更或删除的任务停止调度并撤销（在途请求执行完当前动作或重试后退出）；新增任务独立登记。
  - `just_once` 首次触发后即刻注销，记录保存在容量上限为 `CRON_JUST_ONCE_RECORD_MAX` 的 LRU 缓存中；任务转为常规周期任务后清除记录。
  - `rand_cron` 首次触发后注销原有 cron，并在随机区间内均匀抽取下一时刻，向上取整至整分钟后重新挂载单次匹配的 UTC cron。记录与随机时刻均不持久化，停机期间错过的调度不补发。
- **投递与执行调度**（`packages/cron/run.ts` 与 `packages/cron/delivery.ts`）：
  - 动作之间保持 `CRON_ACTION_GAP_MS` 间隔。网络错误、5xx、429 与出站队列满按 `CRON_ACTION_RETRY_DELAYS_MS` 退避重试。
  - 合成与检索错误支持退避重试；但 TTS 缺失、每日限额耗尽、编码非法、组稿无来源或超长等不可逆错误不重试。最终失败记录错误日志并中止本轮剩余动作。
  - **轮内资源复用**：
    - 同一轮调度新建 `CronRoundVoices`，相同 `send_voice` 动作仅合成一次，跨会话和重试复用该音频；首次成功后记录 Telegram `file_id`，后续群直接引用该 ID 发送，避免重复上传。
    - 同一轮调度新建 `CronRoundDigests`，`send_web_digest` 成功后缓存 MarkdownV2 渲染文本供所有群复用；若组稿失败则不缓存。
  - **全群广播（`all` / `except`）安全检查**：
    - `packages/cron/targets.ts` 遍历主线程 `chat_states` 中所有开启了 `/init` 且未被排除的群，按 chat ID 升序通过 `getChatMember` 与 `getChat` 现查机器人发送对应媒体的权限（`can_send_messages`、`can_send_photos`、`can_send_documents`、`can_send_voice_notes`）。权限不足或查询失败的群整群跳过，并在轮末记录日志。
  - **消息发送边界与留存**：
    - `delivery.ts` 为唯一发送边界，走主线程出站调度器，不附带论坛话题（落入 General 话题），成功后登记自发消息。
    - 定时任务消息属于用户授权的长期保留例外，不挂 30 秒自毁定时器。
    - 本地文件上传前核对大小上限（`TELEGRAM_PHOTO_UPLOAD_MAX_BYTES`、`TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES`），流读取每次序列化重新打开，确保 429 重试时不复用已耗尽的流。
- **AI 摘要生成（`send_web_digest`）**：
  - 由 AI Worker 内的 `aiChat/ai/webDigest.ts` 执行。检索优先使用 `agent.web_search` 模型，未配置时退回 `text` 模型内建检索。
  - 若调用端点未触发检索（`searchCalls === 0`）且有正文，添加模型缓存警示并转义为 MarkdownV2 发送；若已检索，则将来源元数据与 HTTPS 链接构建白名单，严禁虚构未核实的外部链接。
  - 组稿采用 `text` 模型输出结构化 JSON，由 `libs/webDigest.ts` 严格解码并按字符上限检查。格式不合格时允许带诊断重试一次（`WEB_DIGEST_COMPOSE_ATTEMPTS`）。
  - 主线程等待单次摘要生成的总时限为 `WEB_DIGEST_REQUEST_TIMEOUT_MS`；停机时取消在途请求，调度器在 Telegram 关闸前完成 drain。

### 回复与响应体的资源边界

- **有界读取与内存管理**：
  - `libs/boundedResponse.ts` 在接入流式响应时，逐块检查累计字节数并跳过空块。
  - 当块引用数超出预算时，使用 `Bun.ArrayBufferSink` 聚合字节，确保成功结果独占分配内存。超出限额、网络中断或取消时统一触发中止并释放资源；获取头像发生 HTTP 非 2xx 响应时主动取消未消费的响应体。
- **AI 闲聊并发与发送容量控制**：
  - 工具上下文生命周期延伸至消息最终发送与资源收尾阶段。
  - 单群上限 `REPLY_DELIVERY_MAX_PER_CHAT`，全局 Worker 上限 `REPLY_DELIVERY_MAX_TOTAL`，统一覆盖所有在途代际；防范跨窗口阻塞与异常堆积。

## 持久化

- **持久化输入严格校验与祖先路径核验**：
  - `libs/fileAccess.ts` 的 `inspectOptionalDirectory` 与 `inspectOptionalFile` 在文件或目录缺失时，递归核验其所有祖先路径：遇到断链、死循环软链接、目录被文件占用、`ENOTDIR` 或 `EACCES` 均直接拒绝启动。
  - 领域目录允许有效软链接，但普通持久化数据文件严禁为软链接（`memory/global/state.json` 保持自身链接规则）。
  - 启动阶段对身份库、验证、日志、运势、AI 记忆与成员文件执行全域只读 inspect；任何领域校验失败，均严禁对外发布状态、生成密钥或执行清理，保持磁盘数据原样不动。

### 落盘与快照契约

- **身份字段原样持久化**：
  - 复读与翻译的目标身份字段（`username`、`first_name`、`last_name`、`title`）按 Telegram 原始返回原样存取：不自动去除首尾空白，保留空串与纯空格合法性；存在但类型非字符串时严格解析报错。未知字段使用固定占位符，日志脱敏时不打印敏感键名。
- **全局状态 `memory/global/state.json`**：
  - 采用最新值合并、临时文件、fsync 与原子 rename 写入。顶层仅保存 `copy`（必填）与 `ttsUsage`（选填），不维护额外备份副本。
  - 启动阶段 `loadCurrentGlobalState` 优先检查数据根目录下是否存在旧版 `state.json` 或 `state.json.bak`，若存在直接拒绝启动（`assertLegacyStateFilesAbsent`）；随后按新版 schema 严格解码，校验失败同样阻止启动。
  - copy 目标变更必须等待对应 revision 确认写入磁盘后，才向中间件与调用方反馈成功。
- **语音额度 `ttsUsage` 线程归属与落盘**：
  - `memory/global/state.json` 中的 `ttsUsage`（语音每日计数）权威状态位于 AI Worker（`cache/workers/aiChat/ttsUsage.ts`）；主线程 `cache/main/storage.ts` 的 `globalTtsUsageState` 仅为持久化镜像。
  - AI Worker 每次更新额度，通过 `ttsUsage` 事件全量回传计数（`{ windowStartedAt, agentCount, reserveCount }`；两项归零时回传 `null` 表示从未使用）。主线程替换镜像并通过 `StateStore` 延迟后台批量写入（`STATE_BACKGROUND_SAVE_DELAY_MS`），停机或遇到强制落盘时立即刷盘。
  - AI 语音工具准入时的在途预留（`pendingAiTtsReservations`）仅驻留在 AI Worker 内存，不回传也不落盘；Worker 重启时从零重新计算。
  - 计数窗口自 `windowStartedAt` 起算 `TTS_USAGE_WINDOW_MS`；若时钟大幅回拨导致窗口起点晚于当前时间，视同窗口结束并重新建窗。配置额度下调时不回写历史计数，仅拒绝超过新上限的新请求。
- **翻译会话（`ChatState.translate`）状态管理**：
  - 翻译会话作为 `ChatState.translate` 字段与群状态一同存储在 SQLite `chat_states` 中，主线程维护热读副本，受 `STATE_MANAGED_CHAT_LIMIT` 容量约束。
  - 每群保存至多 `TRANSLATE_CHAT_USER_LIMIT` 个不同身份及其目标语言（`ja|cn|en|uk|ru`）；无会话时为 `undefined`。`memory/global/state.json` 中出现 `translate` 字段直接报错拒绝启动。
  - 翻译消息由 `translate/message.ts` 按群串行异步发送，不阻塞 update 中间件；每群等待队列上限 `TRANSLATE_CHAT_BACKLOG_MAX`，满载时丢弃新消息翻译并记录日志。会话开启与关闭必须等待 `persistChatState` 精确持久化确认后才反馈成功。
- **状态文件只读探测边界**：
  - `memory/global/state.json` 必须为普通文件或指向普通文件的有效软链接。若为目录、损坏链接或遭遇权限拒绝，直接拒绝启动；仅在 `lstat` 返回 `ENOENT` 时按文件不存在处理。
  - 文件读取使用致命模式 `TextDecoder` 严格解码 UTF-8 并剥离 BOM，解析失败保留原文件。
- **素材配置 `config/dynamic/assets.json`**：
  - 顶层严格分为三组：`onlyPath`（随机图库路径 `random_h_image_dir`）、`pathOrUrl`（机器人默认头像 `bot_default_avatar`）、`onlyUrl`（内联抽签与 gag 缩略图直链）。
  - 字段缺省统一回退到代码内置常量（`consts/ui/assets.ts`），不沿用旧运行态。机器人从不修改或回写此文件；出现未声明分组或字段时整份拒绝。
  - 缩略图由 Telegram 客户端下载，仅允许 `https` 协议；本地抓取的默认头像允许明文 `http` 或本机文件路径（支持绝对路径或 `./`、`../` 开头的相对路径）。本地头像文件大小不超过 `AVATAR_MAX_DOWNLOAD_BYTES`，且校验必须具备合法的 JPEG/PNG 字节签名。
- **统一日志脱敏边界**：
  - 写入 journal、Worker 信封或 `logs/` 前，自动脱敏已加载配置中的所有敏感凭据（Tokens、API Keys、密钥、Google Provider Header 等）。
  - 日志中的 HTTP(S) URL 统一收敛为 `origin + pathname`，丢弃 query 参数、fragment 与 userinfo。
  - 错误对象展开 `cause` 与 `AggregateError`，最大展开深度 `LOGGER_NESTED_ERROR_MAX_DEPTH`，参数序列化受 `LOGGER_MAX_SERIALIZED_BYTES` 限制，循环引用使用静态占位符替代。
- **群状态规范形状与 Normalizer**：
  - `normalizeChatState` 仅回收真实超时的状态字段：`quietUntil` 支持 `QUIET_CLOCK_SKEW_TOLERANCE_MS` 时钟微调容差；大幅时钟回拨时将静默截止时间收敛到 `now + QUIET_MAX_DURATION_MS`，绝不静默删除字段。
  - `ChatState` 遵循**严格固定形状**（`libs/chatState.ts` 的 `createChatState`）：所有字段在对象创建时一次性初始化，未设置的字段赋值为 `undefined`，严禁通过 `delete` 操作改变对象隐藏类。
  - 编码时仅将偏离默认值的字段写入 `chat_states.status`；已确证的 `botPermissions` 即便全为 `false` 也必须显式持久化，与未查询的 `undefined` 严格区分。
- **持久化写入批处理与时区维护**：
  - AI 记忆每 `AI_SNAPSHOT_INTERVAL_MS` 上报脏数据，经 Disk I/O Worker 校验后排入共享 SQLite 事务，按主键更新 `chat_states.ai_context`。
  - 运势、待验证状态、日志、AI 缓存用量与广告样本均采用追加日志文件格式，按 `FLUSH_MAX_ENTRIES` 条或首条变更后 `FLUSH_INTERVAL_MS` 触发批次持久化并在成功后执行 fsync。
  - 跨配置时区午夜时，Disk I/O Worker 启动配置时区零点维护 cron：先通知主线程接纳 `/wed` 每日复核，随后依次触发运势、日志、入群记录、待验证状态等跨日维护与归档。
- **入群日志（`joinLog`）批处理与 `/batch_kick` 检索**：
  - `chat_member` 入群事件经 `recordJoinLog` 写入主线程未确认镜像后即刻返回；Disk I/O 攒批按 `chatId:day` 写入磁盘并返回确认序列号 `through` 与待决序号 `pending`。
  - 磁盘写入失败时保留数据在待写队列并执行退避重试，严禁直接丢弃；主线程镜像硬顶同时约束 Worker 内存。
  - `/batch_kick` 读取 `[since, now]` 滚动窗口内的入群日志，跨度不超过 `DAY_MS`。窗口两端时间戳与日文件名均源自 Telegram 事件原始时间（`joinedAt` 对应配置时区日期），严禁混用宿主机时钟。
  - 记录去重后仅保留每个用户的最新入群记录。命中白名单的跳过；命中黑名单的交回统一封禁；仍留在群内的调用 `kickChatMemberWithOutcome` 执行踢出（只踢不封）。若单批中包含被拉黑用户，批次结束后触发一次全名单补扫。
- **人设与通知文案的启动快照**：
  - AI 人设优先加载 `prompt/persona.md`，缺省时使用内置 `DEFAULT_AI_PERSONA`；`send_voice` 工具说明优先加载 `prompt/voice_tool.md`。两者均在启动总闸阶段生成只读快照并注入 AI Worker，运行期不热重载。
  - 通知文案风格由 `bot.json` 的 `atmosphere` 明确指定（`mesugaki` 雌小鬼或 `normal` 普通）；未配置时若存在人设文件使用普通风格，否则默认雌小鬼风格。全进程风格统一，运行期间不发起额外的 SQL 或 RPC 查询。

### 群状态与 `chat_states`

- **权威副本与容量上限**：
  - 每群状态的权威存储为 SQLite `chat_states` 表；主线程维护容量上限为 `STATE_MANAGED_CHAT_LIMIT` 的固定热读副本（`packages/cache/main/chatState.ts`）。
  - 字段完整保存在 `status` 列中，覆盖功能开关（含 `isProxySendEnabled`）、`quietUntil`、`lockdown` 预写记录、`botPermissions` 快照、`title` 与翻译会话 `translate`。
- **容量保护策略**：
  - 容量达到上限时**严格拒绝、绝不执行 LRU 淘汰**：新建超出限额的群时 `assertChatStateCapacity` 抛错；启动阶段由 `decodeStoredChatStates` 校验容量，Disk I/O Worker 写入前独立复核。
  - 热读副本按插入顺序迭代，`get` 操作不改变顺序，使 `/block` 连带封禁群列表的展示顺序具备确定性。
  - 容量超限拒绝专属于 `/init enable` 入口，以 `INIT_CHAT_LIMIT_TEXT` 明确提示；其余任何命令均禁止隐式触发群新建。
- **状态回收与默认值清除**：
  - 每次写入前调用 `normalizeChatState` 回收过期时间；当 `isEmptyChatState` 为真（所有开关均为 `false` 且其余字段均为 `undefined`）时，直接删除内存条目并写入持久化删除墓碑。
  - 执行 `/init disable` 时必须同时清空群名 `title`，确保停管群完全释放槽位。
- **代理发送唯一性（`isProxySendEnabled`）**：
  - 保证全局最多仅有一个群启用代理发送。仅在启用该选项的写操作时核验其余行，保持轻量判定。
- **落盘屏障**：
  - 遵循 write-through + 精确 revision ACK 机制：`persistChatState` 充当 durable barrier 供核心权威决策等待；`saveChatStateInBackground` 用于群名更新或权限快照失效等可重建状态的低优先级异步写入。

<p align="right"><a href="#快速导航">↑ 返回快速导航</a></p>

### 群问答与 `chat_qa`

- **权威存储与复合主键**：
  - 问答库权威存储为 SQLite `chat_qa` 表，主线程持有唯一热读副本（`packages/cache/main/qa.ts`）。
  - 主键为 `(chat_id, q)` 复合键并在 `q` 上建立索引，同一群内同一问题只能对应一个答案。全表行数上限受管群数 × `CHAT_QA_MAX_PER_CHAT`，启动阶段一次性加载全表，运行期不分页。
- **条数上限独立多重把关**：
  - 单群问答数量上限在三处独立校验：主线程 `setChatQa`、Disk I/O Worker 写入事务缓冲前、启动整表解码阶段。
- **`/qa set` 表单鉴权与生命周期**：
  - 命令侧核验 `isCanControllQaPermission` 并记录 `openedById`（由 `visibleSenderChat` 获取的可见身份）；后续用户投递消息仅需比对可见身份是否与之一致，不再重复查询管理员权限。
  - 自发消息等待、字段删除及表单编辑等 await 操作后均重新核对会话有效性；已关闭或被替代的旧会话放弃认领，不再处理后续投递或回执。
  - 表单发送与清理统一经由 `qa/notices.ts` 边界执行，严格遵守 Telegram 取消与错误处理，不建立独立重试队列。
  - 字段校验：问题超过 `CHAT_QA_QUESTION_MAX_CHARS`、答案超过 `CHAT_QA_ANSWER_MAX_CHARS`，或问题整条、答案在 ``` 代码块之外含会渲染成可点击命令的斜杠写法（`containsRenderableCommand`；答案按直答出口同一个 `renderFencedText` 拆分）时，该字段不写入会话，表单保留，回执按 `QaFormIngressResult.rejection` 给出对应提示。
- **自发消息阻断**：
  - 投递入口监听 `["message", "channel_post"]`，通过 `isBotOwnMessage` 阻断机器人自身消息回弹。
  - 判定按照**执行开销递增**排序：先做群 ID 的 Map 精确查找（数字键零分配），再通过 `selfSentTracker.ts` 查本地消息 ID，最后才执行跨线程 `waitForBotOwnMessage` 协同等待。
- **格式化、回显截断与看板分页**：
  - 答案中的代码块以字面 ``` 围栏存储在 SQLite 中，围栏字符计入 `CHAT_QA_ANSWER_MAX_CHARS`；直答发出时重新解析为实体。
  - 表单提示（`renderQaFormPrompt`）在超出单条消息上限时截断**回答预览**并追加省略号，保留完整问题文本；实际落库仍使用未截断的权威内容。
  - `/qa query` 看板将答案压缩至 `QA_QUERY_ANSWER_PREVIEW_MAX_CHARS` 并补省略号，问题保持完整展示；按每页 `QA_QUERY_PAGE_MAX_ENTRIES` 条进行分页，页码存储于 `callback_data` 中，点击时重新装载最新数据。
- **直答匹配与 AI 隔离**：
  - 问题文本在写入时执行 trim，热匹配路径不做全局归一化；首实体为前导 `@机器人` 时仅对 bot 用户名忽略大小写，问题文本本身仍要求一字不差匹配。
  - 直答优先于 AI 闲聊触发，且不受 `/quiet` 静音抑制；命中后立即发送答案并终止下游处理，该交互不进入 AI 滚动上下文。
  - 模型侧查询工具（`group_qa_query` 与 `group_qa_answer`）所需上下文直接搭载于主线程的 `trigger` 消息中，不建立跨线程镜像，不支持模糊匹配。落盘遵循统一的 write-through 与精确 revision ACK 规范。

### 黑名单与广告检测

本节依次说明 [黑名单权威名单与 block 命令](#黑名单权威名单与-block-命令)、[广告检测的准入、判定与处置](#广告检测的准入判定与处置)、[封禁与消息撤回](#封禁与消息撤回)、[黑名单移除 outbox](#黑名单移除-outbox)、[权限恢复后的重放](#权限恢复后的重放)及[黑名单销号识别](#黑名单销号识别)。

#### 黑名单权威名单与 block 命令

- **权威名单与缓存一致性**：
  - `/block` 权威存储为 SQLite `blocklist_entries` 表；主线程仅维护最近访问身份的有界 LRU 缓存与尚未持久化确认的待决写入。
  - 黑名单属于同步安全边界：在执行决策前，必须预热目标身份的白/黑名单正负判定；写入时先更新内存 LRU 最终值，再向 Disk I/O Worker 投递 revision。
  - 名单条目不设时间淘汰机制。删除仅有两条合法途径：管理员执行 `/block disable`，或系统触发[黑名单销号识别](#黑名单销号识别)自动解除。
  - 条目数据必须是包含 `blockedAt` 与 Telegram 元信息的完整严格 JSONB 格式；选填字段 `participantInvalidCount` 默认为 0，存在时取值范围限定在 `1` 到 `BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1` 的整数之间，非法数据阻止启动。
- **`/block disable` 完整解除机制**：
  - 若目标已在表中，主线程先发布负向缓存与计数，从 `pendingBlockedRemovals` 在途批次中剔除该 ID 并投递裁剪后的 outbox 快照，最后投递删除墓碑（`queueBlocklistDeletion`）。
  - Disk I/O Worker 按顺序处理，快照写入优先于删除，确保数据库不引用已删条目且不残留补扫任务；Worker 重建时按领域优先级恢复。
  - 无论目标此前是否在库中，均在 `managedAdminChatIds` 受管群清单中解除封禁：发起命令的本群排在最前，其余为所有已 `/init enable` 且机器人具备管理员权限的群。普通用户调用 `unbanChatMemberIfBanned`（`only_if_banned: true`），频道身份调用 `unbanChatSenderChat`。
- **保护身份与互斥串行化**：
  - 超级管理员（`SUPER_ADMIN_USER_ID`）与永久白名单成员恒受保护，`isWhitelisted` 贯穿 `/block`、`/mute` 与 `/batch_kick` 的准入门禁；临时广告免检不享有该永久保护。
  - `/white enable` 严格拒绝已处于黑名单中的身份。
  - 通过 `runProtectedIdentityMutation` 保证身份互斥判定与状态更新在主线程严格串行，Telegram 网络调用与持久化确认在临界区外执行。拉黑操作先写入临时免检墓碑再写入黑名单记录，启动与事务校验时两类名单严禁交叠。
- **落盘屏障与领域收敛**：
  - `/block` 的落盘确认（`confirmBlocklistPersisted`）与白名单同口径走 `confirmIdentityPolicyPersisted("blocklist", id, …)`：只等黑名单领域的 flush 屏障，Worker 仅刷黑名单所在的共享 SQLite 事务，隔离其他持久化领域（如 wed 成员文件）的无关错误；flush 成功后还要核对该 id 最新 revision 已收到精确 ACK。
  - 统一 flush 覆盖全部领域并在回执中点名 `failedDomains`；AI 缓存用量与广告样本属于旁路数据，刷盘失败仅输出错误日志，不使整机 flush 报故障。
  - 重复调用 `/block`（含目标已不在名单里的 `/block disable`）是落盘失败后的重试手段：该 id 仍有未确认的最终值（拉黑记录或解除墓碑）时，以 `retryUnacknowledged` 经 `requeueUnacknowledgedIdentityWrite` 补投同一 revision，禁止凭内存存在性跳过落盘确认。
- **群级补扫触发与状态闩锁（`sweepBlockedMembers`）**：
  - 当且仅当「机器人是管理员 && 群开启了 `/init`」时触发补扫；两项条件中任意一项发生变更时均重新核验。
  - 只有在收到 Worker 明确返回 `complete: true` 的 `blockedMembersRemoved` 回执后，才在 `blocklistSweepState` 中记录 `sweptAt`。
  - 重试受退避定时器 `BLOCKLIST_SWEEP_RETRY_INTERVAL_MS` 约束，且退避判定必须排在跨线程读取名单页之前。群注销或权限丧失时通过 `forgetChatBlocklistWork` 清除补扫进度并作废在途批次。
  - `sweptAt` 作为完成闩锁，在检测到群内仍残留黑名单成员（如封禁失败或秒踢未完成）时通过 `requestBlocklistResweep` 重置为 `null`；连续失败时重试退避线性递增，封顶为 `BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS`。
- **权限不足与目标是管理员的细分判定**：
  - Telegram 返回 403 或 400 `not enough rights` 时被归类为 `forbidden`。
  - 若封禁目标本身是该群的管理员，Telegram 同样返回 400 `not enough rights`。此时 Worker 通过 `probeChatAdmin` 现查身份：若确证目标是管理员，记录日志并跳过该目标，同批其余目标正常处置，整批照常落定；但回执附加 `targetIsAdmin` 标记，主线程据此不更新 `sweptAt` 并累计失败计数，使该群继续保持待补扫状态。
  - 若机器人自身确实缺乏封禁权限，Worker 回传 `permissionDenied`：主线程标记 `permissionBlocked`，暂停时间退避重试，outbox 中的补扫批次标记为 `missing-permission`。仅当接收到明确具有 `canRestrictMembers` 权限的 `my_chat_member` 更新或现查结果时，方可解除闩锁。
- **任务持久化与秒踢（即时封禁）**：
  - 封禁批次通过 `trackBlockedRemoval` 记录于 `pendingBlockedRemovals`，Worker 重建时全量重投（封禁操作幂等）。
  - 黑名单成员入群时触发秒踢，取代常规的入群验证流程（不开启验证窗口）；通过 `recentBlockedJoinCounts` 消除 `chat_member` 与 `new_chat_members` 的重复入群事件，补记滑动窗口入群计数并撤销入群服务通知。
- **线程协作与跨群扇出**：
  - 身份判定与名单维护归属主线程；探测、封禁与重试顺序交由 Anti-Raid Worker 异步串行执行，出站请求按 `query` / `kick` 分流至 429 调度车道。
  - `/block` 命令自身的跨群封禁扇出属于显式例外：主线程在 update 内完成落盘确认后，将扇出任务提交至延迟执行器的后台档（`commands/blocklistFanOut.ts`），以 `MANAGED_CHAT_BATCH_CONCURRENCY` 限制并发，逐群直接派发 `banChatMember` 或 `banChatSenderChat`，失败群交回后续补扫统一处理。

#### 广告检测的准入、判定与处置

- **准入门禁与复核机制**：
  - 送检门禁必须同时满足三项条件：本群 `ChatState.isAdDetectEnabled === true`、机器人是群管理员、发送者不具备免检权限（`isCanBypassAdDetection`）。超级管理员恒定免检。
  - Worker 判定命中并将事件回传主线程后，在写入黑名单临界区前必须再次核对群开关与白名单状态；若期间群关闭了广告检测，按预期竞态记录普通日志并放弃拉黑。
- **豁免与特殊消息来源**：
  - 关联频道的自动转发（`is_automatic_forward`）与机器人自身发布的消息（`isBotOwnMessage`）一律跳过。
  - 本 bot 发出的 inline 消息（`via_bot` 指向自身）送检的是用户的**原始查询文本**，而非 bot 渲染后的带格式落群正文。各 inline 功能在应答成功后调用 `recordInlineResultSources` 登记源文本，容量上限 `INLINE_RESULT_SOURCE_MAX_AUTHORS`；取不到源文本或正文不符时跳过判定。
  - 讨论组评论区引用的频道原帖正文与截取片段不混入待检正文。群主与管理员恒不被判定为广告。
- **队列管理与流量控制**（Worker 线程）：
  - 队列以 `chatId:senderId` 为键，同一用户的连续消息合并入 `pendingAdMessages` 的单一 bundle 中，不重复排队。
  - 待检发送者上限 `AD_DETECT_MAX_PENDING_SENDERS`，满载后直接拒绝新用户，禁止淘汰已有未检用户。
  - 调度器每 `AD_DETECT_QUEUE_TICK_MS` 从队首提取至多 `AD_DETECT_BATCH_SIZE` 个用户，全局在途请求上限为 `AD_DETECT_MAX_IN_FLIGHT`。
  - 抑制窗口 `AD_DETECT_JUDGED_RETENTION_WINDOW_MS`：刚处置过的发送者键记录在 `recentlyDisposedAdKeys` 中，在此期间到来的新消息抑制重复判定；但频道马甲在此窗口内的新消息仍照常删除。
- **送检组装与模型交互**：
  - 单用户消息数量上限 `AD_DETECT_MAX_MESSAGES_PER_SENDER`，字符预算 `AD_DETECT_BUNDLE_MAX_CHARS`。当未判消息由于超限被丢弃时，正文移除但消息 ID 转入 `pendingDeleteIds`，确保处置时完整删除，并记录错误日志。
  - 发送者的个人姓名（`firstName`、`lastName`）与非转发正文共同送检，姓名推广与正文推广同等归因。
  - **纯链接保护**：若用户整串消息仅由单个或多个链接及普通姓名组成，且无任何推广、招募或交易文案，必须判定为 false（支持各类代理节点与订阅协议）。
  - 提示词必须显式包含 `"JSON"` 字符串，要求模型仅返回裸 JSON 对象；解析器优先解析裸对象，兼容 markdown 围栏包裹。模型识别失败时视为未检，不盲目判罚。
  - 模型上下文事实声明：主线程同步获取用户是否处于入群待验证状态，作为事实独立声明并附加于固定位置，不混入待判定正文。
- **处置执行与通知**：
  - 判定为广告后，Worker 侧删除该用户待删消息列表并回传 `adDetected`；主线程在临界区内执行 `blockUser`、刷新黑名单落盘，并生成持久化封禁批次投回 Worker 执行全群封禁。
  - 主线程通过 `sendTemporaryMessageOnMain` 发布处理播报，挂载 30 秒自毁定时器，播报内容如实反馈成功封禁的群数与权限缺失情况。
  - 停机时广告检测仅停止接入新请求，在途模型调用自行超时收尾，不阻塞快速停机。命中样本以追加方式写入 `memory/ad-detected/sample.json`，按配置时区日期自动归档轮转。

#### 封禁与消息撤回

- **消息撤回机制**：
  - 黑名单封禁操作（`/block`、入群秒踢、补扫、广告处置）统一调用 `banChatMember` 并固定设置 `revoke_messages: true`，撤回目标在群内的历史消息。
  - 频道马甲由于缺乏成员概念，`banChatSenderChat` 不支持自动撤回消息，广告检测处置时在 Worker 侧显式调用删除接口清理关联消息。

#### 黑名单移除 outbox

- **跨进程持久化保证**：
  - 黑名单封禁批次通过 Disk I/O Worker 写入 SQLite `pending_blocked_removals` 表。只有在事务落盘（durable）并收到 revision ACK 后，主线程才向 Anti-Raid Worker 派发任务并确认 update。
  - 补扫任务（`probeMembership: true`）在 outbox 中仅持久化群 ID，执行时以稳定游标按 `BLOCKLIST_SWEEP_PAGE_SIZE` 分页拉取最新黑名单主键；秒踢任务（`probeMembership: false`）则冻结当时确定的 `userIds` 列表。
  - 启动阶段自动从 SQLite 恢复未结任务并重放；outbox 容量上限 `BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES`，校验失败安全退出。

#### 权限恢复后的重放

- **权限补齐恢复流程**：
  - 当确证机器人恢复 `can_restrict_members` 权限时，系统首先按原 `removalId` 重放 outbox 中因权限不足而挂起的秒踢与广告封禁批次。
  - 随后触发一次全名单补扫，彻底清理此前封禁失败或未覆盖的黑名单成员。补扫任务与重放批次各自独立收敛并销账。

#### 黑名单销号识别

- **销号错误探测与计数**：
  - Telegram 对已注销账号返回 400 `PARTICIPANT_ID_INVALID`。在全名单补扫中，若用户在所有 `BLOCKLIST_REMOVAL_MAX_ATTEMPTS` 次尝试中均返回该错误且未被停机中断，判定为 `participantInvalid`。
  - Worker 在 `blockedMembersRemoved` 回执中分类回传 `participantInvalidUserIds` 与已落定的 `settledUserIds`。主线程按到达顺序串行处理：前者的条目计数 `participantInvalidCount` 累加 1，后者中已存在的计数被清除。
- **自动解除机制**：
  - 当某个用户的 `participantInvalidCount` 累计达到 `BLOCKLIST_PARTICIPANT_INVALID_LIMIT` 上限时，系统判定该账号已被 Telegram 永久注销。
  - 主线程自动调用 `unblockUser` 将其移出黑名单，发布负缓存并写入删除墓碑，记录审计日志。该路径不触发跨群解封 API，终结无效的死循环补扫。

### 运势与 AI 记忆恢复

- **运势跨日轮换与滞留队列**：
  - 切换配置时区自然日 owner 之前，必须先 flush 旧日的追加缓冲区；若刷盘失败，保持旧 owner 并拒绝轮换。
  - 触发跨日轮换的新一天抽签记录必须转入滞留队列等待补录，严禁随轮换失败而丢失（主线程 `dailyLuckCache` 已记录其当日抽签事实并反馈回执）。滞留队列设有容量硬上限，溢出时淘汰最旧条目并记录日志；后续刷盘重试成功后立即触发补录。
  - 若目标日已存在确认记录，密钥缺失或日期不符属于严重数据不一致，必须拒绝启动或轮换，严禁静默生成新密钥掩盖问题。
- **跨日启动的时间容差处理**：
  - 若服务恰在 00:00 前后启动，主线程与 Disk I/O Worker 依据配置时区计算出的“今天”可能存在一天偏差。
  - 此时不判定为致命错误，而是主动丢弃过期凭据与当日旧记录（缓存置空），在首次处理运势请求时由 `ensureLuckCacheFreshForToday` 向 Worker 重新索取当天最新密钥，并标记进程已跨日。
- **AI 记忆快照恢复门禁**：
  - 启动阶段仅加载符合当前 `AI_MEMORY_HYDRATE_BUFFER_MAX` 与 `MAX_SUMMARY_ROUNDS` 约束的 version=1 快照；任意字段非法或超限均直接拒绝启动，严禁在恢复期静默截断。
  - 消息及引用的各字段（姓名、用户名、正文、引用）必须为单行文本（仅允许普通空格），引用字符上限 `REPLY_REFERENCE_MAX_CHARS`；时间戳 `at` 格式必须匹配 `YYYY/MM/DD HH:mm:ss`；`pendingImage` 结构严格受限。
  - 水合群总数受 `AI_MEMORY_MAX_CHATS`（设定为 `2 × STATE_MANAGED_CHAT_LIMIT`）硬顶约束，确保受管群与拆除中群并存时不发生意外溢出。
  - AI Worker 耗尽重启预算放弃恢复时，自动清空 `lastInitState.current`，使 `flushAiMemory` 安全返回 `flushed`，避免闲聊功能降级阻断全局停机流程。
- **内存派生消息索引（`chatMessageIndexes`）**：
  - 作为内存滚动缓存的纯派生索引，不落盘，仅在消息进出热区时同步增删，受滚动缓存上限自然约束。
  - 机器人自身消息的回复链通过 Telegram 返回的 `reply_to_message` 关联；在目标滑出热区时使用轮次开始时的快照兜底，不扩张索引边界。

### 确认边界与停机

- **Telegram Update 确认边界**：
  - Update 仅在对应中间件执行完毕、所有副作用结算后，方可推进确认边界（offset）。
  - 若停机期间正在处理的 update 遭遇失败或被强行放弃，runner 立即写入显式失败标记；生命周期在停机收尾阶段核验该标记，若存在未决失败则**拒绝向 Telegram 确认最终 offset** 并以非零码退出，确保 Telegram 重启后重新投递该消息。
  - runner 轮询严格使用 `limit: 1`，保证每条消息在独立的确认边界内落定，杜绝批次内非幂等操作重复执行。
- **长轮询与网络退避机制**（`app/updateFetcher.ts`）：
  - 长轮询超时为 `UPDATE_POLL_TIMEOUT_SECONDS`，重试窗口 `UPDATE_POLL_RETRY_WINDOW_MS`。
  - 遭遇网络抖动时，在 `UPDATE_POLL_INITIAL_RETRY_MS` 至 `UPDATE_POLL_MAX_RETRY_MS` 之间执行指数退避；遇到 429 时严格等待 `retry_after`；遭遇 401/409 等凭据冲突时直接抛出致命错误退出。
  - 关联频道查询使用 `LINKED_CHANNEL_FETCH_TIMEOUT_MS` 独立超时，超时后返回 `undefined`，不授予免检权限。
- **最终 Offset 确认与停机三态分类**：
  - 停机确认最终 offset 的 `getUpdates(timeout: 0)` 调用受 `FINAL_OFFSET_CONFIRM_TIMEOUT_MS` 截止时间保护。
  - 停机结局由 `classifyShutdown` 归纳为三态：
    - `clean`：正常停机，所有状态排空落盘，最终 offset 成功确认；
    - `offsetWithheld`：所有领域正常排空落盘且 Worker 已终止，但最终 offset 未能确认。释放实例锁，以非零状态退出，等待重启重新拉取 update；
    - `unsettled`：存在未完成的排空任务或落盘失败。**强制扣住实例锁**以保护现场，以非零状态退出。
- **Anti-Raid 与各 Worker 停机排空（Drain）**：
  - Anti-Raid 停机时先向 Worker 发送 `drain` 协议，停止广告判定节拍并阻断新请求；取得回执后，主线程在有界预算内排空在途处置、持久化事务并完成固定点对账。
  - 停机流程遵循固定顺序：
    1. 暂停所有新任务接入（quiesce 各业务调度器、热重载与 runner）；
    2. 有界排空 Anti-Raid、未决消息自毁、问答表单、wed 交互；
    3. Flush 并终止 AI Worker；
    4. 排空 Telegram 出站队列；
    5. Flush 并终止 Disk I/O 与 Anti-Raid Worker；
    6. 执行 StateStore 最终落盘，确认最终 offset 并释放实例锁。
  - **共享 SQLite 关库**：`terminateDiskIO` 在当前代际已完成恢复握手、可写且未发出致命信号时，先把 `writable` 置假，再发一次 `closeStorage`（预算 `DISK_IO_STORAGE_CLOSE_TIMEOUT_MS`）。Disk I/O Worker 以一个事务提交残余写，执行 `PRAGMA wal_checkpoint(TRUNCATE)` 后关闭连接，此后忽略身份写消息。回执报残余写未提交，或关库请求超时、被拒、回执报错而无法确认已提交时，Worker 照常终止，磁盘终止这一步记为失败，停机结局为 `unsettled`；checkpoint 被其它读连接挡住只写诊断（残余写已提交，WAL 留在库旁）。`closeStorage` 不算业务消息，Worker 重建时不重放。
  - 停机超时与各步骤耗时预算统一由 `monotonicDeadline.ts` 依据 `performance.now()` 计算，免疫系统时钟回拨。

### 文件权限与 schema

- **运行时目录权限基线**：
  - 数据根目录、`memory/` 与 `logs/` 在启动阶段强制校验权限不宽于 `RUNTIME_DATA_ROOT_MAX_MODE`（严格禁止 group 与 other 的写权限）。
  - SQLite `database/` 目录采用 setgid 协作目录权限 `IDENTITY_DATABASE_DIRECTORY_MODE`，文件默认使用 `IDENTITY_DATABASE_FILE_MODE`。
  - 启动阶段仅校验运行用户是否具备合法的读写权限，不自动修改文件属主或权限；权限不合规直接拒绝启动。
- **原子替换的权限保留**：
  - 执行 `tmp + fsync + rename` 原子写文件时，必须先读取已有目标文件的权限位（mode）并沿用；临时文件默认权限不覆盖既有目标权限。传入的 `mode` 参数仅在目标文件不存在时作为首次创建的初始值。
- **禁止猜测式 schema 迁移**：
  - 持久化数据 schema 必须严格匹配当前版本，不支持静默自动升级或旧格式兼容分支；遇到非法或不兼容数据一律拒绝启动。

### 锁定镜像与终态标志

Lockdown 的持久化指纹、镜像恢复与终态快照约束见 [锁定镜像与终态标志](04-lockdown-invariants.md)。

## 兼容入口

- **顶层导出（Barrel）纯粹性**：顶层兼容入口仅负责符号再导出，严禁持有运行状态、解析配置或引入带有 import 副作用的代码。
- **运势回执验签格式与安全解码**：
  - 运势回执要求内嵌日期精确等于当天配置时区日期，日级 HMAC 密钥每天定时轮换。
  - 验签解码统一收拢至 `libs/luckReceipt.ts`：面对非标准长度或非法 Base64 输入时，内部安全捕获 `SyntaxError` 并归一化返回 `undefined`，禁止异常逃逸至 update 中间件。

---

<div align="center">

[← 上一页：03 目录导览](03-directory-map.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#04-运行时权威约束) · [下一页：05 开发流程 →](05-dev-workflow.md)

</div>
