# 06 常见修改配方

<p align="center">
  <b>简体中文</b> · <a href="../en/06-modification-guide.md">English</a> · <a href="../ja/06-modification-guide.md">日本語</a>
</p>

<p align="center">
  <a href="conntent-table.md">📚 开发者文档首页</a> · <a href="05-dev-workflow.md">← 上一页：05 开发流程</a> · <a href="07-operations.md">下一页：07 运维与排障 →</a>
</p>

---

每个配方给出触碰的文件与顺序。通用前提：改动前读 [`AGENTS.md`](../../AGENTS.md)；涉及运行时数据文件（`state.json`、`memory/`、`bot.lock`）或会间接写它们的代码路径时，动手前先备份；完成后 `bun run check` 全绿并按需同步根 README。

## 增加并发批处理

- 固定且互不依赖的 Promise 用 `Promise.allSettled` 等齐，并逐项处理 rejection；不得用 settlement 吞错。
- 输入规模会增长时复用 [`runBoundedSettledBatch`](../../packages/libs/boundedSettledBatch.ts)，明确并发硬顶，并从结果中的 `item/index/attempt` 记录失败身份。不要先 `map` 成整批 Promise 再等待。
- 只有领域能区分瞬时错误时才配置有限退避，并通过 `shouldRetry` 和 `onRetry` 分别约束错误类型、记录每次退避。下层 owner 已经有重试时不要叠加，尤其不能重复执行非幂等副作用。
- 只为 drain 已登记任务而取的 Promise 快照无需改造成任务池；前提是快照不会启动新任务，且每个任务自身已经捕获或归属错误。

## 新增一个斜杠命令

1. **handler**：在 `packages/commands/` 新建一文件，`function` 声明导出 `handleXxxCommand`，显式返回类型。权限门禁参考现成模式：按权限键授权看 `block.ts` / `mood.ts`（一律 `hasCommandPermission(ctx, key)`，超级管理员恒持有全部权限键，不要再单独判身份）；只认超管身份、无法授权出去的看 `isSuperAdminActor`（`white.ts`、`batchKick.ts`）；仅私聊看 `send.ts`（非本人/非私聊静默 return，不回错误提示）。用户可见文案不写在 handler 里：放进所属领域的 `packages/consts/<domain>.ts` 文案表，类型放 `packages/types/`（见 `PERMISSION_COMMAND_TEXTS`、`BLOCK_TARGET_TEXTS`）——那既是给文案改动一个集中入口，也免掉每次调用现造一个对象加三个闭包。文案里要嵌无界的用户输入时才例外，`cjkAction.ts` 是唯一一处。
2. **导出**：加入 `packages/commands/index.ts`。
3. **注册**：在 [`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts) 的 `commands` 子链上加 `commands.command("xxx", ...)`。**不要直接挂到 `bot` 上**——命令一律收在那条 `bot.on(":entities:bot_command")` 子链后面（理由见 [02 架构总览](02-architecture.md#一条消息的旅程) 的「命令注册」），`test/app/registerHandlers.test.ts` 会拒绝任何直接挂在 `bot` 上的命令。注意注册点位于 init 网关、按群串行、私聊网关与入群验证 middleware 之后——新命令自动获得这些语义，不要在 handler 里重复做网关判断。
4. **私聊网关**：新命令若要在私聊中使用，还必须同步调整 [`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts) 并补网关测试；当前私聊中的斜杠命令只显式放行 `/send`，仅注册 handler 不会到达命令处理器。纯群聊命令无需改这里。
5. **菜单**：要出现在 Telegram 命令菜单就在 [`packages/consts/commands.ts`](../../packages/consts/commands.ts) 的 `BOT_COMMANDS` 加一项；像 `/send` 这类隐藏命令则不加。
6. **参数常量**：冷却、阈值等进 `packages/consts/commands.ts` 或对应领域 consts，带中文 JSDoc。
7. **测试**：`test/commands/xxx.test.ts`，至少覆盖权限拒绝、参数解析与主路径。
8. **文档**：根 README「命令与权限」表加一行。

### 非 ASCII 命令名

`/咬`、`/贴贴` 这类中文动作命令（动作词收 1~2 个中文字）走另一条路，现成范例见 [`cjkAction.ts`](../../packages/commands/cjkAction.ts)：

