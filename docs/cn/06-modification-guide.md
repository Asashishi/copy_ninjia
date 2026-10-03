# 06 常见修改配方

<p align="center">
  <b>简体中文</b> · <a href="../en/06-modification-guide.md">English</a> · <a href="../ja/06-modification-guide.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="05-dev-workflow.md">← 上一页：05 开发流程</a> · <a href="07-operations.md">下一页：07 运维与排障 →</a>
</p>

---

每个配方给出触碰的文件与实现顺序。

> [!IMPORTANT]
> **通用前提**：
> - 改动前阅读 [`AGENTS.md`](../../AGENTS.md)。
> - 实际改动部署配置或运行时数据、运行可能写入真实部署数据的生产入口前，先备份受影响文件；普通源码修改与独立临时数据根测试不触发部署备份流程。
> - 提交前运行 `bun run lint && bun run typecheck` 或完整的 `bun run check`；合入 `master` 前必须通过 `bun run check`。文档、README 和指标仅在用户明确要求时更新。

---

## 增加并发批处理

- **确定性落定**：固定且互不依赖的 Promise 用 `Promise.allSettled` 等齐，并逐项处理 rejection，**严禁使用 settlement 吞错**。
- **动态输入限流**：输入规模可能动态增长时，复用 [`runBoundedSettledBatch`](../../packages/libs/boundedSettledBatch.ts)，明确并发硬上限，并从结果的 `item/index/attempt` 记录失败身份。禁止先 `map` 成整批 Promise 再等待。
- **有限退避**：只有领域能区分瞬时错误时才配置有限退避，并通过 `shouldRetry` 和 `onRetry` 约束错误类型并记录退避。下层已重试的逻辑切勿重复叠加，严禁重试非幂等副作用。
- **Drain 等待**：仅为 drain 已登记任务而取的快照无需引入任务池，前提是快照不产生新任务，且各任务已内置错误隔离。

---

## 新增一个斜杠命令

1. **实现 Handler**：
   - 在 `packages/commands/` 导出带显式返回类型的 `handleXxxCommand`。
   - 权限校验：按权限键授权使用 `rejectUnlessPermitted(ctx, key, rejection)`；仅超级管理员可用使用 `rejectUnlessSuperAdmin(ctx, rejection)`（见 `commands/commandActor.ts`）。
   - 文案体系：固定提示与格式化函数放入 `packages/consts/atmosphere/{teasing,plain}/` 对应领域文件，两版使用同一类型定义。主线程通过 `chatAtmosphere()` 读取当前风格文案。
2. **导出模块**：加入 `packages/commands/index.ts`。
3. **注册命令**：
   - 在 [`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts) 的 `commands` 子链上追加 `commands.command("xxx", ...)`。
   - **严禁直接挂到 `bot` 上**：命令一律收在 `bot.on(":entities:bot_command")` 子链后面。注册点位于 init 网关、按群串行、私聊网关与入群验证中间件之后，自动继承这些前置安全边界。
4. **私聊网关配置**：若命令允许在私聊中使用，必须同步调整 [`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts)；当前私聊命令仅显式放行 `/send`。纯群聊命令无需修改。
5. **菜单配置**：在 `packages/consts/atmosphere/{teasing,plain}/commands.ts` 的两份 `BOT_COMMANDS` 中同时添加命令描述。
6. **参数常量**：冷却、阈值等常量放入 `packages/consts/commands.ts` 或对应领域的 `packages/consts/<domain>.ts`，附加中文 JSDoc。
7. **自动化测试**：编写 `test/commands/xxx.test.ts`，至少覆盖权限拒绝、参数解析与主执行链路。
8. **文档更新**：在三语 `docs/{cn,en,ja}/09-commands.md` 命令表中登记条目及权限边界。

### 非 ASCII 命令名

中文动作命令（如 `/咬`、`/贴贴`，动作词 1~2 个中文字）参考 [`cjkAction.ts`](../../packages/commands/cjkAction.ts) 的专属实现路径：

