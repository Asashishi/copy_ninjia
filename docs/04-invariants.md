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

> [!TIP]
> 本页是供实现与审查时查阅的约束全集，不必从头顺序通读。先从下方导航进入领域；长条目按段落阅读，段首的粗体文字通常是该段必须守住的结论。

## 快速导航

| 范围 | 主题 |
| --- | --- |
| [启动与 import 边界](#启动与-import-边界) | [启动顺序与资源获取](#启动顺序与资源获取) · [可选凭据与配置降级](#可选凭据与配置降级) · [数据根与后台任务](#数据根与后台任务) · [出站请求与消息安全](#出站请求与消息安全) |
| [Worker 与状态所有权](#worker-与状态所有权) | [线程与状态归属](#线程与状态归属) · [状态机契约](#状态机契约) · [AI 闲聊运行时](#ai-闲聊运行时) · [AI 提示词与转录](#ai-提示词与转录) · [入群验证与终态处置](#入群验证与终态处置) · [刷屏禁言与自身权限缓存](#刷屏禁言与自身权限缓存) · [身份解析与运行时清理](#身份解析与运行时清理) |
| [持久化](#持久化) | [落盘与快照契约](#落盘与快照契约) · [黑名单与广告检测](#黑名单与广告检测) · [运势与 AI 记忆恢复](#运势与-ai-记忆恢复) · [确认边界与停机](#确认边界与停机) · [文件权限与 schema](#文件权限与-schema) · [锁定镜像与终态标志](#锁定镜像与终态标志) |
| [兼容入口](#兼容入口) | 顶层 barrel 与运势回执格式 |

## 启动与 import 边界

### 启动顺序与资源获取

- 生产模块 import 不启动 Worker、计时器、网络请求或共享目录写入。
- 主进程先递归创建并预检运行时数据根的写入、文件 fsync、hard link、原子 rename 与目录 fsync，再取得 `bot.lock`；数据根及敏感顶层 `memory/`、`logs/` 必须是实际目录，`lstat` 命中符号链接即 fail closed。显式配置 `COPY_NINJIA_DATA_ROOT` 时还要求目录 mode 为 `0750` 或更严格，已有目录只校验、不自动 chmod。随后清理顶层孤儿临时文件并严格恢复 `state.json`，这些步骤发生在任何联网和 Worker 创建之前。

  之后才初始化 Telegram 客户端与 Disk I/O Worker、恢复 `memory/` 数据、完成 handler/命令菜单/`bot.init()` 握手，最后初始化并 hydrate AI/Anti-Raid Worker、启动 acknowledgement-safe runner。
- 初始化失败和正常退出都由 `ApplicationLifecycle` 收口；只有已取得的资源才会释放或 flush。

### 可选凭据与配置降级

- 配置解析器本身无 I/O；`getStickerConfig()` / `getReactionConfig()` / `getMoodConfig()` / `getAdSampleConfig()` 在业务首次使用时惰性加载。

  **主进程不得在启动阶段统一预热它们**：四份文件各属一个按群 opt-in、缺省关闭的可选功能，在那里抛错等于一份写坏的贴纸白名单就能让 copy、抽奖、入群验证、黑名单一起离线，systemd 还会照着重启循环。校验改在功能自己的 enable 分支做（`packages/config/readiness.ts` 按功能聚合结论，`packages/commands/configGate.ts` 统一拒绝文案）：坏了只拒绝那一个开关，回复点名到具体文件，日志留英文诊断，其余能力照常服务。

  已经开着的群由运行时门禁（`aiChat/availability.ts`、`antiRaid/adDetect.ts` 的 `buildAdCandidate`）一并停摆，不让 Worker 拿着读不动的配置反复崩溃。结论**连同失败一起**按进程缓存：这道判定挂在每条群消息的门禁上，不缓存失败就是每条消息一次 `readFileSync`；代价是修好文件要重启才生效，与四份 loader 的单例语义一致。

  唯一无条件读配置的地方是 Disk I/O Worker 的启动恢复（要拿贴纸白名单对账 `memory/stickers/`），它必须在读不动时**整体跳过对账**——绝不能退化成空白名单，那会把不在白名单里的持久化文件当孤儿删掉。
- `config/whitelist.json` 与 `config/blocklist.json` 不属于上一条的可选配置：前者决定同步鉴权与自己人保护，后者是静态封禁安全边界，两者都必须在联网和 Worker 创建前严格加载，缺失、未知字段或非法 ID 一律拒绝启动。白名单只在实际变化时由 `/white`、`/permission` 原子全量重写，成功落盘后才发布新的主线程缓存；读路径始终只查这份内存副本。启动读取同时记录文件 SHA-256，命令每次整份重写前复核原始字节；发现进程外编辑或文件不可读就拒绝覆盖并让 update 失败，禁止用旧缓存静默抹掉人工变更。

  静态黑名单只读，与 `memory/blocklist/blocklist.json` 的动态层在内存中取并集，`/unblock` 不得移除静态条目。
- **只有整个进程都离不开的凭据才能在模块求值期 `requireEnv`**（`TELEGRAM_BOT_TOKEN`、`SUPER_ADMIN_USER_ID`）。只服务于某个按群 opt-in、缺省关闭的可选功能的密钥必须走 `optionalEnv`：`packages/infra/config.ts` 几乎被所有入口路径 import，在那里抛错等于进程还没开始拉取更新就退出、systemd 进入重启循环，copy、抽奖、入群验证、黑名单全部离线——只因为一个默认就没开的功能缺了 key。

  两把 AI 密钥都属于后者，**变量名一律以所服务的功能打头**（`AI_CHAT_GEMINI_API_KEY`、`AD_DETECT_DEEPSEEK_API_KEY`）：读 `.env` 的人要能一眼看出「缺这一把会瘸哪个功能」，而同一家供应商日后完全可能同时服务两个功能，按供应商命名到那时就再也分不开了。缺 `AD_DETECT_DEEPSEEK_API_KEY` 时 `/ad_detect enable` 直接拒绝、已经开着的群也不再投递待检消息；

  缺 `AI_CHAT_GEMINI_API_KEY` 时 AI Worker 根本不启动、`/ai_chat enable` 与 `/switch_mood` 直接拒绝、已经开着的群也不再投喂消息与触发。两把密钥职责不重叠、互不回退：Gemini 只服务 AI 闲聊 agent，DeepSeek 只服务广告检测。

  **日语翻译同理，唯一判定入口是 `packages/copy/availability.ts`**（`g-auth.json` 可用 + 本群 opt-in），`/ja_copy` 与自动复读的 ja 变换都必须走它：这条线的降级是**静默**的——`translateToJapanese` 失败只返回 null，调用方原样发出未翻译的原文，群里看到的与「翻译服务抖了一下」完全不可区分，一次配置事故能这样连续伪装好几天。命令路径点名 `g-auth.json` 并拒绝，自动路径退化成普通复制，都不允许「假装翻译过」。

  **AI 闲聊的「此刻跑不跑」只有 `packages/aiChat/availability.ts` 一个判定入口**（凭据 + 本群 opt-in 的合取），新增调用点必须走它：把这个合取拆开写在各调用点，迟早有一处只判了本群开关——落在启动 hydrate 上就是数据损失，因为那条路把「本群没开」当成删除磁盘记忆的依据，而没有凭据时每个群看起来都是关的。

  **因此凭据缺失时 `hydrateAiMemory` / `hydrateStickerCatalog` 必须整体早退、一条都不删**，`memory/` 里的快照要原样留到 key 补回来为止。
- **「谁都没开」才允许降级；「已经开着」一律拒绝启动。**`state.json` 里的 `isAIChatEnabled` / `isAdDetectEnabled` / `isJATranslationEnabled` 是管理员明确按下的开关，把它悄悄降级成「静默不干活」，外部看到的就是机器人从某次重启起再也不理人，而唯一的痕迹是一行没人在看的日志。

  因此 `packages/app/featurePreflight.ts` 在 `loadState` 之后、Telegram 客户端与任何 Worker 之前核对一次：凡是还有群开着的可选功能，其凭据与部署配置必须齐备，缺了就带着群 id、缺失项与关掉它的命令名抛错，由 `ApplicationLifecycle` 的失败路径释放实例锁。位置不能挪到 `loadState` 之前（读不到群状态）或 Worker 之后（失败时要释放的资源就不止实例锁了）。

  一次只报第一个坏掉的功能：三个同时坏的概率远低于「照着第一条改完再重启」，堆在一起只会让真正要修的那条更难认。

### 数据根与后台任务

- `state.json`、`bot.lock`、`logs/` 与 `memory/` 全部从统一运行时数据根派生；生产缺省使用项目根目录，测试 preload 在任何生产模块 import 前注入逐隔离体的临时根，让真实文件 I/O 也不可能读写生产缓存。
- 命令菜单、`bot.init()`、Worker hydrate 与 acknowledgement-safe runner 就绪后，才启动低优先级群标题维护；标题 owner 当前最多并发 15 个 `getChat`，限制历史回填在共享 throttler 中造成的队头阻塞，并接受生命周期的 quiesce/abort 信号。

### 出站请求与消息安全

- 通用 JSON API 请求只允许访问 `JSON_API_ALLOWED_ORIGINS` 明列的 HTTPS origin，并禁用 redirect；新增调用方必须显式扩充白名单。Telegram 头像爬取使用独立入口与 Telegram 自有资产域后缀 allowlist，但复用同一套「HTTPS、无凭据、标签边界匹配」URL 策略并同样禁用 redirect；不得误接到 JSON allowlist，也不得恢复成任意 HTTPS 图片。
- 出站消息一律不设 `parse_mode`：用户昵称与消息内容只能作为纯文本参与拼接，不得有机会被解析成格式或链接。需要富文本时由调用方按段拼好文本、自行给出 `entities`（偏移按 Telegram 的 UTF-16 code unit 口径，等价于 JS `String#length`；长度为 0 的实体会让整条消息被拒收）。新增发送路径不得改用 `parse_mode` 绕开这条约束。

<p align="right"><a href="#快速导航">↑ 返回快速导航</a></p>

## Worker 与状态所有权

### 线程与状态归属

- 主线程持有 Telegram runner、Worker 监督句柄，并由 `StateStore` 独立维护 `state.json` 的内存镜像、latest-only 原子写、有限失败重试和退出 flush。有限重试耗尽是 fatal durability failure，必须停止 runner；不得继续确认 update。
- AI Worker 独占群聊记忆、回复准入、媒体描述流水线、群心情和贴纸目录生成的运行时状态。
- Anti-Raid Worker 独占验证/锁定状态机和对应计时器；主线程只持可恢复镜像。
- Disk I/O Worker 独占日志、AI 记忆、贴纸目录、运势和待验证数据的持久化，在单一 Worker 线程内串行读写这些共享目录；`state.json` 是明确的例外，由主线程 `StateStore` 异步维护。业务 Worker 不直接写共享目录。
- 长期 Map、Set、队列和 timer 必须由对应 `packages/cache/` 模块与业务生命周期模块共同给出容量、清理和 Worker 重建语义。
- **缓存的线程归属由目录名声明，并由门禁按真实模块图核对**。`packages/cache/` 的第一层就是这份状态的 owner 线程：`main/` 只属主线程，`workers/aiChat|antiRaid|diskIO/` 各属一条 Worker 线程，`perThread/` 是「每条线程各持一份、彼此无关」的状态（Telegram 客户端、部署配置单例、自发消息登记）。

  跨线程只传消息、不共享内存，因此**一份只属于某条线程的状态被另一条线程 import 就是错的**：Worker isolate 拿到的是同一份代码的另一个实例，写进去的东西对面永远读不到，静态上完全看不出来，运行起来只表现为「缓存莫名其妙不命中」。`bun run check:conventions` 从四个线程入口（`index.ts` 与三个 `*Worker.ts`）算运行时 import 闭包（`import type` 与 `new Worker(new URL(...))` 都不算边）逐个核对，违例时打印完整引入链。

  唯一豁免是 `packages/cache/main/diskIO.ts`——`infra/logger.ts` 静态依赖 `infra/diskIO.ts` 的 `relayLogMessage`，而四条线程都要能记日志；Worker 侧那份恒为初始值、从不读写，理由见该文件模块头注。
- 业务 Worker 与独立 Disk I/O 宿主都把同步 `postMessage` 拒绝统一收敛为显式失败；请求型投递立即清理 waiter/timer，日志只退回 console，关键业务投递触发 fatal。Disk I/O 运行时恢复是一整段不可分割的握手：load 成功后，各领域必须只用本代际的 scoped transport 按登记顺序重放并等待全部异步工作，再按 FIFO 排空恢复窗口的有界业务缓冲，最后才可公开 writable；

  listener 的 `false`、throw、reject、超时或 scoped post 拒绝都必须终止当前代际并 fatal。旧代际 listener 的迟到结算不得写入或激活新实例。需要确认处理与落盘边界的调用方必须把 `false` 当作失败，不能确认对应 Telegram update。

### 状态机契约

- 状态机的 `State/Event/Effect/Transition/Decision` 契约统一由 `packages/types/states/` 持有，`packages/states/` 只实现无 I/O 的纯状态转移；解释器和 cache 直接依赖前者的类型。

  **形态分两种，按被判定对象有没有需要持久化的离散状态来选**：`verification`/`lockdown` 有（PENDING/ACTIVE 这类状态要存进 Map、被后续事件引用），走 `transition(state, event) → {next, effects}` 的单机形态；`replyAdmission`/`adDetectAdmission` 没有（判定吃的是调用方算好的标量，容器与计时留在运行时模块里），走一组纯函数的形态。

  把后者硬塞进单机形态，状态对象里会同时出现「我这一条」和「全线程一共多少」，两者生命周期完全不同，反而更难读。
- **私密模式的解锁公告只在真的公告过封锁时才发**（`LockdownState.announced`）。`RESTORING` 有两个入口：正常到期/手动解除（来自 `ACTIVE`，公告过）与 `setChatPermissions` 抛错后的补偿对账（`applyResult(!ok)`，从未公告过）。少了这面旗，后一条路恢复成功时会往群里发一句「限制解除」——而那个群从头到尾没收到过封锁公告，读起来是句没头没尾的话。

  `announced` 由 `ACTIVE` 一路带到 `RESTORING`，也带过 `RESTORING ──再次超阈值──> ACTIVE` 这条回头路（那一步不重发封锁公告，因此不能在那里重置成 true）。它只活在内存里、不进 `state.json`：持久化记录的形状是 `{phase,intentId,originalPermissions,expiresAt}`，为一条公告文案改盘上格式不划算，`adopt` 时按 phase 取最常见的那一侧。`reportUnlock` 与公告是两件事，任何一条路都照发——主线程要据此清掉持久化记录。

### AI 闲聊运行时

- `/switch_mood` 采用主线程 request/waiter 与 AI Worker 回执握手。主线程必须先登记 waiter 再投递，并在超时、Worker 崩溃、放弃重启和停机时统一结算；请求携带绝对截止时刻，AI Worker 必须在重抽这一副作用之前拒绝已经过期的积压请求。只有 `moodSwitched` 回执能宣称重抽成功；后续 Telegram 成功回复发送失败不得被改写成「重抽失败」。
- AI chat invalidate 是可等待的取消边界：每个群首次接纳 generation-sensitive 工作时取得本 Worker isolate 内永不复用的唯一 epoch；invalidate 同步删除当前 epoch、abort 旧代并清空未开始任务，再等待该 epoch 下已登记的回复轮、限频提示、媒体描述与记忆压缩 settle，最后按 request ID 回 `chatInvalidated`。

  **这个等待必须有上限**（`AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS`，且明显小于主线程那道 `AI_CHAT_INVALIDATE_TIMEOUT_MS`）：登记进来的任务并非都收得住 abort——记忆压缩与媒体描述那两条链拿不到 `AbortSignal`（`requestGeminiResponse` 不接受），重试间隔加请求超时最坏能跑几分钟。

  无上限地等，一次「`/ai_chat disable` 撞上镜像块轮转」就会让主线程先超时 reject，而那个异常会逃进 grammY 中间件：这条 update 判失败、最终 offset 被扣住，重启后 Telegram 重投同一条指令。到点降级放行并记一行错误日志，不影响正确性——这些任务全部按 generation 自检，失效之后跑完也不会再写任何东西。迟到任务只做无副作用 epoch 对账，条目回收或群重新启用都不能让旧 token 复活；epoch Map 因此只随当前活跃工作增长，不保留历史群。

  主线程必须同时等该回执与记忆删除 durable 才能宣称 `/ai_chat disable` 完成。Worker 崩溃、放弃重建、投递失败、超时或停机都必须 reject waiter。
- AI 回复只把成功的文字、贴纸、反应和图片计入统一动作预算；模型提示上限为 8，执行侧硬顶为 11。贴纸、反应与生成图片各最多成功一次；其它动作工具不设单工具调用上限。贴纸包查看和 Google Search 分别保留独立查询上限，所有自定义函数调用另有整轮防循环硬顶。仅在零成功动作时，最终正文才经 `send_message` 兜底；所有有意展示的文字必须由模型显式调用该工具。

  并发满载后排队的直接触发，在补跑时被限频闸拒绝必须停在队首、不得继续消费队列：限频只看该群窗口内的轮数、与是哪一条触发无关，第一条被拒就意味着后面每一条都会被拒，而被拒时并发计数不增长——继续往下走就是在同一个同步 tick 里把整队 @ 提及/回复全部丢弃，那些人一句回复都收不到。
- AI 回复的准入是两道独立的闸，中间隔着「入队等待补跑」这个不定时长的中间态：并发闸（`admitTrigger`）在触发到达时判，限频闸（`admitRound`）在真正开一轮前判 5 分钟滑动窗口。

  **队列非空时即使有空并发位也一律入队**：队列是 FIFO 的，让新触发插到已经等了一轮的人前面就把这个语义整个反过来了——限频窗口一放开，先跑的会是刚到的那一条，而队里那些人已经等了几分钟。

  **队列必须有一条不依赖轮次结束的推力**：常规排空只发生在轮次的 `onFinished` 回调里，而限频闸拒绝时那一轮根本没建任务、也就永远不会有那次回调；在途几轮各自结束后就再没有人碰这个队列，最多 `REPLY_TRIGGER_QUEUE_MAX` 条 @提及连同它们的快照（正文片段、图片引用）会无限期扣在内存里，直到某次无关触发恰好完整跑完一轮。因此推力有三处：轮次的 `onFinished`、**新触发入队之后立刻试的那一次**，以及 AI Worker 维护节拍的兜底排空（`drainPendingReplyQueues`）。

  入队后那一次不能省——上一批排空撞上限频闸停下之后，这个群就停在「零在途 + 非空队列」上，此后每条新 @ 提及都只是继续入队，队首那些人要一直等到 30 秒的维护节拍才轮得上。三处推力都**只在窗口确实有余量时才推**（`drainReplyQueueIfWindowAllows`），窗口仍然满的群直接跳过——空转一次就会发一条限频提示（自带 60 秒冷却），等于每分钟往群里刷一句。撞满窗口的群里轮次还在一轮接一轮地结束，漏掉任何一处的闸都不是偶发空转，而是整个饱和期每分钟刷一句。

  **溢出提示的补发必须与推队列分开两条路径**（`flushOverflowNotice` 与 `drainReplyQueueIfWindowAllows`）：`enqueueOverflow` 欠下的那条提示是欠着群成员的一句话，窗口满不满都得发；写在同一个函数里的话，给推队列设闸会连提示一起跳过，不设闸又会把上面那条刷屏放回来。先入队再推，顺序仍是先来先跑。
- 白名单贴纸包的目录对账不能只在 Worker 收到 `init` 时跑一次：`generatePackCatalog` 在 `getStickerSet` 失败时是整包放弃的，而进程按 systemd 托管可以连跑几周——首次部署（`memory/stickers/` 为空）撞上一次几秒的网络抖动，`catalogs` 就永久为空，`view_sticker_pack` 与 `send_sticker` 两个工具对所有回复返回 null。

  维护节拍因此按 `STICKER_CATALOG_RETRY_INTERVAL_MS` 重试**目录为空或整包简介缺失**的包（`retryIncompleteStickerCatalogs`）；正常跑起来之后每轮只是一次判空，不打任何请求。间隔取分钟级而不是跟着维护节拍走：包名配错这类永远好不了的情形下，每次重试都会跟着记一条错误日志。

  **单枚贴纸的描述失败记录（`failedEntries`）同样只能是带 TTL 的负缓存、不能是永久闩**（`STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS`）：`getStickerSet` 成功但视觉端点整段不可用（配额耗尽、密钥刚轮换、媒体任务饱和）时整包每一枚都会进这张表，永久闩死的话上面那道重试虽然每轮都正确选中这个包，`generatePackCatalog` 却把每一枚都原地跳过，目录永远填不起来——与它要修的「整包永久为空」是同一个结局。

  这条与 `failedPacks` 用 `STICKER_SET_FAILURE_RETRY_MS` 做负缓存是同一个理由，两级失败记录不得只有一级会自愈。

### AI 提示词与转录

- AI 回复的联网查证说明按本轮搜索进度三态切换：尚未搜索时讲判定标准与「先查证再行动」，已搜索且仍有额度时改讲结果使用纪律与缺口补搜，额度耗尽时保留结果使用纪律并给出查不到时的收口方式。三态共用同一份结果纪律——结果与既有认知冲突时以结果为准、结果里没有的具体信息不得凭记忆补全——任何一态都不得省略；模型可见提示必须声明 Google Search 不计入统一动作预算，避免模型为省动作跳过查证。观测到服务端搜索之后的工具轮改用更低的采样温度；搜索与该轮首次成文发生在同一次请求内，那一轮无法预知，仍按常规回复温度生成。
- AI 回复的初始 Gemini 输入必须保持一个 `user Content` 下的三个有序 `text Part`：只读参考记忆、只读当前会话、本轮回复任务。每段只由模型可见的首尾标签加一行段首职责标注包围；防注入总规则（数据 vs 指令、伪造边界无效、不暴露内部结构）统一只在 `systemInstruction` 声明一次，不逐段重复。工具调用后的历史再按真实 `model/user` 角色追加，不得把参考资料伪装成历史对话轮次。

  系统提示词只通过 `GenerateContentConfig.systemInstruction` 独立字段发送，不得拼入普通对话 `contents`。
- 群聊转录的行内标注（回复引用、转发来源）由 `packages/consts/aiChat/prompts/transcript.ts` 的共享模板同时生成拼装文本与提示词说明里的占位形态，两侧不得各自手写同一格式；转发归属按标注层级区分：回复标注外层属于当前消息本身，内层属于被回复的原消息。机器人自己动作的记号（`（发了一枚贴纸：…）`、`（…生成并发送了一张图片：…）`）同样出自这份模板，而且**只由执行侧在动作真正落地之后写入**：它是「这个动作确实发生过」的唯一凭据，模型只能读到，绝不能自己产出。

  生图撞上群冷却时模型有概率不说「发不了」，而是照着转录里见过的形状用 `send_message` 打一段出来——群友收到一条声称配了图、实际什么都没有的消息，记忆里还会留下一条假的动作记录，下一轮它自己也会当真。提示词里的禁令只是概率性的，因此 `send_message` 执行侧硬拦截一次，并让模型改用自己的话说明这次发不了。

  **拦截必须锚定模板的整体形状而不是裸短语**（`SELF_ACTION_TAG_PATTERNS`：记号出现在一对全角括号里、紧跟 `：` 或收尾的 `）`，中间只允许一小段没跨过 `）` 的前缀，好覆盖模型把「参考素材」仿写成「参考上传的素材」这类改动）。裸子串是不行的——「发了一枚贴纸」「生成并发送了一张图片」本身是日常中文，群友问一句「你刚刚生成并发送了一张图片吗？」，模型照常作答就会被拒，而本轮兜底文本走的又是同一个执行器、会被再拒一次，结果是对着一条 @ 提及完全沉默。

  三处（执行侧写入、提示词占位、拦截判定）共用同一份字面量，任何一处手抄都会让凭据失效。多层回复链的逐跳格式、转发来源和 `[仅回复快照]` 标记也必须复用该领域模板；只有至少两层关系才向回复任务追加链路，快照链尾必须明确原消息已不在逐字转录中，不得暗示存在可供模型查阅的完整原文。

### 入群验证与终态处置

- Anti-Raid 对关联频道评论区的直属评论和楼中楼回复采用同一豁免语义；评论关联缓存只保存消息 ID 与观察时间，不把已无行为差异的来源标记泄漏进状态机。只有关联频道讨论组的评论线程才是候选：`message_thread_id` 同时也出现在论坛（topics）群的每一条话题消息上，必须用 `is_topic_message !== true` 把论坛话题排除，它们一律走普通待验证语义，不触发 barrier 加投与关联频道探测。

  冷缓存的 `message_thread_id` 只是异步确认候选：查询落定前先按普通待验证消息处理，仅在确认 `linked_chat_id` 且状态对象/代际仍一致时撤销；查询失败 fail closed 并允许后续重试。
- 真人的入群验证只接受本人点击：Worker 必须以可信的 `callback_query.from.id === callback_data` 目标 ID 计算本人关系，不能接受调用方直接声称。即使点击者在 `config/whitelist.json` 中，也不得替真人通过；唯一代点例外是当前待验证快照明确 `isBot === true` 且点击者在该白名单中。无状态、已终结或目标不匹配的点击只能应答失败，不得改变验证记录。
- 终态处置（超时/刷屏踢人）执行 `kickChatMember` 前必须用 `probeChatMembership` 现查：确认仍在群才踢，确认已离群就直接结算且不发错误战报，查询失败则不做破坏性成员操作、保留终态进入既有退避。私密模式下由刚到达的 join update 同步产生的 `kickMember` 已由该 update 证明人在群里，不重复付一次查询。终态处置失败后按指数退避重试到上限，记录不因重试耗尽被删除——删了就等于把没处置的成员当成已完成。

  固定间隔不行：机器人是管理员却没有封禁权限、或目标本人就是这个群的管理员时，这条重试永远不会成功，一次刷群留下的每个未验证成员都会各占一个永久的短周期循环，不停打删消息 + 踢人并往 `logs/` 刷同一行报错，Worker 重建与进程重启后还会照单重新武装。退避而不是放弃：管理员补上权限后最迟一个上限周期内自愈。
- 私密模式秒踢先进入不持久化的 `kickPending`，该状态对象是同批不可逆动作的执行 token。删除公告等前置 `await` 之后、真正调用 `kickChatMember` 之前必须复核条目仍持有同一对象，复核与 API 调用之间不得再有 `await`；权威管理员豁免、离群、新一代入群记录或 chat teardown 替换/删除对象后，旧批次必须停在这里。API 请求同步发出时才置 `executionStarted`：此前到达的豁免转成 `exempt`，此后到达则只能保留诊断；

  请求结算且 token 仍匹配时才转 `kicked` 并从结算时刻开始去重窗口。不得用“dispatcher 已写入 `kicked`”冒充 Telegram 动作已经执行。

  **撤销入群计数只认真正计过数的那一次**：`kickPending` 单独记 `countedJoinAt`，只有 `joinCreatesNewRecord` 为真、调用方确实 `recordJoin` 过的那次入群才填。

  踢完之后真的重新申请入群会补建一个 `kickPending`，但那一路状态已存在、不会再计一次数，拿它的 `requestedAt` 去撤等于按值删掉队列里第一个相等的时间戳——同一批 `new_chat_members` 在同一 tick 处理、时间戳完全相同，删掉的会是另一名合法计数成员那一格，滑动窗口因此差一个而不触发私密模式，正是这个计数要挡的事。
- 那条诊断（`logUncancelableKickExemption`）必须走 `logger.error`：Worker 只把 error 级别的日志信封中继给主线程，warn 只留在本线程的临时 stdout 里，进不了 `logs/<day>.json`。它是「一个管理员/白名单成员被误踢了、请人工拉回来」的唯一线索，事后翻日志看不到它，那个人就一直在群外。
- 验证提醒按成员只有一个投递 owner，发送失败有界退避。`reminderMessageId` / `replyReminderMessageId` 至少一个成功回填是超时踢人的前置不变量；从未落地时只续窗补发。

  **但续窗必须有尽头**：入群后超过 `VERIFICATION_REMINDER_UNDELIVERED_MAX_MS` 仍一条都没落地，就按普通超时结算（踢人本就只踢不封，人随时能重进）。无限续期的代价是每个入群者留下一条不朽记录——某个群 `sendMessage` 持续失败（论坛 General 话题被关闭、机器人被禁言却仍保有限制成员权限）时，那些记录常驻待验证表与主线程镜像，每 90 秒重写一次当天文件，而 `messageIds` 还按该成员的发言数继续增长。

  同理，`messageIds` 有 `VERIFICATION_TRACKED_MESSAGE_IDS_MAX` 这道上界：常规窗口里到不了（刷屏第 46 条就同步转成踢人），它只兜这条退化路径，越界丢最早的那条。

  **入群公告不进这条队列**：它单独存在 `announcementMessageId` 里，不参与截断。混在一起时上限一满第一个被挤掉的就是它（它恒为最早入列的那条），而除了处置路径没有任何地方会再删它——恰恰在提醒发不出去、记录被反复续期的那条退化路径下，成员足以发够几百条把上限撑满，机器人自己制造的那条公告于是永远留在群里。处置时先删公告再删追踪到的发言。恢复时尚无 reminder ID 的当前格式快照复用同一 owner，状态替换、离群、teardown 和 Worker 终止均会撤销它；这里是未成功发送提醒的业务状态，不是旧格式兼容分支。

- 冷缓存评论区确认按 `chatId:userId` 只有一个可更新 owner，并受 `THREAD_COMMENT_CONFIRMATION_MAX` 全局背压与 `LINKED_CHANNEL_FETCH_TIMEOUT_MS` 结算上限约束；满载时保持普通待验证语义。群停管、adopt 或停止删除 owner 后，迟到回调必须以对象同一性止步，不能重写 recent comment。

  若 owner 覆盖的那条普通派发恰好把同一 `pending` 推到 `flood` 终态，只有在 `executionStarted !== true` 时，确认结果才可撤回该终态并发布 tombstone；不可逆处置一旦开始就不再假装能够取消。
- `kickPending` 的 Telegram 请求结算不等于踢人成功：只有 `kickChatMemberWithOutcome === "kicked"`，或随后权威成员探测确认目标已离群，才能派发 `kickSettled`。`forbidden` / `failed` 必须清掉本次 `executionStarted`、保留同一 token 并按终态退避重试；状态被豁免、停管或新一代记录替换后，迟到结果与 timer 都不得继续处置。
- `messageIds` 的容量约束覆盖每一个写入口，包括普通消息、重复入群公告与 original/reply reminder 的迟到落地；所有入口必须走同一个有界追加 helper，不能只在普通消息路径截断。

### 刷屏禁言与自身权限缓存

本节依次说明 [计数与执行边界](#计数与执行边界)、[命中抑制与并发安全](#命中抑制与并发安全)、[动手前的权限闸](#动手前的权限闸)及[机器人自身权限镜像](#机器人自身权限镜像)。

#### 计数与执行边界

- **刷屏禁言的计数与执行全在 Anti-Raid Worker，主线程只做同步门禁 + 一次尽力而为的 `post`**：同一成员在同一**超级群**内一分钟发言达到 `FLOOD_MESSAGE_LIMIT`（当前 21 条）即禁言 `FLOOD_MUTE_DURATION_MS`（当前 5 分钟）。只认超级群是因为 `restrictChatMember` 按 Bot API 的定义只对超级群有效，普通群里连计数都是白占内存——攒满一整个窗口只换来一次注定失败的请求和一行误导性报错。

  主线程侧（`packages/antiRaid/floodControl.ts`）只判三件它独有的事实：是不是超级群、发言的是不是真实用户（频道马甲与匿名管理员没有可禁言的成员身份，`restrictChatMember` 只认真实用户，而皮套底下是谁 Telegram 并不暴露）、发送者是不是自己人（`SUPER_ADMIN_USER_ID` 与 `config/whitelist.json`，判定收在 `antiRaid/memberFacts.ts` 的 `isProtectedSender`，与广告检测共用同一处），随后把 `floodCandidate` 投过去。

  投递与广告检测同理走普通 `post` 而非 `postAntiRaidDurably`：窗口随 isolate 生死，为每条群消息加一道跨线程屏障换不来任何恢复能力。入群/离群服务消息不算谁的「发言」，投递入口因此排在那两条分支之后。

  窗口按「群 + 成员」记在 `packages/cache/workers/antiRaid/flood.ts`，条目数由 `FLOOD_WINDOW_MAX_MEMBERS` 按 LRU 兜住，空闲满一个窗口的条目由 Worker 的统一 sweep 节拍删除——只靠 LRU 的话，一个曾经热闹过、此刻早已安静的群会一直占着名额，把真正活跃的群挤出去。解除禁言靠 Telegram 按 `until_date` 自行到期，Worker 不排恢复计时器，因此这条处置不写任何持久化状态、Worker 重建也不需要 adopt。

#### 命中抑制与并发安全

- **命中那一刻就地置抑制位，不等禁言落地**：mailbox handler 是同步的，一次爆发式刷屏可以在第一次网络往返回来之前就把下一个窗口填满，等结果再置位就是同一个人挨两次禁言、群里挨两条公告。结论是确定性的那几种（禁言成功、目标是管理员、机器人没有限制成员权限）**保留**这次抑制——重判换不来新结果，只会重复打请求，或者每填满一个窗口往 `logs/` 刷同一行；瞬时失败（管理员身份没查出来、禁言请求失败或意外抛错）**回滚**成 0，让下一个填满的窗口重试。

  回滚与对齐真实截止时刻之前都必须按「状态对象同一性」复核条目仍是发起这次判定的那一个：`await` 期间它可能已被 LRU 淘汰或随 `deactivateChat` 清掉。

  **复核对不上时要中止的是整段处置，不只是那次回写**：`/init disable` 与停管会走 `deactivateChat → clearChatFloodWindows` 丢掉这个群的全部窗口，而机器人此刻多半仍是 Telegram 管理员——照样禁得动、也发得出话，那就是在一个本进程已经不再管理的群里把成员按住五分钟、再公开点名说一句「本天才把你禁言 5 分钟」，而这条处置没有恢复计时器、也没有任何人再为它负责（同广告判定的 `pendingAdMessages.get(key) !== bundle` 与验证处置的 `stillCurrent`）。

  代价是 LRU 淘汰恰好撞在这次往返上时少判一次刷屏，与 `FLOOD_WINDOW_MAX_MEMBERS` 写明的取舍一致。命中时把窗口整体清空是这套抑制的补充：抑制万一被回滚，也不会拿旧时间戳立刻再凑出一次命中。

#### 动手前的权限闸

- **动手前两道闸缺一不可**：先看机器人自己的权限位（下一条），再用入群守卫本来就热的管理员缓存（`freshAdminIds`，冷了才 `fetchAdminIds`）确证目标不是本群管理员，**确证不了一律不动手**。权限位那道闸是三态的，**「没观测到」不当成「观测到没有」**：确证没有才就地放弃并保留抑制位；没观测到则照常往下走、由 Telegram 的回应当裁判——镜像可能只是还没到（主线程的按需现查撞上一次 429 就会退避几分钟），那几分钟里把刷屏放过去、还在日志里写一句没有依据的「没有权限」，比多打一个注定失败的请求糟得多。

  禁言请求本身因此也返回三态（`muteChatMemberWithOutcome`，形态同 `banChatMemberWithOutcome`）：`forbidden` 是 Telegram 明确的拒绝（缺 `can_restrict_members`，或目标其实是管理员而那份缓存刚好没认出来），保留抑制位、不重打，具体原因由统一错误边界带着 Telegram 自己的说法进日志；`failed` 是限流/网络抖动，回滚抑制位等下一个满窗口。这两档正是「镜像还没到」那条兜底路径的收口——没有它，一个真的没有权限的群会每填满一个窗口换来一次注定失败的请求。

  两者不能省成「直接试一次」——Telegram 对「机器人缺权限」与「目标本身是管理员」回的是同一句 400 `not enough rights`，混着打只会往 `logs/` 塞一条把运维引向权限配置的假线索，而把群主按住五分钟的代价远大于放过一次刷屏（下一条消息会重新计数）。禁言请求带 `FLOOD_MUTE_DISPATCH_TIMEOUT_MS` 的超时信号：`until_date` 是入队前算好的绝对时刻，而请求还要过每群的限流桶；

  排到它距当下不足 30 秒时 Bot API 会当成**永久限制**，而本模块不排恢复计时器也不落盘，那就是一次只能人工解除的永久禁言。超时即放弃这次禁言（抑制位回滚，下一个满窗口重来），代价远小于此。

  群内通知只在禁言真的落地之后才发（文案断言的正是「人已经被按住了」），并在禁言解除那一刻自撤，不给群里留永久公告——这条自撤靠的是登记在册的待删表（`scheduleNoticeDeletion`），停机 drain 前由 `flushPendingNoticeDeletions` 就地兑现（**必须按「客户端 + 群」合批走 `deleteMessages`**：同一个群的删除全排在同一条限流桶里，逐条发 N 条至少要 N 秒才结算，而 drain 的预算是秒级——同群几名成员在五分钟内接连刷屏就能攒出四条公告，足以让 drain 超时，讽刺的是触发它的正是这个为了让停机更整洁才加的清理步骤；

  合批的理由与广告处置的批量删除一致，为的是**请求条数**而不是速度）；裸 `setTimeout` 活在 Worker 的 isolate 里，崩溃重建或进程重启就会把它连同公告一起丢掉，留下一条永久点名的公开公告。

  群内通知同样带派发截止时间（`FLOOD_NOTICE_DISPATCH_TIMEOUT_MS`）：它与验证的踢人、欢迎语、提醒共用同一条**按群 FIFO** 的限流队列，协同突袭里几十条公告排在前面，验证的 `kickChatMember` 就只能等它们一条条发完——未验证的突袭号因此活过 `VERIFICATION_TIMEOUT_MS`，群里反倒多出几十条点名成员的机器人消息。机器人自己的碎嘴不该把安全动作顶到窗口之后；超时的公告被丢掉时也就把那个位置腾了出来，因此那个值同时是「验证动作最多被公告挡多久」的上界。

  整段处置登记进 Worker 的在途任务集合、由停机 drain 等待结算，**但每个这类请求都必须订阅停机取消信号**（`antiRaidDispatchSignal`，权威说明在 `packages/cache/workers/antiRaid/tasks.ts`）：drain 的预算是 `ANTI_RAID_BARRIER_TIMEOUT_MS` 那一档的秒级数值，而禁言按设计能在限流桶里排上 `FLOOD_MUTE_DISPATCH_TIMEOUT_MS`（分钟级）。

  停机恰好落在排队期间时，drain 等不到结算就超时，生命周期据此拒绝确认 Telegram offset 并非零退出——重启后该条 update 被重投（其中已发生的验证踢人与通知可能重复），systemd 报单元失败。drain 到达时因此就地 abort 这些排队中的请求、并且不再开始新的处置；禁言本就是尽力而为的（到点由 Telegram 按 `until_date` 自行解除），丢一次不构成安全边界失守，与广告判定批次干脆不登记进这个集合是同一条理由。

  **这个取消信号不覆盖 drain 自己要发的请求**：公告 flush 是停机期间必须发出去的，abort 排在它之前正是为了把限流额度让给它。

#### 机器人自身权限镜像

- **机器人自己的权限位由主线程持有、按变更镜像给 Worker，「没观测到」不得折算成「观测到没有」**：`packages/cache/main/botAdmin.ts` 的 `botChatPermissions` 记 `can_restrict_members` 与 `can_delete_messages`，owner 是 `packages/infra/botAdmin.ts`，只为已 `/init enable` 的群留条目（否则光是被拉进一堆群就会凭空长出一张表）。

  观测只可能发生在主线程——`my_chat_member` 更新（机器人被任免、**或管理员只是改了它的某一项权限开关**时 Telegram 都会送达）与按需 `getChatMember` 现查——而踢人、禁言、删消息都在 Worker 里执行，因此每次确证或作废都经 `packages/cache/main/botAdmin.ts` 的反向注册单槽位广播成一条 `botPermissionsChanged`（infra 不得静态依赖 Anti-Raid 业务模块），Worker 侧只留一份只读快照（`packages/cache/workers/antiRaid/botPermissions.ts`）。

  收到别人的 `chat_member` 更新那一路只推得出「我是管理员」、推不出权限位，因此既不写表也不广播——写了就等于把一个权限齐全的群永久判成不能动手。撤管理员、被移出群聊与 `/init` 开关切换都当场清空条目、广播「未知」并作废在途现查；作废靠代际对账，而**代际条目的存在与否同时是「有没有现查在途」的唯一依据，必须在发请求之前同步占位**，否则那一小段窗口里到达的失效会被漏掉，旧身份随后被写回表里。现查失败、被失效作废、或查回来根本不是管理员时一律给出 `undefined`。主线程侧按「这个动作现在做不了」处理；

  Worker 侧只如实转述三态，由各处置自己决定未知那一档怎么办（刷屏禁言的选择见上一条）。

  **镜像读出来的必须保持三态、不得压成布尔**：一压，「确证没权限」与「还不知道」就再也分不开，而这两者要的处置恰好相反。

  **Worker 重建与进程启动必须整表重放**（`replayBotPermissions`，排在 adopt 之前）：新 isolate 的那张表是空的，而空表按契约等于什么都做不了。

  热路径上的按需补齐（`ensureBotChatPermissions`）**必须带退避**（`BOT_PERMISSION_PROBE_RETRY_MS`）：`state.json` 记着是管理员而实际已经不是、或 `getChatMember` 持续失败时，`botChatPermissionsIn` 按约定不落缓存，没有退避就等于那种群里每条消息都换一次注定失败的现查。

  这份缓存服务全部破坏性动作的「先判后打」：刷屏禁言看 `canRestrictMembers`，广告处置的批量删除、频道马甲的漏网消息与验证超时踢人的痕迹清理看 `canDeleteMessages`——这些删除与踢人共用同一条限流队列，一场突袭里几十个注定 400 的往返会把真正的踢人顶到验证窗口之后。拦的只有确证的 `false`，`undefined` 照常发请求（同上一条的三态口径）。

  **确证没权限而跳过删除时，播报文案不得再断言「痕迹清干净了」**：那批消息还挂在群里，群成员一眼就能证伪；反过来，**「这条消息本来就不在了」不算删不动**——管理员（或本人）比超时更快手删、入群公告已被别人清掉、消息超过 48 小时，`deleteMessage` 回的都是一句 400，而把它们折进失败就是让一个权限齐全的机器人把管理员送去排查一个配置完全正确的 `can_delete_messages`。

  删除因此返回三态（`deleteMessageWithOutcome`：`deleted` / `gone` / `forbidden` / `failed`，`gone` 与 `deleted` 同样算痕迹清干净了），只有 Telegram 真的拒了权限才在公告里点管理员，其余失败照实说是几条里的几条：全有全无的布尔任一条失败即翻，「一条都删不动」同样是一句假话。广告播报索性完全不提删除——删除跑在判定线程上、排在事件回投之后，主线程压根不知道它成没成。

  Anti-Raid Worker 另有一份**群管理员**缓存（`workers/antiRaid/adminCache.ts`），两者描述的是不同对象，不共享也不互相替代。

### 身份解析与运行时清理

- 发送者用户名缓存同时维护「归一化 username → identity」与「sender ID → 当前 username」；改名、去名、换绑和容量淘汰都在同一 owner 原子更新双向关系，解析器拒绝不一致别名。
- 匿名管理员本人仍按管理员身份豁免，但不能作为“可归属的管理员邀请人”为新成员继承邀请豁免。匿名管理员以当前群身份发言时，可见发送者必须保留当前群 identity，供 copy/头像爬取复用；破坏性的成员操作必须拒绝把当前群 identity 当作用户目标。

  **`/block` 与 `/unblock` 额外接受裸用户 id**（`USER_ID_ARG_PATTERN`，且必须过 `Number.isSafeInteger`）：处置的对象本来就是一个 id，而用户名可以被释放后由别人重新注册——同 `/steal_icon` 那条现查要求，只是这两条命令不可逆，代价更大。id 那条路查不到缓存**不算失败**（`resolveIdTarget` 退化成只带 id 的最小身份），只影响回执标签。

  裸 id 逐命令 opt-in（`acceptUserId`），不做成全局行为：`/copy` 与中文动作命令要的是有名字、有头像的身份，拿一个没见过的裸 id 只能复读出一具空壳。

  **回复目标与参数同时给出、又指向不同的人时必须报错，绝不静默取一**：id 那条路被引入的场景恰恰是「对着别人贴出的 id 动手」——管理员看到群里有人发「请封 123456789」，对着那条消息点回复再发 `/block 123456789`，而静默优先取回复目标的话，被永久拉黑并在每个托管群带 `revoke_messages` 封禁的是贴出这串 id 的同事，回执里显示的正是那位同事的名字，读起来像一次成功确认。参数解析不出目标时同样按冲突报错，不再说「这不是合法用户名」：那句话会让人以为参数被忽略、回复目标生效了。

  两者指向同一个 id 时是无害的重复，照常放行。
- 裸**会话** id（频道/群的负数，`CHAT_ID_ARG_PATTERN`）单独一个开关，**只有 `/unblock` 打开**（`acceptChatId`）。频道马甲的 id 本来就会进黑名单（`/block` 回复一条频道消息、广告检测命中 `sender_chat`），而划掉它此前只有回复消息与 `@username` 两条路：前者在广告检测删掉原消息后就没了，后者要求频道有公开 username 且未被 `USER_CACHE_MAX` 挤出缓存——两条都断掉的条目会永远留在名单上。

  反方向的 `/block` 必须继续拒绝负数：把粘错的会话 id 当目标会改去封整个会话身份，而那条命令不可逆；`/unblock` 是恢复方向，指错至多一次空解封。

  **负数 id 一律带 `isChannel`**（`resolveIdTarget` 在最小身份上就标好，与 `workers/antiRaid/blocklistEffects.ts` 按符号分派同源）：`/unblock` 靠它选 `unbanChatSenderChat` 而非 `unbanChatMemberIfBanned`，漏标会让解封报错记进 `failedCount`，回执变成一份关于「根本没被碰过的目标」的假战报。
- `/steal_icon` 的 t.me 主页抓取兜底**只认 `getChat(targetId)` 现查回来的 username**，不得用调用方上下文里带的那个短路掉这次查询。命令上下文的 username 来自 `reply_to_message`（可能是几个月前的消息）或身份缓存，而 Telegram 用户名释放之后可以被任何人重新注册；抓取时的页面身份校验只能证明「这个页面属于 @name」，证明不了「@name 此刻仍指向 targetId」。短路的后果是把**现任 handle 持有者**的头像顶成机器人头像，而成功提示里写的还是原目标。

  provided 值只作诊断线索进日志。
- chat runtime teardown 的三个固定 owner 回调由 `packages/cache/main/chatTeardown.ts` 持有，上层领域经 `packages/infra/chatTeardown.ts` 反向注册；`packages/infra/botAdmin.ts` 不得静态依赖 `commands/`、AI 或 Anti-Raid 业务模块。
- 成员现查本身是新的异步边界：`probeChatMembership` 返回“仍在群”后、真正调用 `kickChatMember` 前必须再次确认终态对象仍是发起查询时的同一引用，而且这次确认与 API 调用之间不得再有 `await`。否则 teardown、停管或状态替换已经取消的旧处置会消费迟到查询结果，把不再属于该终态的成员踢掉。
- `/unblock` 对命令侧“确证踢出”缓存的失效必须覆盖跨群解封的两个边界：开始前先清掉旧结局，全部 `unban` await 结束后再清一次等待期间迟到的 `/block` 回填。runner 只按 chat 串行，不同群的命令可交错；少掉后一次会让已被更晚解封的用户仍命中缓存，同日重跑 `/block` 时错误跳过成员查询与封禁。

<p align="right"><a href="#快速导航">↑ 返回快速导航</a></p>

## 持久化

### 落盘与快照契约

- `state.json` 使用最新值合并、临时文件、fsync 和原子 rename。命令开关、代理、copy 与权限/离群状态等权威变更必须等待对应 revision 依次写入主文件和 LKG 后才能反馈成功并返回 middleware；群标题等可重建元数据才允许后台最终一致保存。
- AI 记忆与贴纸目录按实体写原子快照；日志、运势和待验证状态使用可修复尾部截断的 JSON 追加文件。每批追加在成功回执前 fsync；待验证终结追加 tombstone。启动跨东京午夜时，先严格解码最新旧日文件，再以当天 active/tombstone 为更晚权威值合并并原子压缩到当天；只有发布成功才删除旧日，旧日损坏则保持新旧文件不动并拒绝恢复。稳态只保留东京当天文件，并在条数/字节阈值处收敛为 active 快照。截断修复必须按 JSON 字符串、转义与括号深度识别顶层成员边界，不能依赖对象值的收尾缩进；

  `null` tombstone 与其它基础类型都必须被视为完整的最后值。
- AI 记忆 upsert/delete 按 chat 使用运行时单调 revision。主线程持有未确认删除 tombstone，Disk I/O Worker 只有在 unlink 达到 durable 边界或删除已被更新 revision 覆盖时才回执；Worker 重建会重放 tombstone 与最新镜像，顺序不决定最终结果。一次已确认删除或 LRU 淘汰后的首份新快照必须立即写入，主线程在收到对应 durable upsert 回执前保留 revision 标记并在 Disk I/O Worker 重建后重放最新镜像。

  启动恢复以 `state.json` 为准，只 hydrate 明确启用 AI 的群，并为关闭群的残留快照安排删除。当前快照中的每条热区消息必须包含正数 `messageId`；回复链索引由这些消息重建，不单独持久化。

- `chat_member` 入群事实只有在 `flushDiskIODomain("joinLog")` 返回 `flushed` 后才能确认对应 update；投递成功不等于 durable。Worker 写失败必须把原分组放回缓冲并退避重试，不能清空后丢弃；待刷事实硬顶 1,200 条，满载必须快速失败并让尚未确认的 update 重投，不能把磁盘故障转成无界内存。群日 latest-by-user 索引最多常驻 64 份并按 LRU 淘汰，失败退避最多记 128 份；两者都可由权威文件/下一次重试安全重建，绝不能当成持久化成功的证据。

  Telegram 重投的完全相同事件由磁盘恢复出的索引在追加前跳过。`/batch_kick` 读取的是 `[since, now]` 滚动窗口，跨东京午夜时合并两个群日文件，而不是截成“当天”。

### 黑名单与广告检测

本节依次说明 [黑名单权威名单与 block 命令](#黑名单权威名单与-block-命令)、[广告检测的准入、判定与处置](#广告检测的准入判定与处置)、[封禁与消息撤回](#封禁与消息撤回)、[黑名单移除 outbox](#黑名单移除-outbox)及[权限恢复后的重放](#权限恢复后的重放)。

#### 黑名单权威名单与 block 命令

- `/block` 的权威名单固定在 `memory/blocklist/blocklist.json`，同目录 `removals.json` 只是未完成群级处置的 outbox，不是名单副本。黑名单是同步安全边界：写路径必须先更新主线程内存 Map（`packages/cache/main/blocklist.ts`）再投递落盘消息，反过来的话两步之间到达的入群更新会查到一个还没记上的名单，那个人就进来了。判定只读内存，不做跨线程往返——入群更新必须当场决定踢不踢。名单无自动淘汰，只有 `/unblock` 这一条人工出口；

  代码里始终不接受 `isBlocked: false` 这种墓碑记录——启动恢复的严格校验会因此拒绝整个文件，解除必须是把条目整条删掉。

  **`/unblock` 只能整文件重写**：黑名单文件是追加型的（按位置覆写结尾的 `\n}`），没有「删掉一条」的写法，因此流程是「先从主线程内存 Map 删掉这个 id，再把删除之后的**整份 Map** 投给落盘 Worker 原子重写（tmp + fsync + rename）」。顺序与 `/block` 同理不能反：两步之间到达的入群更新会查到一个还没解除的名单，那个人白挨一次秒踢。

  这也要求读回来的结构必须是**完整记录**而不是「在不在」——`blockedUserIds` 因此存 `BlockedUserRecord`，只留 `true` 的话重写会把名单里其他人的 `blockedAt` 一起抹平。重写完必须重置追加游标与 Worker 侧已知 id 集合：文件长度变了，旧游标指向的位置不再是结尾的 `\n}`，照着它继续追加会写坏 JSON。

  落盘 Worker 崩溃重建后，只要本进程解除过（`sessionUnblockedIds` 非空）就必须整份重写一次而不是补投增量——追加补不回「删除」，新 Worker 从文件读回来的那些条目还在。`sessionBlockedAt` 与 `sessionUnblockedIds` 必须互斥（拉黑时从后者删、解除时从前者删），否则同一个 id 同时挂在两张表上，重放顺序就决定了他到底在不在名单里。

  **`/unblock` 默认完整解除**：先从动态名单移除目标（若存在），再在所有 `ChatState.botIsAdmin` 的群解除 Telegram 封禁；目标不在动态名单里也照样跨群解封。命令只要求 `isCanUnBlock`，`SUPER_ADMIN_USER_ID` 仍显式放行；旧的额外 `all` 参数不再解析或兼容。静态 `config/blocklist.json` 身份必须在动名单和 Telegram API 之前 fail closed，因为命令不能改写部署配置，单独解开群级封禁只会制造自相矛盾的状态。

  **跨群解封必须走 `unbanChatMemberIfBanned`（带 `only_if_banned: true`）**：Bot API 的 `unbanChatMember` 对「当前就是群成员」的人语义是把他移出群聊——`kickChatMember` 的「只踢不封」正是靠这一点实现的，不带这个标志去批量解封，会把那些本来好端端待在群里的人一个个踢出去。频道马甲没有「成员」概念，走 `unbanChatSenderChat`，不存在这个陷阱。

  解除时还要把该 id 从 `pendingBlockedRemovals` 的在途批次里摘掉（批次因此变空就整批销账），否则 Worker 重建后的重放会拿着旧批次把刚解除的人重新封回去；已经投出去、正在 Worker 里跑的那一批拦不住（判定是主线程状态，Worker 没有副本），那一小段窗口属于已知取舍。

  **自己人不可拉黑**：`SUPER_ADMIN_USER_ID` 与 `config/whitelist.json` 在 `/block` 入口就被挡回；启动还会拒绝它们与静态配置、恢复出的动态黑名单的任何交集，`/white enable` 也拒绝仍在黑名单中的身份并要求先 `/unblock`。这不只是一组各自独立的前置检查：`runProtectedIdentityMutation` 通过主线程的 `protectedIdentityMutationQueue`，把 `/white` 的「检查成员关系 + 原子写入并发布白名单」与 `/block`、广告命中新增动态黑名单串行化。否则白名单写盘的异步窗口内仍可插入一次拉黑，让同一身份同时出现在两边并导致下次启动必然拒绝。临界区只包身份检查和权威状态变更，Telegram 副作用与后续落盘确认留在外面。

  启动恢复时任何一条记录形状不合规都整体拒绝启动：漏掉一条就等于放那个人重新进群。因此黑名单文件是唯一**不允许截断自愈**的追加型文件（`openAppendOnlyFile(..., repair=false)`）：日志/运势/待验证丢掉末尾残片不影响正确性，黑名单裁掉的每一条都是一个被放回群里的人，宁可拒绝启动、原样保留字节等人工恢复。

  id 键必须 `String(Number(key)) === key` 原样还原——`Number` 认得 `0x1f4`/`1e3`/`7.0`/`""`，它们都是安全整数却指向另一个人。文件按 `PERSISTED_FILE_MODE` 建立；`memory/blocklist/` 同时有两个 owner，权威名单只清扫自己的 `.blocklist.json.*.tmp`，不得碰 `removals.json` 的临时文件。

  落盘失败时 `/block` 的回复必须说破「没写进硬盘」：Worker 侧写盘错误只有 `console.error`，按设计不进 `logs/`。

  **落盘确认按领域收敛**：统一 flush（`flushAll`）是八个领域的合取，任何一个失败都会让整体回执变成 `flushFailed`；`/block` 只能等 `flushDiskIODomain("blocklist")`，否则某群 `memory/ai/<chat>.json` 属主不对也会让它报「小本本没能写进硬盘」，把运维引向一个其实没坏的文件。回执因此必须带 `failedDomains`，主线程据此点名真正坏掉的领域——不点名就没有任何一条进得了 `logs/`。

  **重复 `/block` 是落盘失败后的重试动作**：目标已在内存 Map 里但仍在 `sessionBlockedAt`（本进程新增、可能没落盘）时必须重投一次落盘消息并重新等确认，不能因为「Map 里已经有了」就把 `persisted` 当成 true——那会连着两次都告诉管理员成功了，而文件里根本没有这条记录。黑名单成员入群一律 ban（不是「踢而不封」）——那条只踢不封的规则是为反刷群自动踢出防误杀而设，黑名单里的每个 id 都是管理员亲手写进去的。

  「机器人在这个群可以干活了」这个合取（**是管理员 && 已 `/init enable`**）成立时必须补一次清扫（`sweepBlockedMembers`）：拉黑时本群没权限、连坐封禁跳过了它，入群秒踢又只对之后的入群更新生效，对早就坐在群里的人无效。触发点是合取本身而不是某一条更新——两边任意一边变更都算，因此两种上线顺序都会扫到。

  **边沿只能消耗在落地那一刻，不能消耗在投递那一刻**：`recordBotAdminStatus` 每次确证管理员身份都调一次 `sweepBlockedMembers`，「这个群扫过了没有」由 `blocklistSweepState`（`packages/cache/main/blocklist.ts`）按 Worker 的 `blockedMembersRemoved` 回执记账——只有 `complete` 才记 `sweptAt`。把它挂在身份变更的边沿上，一次限流失败就等于那些人永久坐在群里。

  重试同样挂在身份观测上，而那类更新每条入群都会来一次，因此必须有 `BLOCKLIST_SWEEP_RETRY_INTERVAL_MS` 这道退避闸；`/init` 开关与撤管理员/离群都经 `forgetChatBlocklistWork` 清掉该群的清扫进度**并丢弃在途批次**，重新接管后重新欠一次；

  这一步必须排在状态落盘**之前**——停管是 Telegram 已经告知的权威事实，不会因为 `state.json` 没写成而撤销，而落盘一旦拒绝，进程随即退出、盘上 `botIsAdmin` 还是 `true`，启动恢复那道过滤兜不住，那批注定失败的处置会在每次重启与每次 Worker 重建时原样重投。

  同理，`isBotAdminIn` 的「查不到就当不是管理员」只覆盖 `getChatMember` 本身：状态落盘失败必须原样上抛，折算成「不是管理员」会让调用方跳过整条入群守卫（这一批 `new_chat_members` 不开验证窗口、不被消息跟踪、超时也不踢），而诊断把锅指向 Telegram API、下一次调用又从内存读到 `true`，现象根本复现不了。

  **`sweptAt` 是闩锁，必须有打开它的路径**：`requestBlocklistResweep`（`packages/infra/blocklist/sweep.ts`）在「这个群里还留着黑名单成员」的信号上把它置回 null——`/block` 在某个群 `banChatMember` 失败、秒踢批次回执 `complete: false` 都算。没有它，扫过一次的群里那个人会待到进程结束：秒踢只对之后的入群更新生效，补扫又被闩锁挡住。

  请求时若有批次在途，只能记 `resweepRequested` 而不能直接改 `sweptAt`——那批的 `complete: true` 回执可能晚于请求到达，会把 `sweptAt` 写回去，请求就丢了。秒踢失败触发的重扫必须带退避（黑名单账号可能反复回流，每次失败都立即重扫就是 O(名单长度) 次探测的请求风暴）；退避还要按该群**连续没落定的补扫次数**线性放大到 `BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS`，`complete` 回执把计数清零。

  **这个计数必须由每一条没落定的路径推进，不只是回执那一条**：`sweepBlockedMembers` 的两条降级路径（登记不进 outbox、投递边界抛错）之后不会再有回执来替它们推进（claim 已清空，迟到的回执走的是不动计数的重扫请求），漏掉就等于执行 owner 持续抛错（Worker 不可用、outbox 满）时每一轮都按基础间隔重来、永远走不到上限，而每一轮还要烧掉一个 outbox id 加一行错误日志。

  固定间隔兜不住「永远封不掉」的目标——目标本人就是这个群的管理员、或机器人是管理员却没有封禁权限时，每一轮补扫都注定失败，那就是这个群在进程存活期间每 5 分钟重扫一次整份名单，而它们与验证超时踢人共用同一条限流队列。上限同样不能去掉：闩锁必须始终有打开的路径，权限修好之后不能等到进程重启才重扫。

  **「权限不够」必须与其它失败分成两档**：退避拉长的仍然是按时间重试，而缺封禁权限时重试多少次都一样，只是把同一条报错再刷一遍、外加一次 O(名单长度) 的重扫。`banChatMemberWithOutcome`（`packages/infra/telegram/actions.ts`）据 Telegram 的回应把它单独识别出来——403 一律算，400 只认点名 `not enough rights` 的那一句（同为 400 的「用户不存在」不能算，否则一批本可重试的处置会永久挂起等一个不会到来的授权）；

  单个 id 命中后立刻结束剩余尝试，回执带 `permissionDenied` 回主线程。

  **但 `forbidden` 本身还混着两种成因，必须再分一次**：Telegram 对「目标本身是这个群的管理员」返回的也正是那句 400 `not enough rights`，混进 `permissionDenied` 就意味着一个封不掉的管理员把**整个群**的清扫永久闩死——此后补扫早退、重扫请求被拒、每次 Worker 重生跳过重放，而唯一的解锁边沿是「机器人的封禁权限变了」，那件事根本不会发生。

  Worker 侧因此在 `forbidden` 之后用 `probeChatAdmin` 对这个 id 确证一次身份：确认是管理员就**只结算这一个 target**（记一条点名日志，同批其余 id 照常处置完，整批照常落定），确证不了则维持原判按 `permissionDenied` 上报——没有确证不把群级闩锁降级成逐个重试。

  **但「这一批不必重投」不等于「这个群扫干净了」**：回执必须另带一档 `targetIsAdmin` 与 `complete` 正交地上报，主线程据此不写 `sweptAt`、并把该群的连续失败计数照常累计（不累计的话，一个长期挂着管理员身份的黑名单目标会把整份名单的补扫钉死在 5 分钟一轮）。少了这一档，闩锁就在「批次报成功」的同时关死：目标被降级为普通成员之后再也没有补扫会去清他，而机器人对外声称已经把他拉黑了。

  主线程据此把标记同时落在两处：内存里的 `blocklistSweepState.permissionBlocked` 停掉这个群的按时间重试、新一轮补扫与 Worker 重建重放，durable outbox 里对应条目记成 `missing-permission`（**该群还没有补扫记录时必须补建一条最小记录**，不能把标记丢掉：补扫记录只由 `sweepBlockedMembers` 创建，而机器人从来就没有 `can_restrict_members` 的群恰恰是最需要它的一类——秒踢那一路的权限拒绝记不下来的话，`replayPendingBlockedRemovals` 每次 Worker 重生都把这批注定失败的处置重投一遍，而解锁边沿没有记录可解锁）——**那是这条卡住的批次唯一的自解释标记**，运维打开文件就知道该去补权限，而不是去查网络或磁盘。

  解除只认一条边沿：一次**确证的封禁权限观测**（`my_chat_member` 更新或按需 `getChatMember`，见 `packages/infra/botAdmin.ts` 与 `libs/chatMember.ts` 的 `canRestrictMembers`）。观测不到权限位时（收到别人的 `chat_member` 更新那一路只能推出「我是管理员」）保持卡住不动，不得把「没观测到」当成「有权限」；观测到仍无权限同样不解锁——那不是「再试有意义」的边沿。

  「是管理员」与「能封人」是两回事，被授予管理员却没勾封禁权限正是这条路径最常见的成因。

  **处置没有状态机，重放是它唯一的存活方式**：每批经 `trackBlockedRemoval` 编号并登记进 `pendingBlockedRemovals`，Anti-Raid Worker 重建时整表重投（重复 ban 幂等，漏掉却意味着人一直坐在群里）。

  **镜像只能在任务已经完成或被权威状态判定为不再需要时删除**，分成三类：收到 `complete: true` 回执；权威取消（`/unblock` 摘掉用户或该群停管）；同群的补扫批次被新一轮补扫取代（名单只增不减，新快照是旧批次的超集）。后两条不做就是无界增长：一个缺封禁权限的群每个退避窗口沉积一份完整 `userIds` 副本，且每次 Worker 重建全量重投。

  **投递调用抛错也不能删除任务**：`postAntiRaidDurably` 的 `post()` 返回 false 只说明 Worker 没收到；durable outbox 仍是独立于 Telegram update 重投的恢复边界。屏障超时与落盘失败时 Worker 可能已经收下并在后台执行，任何一种错误里删镜像都会毁掉跨进程重放依据。catch 里回写 `blocklistSweepState` 前还必须对账 `removalId` 仍是自己，否则会踩掉抢先到达的回执写下的 `sweptAt`。

  **反过来，任何「销账而不是落定」的路径都必须自己放掉那个在途占位**（`releaseSweepClaim`）：非 null 的 `removalId` 是「这个群有一批在跑」的唯一凭据，`sweepBlockedMembers` 开头据此早退，而销账之后回执永远不会来——这个群在本进程内再也扫不了，`requestBlocklistResweep` 也救不回来（它在有批次在途时只记 `resweepRequested`、把 `removalId` 原样留着，那条路径依赖的正是「回执迟早会到」）。

  只放 `removalId` 一项：`sweptAt` 保持原样（这一批没扫成，欠着的那次仍然欠着），`nextRetryAt` 保持派发时写下的退避，免得销账立刻换来一次重扫。

  **「未落定」必须留下日志，且要排在 `removalId` 对账之前**：秒踢批次跟补扫进度对不上会提前返回，而那一路没有验证窗口兜底，这批失败就是那个人留在群里的全部原因。

  **停管由主线程权威判定**：Worker 侧的 `blocklistRemovalEpochs` 只活在 isolate 里，崩溃重建即归零，拦不住重放。Worker 侧单个 id 失败按 `BLOCKLIST_REMOVAL_MAX_ATTEMPTS` 退避重试——黑名单入群不开验证窗口，没有超时踢人兜底，这次处置是唯一的机会；成员探测**只有确认不在群才跳过**，探测失败照封（多封一次是幂等的，漏封则是静默放过）。

  补扫按 `BLOCKLIST_SWEEP_BATCH_SIZE` 分批、批间让步，且每处理一个 id 就比对一次该群的处置世代（`packages/cache/workers/antiRaid/blocklist.ts`）：群被 `/init disable` 或机器人被撤管理员后，在途批次立刻整批放弃。秒踢路径不投 `join`，因此处置消息必须带上 `joinedAt` 与入群公告 id，由 Worker 补记反刷群入群计数、并删掉那条公告。

  **但补记用的是 Worker 观测到的时刻，不是 `joinedAt` 本身**：`joinedAt` 由主线程在 durable outbox flush **之前**取得，必然早于 Worker 随后用自己的墙钟记下的那些入群，而滑动窗口把传进来的时刻当成「现在」，会按契约将所有落在「未来」的队尾判成时钟回拨整段丢掉——一次补记就能抹平同批里刚记下的真实入群，阈值再也凑不满。

  同理，`joinedAt` 已经滑出 `JOIN_WINDOW_MS` 的补记直接丢弃：跨进程重放（启动恢复、Worker 重生）带来的那批属于上一个进程的入群潮，对齐到现在就是凭空多算一次入群。

  **但 `joinedAt` 每次物理入群只能带一次**：同一次入群会被 `chat_member` 与 `new_chat_members` 两条路径各认领一次（两条都要拦——隐藏入群消息的群只有前者会到，前者又要管理员权限才送达），而普通入群靠 `joinCreatesNewRecord` 去重、处置这一路没有那道闸。两条都带就是 `recordJoin` 两次，`ANTI_RAID_PER_MINUTE_LIMIT` 对黑名单账号实际减半，整群被提前打进私密模式，普通成员的发言权跟着被收走。

  去重按 `(chatId, userId)` 记在 `recentBlockedJoinCounts`（`packages/cache/main/antiRaid/blocklistGuard.ts`），窗口取 `JOIN_WINDOW_MS`、容量由 `BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES` 兜住；公告 id 照常带，删公告本来就是幂等的。

  **秒踢的登记失败（outbox 满、id 空间耗尽）必须就地降级，绝不能让异常逃出 `claimBlockedJoiner`**：它跑在更新中间件里，抛出去就是该条 update 失败 → 扣住 offset → 非零退出 → systemd 重启 → Telegram 重投同一条 update → 再抛，一个只能靠手改 `memory/blocklist/removals.json` 解开的重启循环，而 outbox 满本身通常正是一批永远封不掉的处置堆出来的。

  降级要点名记日志并让该群重新欠一次补扫，同时仍返回「已按黑名单处置」——名单判定没变，不该反过来给他开一个入群验证窗口。

  **黑名单成员入群的处置是「取代」join、不是「附加」在 join 之外，因此它被取消时必须把那条 join 补回去**（`ClaimBlockedJoinerParams.replacedJoin`）：`claimBlockedJoiner` 命中时刻意不投 `join`——Worker 不会为一个马上要被踢掉的人开验证窗口。

  可这批处置在随后的 write-ahead flush 等待期里仍可能被并发的 `/unblock`（`forgetUserBlocklistRemovals`）整批删掉，而 `reconcileBlockedRemovalMessages` 只会把查不到权威参数的消息摘掉：不补 join 的话，这个人既没有移除、也没有验证窗口——没有窗口就没有提醒、没有超时踢人，他就这么留在群里，反刷群的入群计数也漏记，而系统里再没有任何一处会为他重新开一个（`chat_member`-only 的入群更甚：那一批消息会因此整个变空，什么都不投）。

  **只有「批次真的从权威镜像里消失」这一档需要补**；对账轮数用尽的那一档不补——任务还在 durable outbox 里、这个人仍待清出去，那时补一个验证窗口等于给一个仍在黑名单上的人开门。

  **这条契约覆盖整条投递路径，不止 `claimBlockedJoiner`**：`prepareDurableAntiRaidMessages` 的对账轮数（`BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS`）用尽时同样不得抛——它经 `postAntiRaidDurably` 被同一批 update 中间件调用，抛出去是同一个重启循环，而触发条件（并发 `/unblock` 反复裁剪同一批）在重投后照样成立。用尽时也不能退而投出最后一次对账结果，那可能含刚被 `/unblock` 取消的批次，正是这套对账要挡的；

  正确做法是把处置消息整批摘掉、非处置消息照常投，记一行错误日志并让相关群欠一次补扫——任务本身留在 durable outbox 里不会丢。

  **判定与执行按线程分离**：判定留主线程（名单是主线程状态，Anti-Raid Worker 没有副本，且必须在投递 join 之前决定，否则 Worker 会为一个马上要被踢掉的人开验证窗口）；

  探测与封禁一律投给 Anti-Raid Worker 执行，走它的 `joinVerificationApi` 队列，与验证超时踢人同源——一波黑名单账号回流和一次清扫都是「一波踢人请求」，压在默认客户端上会拖慢正常指令与 AI 回复，跑在主线程上还会占住该群的更新车道（Bot API 没有枚举群成员的接口，一次清扫固定是 O(黑名单长度) 次 getChatMember）。处置消息与同批 join/left 一起经 `postAntiRaidDurably` 投递，Worker 处理完 mailbox 才交接 update；

  真正的网络请求按该线程惯例事后串行执行，不阻塞 mailbox。infra 侧不得静态依赖 Anti-Raid 业务模块，执行 owner 经 `packages/cache/main/blocklist.ts` 的单槽位反向注册（同 `infra/chatTeardown.ts`）。

  **`/block` 命令自身的跨群连坐封禁是这条线程分工的显式例外**：它在主线程串行打 `isChatMember` + `banChatMember`（走默认 `bot.api`），因为战报要按群区分「踢出去」和「提前拉黑」，而现有回执只带 `complete`，投给 Worker 就拿不到逐群结果。主线程可用 `confirmedKickedUserIdsByChat` 降低重复命令的请求量，但只能在 `isChatMember === true` 且随后 ban 成功时记录该 `(chatId, userId)`；

  确认不在群、查询失败与提前封禁都不能写入。缓存按东京自然日懒清空，`/unblock` 提前失效目标用户，且绝不从 `blocklist.json` 或 `removals.json` 恢复——后两者涉及未落定重试与重踢，拿来跳过 API 会静默放人。代价是一次命令会占住该群更新车道若干秒、且单次调用失败不重试；后者由 `requestBlocklistResweep` 兜住——封禁失败的群会被标回「欠一次」，下一次管理员身份观测重扫一遍。这个例外只覆盖 `/block` 命令本身，秒踢与补扫仍一律投给 Worker。

#### 广告检测的准入、判定与处置

- `/ad_detect` 广告检测是**尽力而为的启发式**，不是安全边界，但它的处置与 `/block` 完全同权，因此边界必须划清。投递门禁是三者的合取：本群 `ChatState.isAdDetectEnabled === true`、机器人是本群管理员（与入群守卫共用同一道 `isBotAdminIn` 判定——不是管理员就删不掉广告也封不了人，判一次纯属白烧额度）、发送者不具备广告检测豁免。`SUPER_ADMIN_USER_ID` 恒豁免；白名单则由 `isCanBypassAdDetection` 单项决定，设为 false 的成员仍会送检，Worker 也可能删除本批命中消息。

  **白名单成员关系仍无条件保护永久黑名单**：判定结果回到主线程时，处置会在与 `/white`、`/block` 共用的 `runProtectedIdentityMutation` 临界区内重新调用 `isProtectedSender`。候选排队后刚加入白名单，或本来就在白名单但关闭了广告检测豁免，两种情况都拒绝 `blockUser`、跨群封禁与封禁播报；只有 Worker 已完成的本批消息删除保留。拿本群当皮套的匿名管理员（`sender_chat.id === chat.id`）同样跳过，理由同 `/block`：Telegram 不暴露皮套底下是谁，处置只会尝试封掉整个群身份。

  **关联频道推进讨论组的自动转发（`is_automatic_forward`）与机器人自己帖子的回弹（`isBotOwnMessage`）也一律跳过**：那条消息的发送者是频道本身，处置会走 `userId < 0` 分支在每个托管群 `banChatSenderChat`——因为频道自己的一条推广贴，整个评论区被连根拔掉；机器人发在自己频道里的帖子回弹进来时更是能把自己的频道拉黑。频道贴该不该发由频道管理员决定，不归讨论组的广告检测管。

  **这条豁免必须一并盖住引文**：讨论组评论区里每条顶层评论的 `reply_to_message` 都是同一条频道贴，只挡贴本身、却把它的正文抄进 `sampleContext` 送检，等于拿频道自己的推广文案去判每一个评论者——一条频道推广就能把整个评论区的人逐个连坐拉黑，而他们一个字都没写。`quote` 是从被回复消息里截的片段，因此一并丢掉。

  **群管理员/群主永不被处置**：处置与 `/block` 同权且不可逆（永久名单 + 每个托管群封禁 + `revoke_messages` 抹掉近期消息），而管理员转发合作方链接、玩笑说「加我微信」都足以被读成推广。闸门分两道——入队时用 Worker 侧的管理员缓存（`freshAdminIds`）挡掉已知管理员、省下额度；判定命中后再以 `getChatAdministrators` 为准确证一次，**确证不了一律按不处置办**（放过一条广告的代价远小于误封群主，何况下一条消息会重新排队，那时缓存已经热了）。

  **判定与处置全部跑在 Anti-Raid Worker 线程**：主线程只做同步门禁 + 一次 `post`（不是 `postAntiRaidDurably`——待检队列随 isolate 生死，为每条群消息加一道跨线程屏障换不来任何恢复能力），投递被拒只记日志、不拒收 update。

  **队列只排发送者的键**（`chatId:senderId`），同一人在等待期间的新消息只合并进 `pendingAdMessages` 的同一 bundle，不占第二个队列位置。待检所有权由 `pendingAdMessages`、`adDetectQueue` 与 `queuedAdDetectKeys` 共同表达，三者必须同步增删——**「该不该动这三张表」的判定收在 `packages/states/adDetectAdmission.ts`**（投递闸/排队闸/容量闸/在途闸四道纯规则），运行时那边只执行结论；

  消息串本身的整形（裁剪、收容量、拼送检正文）另在 `packages/workers/antiRaid/adDetect/bundle.ts`，它守的是另一条不变量：能挤掉的只有已经判过的条目。

  `AD_DETECT_MAX_PENDING_SENDERS` 是 11,500 个不同 key 的硬顶——这个数字不是「能接纳多少人」，而是「撑满也还活着」：它乘上单 key 条数上限与每条的正文/URL/样本上下文上限，就是 Anti-Raid Worker isolate 的常驻上界，而入群验证、封锁与黑名单执行都在同一个 isolate 里，OOM 会把它们跟启发式判定一起带走。容量已满时必须在修改任何 Map、队列或 Set 前拒绝第 11,501 个新 key，不能 FIFO 淘汰已经接纳的旧 key；

  已有 key 的后续消息仍按单 key 条数与字符预算合并。已接纳 key 在发生至少一次判定尝试前没有等待 TTL，周期 sweep 也不得删除；停管、`/init disable`、`/ad_detect disable` 与 Worker 停止才是合法取消边界，并且必须同时摘掉 Map、队列和相关 Set。`recentlyEnqueuedAdKeys` 与 `recentlyDisposedAdKeys` 同样受 11,500 硬顶并按窗口轮换，历史发送者不能转化成无界 Set。

  调度器每 `AD_DETECT_QUEUE_TICK_MS` 从全局 FIFO 队首取至多 `AD_DETECT_BATCH_SIZE` 个 key，并受 `AD_DETECT_MAX_IN_FLIGHT` 全局在途闸约束；这两道闸都不按群分配，撞上在途上限的已接纳 key 留在队列里等待恢复，不会过期。

  90 秒的 `AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS` 只约束重复入队和已消费上下文：`seq > checkedSeq` 的未消费条目无论等待多久都保留，只有 `seq <= checkedSeq` 的已消费上下文才能在窗口外裁掉；窗口轮换必须把仍有未消费内容的 key 补排一次。`checkedSeq` 是单调序号，描述“已经消费到哪里”，裁剪不能回退它。

  **送检字符预算（`AD_DETECT_BUNDLE_MAX_CHARS`）只决定「这一拍判到哪里」，不决定「哪些消息会被判」**：未判定的内容一律从最旧一条起按序装，装不下的留到下一次判定（窗口轮换时的补排），剩余预算再补紧挨着的已判上下文；水位只能推到本次真正送检的最后一条。反过来从最新一条往回取是错的——被预算挡在外面的旧消息会夹在水位下面，跟着水位一起被记成「判过」再被裁掉，而单 key 条数上限（45 条 × 512 字正文）本来就比这份预算宽好几倍，一串长消息就能触发。那是一次没有任何日志痕迹的漏判，正是本条规矩要禁的。

  **单 key 条数上限（`AD_DETECT_MAX_MESSAGES_PER_SENDER`）同样只挤得掉已消费的条目**；一次爆发式刷屏能在第一个节拍到来之前就把上限撑满，那时只剩没判过的可丢，正文不再留但消息 id 必须转进 `AdMessageBundle.pendingDeleteIds`（上限 `AD_DETECT_MAX_PENDING_DELETE_IDS`，撑满时丢最旧一条并记错误日志）。

  不转存的话这些消息既进不了判定、也进不了处置的删除集合——判定依据（`judged`）与此刻串里还剩的（`entries`）都覆盖不到它们，命中之后就永久留在群里，频道马甲尤其如此（`banChatSenderChat` 没有 `revoke_messages`）。

  **并集因此可能远超 `deleteMessages` 的单次 100 条上限，必须由调用方分片**：那个接口只有整体成败，一次带满整份 id 会让整批被拒、一条都删不掉，比不转存还糟。

  **判定失败一律当作「本次没判定」并把这一批记成已检**：绝不猜一个 true（一次网络抖动就等于把人永久拉黑），也绝不无限重试（DeepSeek 侧故障时那就是每秒一批的请求风暴）。响应解析只认真正的布尔 `true`，`"true"`/`1`/`yes` 一律判成没判定。

  **被引用段（`quote`）与被回复的原消息必须与正文一起送检**：广告最主流的发法是「先发一条完全正常的消息骗过判定 → 隔一段时间把它**编辑**成广告 → 用回复/引用把它顶到群里」，广告正文自始至终不在任何一条新消息的 `text` 里。编辑不触发重新投递，「原消息发出时已经判过一次」对编辑后的内容不成立，因此只读 `text` 等于对这条路完全免疫。

  **连坐的代价是明知且有意接受的**：引用广告来吐槽的群友会跟着被判——判定分不出「转述广告来骂它」与「借引用把广告顶上来」，宁可误伤也不放过，题材口径由部署方在 `config/ad_samples.json` 里继续收。

  **同一段引文在整串里只留最早认领它的那一条**（`claimSampleContextParts`）：合并送检的全部意义在于把拆开发的碎片凑到同一份清单里判，而这种发法几乎总是每条都回复同一条消息；按条复制的话单条能占到「正文 + URL + 上下文」三份配额的上限，`AD_DETECT_BUNDLE_MAX_CHARS` 被重复引文吃掉近一半，本该一起判的碎片被切成好几轮、模型每轮只看到一个单独无害的片段。后来的那些消息照常凭自己的正文入选，读到的仍是同一份完整引文；样本侧那一份**不**去重——判定可以只看一遍，取证必须如实记下每条当时引的是什么。

  同理，正文、URL、上下文三样全空才算「没有可判定内容」：把广告顶上来的那条消息完全可以自己不打字（一张表情、一张没有 caption 的图），只看 `text` 的话不打字就能绕过去。反过来，`text_link` 实体里的 URL 必须补进送检文本：超链接的可见文字可以完全无害（「点这里」），落地页只存在于实体里，不补的话「有没有把人带离本群」这条最硬的规则对所有挂超链接的广告直接失效。补的是消息自身携带的 URL、不带任何系统措辞，因此不给正文引入可被伪造的结构。

  **URL 必须与正文分开跨线程传递、各有各的字数配额**（`AdCandidateMessage.linkUrls`，Worker 侧在正文按 `AD_DETECT_MESSAGE_MAX_CHARS` 截断之后再接上）：主线程若把它们拼在正文尾部，Worker 那道从头保留的截断切掉的恰好就是这几个 URL——七百字填充文本加一个锚文本为「点这里」的超链接就是一条零成本的绕过路径。

  **已经在黑名单里的人不再送检**（投递门禁里的 `isUserBlocked`）：处置早就排上了，他此刻还在说话只是因为封禁尚未落地，继续送检既白烧额度，又会换来一次与上一次完全相同的处置。

  **但只有真人可以在主线程就地丢弃**：`banChatMember` 带 `revoke_messages`，落地时会把这段空档里的消息一起撤掉；频道马甲走 `banChatSenderChat`，没有 `revoke_messages`，在主线程吞掉就意味着它抢发的每一条广告都没有任何清理路径、永久留在群里且没有任何日志。

  因此频道马甲照常投给 Worker，并把「已在名单里」这个事实随 `AdCandidateMessage.blocked` 带过去（名单是主线程的同步状态，Worker 没有镜像），由投递闸判成 `deleteStraggler`——删掉但不进判定额度。这条与下面 `recentlyDisposedAdKeys` 的抑制是同一个例外，只是覆盖的窗口更长：后者只活一个去重窗口，而「已拉黑但封禁没落地」可以跨窗口存在，且不止由本次判定产生（秒踢、补扫、上个窗口登记的封禁批次都是先写名单再等 outbox 落盘与 mailbox 屏障）。

  Worker 侧另有一层同窗口内的抑制（`recentlyDisposedAdKeys`）：判成广告的键在处置发出的同时记下，覆盖「处置已发出、主线程还没把人写进黑名单」那段跨线程空档里抢跑进来的消息，随窗口轮换一起清掉。

  **频道马甲在这段空档里的新消息只抑制判定、不抑制删除**：`banChatSenderChat` 没有 `revoke_messages`，那次封禁带不走它们，而抑制期内也不会再有第二次判定来删——不在抑制分支里补一次删除，这些广告就永久留在群里。

  **重复命中不得重走整套处置**：那一套的代价是一次带 fsync 的黑名单落盘加上每个在管群各一批封禁、每批都要整份 outbox 深拷贝并落盘，按群数放大就是 O(n²) 写盘。因此 `blockUser` 返回 false（名单里已经有他）时只补触发群这一批、且不再重新等落盘确认——名单条目在第一次命中时已写进内存 Map 并投过落盘（那次若没写成日志里已点名，Disk I/O Worker 重建也会重放本进程新增的条目），其余群的封禁批次还在 outbox 里等重试。

  这与 `/block` 的重试语义不冲突：那条路的重复调用是管理员修好磁盘后的人为重试，这条路是刷屏号自己触发的，两者不共用一套代价。补的那一批同样要过「已初始化且是管理员」的过滤，两次命中之间机器人可能刚被撤管理员。

  **命中后的处置按线程分家**，与黑名单同源：Worker 侧删掉那一串消息并把 `adDetected` 回投主线程；主线程执行不可丢的那一半——`blockUser` + `flushDiskIODomain("blocklist")`，再为每个 `isInitEnabled && botIsAdmin` 的群各 `trackBlockedRemoval` 一批经 durable outbox 投回 Worker 执行封禁，最后由主线程发那条群内播报。

  **播报必须发在知道封禁登记结果之后**：它的文案断言「在所有盯着的群里一起封掉了」，而登记完全可能一个群都没成（outbox 触顶、刚被撤管理员、`/init disable`），那时人根本没被踢走，照发就是一条与事实相反的公告——零登记时改成点名请管理员检查权限。

  **部分群登记失败同样不许说「所有」**：那些群里人还坐着，而唯一的线索只是一行没人在看的错误日志，因此文案要报真正封上的群数并把欠账说出来；只对全失败生效的守卫等于把「三个群里有两个没封动」照旧说成「在所有盯着的群里一起封掉了」。这也是 Worker 侧回投通道已关时不发播报的同一条理由，只是那半边由「主线程压根没收到事件」自然满足。播报 `KICK_NOTICE_AUTO_DELETE_MS` 后自撤，不给群里留永久公告。

  这些主线程任务登记在 `inFlightAdDisposals`（`packages/cache/main/antiRaid/adDisposal.ts`）并由 `drainAntiRaid` 每轮等待，不能连同事件一起丢在半路；

  **这次等待和该轮其余每一步吃同一份剩余预算**，超时即结算成 `timedOut`。裸等是不行的：处置内部要走 `confirmBlocklistPersisted`（带 fsync 的领域 flush）与 `dispatchBlockedRemovals`（outbox 写前落盘 + mailbox 屏障），而异常退出那条路径把全部预算设成 0（`FATAL_FLUSH_TIMEOUTS`）本该立刻结算，实际会一路拖到 15 秒强制退出线——进程带非零码死在停机中途，实例锁不释放、offset 不确认。

  **反过来，Worker 侧的判定批次绝不能登记进 Anti-Raid 的在途任务集合**：那个集合是停机 drain 的等待对象，预算是 `ANTI_RAID_BARRIER_TIMEOUT_MS` 这一档的秒级数值，而一次判定请求可以耗到 `DEEPSEEK_REQUEST_TIMEOUT_MS`（30 秒）再乘上空正文重试。登记进去就意味着：凡是停机时恰好有一次判定在途，drain 必然超时，生命周期据此拒绝确认 Telegram offset 并非零退出——一次尽力而为的启发式换来一次脏退出加一批 update 重投。

  drain 到达时只 quiesce 判定节拍（不再开新的请求，也不再删消息、发播报），在途那次自行收尾。

  **停管、`/init disable`、`/ad_detect disable` 必须清掉该群待检串**：主线程门禁只拦得住之后的消息，已经排进 Worker 的那些若继续判定，就会在开关关掉之后还把人拉黑；在途的那一次由「状态对象同一性」自行作废（整串已被摘掉，旧引用对不上）。

  **但这次投递失败必须由命令自己兜住，不得逃出 update handler**：`post()` 只在「Worker 用尽重启预算被放弃」与「正在重生」两种状态下返回 false，而那两种状态下待检队列本来就跟着旧 isolate 一起没了，没有任何东西需要清；

  反过来放它抛出去的代价是实打实的——开关已经落盘，这条 update 却被判失败，最终 offset 扣住不确认、进程非零退出，重启后 Telegram 重投同一条 `/ad_detect disable`，而 Worker 仍然不可用，恰好把重启循环焊死（同 `/ai_chat disable` 对 `invalidateAiChat` 的处理）。

  **收紧提示词里任何一条结构规则之前，必须拿 `config/ad_samples.json` 的正样本逐条对一遍**：规则管「凭什么算广告」、示例管「本部署认的是哪几类」，而两边都在讲同一件事的口径。规则说「通常不是」而示例清单说「命中同类即判 true」时，模型收到的是一对互相打脸的指令，受损的一侧永远是召回——被放过的广告不留任何日志痕迹，没人会发现。招工诈骗那一类尤其容易踩：那些正样本根本不留联系方式（引流全靠对方私聊），把「三件套」写成必须同时凑齐就会让清单里十几条正样本整批判 false。

  判定提示词里**必须出现「JSON」这个词**：请求带 `response_format: json_object`，DeepSeek 服务端会校验提示词是否提到 json，没提到直接 400 让整条判定失败。

  **输出额度要按推理模型留余量**：`AD_DETECT_MODEL` 是推理模型，reasoning token 与正文共用 `max_tokens`，给得太紧的后果不是截断出半个 JSON，而是推理把额度吃光、正文一个字都没写出来（`finish_reason=length` + 空 content），上层只能当作「本次没判定」把这条广告放过去。传输层因此必须把 `length` 收尾单独识别出来点名记日志并返回 null，不把半截正文交给解析器——否则这类漏判在日志里没有任何痕迹。

  模型看到的群聊原文一律是数据，`reason` 只进日志与播报文案，不参与任何控制流。

  **命中即写一条旁路样本**（`memory/ad-detected/sample.json`，见 `workers/diskIO/adSampleFile.ts`）：判定规则由提示词定死，题材口径全靠 `config/ad_samples.json` 的示例，而示例只能从真实命中里攒——没有原始素材，误判就只能靠人凭印象复述。

  这是整个持久化里**唯一只写不读**的一类：进程从不加载，启动恢复不碰，因此不进统一 flush 的领域清单（一个纯诊断文件的写盘失败不该让 `/block` 的落盘确认报失败）、允许截断自愈、失败即弃只 `console.error`；当前文件达到 8 MiB 时自动轮转为 `sample.<东京日期>[.<正整数序号>].json`，归档严格按文件名日期保留今天在内最近 15 个东京自然日。保留期清扫每天至多一次，只删除严格匹配的普通文件；扫描或单文件删除失败均继续旁路追加；

  投递排在 `blockUser` 之前，那之后每一步都可能抛错，而这条素材恰恰是「这次判得对不对」的唯一证据。样本按**整串**记录而不是只留触发那一条：判定看的就是整串，只留一条的话人看到的是一句孤立的话，复现不出模型当时读到的东西。

  **被引用段与被回复原文既进判定、也进样本**，但从投递入口起就走两个独立字段（`text` 与 `sampleContext`），两条理由各自独立：判定侧必须在正文按 `AD_DETECT_MESSAGE_MAX_CHARS` 截断**之后**再接上（先拼后截就是一条零成本绕过路径，几百字废话即可把引文顶出额度），样本侧必须留一份没并进正文的原样（人回头查误判时得分得清哪一段是他自己写的、哪一段是引来的）。

  接上去时**不带任何系统措辞**（不写「引用：」这类前缀），理由同 URL：那会给正文引入可被伪造的结构，发送者把同样的字打进自己的正文就能假装某段话是别人说的。

  **模型看不到的事实必须由主线程喂进 system 段，且两侧都要显式声明**：判定只拿得到发言者自己那串消息，「是不是刚进群、验证还没过」这类结构信号在转录里根本不存在，写进提示词却不喂数据，只会让模型凭感觉编一个理由。该事实由主线程按待验证镜像（`activeVerificationSnapshots`）同步取得，随投递带给 Worker，并在消息串里取并集而不是覆盖——验证会在窗口内通过，先发广告后点验证的人不该因此洗白。只说成立那一侧同样不行：模型会把「这次没提」当成信息缺失去猜，而这条信号只有在确证时才该加分。

  事实只能拼进 system 段，**绝不能混进待判定正文**——正文全是用户可控内容，混进去等于给刷屏号一个伪造「我不是新成员」的机会。

#### 封禁与消息撤回

- 黑名单封禁一律带 `revoke_messages: true`：`/block`、黑名单成员入群秒踢、新晋管理员后的补扫与广告检测命中共用 `banChatMember` 这一个封装，四者都是「管理员认定这个人不该在这个群留下任何痕迹」的判断，消息一并清掉才是完整处置。反刷群的自动踢出走 `kickChatMember`（只踢不封，防误杀），本来就不经过这条路径，因此这条约束不会波及它。

  频道马甲没有「成员」概念，`banChatSenderChat` 也没有这个参数，广告检测因此在 Worker 侧另外逐条删掉本次判定依据的那串消息——那串消息对频道马甲和已经自己退群的账号同样有效。

#### 黑名单移除 outbox

- 黑名单移除批次还必须跨进程存活：主线程在投递 Anti-Raid Worker 前，把当前 `pendingBlockedRemovals` 全量快照写入并按独立的 `blocklistRemovalOutbox` 领域 flush `memory/blocklist/removals.json`；只有 durable 后才能交接 update。

  **「durable」的边界是那次 flush，不是快照消息本身**：Worker 收到快照只替换镜像并标脏，写盘发生在统一 flush。逐条就地写盘的话，一批 N 个群的清扫依次登记/销账就是 N 次整份 outbox 的 tmp + fsync + rename，而每份 outbox 又按已登记的群数增长——按群数放大的 O(n²) 写盘，正是本文件点名要避开的形态；不等确认的那些路径（批次销账、失败计数、启动对账）也因此不再各付一次 fsync。

  **补扫条目（`probeMembership: true`）不得持久化 `userIds`**：outbox 记的是「拿黑名单把这个群扫一遍」这件事，名单在投递与重放的那一刻按当时的 `blockedUserIds` 现算（`materializeRemovalParams`）。

  冻一份 id 列表进去有三重坏处——落盘量按「群数 × 名单长度」放大（N 个群的补扫条目装的是同一份内容，加起来正是本文件禁止的 O(n²) 写盘），`removals.json` 会成为整个持久化里唯一一个大小随黑名单长度增长的文件而它就在启动恢复的关键路径上，以及重放时那份快照可能已经过期——Worker 重建后该扫的是**此刻**的名单。反过来，秒踢与广告处置（`probeMembership: false`）的名单**必须**随任务冻结：那批人是「此刻确定在群里的这几个」，与名单当前内容无关，现算会扫到一群不相干的人。

  两种形态在类型上由判别联合分开（`PendingBlockedRemovalParams`），补扫带名单或秒踢漏名单都编译不过；codec 也照此拒收，读到带 `userIds` 的补扫条目直接抛错——那多半是没迁移干净的 v1 条目。`/unblock` 因此**只改写冻结名单的批次**，补扫条目不必动（现算的那一份自然已经不含刚解除的人）。文件版本随之从 v1 升到 v2，codec 只认当前版本：漏做迁移必须停在启动这一步。

  同理，这份快照在主线程、跨线程与写盘三处**只保留必要的那一份拷贝**：`postDiskIO` 本身走 structured clone，接收端 `decodeEntry` 又逐字段重建，序列化只读不改，任何一处再手工深拷贝都是按「群数 × 名单长度」多复制一遍。该领域不能与正式名单的 `blocklist` 合并，否则任一文件故障会误判另一方。每项连同创建时间、确认失败次数与最近失败分类持久化，达到告警阈值只升级日志，不得删除任务。

  只有诊断字段（失败次数、失败分类）变化时不得单独排一次完整快照：一轮重放会回来 N 份「没落定」回执，逐条排完整快照就是 O(n²) 次全表深拷贝加整文件 fsync，正是重放路径本身明令避免的形态；这些值由下一次权威快照顺带写回（完成回执、`/unblock`、停管、新批次的 write-ahead、Worker 重建重放），只有**跨越告警阈值那一次**立刻落盘，让「这批已经失败到该报警了」跨重启存活。完成回执、`/unblock`、停管或批次替代都要先更新内存 owner，再排队写回 outbox。

  write-ahead flush 等待期间也可能发生权威取消或裁剪，因此投递前必须重新对账；若消息已变化，先把新快照再次 flush，直到 durable 内容与即将投递的内容一致，最终对账与同步 post 之间不得留下 `await`。启动恢复在 runner 之前加载当前格式，按权威 blocklist 与 `isInitEnabled && botIsAdmin` 过滤失效项，用最大 `removalId` 播种计数器并批量重放（一次 outbox flush 与 mailbox barrier）；

  文件损坏、超过 `BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES` 或写盘失败一律 fail closed，不得从空 outbox 继续。

#### 权限恢复后的重放

- 确证恢复 `can_restrict_members` 时，必须先按原 `removalId` 重放该群全部因权限冻结的秒踢/广告 pending，再发起一次现时全名单补扫。后者只能按自己的回执销账，不能替前者删除 outbox 项；每个冻结批次仍须等自己的 `complete` 回执收敛，补扫失败也不得提前销账。

### 运势与 AI 记忆恢复

- 运势切换东京日 owner 前必须先 flush 旧日追加缓冲，失败则保持旧 owner 并拒绝轮换。目标日已有确认结果时，缺失密钥或密钥日期不一致属于不一致备份，必须拒绝启动/轮换，不能静默生成新密钥。
- AI 记忆恢复必须按当前 `AI_MEMORY_HYDRATE_BUFFER_MAX` 与 `MAX_SUMMARY_ROUNDS`（当前为 149 条逐字消息与 7 轮冷摘要）从快照尾部截取最新数据；调整容量常量部署前，应在旧进程停止后以同一恢复逻辑原子重写现有 `memory/ai/`，避免旧进程的停机 flush 覆盖迁移结果。
- 回复链索引（`chatReplyChainIndexes`）是滚动缓存的纯派生索引，不落盘、内层值与缓存共享对象引用；登记/删除只允许发生在消息进出热区的物理位置（`rollingMemory.ts` 的 push/轮换/hydrate），任何其它模块只读。索引因此永远只覆盖仍在热区的消息，容量受滚动缓存上限约束，无独立淘汰；机器人发送自录只按 Telegram 返回的实际 `reply_to_message` 建边，目标在生成/排队期间滑出热区时使用轮次开始前捕获的有界触发快照兜底，不扩张索引覆盖范围。

  模型可见的回溯深度、单个链节点正文和触发快照分别受 `REPLY_CHAIN_MAX_DEPTH`、`REPLY_CHAIN_NODE_MAX_CHARS`、`REPLY_REFERENCE_MAX_CHARS` 约束（当前为 15 跳、500 字、500 字）。

### 确认边界与停机

- Telegram update 只有在对应 middleware 完成后才可推进确认边界；Anti-Raid mailbox、反应/头像后台 owner 与 StateStore、AI Worker、Disk I/O Worker 的 flush 都有显式有界 drain。任一关键 flush 失败必须返回失败、阻止最终 offset 确认并以非零状态退出。

  **停机时被放弃的那一条同样算数**：取数循环在停机信号到达后不再等待在途 middleware（它可能悬挂，排空交给生命周期按 size() 有界完成），因此随后失败的 update 只能由 runner 的显式标记表达——它在 handleUpdate 抛错的同一个同步段里写下，`size()` 归零时必然已经生效。生命周期必须在确认最终 offset 前读它，为真时不确认 offset 并以非零状态退出，让 Telegram 在重启后重投；只看 `task()` 是否正常 resolve 会把一条从未成功处理的 update 一并确认掉。
- runner 的每次 `getUpdates` 固定 `limit: 1`，本条 middleware 成功后才发起带更高 offset 的下一次取数。这样后一条失败时，前一条非幂等副作用已经在独立确认边界内落定，不会因“兄弟 update”一起重投；取数端若违反 limit 返回多条，必须在执行任何 handler 前 fail closed。失败后不得 fetch 下一条或推进 offset。
- 最终 offset 的 `getUpdates(timeout: 0)` 仍是一次网络请求：`timeout: 0` 只关闭 Telegram 服务端 long polling，不限制 DNS、建连或响应读取，必须另带 `FINAL_OFFSET_CONFIRM_TIMEOUT_MS` 的本地 `AbortSignal`。确认失败、超时，或因 runner/维护/落盘任一前置未完成而跳过时，生命周期要把这道 gate 永久记为失败、非零退出并阻止实例锁被当作干净停机释放；

  后续 `dispose()` 即使第二次等到了迟到 owner，也不得覆盖这次未确认事实。没有已处理 update 时不需要调用 API，这道 gate 视为成功。
- Anti-Raid 的 mailbox barrier 只证明此前消息已经进入调度器，不等待调度器启动的 Telegram 网络副作用；update 热路径继续使用这条轻量边界。生命周期 drain 另发 `drain` 协议并等待 Worker 登记的在途任务集合清空，且在前后穿插 mailbox barrier 与持久化 flush 做有限轮次的固定点对账；不能把普通 barrier 回执解释成网络任务已经结束。

  黑名单处置世代只在该群仍有在途移除任务时保留，最后一个任务结算或 Worker stop 时必须清除，停管过的历史群不得永久堆在 Map 中。
- Anti-Raid 停机 drain 在第一次读取 `inFlightAdDisposals` 前，必须先向 Worker 发送 `drain` 并取得回执。Worker 处理该消息时同步 quiesce 广告判定节拍；同一 Worker 端口的 FIFO 保证更早发布的 `adDetected` 已在主线程先登记，而回执后的在途判定因 stopping 门禁不得再发布处置。拿到这道稳定边界后，才能依次等待主线程广告处置、持久化 flush、回执 barrier 与由其派生的 Worker 任务，并继续固定点对账。

  `drainAntiRaid() === "flushed"` 必须蕴含 `inFlightAdDisposals` 为空，不能让最终 Worker drain 之后新登记的处置漏出本轮。

  **那道前置回执拿不到时也不能直接 return**：Worker 已放弃或正在重生时 `post()` 同步失败、barrier 立刻结算成 `failed`，而主线程侧完全可能正有处置卡在 `confirmBlocklistPersisted` 上——那正是「拉黑已入队、还没落盘」的窗口，直接返回会连同待写的黑名单一起丢掉，重启后那个人不在名单里。因此失败路径仍要用剩余预算排空一次 `inFlightAdDisposals`（没有回执就没有稳定边界，这一轮只覆盖此刻在途的那批，属尽力而为），再把原始失败原因交回调用方——返回值不因这次补救而改写。
- 每个活跃 update 由 runner 分配独立 `AbortController` 并通过异步上下文交给主线程 Telegram 适配层。正常 drain 预算耗尽时，生命周期必须 abort 全部活跃 update，再给出短而有界的取消收敛窗口；生命周期取消不得被 Telegram fallback 吞掉，必须向上解开 handler。取消后仍不退出的 handler 会阻止 offset 与实例锁释放，完成最佳努力 flush 后强制非零退出。
- 正常与异常停机都先 quiesce 标题/反应/头像/翻译入口并停止 runner，再有界 drain。四个 quiesce 调用必须逐项捕获失败：任一入口抛错时仍须尝试其余入口，未全部成功不得缓存静默完成，且该次失败必须阻止最终 offset 确认和实例锁释放；后续 `wait()`/`dispose()` 可重试所有幂等入口。翻译客户端只在首次真实请求时惰性构造，单次 RPC 有项目级短超时，drain 后显式 `close()` 并清理 project parent/客户端引用。

  翻译 drain 超时或 close 失败与其它关键 owner 一样阻止释放实例锁。正常路径必须在确认最终 Telegram offset 前依次 flush AI、Disk I/O 与 StateStore；最终 dispose 按「flush AI → 终止 AI → flush Disk I/O → 终止 Anti-Raid/Disk I/O → flush StateStore」收尾。

  若致命异常发生时普通 dispose 已在途，异常路径可以复用该 Promise，但必须另设当前 15 秒的绝对强制退出 deadline，不能被既有 drain 无限拖住。预算耗尽时 abort 仍在进行的 Telegram 请求、媒体下载和 429 sleep，结算尚未开始的队列；abort 后不得再发送消息、改头像或写入群标题。异常退出路径的维护预算为 0：drain 必须把「预算为 0」当成合法输入，空闲直接结算为 `flushed`，仍有在途工作则立即 abort 并结算为 `timedOut`，绝不能因参数校验抛错；

  未结束的标题刷新在跳过时同样必须 abort。dispose 的每个 owner 也要各自失败隔离，异常一律折算为 `failed` 参与结算，任何单点抛错都不得跳过其后的 owner、`flushStateToDisk` 与实例锁处置。
- Worker flush 与 mailbox barrier 统一使用 `packages/libs/flushBarrier.ts` 管理 ID、等待表、超时、迟到回执和崩溃批量结算；领域缓存不得重新暴露 resolver Map。
- 领域 flush 的成功只能来自同一 request ID 的 Worker 回执：本次 `flushFailed.failedDomains` 不含目标领域时，该领域才可成功；Worker 不可用、投递失败、超时、崩溃或旧请求留下的诊断状态都不能被重新解释为成功。实例锁释放同样不得在底层吞错；只有真实释放成功后生命周期才清除 `lockAcquired`，失败必须进入停机结果并保留锁状态。

### 文件权限与 schema

- 当前部署基线允许开发工作区本身保持协作所需的权限；但显式配置的独立数据根是敏感数据边界，启动时强制不宽于 `0750`，禁止 group 写与任何 other 访问。部署工具负责 owner/group 与已有目录的手工迁移，运行时不得擅自 chmod。
- `memory/` 产物统一为 `0644`；其 other 位受上层不可被 other 遍历的数据根隔离。敏感性由数据根权限、部署隔离和备份策略共同控制。
- 持久化 schema 不做猜测式自动迁移；不兼容输入会阻止启动，避免空状态覆盖原数据。

### 锁定镜像与终态标志

- lockdown 落盘握手的指纹只由 `phase` 与 `intentId` 组成——它们才是一次锁定意图的身份。指纹里不得含 `expiresAt`：私密模式生效期间，每条越过阈值的入群都会让 Worker 重发一次 `lockdown` 事件，而其中的 `expiresAt` 是当场按墙钟算出来的，每次都不一样；把它算进去，主线程「存下去 → 再看一眼还是不是同一份」的对账循环永远等不到相等，每轮一次带 fsync 的 `state.json` + LKG 整文件重写，入群比写盘更快时循环不终止，既写不下指纹也发不出落盘回执。

  倒计时本身照常落在镜像的 `expiresAt` 里，adopt 时据此换算剩余时长。该对账循环另有轮次上限兜底，用尽只暂停这个群的握手并留下错误日志，下一条 lockdown 事件会重新进来。
- 当前 lockdown 镜像要求 `phase` 与正数 `intentId`；待验证 active 记录要求 `phase` 与 `trackedMessageTimes`。reminder ID 与 `announcementMessageId` 仍是业务可选字段：缺失只表示提醒尚未成功落地、或这条记录压根没观测到入群公告，恢复后各走自己的补发/清理路径。其它缺失或不兼容字段必须在旧进程停止期间人工迁移，生产读取路径不保留兼容逻辑。
- **终态播报的「已发送」标志必须全部进快照**：`expelling` 记录带三个互不替代的标志——`successNoticeSent`（成功战报，本身 30 秒后自撤）、`failureNoticeSent`（踢不动、缺 `can_restrict_members`）、`unconfirmedNoticeSent`（没能确认人还在不在群里）。后两条都不自删，不落盘的话每次 Worker 重生或进程重启都会为同一个卡住的成员再发一条，群里越堆越多。

  三者也不能合并成一个名额：探测抖动先发出去的那条会把唯一点名「去检查封禁权限」的诊断永久顶掉，人留在群里而管理员被引向网络问题。置位时要立刻发布新 revision 让它落盘，终态重试认的是那一版的落盘回执。

<p align="right"><a href="#快速导航">↑ 返回快速导航</a></p>

## 兼容入口

大文件拆分时保留的顶层 barrel 只用于渐进迁移。新增生产代码应从所属领域文件导入；兼容入口不得重新持有状态、解析配置或引入 import 副作用。

运势回执不设旧格式兼容分支：验签要求回执内嵌日期等于当天东京日期、且日级密钥每天轮换，因此跨日回执一律验不过——旧格式回执在展示标签格式上线次日起就已不可能通过验证。识别、剥离与验签一律只认当前格式（标签前缀 + 定长 HMAC 摘要 + 同范围 `text_link` 实体携带的原回执）。

---

<div align="center">

[← 上一页：03 目录导览](03-directory-map.md) · [📚 开发者文档首页](README.md) · [⬆️ 回到顶部](#04-运行时权威约束) · [下一页：05 开发流程 →](05-dev-workflow.md)

</div>