- **改用 `bot.hears` 匹配**：Telegram 只为 ASCII 命令生成 `bot_command` 实体，`bot.command` 永远匹配不到。必须用 `bot.hears(正则, ...)` 按消息原文匹配，并注册在消息兜底处理器 `bot.on(["message", "channel_post"], ...)` 之前，否则会被当作普通消息进入 AI/复读流水线。
- **目标解析走另一条入口**：这类 handler 拿到的是普通 `Context` 而非 `CommandContext`，改为直接给 [`targetResolution.ts`](../../packages/commands/targetResolution.ts) 的 `resolveCommandTarget` 传 `ResolveCommandTargetParams`。不认领的形态（`/咬@OtherBot`、只有 caption 的消息、消息形态异常）必须 `next()` 放行，不能静默吞掉更新。
- **只认 `message.text`**：`bot.hears` 对 text 和 caption 都会匹配，但认领一条带图消息意味着它不再流进 `handleIncomingMessageMiddleware`，那张图就不会进 AI 滚动记忆与视觉流水线。
- **自己补上流水线的前置动作**：注册点在自动流水线**之前**，拿不到它那道自发消息门禁与 `cacheSender`。handler 必须自己调 `isBotOwnMessage` 跳过机器人自己的消息（否则频道回弹会形成自问自答的刷屏循环），并自己把发起人写进 username 缓存。
- **显式区分留存语义**：成功动作结果是用户授权的长期留存内容，调用 `sendCommandMessage` 时必须显式传 `preserveInGroup: true`；目标缺失、参数错误和 `/x` 用法提示仍使用默认路径，在群里发送成功 30 秒后删除。
- **不能进 `BOT_COMMANDS` 菜单**：BotFather 的命令名同样只收 ASCII（拉丁字母、数字、下划线，最长 32 字符）。`setMyCommands` 是整体提交，混入一个非法名会让整份菜单以 `BOT_COMMAND_INVALID` 失败，而注册失败只记日志不阻断启动，菜单会静默消失。想在菜单里曝光用法，就加一条 ASCII 占位说明项（现有的 `/x`），把语法写在 description 里。
- **占位项必须注册 handler**：点菜单会真的把命令发出去，不注册就会落到消息兜底、被当成普通消息进入 AI/复读流水线；而注册成完全不做事的空 handler 又会让点了菜单的人只收到一片沉默。正确做法是回一条用法提示并就此终止链路。
- **必须自带全局限流**：这类命令没有命令菜单那层天然约束，谁都能随手造一个动作词。窗口与上限进 `packages/consts/commands.ts`，时间戳队列进 `packages/cache/main/<domain>.ts`，判定复用 [`libs/slidingWindowRateLimit.ts`](../../packages/libs/slidingWindowRateLimit.ts)（纯函数，就地维护调用方传入的队列，本身不持有状态）。

## 在回复里加链接或格式

`sendMessage` 一律不设 `parse_mode`——用户昵称、消息内容里的标记字符不能有机会变成格式或链接。确实需要富文本时，由调用方把文本按段拼好、自己算出 `entities` 偏移传进 `sendMessage`（见 [`infra/telegram/actions.ts`](../../packages/infra/telegram/actions.ts)）。偏移按 Telegram 的 UTF-16 code unit 口径计，正好等于 JS 的 `String#length`，昵称里的 emoji（代理对）自然占 2 个单位，不必额外换算；长度为 0 的实体会让 Telegram 整条拒收，空文本段不要挂实体。范例见 `cjkAction.ts` 的 `buildActionMessage`。

## 换成别的语言：不做 i18n，请自行 fork

面向用户的文案只有简体中文一套，仓库不提供也不接受 i18n 层——文案不是能替换的字典项：

- 大量回复由片段拼接而成，还要同时算出 Telegram `entities` 的 UTF-16 偏移（见上一节）。换语言意味着词序、长度、乃至句子该不该拆都变了，偏移必须跟着重算，key-value 词条表接不住这类文案。
- `/咬` 这类中文动作命令依赖中文形态本身（见「新增一个斜杠命令」末尾），换成别的语言就不再是同一个交互。
- 人设、工具描述与提示词（[`prompt/persona.md`](../../prompt/persona.md)、`packages/consts/aiChat/prompts/`）用中文写成，模型的输出语言也由它们决定。

需要别的语言就 fork 一份自己改。生产代码里含中文字符串或模板字面量的源码行约 861 处、分布在 83 个文件，加上 `prompt/persona.md` 与 `config/*.json`：整份 fork 交给 AI vibe 一遍，比在上游架一层抽象再逐条填词更省事，也不会把偏移计算这类逻辑复杂化。改完照常 `bun run check`。

## 调整行为参数

