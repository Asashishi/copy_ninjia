# 06 常见修改配方

<p align="center">
  <b>简体中文</b> · <a href="en/06-modification-guide.md">English</a> · <a href="ja/06-modification-guide.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 开发者文档首页</a> · <a href="05-dev-workflow.md">← 上一页：05 开发流程</a> · <a href="07-operations.md">下一页：07 运维与排障 →</a>
</p>

---

每个配方给出触碰的文件与顺序。通用前提：改动前读 [`AGENTS.md`](../AGENTS.md)；涉及运行时数据文件（`state.json`、`memory/`、`bot.lock`）或会间接写它们的代码路径时，动手前先备份；完成后 `bun run check` 全绿并按需同步根 README。

## 新增一个斜杠命令

1. **handler**：在 `packages/commands/` 新建一文件，`function` 声明导出 `handleXxxCommand`，显式返回类型。权限门禁参考现成模式：白名单看 `block.ts`，超管看 `superAdminToggle.ts` / `switchMood.ts`，仅私聊看 `send.ts`（非本人/非私聊静默 return，不回错误提示）。
2. **导出**：加入 `packages/commands/index.ts`。
3. **注册**：在 [`packages/app/registerHandlers.ts`](../packages/app/registerHandlers.ts) 加 `bot.command("xxx", ...)`。注意注册点位于 init 网关、按群串行、私聊网关与入群验证 middleware 之后——新命令自动获得这些语义，不要在 handler 里重复做网关判断。
4. **私聊网关**：新命令若要在私聊中使用，还必须同步调整 [`packages/infra/updateGate.ts`](../packages/infra/updateGate.ts) 并补网关测试；当前私聊中的斜杠命令只显式放行 `/send`，仅注册 handler 不会到达命令处理器。纯群聊命令无需改这里。
5. **菜单**：要出现在 Telegram 命令菜单就在 [`packages/consts/commands.ts`](../packages/consts/commands.ts) 的 `BOT_COMMANDS` 加一项；像 `/send` 这类隐藏命令则不加。
6. **参数常量**：冷却、阈值等进 `packages/consts/commands.ts` 或对应领域 consts，带中文 JSDoc。
7. **测试**：`test/commands/xxx.test.ts`，至少覆盖权限拒绝、参数解析与主路径。
8. **文档**：根 README「命令与权限」表加一行。

### 非 ASCII 命令名

`/咬`、`/贴贴` 这类中文动作命令（动作词收 1~2 个中文字）走另一条路，现成范例见 [`cjkAction.ts`](../packages/commands/cjkAction.ts)：

- **改用 `bot.hears` 匹配**：Telegram 只为 ASCII 命令生成 `bot_command` 实体，`bot.command` 永远匹配不到。必须用 `bot.hears(正则, ...)` 按消息原文匹配，并注册在消息兜底处理器 `bot.on(["message", "channel_post"], ...)` 之前，否则会被当作普通消息进入 AI/复读流水线。
- **目标解析走另一条入口**：这类 handler 拿到的是普通 `Context` 而非 `CommandContext`，改为直接给 [`targetResolution.ts`](../packages/commands/targetResolution.ts) 的 `resolveCommandTarget` 传 `ResolveCommandTargetParams`。不认领的形态（`/咬@OtherBot`、只有 caption 的消息、消息形态异常）必须 `next()` 放行，不能静默吞掉更新。
- **只认 `message.text`**：`bot.hears` 对 text 和 caption 都会匹配，但认领一条带图消息意味着它不再流进 `handleIncomingMessage`，那张图就不会进 AI 滚动记忆与视觉流水线。
- **自己补上流水线的前置动作**：注册点在自动流水线**之前**，拿不到它那道自发消息门禁与 `cacheSender`。handler 必须自己调 `isBotOwnMessage` 跳过机器人自己的消息（否则频道回弹会形成自问自答的刷屏循环），并自己把发起人写进 username 缓存。
- **不能进 `BOT_COMMANDS` 菜单**：BotFather 的命令名同样只收 ASCII（拉丁字母、数字、下划线，最长 32 字符）。`setMyCommands` 是整体提交，混入一个非法名会让整份菜单以 `BOT_COMMAND_INVALID` 失败，而注册失败只记日志不阻断启动，菜单会静默消失。想在菜单里曝光用法，就加一条 ASCII 占位说明项（现有的 `/x`），把语法写在 description 里。
- **占位项必须注册 handler**：点菜单会真的把命令发出去，不注册就会落到消息兜底、被当成普通消息进入 AI/复读流水线；而注册成完全不做事的空 handler 又会让点了菜单的人只收到一片沉默。正确做法是回一条用法提示并就此终止链路。
- **必须自带全局限流**：这类命令没有命令菜单那层天然约束，谁都能随手造一个动作词。窗口与上限进 `packages/consts/commands.ts`，时间戳队列进 `packages/cache/<domain>.ts`，判定复用 [`libs/slidingWindowRateLimit.ts`](../packages/libs/slidingWindowRateLimit.ts)（纯函数，就地维护调用方传入的队列，本身不持有状态）。