- **`bot.hears` 匹配**：Telegram 只为 ASCII 命令生成 `bot_command` 实体。中文命令必须使用 `hears(正则, ...)` 匹配消息原文，注册在 `cjkActions` 子 Composer 上（以 `^\/` 开头），排在普通消息兜底之前。
- **独立目标解析**：直接向 `resolveCommandTarget` 传递 `ResolveCommandTargetParams`；不匹配形态必须 `next()` 放行，不可吞掉更新。
- **仅认 `message.text`**：带图消息不走此路径，避免绕过图片视觉流水线与 AI 记忆。
- **补全前置流水线**：由于注册在自动流水线之前，需自行调用 `isBotOwnMessage` 排除 Bot 自身消息，并主动向用户名缓存记录发起人。
- **显式留存语义**：动作成功结果长期保留，调用 `sendCommandMessage` 时显式传入 `preserveInGroup: true`；参数校验失败仍走 30 秒自删。
- **菜单与占位项**：Telegram 命令菜单只接受 ASCII。在菜单中使用 ASCII 占位项 `/x` 展示语法，并为其注册空指令提示 handler，阻止落入普通消息兜底。
- **全局滑动窗口限流**：中文动作命令无菜单约束，必须配合滑动窗口限流（如 90 秒内 450 次，复用 `libs/slidingWindowRateLimit.ts`）。

---

## 在回复里加链接或格式

富文本与纯文本二选一（`entities` 与 `parseMode` 在类型上互斥，见 [`packages/infra/telegram/actions.ts`](../../packages/infra/telegram/actions.ts)）：

- **MarkdownV2 模式**：
  - 给 `sendMessage` 或 `sendCommandMessage` 传 `parseMode: MARKDOWN_V2_PARSE_MODE`。
  - 正文**全部**经 [`libs/telegramMarkdown.ts`](../../packages/libs/telegramMarkdown.ts) 转义与构造（普通文字调 `escapeMarkdownV2`，粗体/代码块/链接调对应拼装函数）。
  - 动态昵称、模型输出和固定文案**绝对不能绕过转义直接拼接**，漏转任一保留字符会导致整条消息被拒。
  - 单测使用 `test/helpers/markdownV2.ts` 的参照解析器核验解析结果。
- **Entities 显式标注**：
  - 由调用方按段拼装文本并计算 `entities` 的 UTF-16 code unit 偏移量。
  - 代理对字符（如 emoji）占 2 个单位；长度为 0 的实体会导致整条消息被拒。

---

## 换成别的语言：不做 i18n，请自行 fork

用户可见的固定文案均为简体中文，`packages/consts/atmosphere/` 提供雌小鬼版与普通版。

- 文案表保存固定字符串与格式化函数，Telegram entities 偏移由最终渲染文本计算。
- `/咬` 等动作命令解析与展示文案分别维护。
- AI 人设缺省使用 `packages/consts/aiChat/prompts/persona.ts`，存在 `prompt/persona.md` 时采用自定义文件。
- 若需支持其他语种，建议自行 fork 仓库并完整替换上述文案模块与配置。

---

## 调整行为参数

所有业务参数集中于 `packages/consts/`，修改参数不改动业务逻辑：

| 想调什么 | 对应文件 |
| :--- | :--- |
| AI 触发概率、限频、并发、队列 | `packages/consts/aiChat/rateLimit.ts` |
| AI 记忆容量、快照周期、压缩背压 | `packages/consts/aiChat/memory.ts` |
| 媒体描述长度、执行槽、LRU 容量 | `packages/consts/aiChat/media.ts` |
| 生图冷却与字节上限 | `packages/consts/aiChat/imageGeneration.ts` |
| 心情时长与开关超时 | `packages/consts/aiChat/mood.ts` |
| 工具动作/查询上限、打字与错字节奏 | `packages/consts/aiChat/tools.ts` |
| 语音转写的时长/体积上限与占位文案 | `packages/consts/aiChat/voice.ts` |
| 语音工具的每轮上限、台词/语气长度、每日额度 | `packages/consts/aiChat/voiceMessage.ts` |
| 请求超时、重试次数、采样与安全档位 | `packages/consts/aiChat/gemini.ts`、`packages/consts/aiChat/openai.ts` |
| **模型名、provider、key、端点** | **不是常量**：在 `config/dynamic/agent.json` 按能力配置 |
| OAI 兼容生图线协议/尺寸能力档 | `config/dynamic/agent.json` 的 `agent.image.image_protocol` |
| 验证窗口、刷屏阈值、追加/收敛策略 | `packages/consts/antiRaid/` |
| Copy 冷却、/quiet 范围、动作命令限流 | `packages/consts/commands.ts` |
| 随机触发的发言人冷却 | `packages/consts/auto.ts` |