参数全部集中在 `packages/consts/`，改值不动业务代码。常用位置：

| 想调什么 | 文件 |
| :--- | :--- |
| AI 触发概率、限频、并发、队列 | `packages/consts/aiChat/rateLimit.ts` |
| AI 记忆容量、快照周期、压缩背压 | `packages/consts/aiChat/memory.ts` |
| 媒体描述长度、执行槽、LRU 容量 | `packages/consts/aiChat/media.ts` |
| 生图冷却与字节上限 | `packages/consts/aiChat/imageGeneration.ts` |
| 心情时长与开关超时 | `packages/consts/aiChat/mood.ts` |
| 工具动作/查询上限、打字与错字节奏 | `packages/consts/aiChat/tools.ts` |
| 语音转写的时长/体积上限与占位文案 | `packages/consts/aiChat/voice.ts` |
| 生歌冷却、每轮上限、封面与曲目信息 | `packages/consts/aiChat/songGeneration.ts` |
| 请求超时、重试次数、采样与安全档位 | `packages/consts/aiChat/gemini.ts`、`packages/consts/aiChat/openai.ts` |
| **模型名、provider、key、端点** | 不是常量：`config/agent.json` 按能力配置，见 [01-getting-started](01-getting-started.md) |
| OAI 兼容生图线协议/尺寸能力档 | `config/agent.json` 的必填 `agent.image.image_protocol`；新增档位还要同步类型、固定画幅表、穷举分派与测试 |
| 验证窗口、刷屏阈值、追加/收敛策略 | `packages/consts/antiRaid/` |
| copy 冷却、/quiet 范围、用户名规则、动作命令限流 | `packages/consts/commands.ts` |
| 随机触发的发言人冷却 | `packages/consts/auto.ts` |

步骤：改常量 → 更新它的中文 JSDoc（不变量变了就改说明）→ 检查根 README 是否引用了该数值并同步 → `bun run check`。