## 在回复里加链接或格式

`sendMessage` 一律不设 `parse_mode`——用户昵称、消息内容里的标记字符不能有机会变成格式或链接。确实需要富文本时，由调用方把文本按段拼好、自己算出 `entities` 偏移传进 `sendMessage`（见 [`infra/telegram/actions.ts`](../packages/infra/telegram/actions.ts)）。偏移按 Telegram 的 UTF-16 code unit 口径计，正好等于 JS 的 `String#length`，昵称里的 emoji（代理对）自然占 2 个单位，不必额外换算；长度为 0 的实体会让 Telegram 整条拒收，空文本段不要挂实体。范例见 `cjkAction.ts` 的 `buildActionMessage`。

## 换成别的语言：不做 i18n，请自行 fork

面向用户的文案只有简体中文一套，仓库不提供也不接受 i18n 层——文案不是能替换的字典项：

- 大量回复由片段拼接而成，还要同时算出 Telegram `entities` 的 UTF-16 偏移（见上一节）。换语言意味着词序、长度、乃至句子该不该拆都变了，偏移必须跟着重算，key-value 词条表接不住这类文案。
- `/咬` 这类中文动作命令依赖中文形态本身（见「新增一个斜杠命令」末尾），换成别的语言就不再是同一个交互。
- 人设、工具描述与提示词（[`prompt/persona.md`](../prompt/persona.md)、`packages/consts/aiChat/prompts/`）用中文写成，模型的输出语言也由它们决定。

需要别的语言就 fork 一份自己改。生产代码里含中文的字符串字面量约 465 处、分布在 56 个文件，加上 `prompt/persona.md` 与 `config/*.json`：整份 fork 交给 AI vibe 一遍，比在上游架一层抽象再逐条填词更省事，也不会把偏移计算这类逻辑复杂化。改完照常 `bun run check`。

## 调整行为参数

参数全部集中在 `packages/consts/`，改值不动业务代码。常用位置：

| 想调什么 | 文件 |
| :--- | :--- |
| AI 触发概率、限频、并发、队列 | `packages/consts/aiChat/rateLimit.ts` |
| AI 记忆容量、快照周期、压缩背压 | `packages/consts/aiChat/memory.ts` |
| 媒体描述长度、执行槽、LRU 容量 | `packages/consts/aiChat/media.ts` |
| 生图冷却与字节上限 | `packages/consts/aiChat/imageGeneration.ts` |
| 心情时长与开关超时 | `packages/consts/aiChat/mood.ts` |
| 工具动作/查询上限、模型名、请求超时 | `packages/consts/aiChat/tools.ts` |
| 验证窗口、刷屏阈值、追加/收敛策略 | `packages/consts/antiRaid/` |
| copy 冷却、/quiet 范围、用户名规则、动作命令限流 | `packages/consts/commands.ts` |
| 随机触发的发言人冷却 | `packages/consts/auto.ts` |

步骤：改常量 → 更新它的中文 JSDoc（不变量变了就改说明）→ 检查根 README 是否引用了该数值并同步 → `bun run check`。