**修改流程**：修改常量 → 更新对应中文 JSDoc → 运行提交前门禁；用户明确要求更新文档时，再同步 README 中受影响的引用。合入 `master` 前运行 `bun run check`。

> [!WARNING]
> **容量类常量可能与磁盘数据耦合**：
> 调小 `AI_MEMORY_HYDRATE_BUFFER_MAX` 或 `MAX_SUMMARY_ROUNDS` 等常量前，必须按 [04 运行时权威约束](04-invariants.md#持久化) 规范在停机状态下通过 SQLite 事务重写现有 `chat_states.ai_context` 快照，否则新版本启动会拒绝旧格式数据。

---

## 新增一项可选供应商能力

能力契约拆分为 6 份独立最小接口（`AiTextProvider`、`AiSummaryProvider`、`AiMediaProvider`、`AiImageProvider`、`AiSpeechProvider`、`AiWebSearchProvider`），由 `AiChatProvider` 组合汇聚：

1. **契约声明**：在 [`packages/types/aiChat/provider.ts`](../../packages/types/aiChat/provider.ts) 用可选成员声明，并显式标注 `this: void`。
2. **实现注入**：仅在支持的实现包中添加并在其 `index.ts` 导出。不支持的厂商**连键都不要声明**（保持 undefined）。
3. **能力判断**：调用方一律通过 `provider.someCapability === undefined` 判定，**绝对不可通过厂商名字判断**（如 `provider.name !== "gemini"`）。
4. **缺失降级策略**：能降级（如语音转写）的保留占位并记日志，严禁临时切换跨厂商调用；不能降级（如语音合成）的直接不挂载该工具。
5. **动态摘挂**：工具按轮组装，缺少对应能力配置或实现缺失时，定义与执行器必须一并摘除。

---

## 新增一个 AI 工具

1. **名称常量**：在 [`packages/consts/tools.ts`](../../packages/consts/tools.ts) 声明工具名；副作用工具登记至 `ACTION_TOOL_NAMES`。
2. **工具定义**：静态查询工具加进 `TOOL_DECLARATIONS`；行动工具在 `packages/aiChat/ai/tools/replyToolset/` 提供 definition builder。中立的 `AiToolDefinition` 会由实现包按需转换为厂商特定 Schema。
3. **执行实现**：在 `packages/aiChat/ai/tools/` 编写执行逻辑；Telegram 副作用经主线程代理执行。
4. **分发注册**：静态工具接入 `tools/index.ts` 的 `callTool`；行动工具接入 `replyToolset/` 的 definitions 与 dispatch 流程。
5. **预算控制**：可见副作用工具纳入统一动作预算（硬上限 11）；每轮独立限制仅用于明确的领域限制（如贴纸、生图、语音各一次）。
6. **提示词规范**：在 `packages/consts/aiChat/prompts/` 补充规则说明，涉及转录格式必须复用 `transcript.ts`。
7. **验证与文档**：补充 `test/aiChat/ai/` 单元测试，并在三语文档中同步工具说明。

---

## 新增一个通用 JSON API 调用

1. 在 [`packages/consts/httpFetch.ts`](../../packages/consts/httpFetch.ts) 的 `JSON_API_ALLOWED_ORIGINS` 中显式添加准入的 HTTPS Origin。严禁放宽为任意 Host 或 HTTP 协议。
2. 复用 [`packages/infra/httpFetch.ts`](../../packages/infra/httpFetch.ts) 的有界 JSON 读取器；保持禁用重定向，严格限制响应体与错误日志长度。
3. 补充针对 Origin 校验、重定向阻断、响应超限及错误处理的单测。

---

## 修改人设与 JSON 配置

- **人设维护**：内置人设位于 `packages/consts/aiChat/prompts/persona.ts`；自定义人设在项目根放置 `prompt/persona.md`，重启后全局生效。通知优先采用显式 `atmosphere`，未配置风格时自定义人设使用普通文案。
- **配置文件**：开发中只修改被 Git 忽略的 `config/`；`config_example/` 仅作为模板。
  - `config/dynamic/` 支持热重载（`assets.json`、`ad_samples.json`、`agent.json`、`mood.json`、`stickers.json`、`cron.json`）。
  - `config/static/` 需重启生效（`bot.json`、`g-auth.json`）。
- **表情与名单**：反应表情由 `AI_REACTION_EMOJIS` 约束。黑白名单权威存储在 SQLite，不通过 JSON 维护。

---

## 新增部署 JSON 配置

1. 在 `packages/config/<domain>.ts` 声明严格解析器（必填/可选、范围、未知键拒绝）。
2. 在 `config_example/static/` 或 `config_example/dynamic/` 提供脱敏示例，同步三语 `config_example/README/`。
3. 若需热重载，在 `packages/config/reload.ts` 登记读取与快照广播。
4. 同步三语环境搭建说明。

---

## 新增运行时缓存

1. 放入 `packages/cache/<owner 线程>/<domain>.ts`，文件首行写 `/** owner: <main|perThread|workers/<线程>>。…`（与目录一致，`bun run check:conventions` 核对）；可变单例使用 `{ current: T | null }`。
2. 每个导出编写 JSDoc：说明生命周期、填充时机、清理策略与 Worker 重建方式。
3. 明确容量上限，满足有界、有属主、可重建的不变量要求。
4. 涉及停机 flush 的统一接入 `packages/libs/flushBarrier.ts`。

---

## 变更持久化 schema

> [!CAUTION]
> **绝对准则**：代码中**不保留旧格式兼容逻辑，亦不做运行时自动迁移**。非法格式直接拒绝启动。

1. 修改 `packages/types/` 中的持久化类型与严格校验逻辑。
2. 补充并修改测试，运行 `bun run test:fault-injection`。
3. **停止旧进程**，确认 `bot.lock` 已释放。
4. 外部备份数据后，手工将现有 `memory/global/state.json` 与相关文件迁移至新格式。
5. 启动新版本验证。若校验失败，排查遗漏字段并修正。
6. 观察至少两个 supervisor 重启周期，确认运行稳定后清理临时备份。

---

## 新增一张 SQLite 表

运行时不自动执行数据库迁移，表结构不匹配时拒绝启动：

1. 在 `packages/database/schema/<domain>.ts` 声明表结构并接入 `schema/storage.ts`。
2. 编写 `schema/migrations/000N_<name>.sql` 并更新 `migrations/meta/_journal.json`。
3. 在临时数据库执行迁移，从 `__drizzle_migrations` 读取真实 `created_at` 与 `hash` 填入 `packages/consts/identityStorage.ts`，并将 `IDENTITY_DATABASE_SCHEMA_VERSION` 加 1。
4. 编写停机冷迁移脚本，并在 `scripts/migrations/active.ts` 登记新迁移边，清理被替代的旧边。
5. 迁移脚本中严格使用对应版本的历史 Schema 解码待迁数据。
6. 独立产物经双向哈希校验通过后生成 `ready.json`。
7. 数据落盘遵循 Write-Through 事务流。

---

## 改动 Worker 间协议

跨线程消息协议归 `packages/types/` 所有。修改协议时同步更新三处：
1. `packages/types/` 类型定义。
2. 主线程侧代理（`packages/infra/` 或 `packages/cache/main/`）。
3. Worker 侧处理函数（`packages/workers/<domain>/`）。
请求/回执交互遵循 Waiter 预登记、超时/崩溃统一定向结算模式。

---

<div align="center">

[← 上一页：05 开发流程](05-dev-workflow.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#06-常见修改配方) · [下一页：07 运维与排障 →](07-operations.md)

</div>