> [!WARNING]
> **容量类常量可能与磁盘数据耦合。** 例如调小 `AI_MEMORY_HYDRATE_BUFFER_MAX` 或 `MAX_SUMMARY_ROUNDS` 前，必须按 [04 运行时权威约束](04-invariants.md#持久化) 的要求在旧进程停止后原子重写现有 `memory/ai/` 快照。改这类值前先在 04 里确认没有踩到迁移要求。

## 新增一项可选供应商能力

契约按能力拆成五份最小接口（`AiTextProvider`、`AiSummaryProvider`、`AiMediaProvider`、`AiImageProvider`、`AiSongProvider`），`AiChatProvider` 是它们的组合——实现包导出的仍是这一个完整对象，但 `aiChat/provider.ts` 的每个能力路由只把对应的那一份交出去，跨能力调用在**编译期**就不成立（断言见 `test/aiChat/provider.test.ts` 的 `@ts-expect-error`）。每份接口内部再分必备与可选：必备的（回复会话、纯文本、视觉描述、生图）每家都要实现，可选的（当前是语音转写 `transcribeVoice` 与生歌 `generateSong`）只有实现了的那家才带。

1. **契约**：在 [`packages/types/aiChat/provider.ts`](../../packages/types/aiChat/provider.ts) 用**可选成员**声明，并显式写 `this: void`——可选成员必须先取出来判空再调用，带隐式 this 的方法签名一旦取成变量就丢了接收者。
2. **实现**：只在支持的那个实现包里加，并在该包的 `index.ts` 装配进去。不支持的那家**连键都不要写**：写成 `undefined` 与不写在类型上等价，但读代码的人会以为那是一个待填的坑。
3. **判定**：调用方一律写 `provider.someCapability === undefined`，**绝不写** `provider.name !== "gemini"`。按名字判会让每个调用点各记一份「谁支持什么」的名单，再有第三家或某家补齐能力时，漏改的那处只会在运行期表现成一个不该出现的工具。
4. **缺席的处置要想清楚**：能默默降级的（如语音转写）就留兜底占位并记一行日志，**不得为此临时换一家**；不能降级的（如生歌）就整个不挂那个工具——模型看不到的工具不会被调用。两种都不要留一条「运行期报不支持」的路径当唯一防线。
5. **能力被配置摘挂**：工具按轮组装；`image`/`song` 缺配置或实现成员缺失时，定义与执行器必须一起摘掉，不能对 `undefined` 取调用。

## 新增一个 AI 工具

1. **名称常量**：在 [`packages/consts/tools.ts`](../../packages/consts/tools.ts) 定义工具名；若工具产生可见副作用，确认是否应加入 `ACTION_TOOL_NAMES`。
2. **定义**：无状态的静态查询工具把 `ToolDefinition` 放进 [`packages/aiChat/ai/tools/index.ts`](../../packages/aiChat/ai/tools/index.ts)；需要 chat 上下文、动态 schema 或逐轮状态的行动工具，在 `packages/aiChat/ai/tools/replyToolset/` 提供 definition builder。reply toolset 的 orchestrator 会把这些领域定义统一收敛成中立的 `AiToolDefinition`（JSON Schema 参数），再由各供应商实现包的 `replySession.ts` 转成自家形状——新增工具不需要碰任何一家 SDK 的类型。
3. **实现**：在 `packages/aiChat/ai/tools/` 实现执行逻辑；面向 Telegram 的副作用经主线程代理执行，Worker 内不直接持有 Bot 实例。
4. **注册**：静态查询工具接入 `packages/aiChat/ai/tools/index.ts` 的分发；行动工具接入 `packages/aiChat/ai/tools/replyToolset/` 的 definitions、dispatch 与按轮状态。
5. **预算**：可见副作用工具应加入统一动作预算；不要默认增加单工具调用上限。只有确有领域理由的独立限制（当前为贴纸包查看、服务端联网检索，以及贴纸/反应/生成图片/生成歌曲各一次成功）才单独建常量；整轮自定义函数防循环硬顶仍统一生效（约束见 [04](04-invariants.md#worker-与状态所有权)）。
6. **提示词**：如需使用规则，在 `packages/consts/aiChat/prompts/` 补充；涉及转录格式的必须复用 `transcript.ts` 共享模板，两侧不得各自手写。
7. **测试 + 文档**：`test/aiChat/ai/`（或对应功能/Worker 路径）补测试；根 README「工具」行按需更新。

## 新增一个通用 JSON API 调用

1. 在 [`packages/consts/httpFetch.ts`](../../packages/consts/httpFetch.ts) 的 `JSON_API_ALLOWED_ORIGINS` 显式加入准确的 HTTPS origin；不要放宽成任意 host、HTTP 或 credential URL。
2. 复用 [`packages/libs/httpFetch.ts`](../../packages/libs/httpFetch.ts) 的有界 JSON 读取；redirect 保持禁用，响应体和错误日志都受限。
3. 补充 origin、redirect、超大响应和失败日志测试。Telegram 头像下载是独立媒体入口：Bot API `file.getUrl()` 主路径和 `t.me` 网页/图片回退都必须禁用 redirect 并保持有界读取；不要为了新增 JSON API 而改接该路径。

## 修改人设与 JSON 配置

- 人设：改 [`prompt/persona.md`](../../prompt/persona.md)，重启生效。与转录格式、身份标记耦合的互动规则由代码注入，不写进人设文件。
- 部署配置只改 Git 忽略的 `config/`；`config_example/` 是新部署模板，只有 schema 或默认示例本身变化时才同步。`telegram.json` 在联网前严格加载；`stickers.json`、`reactions.json`、`mood.json` 与其它功能输入按对应启用边界严格校验。白名单、黑名单与待踢 outbox 不属于部署配置，权威数据在 `database/storage.sqlite`；改身份结构时先更新 `packages/database/schema/`、`packages/database/codec/identity.ts`、领域类型与严格校验，再提供停服迁移脚本和故障注入测试，不得重新引入 JSON 兼容读取。

## 新增部署 JSON 配置

1. 在 `packages/config/<domain>.ts` 声明并严格解析（必填/可选、格式校验、未知键拒绝都在这里，解析失败拒绝启动）。
2. 在 `config_example/<domain>.json` 增加不含真实凭据的结构示例，并同步 [`config_example/README/zh.md`](../../config_example/README/zh.md) 的字段说明。
3. 根 README「配置」节与相关环境搭建入口同步。

## 新增运行时缓存

1. 放 `packages/cache/<owner 线程>/<domain>`（线程目录见 [03 目录导览](03-directory-map.md#缓存按线程分权)），文件头注明 owner 模块；可变单例用 holder 对象 `{ current: T | null }`。
2. 每个导出写 JSDoc 生命周期：何时填充、何时清理、Worker 崩溃重启后如何重建。
3. 给出容量上限与清理策略，并核对 [04 运行时权威约束](04-invariants.md#worker-与状态所有权) 对长期容器的要求（有界、有 owner、有重建语义）。
4. 需要随停机 flush/结算的，统一走 `packages/libs/flushBarrier.ts`，不自建 resolver Map。

## 变更持久化 schema

铁律（[AGENTS.md](../../AGENTS.md) 与 [04](04-invariants.md#持久化)）：**代码不保留旧格式兼容逻辑，也不做运行时自动迁移**；不兼容输入直接拒绝启动。因此流程是：

1. 改 `packages/types/` 中的持久化类型与对应校验，写好新格式的严格校验。
2. 补/改测试（`test/infra/storage/`、`test/workers/diskIO/` 等），跑 `bun run test:fault-injection`。
3. **停掉旧进程**（确认 `bot.lock` 释放）。
4. 手动把现有 `state.json`、`state.json.bak` 与受影响的 `memory/` 快照迁移到新格式；迁移前先复制备份。
5. 部署新版并启动。若报两份 state 副本均无效，说明迁移不完整——程序不会动原文件，修好再启。
6. 观察 `.corrupt` 隔离件与 `logs/`，确认无恢复异常后删除临时备份。

**新增可选块可以免掉第 3–4 步**，前提是把「缺省」定义清楚：解码器对整块与块内字段都允许缺省（照 `libs/stateFileCodec.ts` 里 `globalAssets` 的写法，两条分支返回同一组字段，`save` 的自校验才不会看到两种 shape），取值侧收敛出唯一的兜底值。现成范例是 `state.global.assets`——旧文件不用改也能读回，行为与没有这一块时逐字相同。若这一块是给人手工编辑的旋钮，再补一个启动补齐（`seedMissingAssetState`）把缺项写成当前生效值，让键出现在文件里；补齐必须排在**所有会中止启动的 `await` 之后**、只补缺项、走后台落盘，理由见 [04](04-invariants.md#落盘与快照契约)。反过来，**任何会让旧文件解码失败的改动仍然走完整的 3–4 步**。

## 新增一张 SQLite 表

比改 `state.json` 多一条硬约束：**运行时不自动迁移**，库版本对不上就拒绝启动，因此每加一张表都要配一条停机冷迁移。顺序：

1. `packages/database/schema/<domain>.ts` 声明表并注册进 `schema/storage.ts`；`data` 列沿用 `jsonbText` + `jsonDataCheck`，与其余业务表同一口径。
2. 写 `schema/migrations/000N_<name>.sql`，并把条目补进 `migrations/meta/_journal.json`。
3. **hash 要实测，不能算**：建一个临时库跑一次 migration，从 `__drizzle_migrations` 读回 `created_at` 与 `hash`，再写进 `packages/consts/identityStorage.ts`。同时把 `IDENTITY_DATABASE_SCHEMA_VERSION` 加一。
4. 写冷迁移脚本，并**替换** `scripts/conventions/coldMigrations.ts` 里那条唯一的边——约定只允许存在「上一版 → 当前版」一条，旧脚本连同它的测试一起删掉。
5. 迁移**前**的校验必须用那一版的历史形态。若本次改动了某张表的字段闭集（例如给白名单加一个权限键），迁移前不能用生产解码器：它已经按新版要求那个字段存在，拿它去校验待迁库会让每个部署在迁移开始前就被判成损坏，报错还指向部署方从没写过的字段。历史键集合写死在迁移脚本里，不从当前常量推导——推导会在下次加键时悄悄改写这条历史边的判定。
6. 不随版本变的部分（如 `meta`）仍用生产解析器：`--check` 必须拦下 `--apply` 会拒绝的一切，否则坏行要等库已经被改过之后才暴露。
7. 落盘沿用既有 write-through：主线程发布内存最终值 → 投给 Disk I/O Worker → 显式事务 → 精确 revision ACK → Worker 重建后从内存重放。

当前仓库只保留最近发布版到当前版的迁移入口；实现新边时必须同时替换上一条入口、测试与约定登记。

## 改动 Worker 间协议

`packages/types/` 持有跨线程消息协议。改协议时同步三处：类型定义、主线程侧代理（`packages/infra/` 或 `packages/cache/main/` 对应模块）、Worker 侧处理（`packages/workers/<domain>/`）。请求/回执式交互遵循 [04](04-invariants.md#worker-与状态所有权) 的 waiter 先登记再投递、超时/崩溃统一结算模式（现成范例：`/query_mood` 与 `/switch_mood` 共用的心情握手）。

---

<div align="center">

[← 上一页：05 开发流程](05-dev-workflow.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#06-常见修改配方) · [下一页：07 运维与排障 →](07-operations.md)

</div>