> [!WARNING]
> **容量类常量可能与磁盘数据耦合。** 例如调小 `AI_MEMORY_HYDRATE_BUFFER_MAX` 或 `MAX_SUMMARY_ROUNDS` 前，必须按 [04 运行时权威约束](04-invariants.md#持久化) 的要求在旧进程停止后原子重写现有 `memory/ai/` 快照。改这类值前先在 04 里确认没有踩到迁移要求。

## 新增一个 AI 工具

1. **名称常量**：在 [`packages/consts/tools.ts`](../packages/consts/tools.ts) 定义工具名；若工具产生可见副作用，确认是否应加入 `ACTION_TOOL_NAMES`。
2. **定义**：无状态的静态查询工具把 `ToolDefinition` 放进 [`packages/ai/tools/index.ts`](../packages/ai/tools/index.ts)；需要 chat 上下文、动态 schema 或逐轮状态的行动工具，在 `packages/ai/tools/replyToolset/` 提供 definition builder。reply toolset 的 orchestrator 会把这些领域定义统一转换成 SDK `FunctionDeclaration`。
3. **实现**：在 `packages/ai/tools/` 实现执行逻辑；面向 Telegram 的副作用经主线程代理执行，Worker 内不直接持有 Bot 实例。
4. **注册**：静态查询工具接入 `packages/ai/tools/index.ts` 的分发；行动工具接入 `packages/ai/tools/replyToolset/` 的 definitions、dispatch 与按轮状态。
5. **预算**：可见副作用工具应加入统一动作预算；不要默认增加单工具调用上限。只有确有领域理由的独立限制（当前为贴纸包查看、Google Search，以及贴纸/反应/生成图片各一次成功）才单独建常量；整轮自定义函数防循环硬顶仍统一生效（约束见 [04](04-invariants.md#worker-与状态所有权)）。
6. **提示词**：如需使用规则，在 `packages/consts/aiChat/prompts/` 补充；涉及转录格式的必须复用 `transcript.ts` 共享模板，两侧不得各自手写。
7. **测试 + 文档**：`test/ai/`（或对应 workers 路径）补测试；根 README「工具」行按需更新。

## 新增一个通用 JSON API 调用

1. 在 [`packages/consts/httpFetch.ts`](../packages/consts/httpFetch.ts) 的 `JSON_API_ALLOWED_ORIGINS` 显式加入准确的 HTTPS origin；不要放宽成任意 host、HTTP 或 credential URL。
2. 复用 [`packages/libs/httpFetch.ts`](../packages/libs/httpFetch.ts) 的有界 JSON 读取；redirect 保持禁用，响应体和错误日志都受限。
3. 补充 origin、redirect、超大响应和失败日志测试。Telegram 头像爬虫是独立媒体入口，不要为了新增 JSON API 而改接或收紧该路径。

## 修改人设与 JSON 配置

- 人设：改 [`prompt/persona.md`](../prompt/persona.md)，重启生效。与转录格式、身份标记耦合的互动规则由代码注入，不写进人设文件。
- `config/stickers.json` / `reactions.json` / `mood.json` / `ad_samples.json`：schema 在 `packages/config/` 对应文件，启动时严格校验（贴纸包最多 5 个；mood 权重必须为正整数且总和恰好 100；广告示例顶层就是字符串数组，条目非空、不重复、最多 500 条）。改结构时先改 `packages/config/` 的 schema 与 `packages/types/`，再改 JSON，配错会拒绝启动。

## 新增环境变量

1. `packages/infra/config.ts` 声明并解析（必填/可空、格式校验都在这里，解析失败拒绝启动）。
2. [`.env.example`](../.env.example) 加注释示例。
3. 根 README「配置」节与 [01 环境搭建](01-getting-started.md#配置-env) 的变量表同步。

## 新增运行时缓存

1. 放 `packages/cache/<domain>/`（或领域文件），文件头注明 owner 模块；可变单例用 holder 对象 `{ current: T | null }`。
2. 每个导出写 JSDoc 生命周期：何时填充、何时清理、Worker 崩溃重启后如何重建。
3. 给出容量上限与清理策略，并核对 [04 运行时权威约束](04-invariants.md#worker-与状态所有权) 对长期容器的要求（有界、有 owner、有重建语义）。
4. 需要随停机 flush/结算的，统一走 `packages/libs/flushBarrier.ts`，不自建 resolver Map。

## 变更持久化 schema

铁律（[AGENTS.md](../AGENTS.md) 与 [04](04-invariants.md#持久化)）：**代码不保留旧格式兼容逻辑，也不做运行时自动迁移**；不兼容输入直接拒绝启动。因此流程是：

1. 改 `packages/types/` 中的持久化类型与对应校验，写好新格式的严格校验。
2. 补/改测试（`test/infra/storage/`、`test/workers/diskIO/` 等），跑 `bun run test:fault-injection`。
3. **停掉旧进程**（确认 `bot.lock` 释放）。
4. 手动把现有 `state.json`、`state.json.bak` 与受影响的 `memory/` 快照迁移到新格式；迁移前先复制备份。
5. 部署新版并启动。若报两份 state 副本均无效，说明迁移不完整——程序不会动原文件，修好再启。
6. 观察 `.corrupt` 隔离件与 `logs/`，确认无恢复异常后删除临时备份。

## 改动 Worker 间协议

`packages/types/` 持有跨线程消息协议。改协议时同步三处：类型定义、主线程侧代理（`packages/infra/` 或 `packages/cache/` 对应模块）、Worker 侧处理（`packages/workers/<domain>/`）。请求/回执式交互遵循 [04](04-invariants.md#worker-与状态所有权) 的 waiter 先登记再投递、超时/崩溃统一结算模式（现成范例：`/switch_mood` 握手）。

---

<div align="center">

[← 上一页：05 开发流程](05-dev-workflow.md) · [📚 开发者文档首页](README.md) · [⬆️ 回到顶部](#06-常见修改配方) · [下一页：07 运维与排障 →](07-operations.md)

</div>
