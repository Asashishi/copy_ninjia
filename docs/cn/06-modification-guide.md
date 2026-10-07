# 06 常见修改配方

<p align="center">
  <b>简体中文</b> · <a href="../en/06-modification-guide.md">English</a> · <a href="../ja/06-modification-guide.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="05-dev-workflow.md">← 上一页：05 开发流程</a> · <a href="07-operations.md">下一页：07 运维与排障 →</a>
</p>

---

本页汇总开发中最常见的修改场景，列出每个场景需要触碰的文件与标准的实现步骤。

> [!IMPORTANT]
> **开发通用准则**：
> - 动手前请先阅读 [`AGENTS.md`](../../AGENTS.md) 了解项目规范与安全红线。
> - 若涉及修改真实部署配置、运行时状态数据，或运行可能写入真实环境的入口，必须先做好外部备份；普通源码开发、单元测试与基于独立临时目录的测试不受此限。
> - 提交前请执行 `bun run lint && bun run typecheck`（或全量 `bun run check`）；合入 `master` 必须确保 `bun run check` 完全通过。文档、README 与测试指标只在明确要求时同步。

---

## 增加并发批处理

处理并发异步任务时，需遵循以下可靠性规范：

- **避免静默吞错**：对于数量固定、彼此独立的异步操作，统一使用 `Promise.allSettled` 并行等待。必须逐项检查并处理每个 rejected 结果，严禁用空 catch 或无视 settlement 掩盖异常。
- **动态批量必须限流**：如果待处理项数量由外部输入动态决定，禁止直接用 `Promise.all(list.map(...))` 瞬间拉起全量请求。应复用 [`runBoundedSettledBatch`](../../packages/libs/boundedSettledBatch.ts) 设定并发上限，并根据返回结果中的 `item` 或 `index` 精确定位失败项。
- **重试职责单点化**：`runBoundedSettledBatch` 仅负责调度执行一次，不自动重试。只有当下层服务能明确识别“瞬时网络抖动”等可恢复错误时，才允许在对应业务层按需加入有限次数的退避重试；严禁在多层重复嵌套重试逻辑，绝不能重试具有非幂等副作用的操作。
- **任务排空（Drain）**：在退出或清理阶段等待已登记的任务执行完毕时，若任务本身已做好异常捕获且不会派生新任务，直接快照排空即可，不需要额外引入复杂的任务池。

---

## 新增一个斜杠命令

实现一个标准的斜杠命令（例如 `/my_cmd`），推荐按以下顺序推进：

1. **编写命令处理函数（Handler）**：
   - 在 `packages/commands/` 目录下创建对应的文件，导出强类型返回的 `handleXxxCommand`。
   - **权限检查**：需要特定功能权限的命令，调用 `rejectUnlessPermitted(ctx, key, rejection)`；仅允许超级管理员使用的系统命令，调用 `rejectUnlessSuperAdmin(ctx, rejection)`（参考 `commands/commandActor.ts`）。
   - **文案组织**：命令回复文案按调侃风（`teasing`）与普通风（`plain`）分别保存在 `packages/consts/atmosphere/{teasing,plain}/` 中对应的领域文件，两份文案需遵循相同的接口类型。业务逻辑通过 `chatAtmosphere()` 获取当前风格文案。
2. **导出模块**：将新增的命令处理函数在 `packages/commands/index.ts` 中统一导出。
3. **注册路由**：
   - 打开 [`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts)，在 `commands` 子链上调用 `commands.command("xxx", ...)` 注册命令。
   - **严禁直接挂到根实例 `bot` 上**：命令必须注册在 `:entities:bot_command` 外层网关后面的专用 Composer 上。此位置已处于初始化检查、私聊过滤、身份预热、入群验证、禁言（gag）以及 `/qa` 表单拦截之后，能自动继承这些前置安全防护。
4. **私聊网关放行**：如果该命令允许在私聊中执行，需同步修改 [`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts) 的放行白名单（当前私聊默认只放行 `/send`）。纯群聊命令无需改动此项。
5. **更新命令菜单**：在 `packages/consts/atmosphere/{teasing,plain}/commands.ts` 两份配置中的 `BOT_COMMANDS` 列表内，同时登记新命令的描述文本。
6. **提取配置常量**：冷却时间、触发阈值等数值应统一放入 `packages/consts/commands.ts` 或对应的 `packages/consts/<domain>.ts` 中，并附上中文 JSDoc 说明。
7. **编写自动化测试**：在 `test/commands/xxx.test.ts` 中补齐单元测试，至少覆盖权限拒绝拦截、参数边界解析以及正常执行路径。
8. **同步命令文档**：在三语文档 `docs/{cn,en,ja}/09-commands.md` 的命令列表中记录该命令的作用与所需权限。

### 非 ASCII 命令名

Telegram 官方仅对 ASCII 字符开头的命令自动生成 `bot_command` 实体。中文动作命令（如 `/咬`、`/贴贴` 等 1~2 个汉字动作）需要走专属的匹配链路，具体参考 [`cjkAction.ts`](../../packages/commands/cjkAction.ts)：

- **使用 `bot.hears` 匹配原文**：中文命令不能通过 `bot.command` 捕获，必须用 `hears(正则, ...)` 匹配消息文本。该路由注册在 `cjkActions` 子 Composer 上（正则匹配以 `^\/` 开头，见 `CJK_ACTION_COMMAND_PATTERN`），置于普通群消息兜底逻辑之前。
- **目标解析与放行**：将消息直接传给 `resolveCommandTarget` 进行目标解析；如果不匹配中文动作命令格式，必须显式调用 `next()` 放行给后续中间件，切勿吞掉消息更新。
- **仅处理文本消息**：仅认 `message.text`，带媒体附带的说明文字（caption）应直接 `next()` 放行回到常规消息流水线。
- **手动补齐前置检查**：因为中文动作命令注册在全自动流水线之前，Handler 内部需要主动调用 `isBotOwnMessage`、`needsBotOwnMessageWait` 与 `waitForBotOwnMessage` 处理机器人自身发出的消息，并通过 `updateCachedIdentity` 刷新发送者的本地身份缓存。
- **消息保留与自删规则**：动作成功后的回复需要长期保留，调用 `sendCommandMessage` 时需显式指定 `preserveInGroup: true` 并传入当前触发话题 `messageThreadId`；若参数不合法或用户触发 `/x` 用法提示，则走默认的 30 秒自动删除。
- **菜单展示与占位命令**：由于 Telegram 客户端菜单只支持 ASCII 字符，我们在菜单中使用 ASCII 占位符 `/x` 作为中文动作命令的用法展示，并专门注册 `handleCjkActionUsageCommand` 回复使用说明。
- **滑动窗口限流**：由于无法依赖 Telegram 原生菜单约束，中文命令极易被连续刷屏。必须配合滑动窗口限流机制（通过 `libs/slidingWindowRateLimit.ts` 结合 `CJK_ACTION_RATE_LIMIT_WINDOW_MS` 和 `CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW`）限制单群调用频率。

---

## 在回复里加链接或格式

Telegram 发送富文本支持 MarkdownV2 与 Entities 两种机制，二者在类型上严格互斥（详见 [`packages/infra/telegram/actions/messages.ts`](../../packages/infra/telegram/actions/messages.ts) 中的 `SendMessageFormat`）：

- **MarkdownV2 模式（推荐用于静态/模板组合）**：
  - 调用 `sendMessage` 或 `sendCommandMessage` 时，指定 `parseMode: MARKDOWN_V2_PARSE_MODE`。
  - 消息正文**所有部分**都必须经由 [`libs/telegramMarkdown.ts`](../../packages/libs/telegramMarkdown.ts) 安全构造（普通文字调 `escapeMarkdownV2`，粗体、代码块或超链接使用专门的拼装工具函数）。
  - 用户昵称、AI 生成内容等动态字符串严禁未转义直接拼入模板；如果 Markdown 格式解析失败，将直接报错并按发送失败处理，绝不静默降级为纯文本发送。
  - 在单元测试中使用 `test/helpers/markdownV2.ts` 的参照解析器核验最终拼出的文本结构。
- **Entities 显式标注（适用于精准定位高亮）**：
  - 由调用方手动拼接纯文本，并精确计算每个高亮实体的 UTF-16 code unit 偏移量与长度。
  - 注意代理对字符（如 emoji）在 UTF-16 下占 2 个单位；长度为 0 的实体将被 Telegram 拒绝，禁止提交。

---

## 换成别的语言：不做 i18n，请自行 fork

系统所有面向用户的固定文案与提示均为简体中文，`packages/consts/atmosphere/` 下提供了“调侃/雌小鬼风格（teasing）”与“常规克制风格（plain）”两套实现。

- 固定提示与格式化函数统一由文案字典维护，Telegram entities 偏移量基于最终渲染生成的文本计算。
- 动作命令（如 `/咬`）的匹配词与回复模版独立存储。
- AI 人设提示词默认读取 `packages/consts/aiChat/prompts/persona.ts`；若在仓库根目录创建了 `prompt/persona.md`，将优先采用该自定义文件。
- `send_voice` 语音工具说明默认根据 `agent.tts.bot_language` 选择 `packages/consts/aiChat/prompts/tools.ts` 中的 `VOICE_LANGUAGE_PROMPTS`；若存在 `prompt/voice_tool.md`，则采用该自定义文件。
- 本项目架构设计上不做多语言（i18n）动态切换机制。若需适配其他语言，建议直接 fork 仓库并在对应常量与提示词文件中全面替换文案。

---

## 调整行为参数

机器人的所有业务参数均集中声明在 `packages/consts/` 下，调节系统行为通常只需修改常量，无需改动核心代码：

| 调整目标 | 对应配置文件 |
| :--- | :--- |
| AI 触发概率、限频、并发槽位、排队上限 | `packages/consts/aiChat/rateLimit.ts` |
| AI 上下文记忆条数、快照触发周期、背压压缩门限 | `packages/consts/aiChat/memory.ts` |
| 媒体描述字数、并发分析槽位、LRU 缓存容量 | `packages/consts/aiChat/media.ts` |
| 生图冷却时长与图片字节上限 | `packages/consts/aiChat/imageGeneration.ts` |
| 心情衰减周期与开关冷却时间 | `packages/consts/aiChat/mood.ts` |
| 工具单次调用上限、打字模拟与错字偶发概率 | `packages/consts/aiChat/tools.ts` |
| 语音转写的音频长度/体积限制与占位提示文案 | `packages/consts/aiChat/voice.ts` |
| 语音生成工具的单轮上限、台词/语气词字符限制与每日总额度 | `packages/consts/aiChat/voiceMessage.ts` |
| AI 请求超时、重试次数、采样温度与安全过滤等级 | `packages/consts/aiChat/gemini.ts`、`openai.ts`、`anthropic.ts` |
| **模型名称、供应商提供商、API Key、请求端点** | **非代码常量**：在 `config/dynamic/agent.json` 中按能力独立配置 |
| OpenAI 兼容生图接口协议与支持的分辨率尺寸 | `config/dynamic/agent.json` 中的 `agent.image.image_protocol` |
| 入群验证等待时间、刷屏检测阈值与禁言追加策略 | `packages/consts/antiRaid/` |
| 复读冷却时长、/quiet 静音时长范围、动作命令限流 | `packages/consts/commands.ts` |
| 随机发言的主动发言人防连续打扰冷却 | `packages/consts/auto.ts` |

**参数修改步骤**：修改常量数值 → 同步更新对应的中文 JSDoc 说明 → 运行提交前门禁（`bun run lint && bun run typecheck`）；如果用户明确要求同步文档，再更新 README 中的对应引用。最后通过 `bun run check` 准备合并。

> [!WARNING]
> **容量类常量可能与持久化数据强绑定**：
> 若需要调小 `AI_MEMORY_HYDRATE_BUFFER_MAX`（记忆加载缓冲上限）或 `MAX_SUMMARY_ROUNDS`（总结轮数）等与持久化快照相关的容量常量，必须按照 [04 运行时权威约束](04-invariants.md#持久化) 规范，在停机状态下通过 SQLite 事务清理或缩减旧快照；服务启动时的严格校验会直接拒绝超出新容量定义的已有记录。

---

## 新增一项可选供应商能力

系统将模型能力细化为最小职责接口（如 `AiTextProvider` 文本、`AiSummaryProvider` 摘要、`AiMediaProvider` 图像理解、`AiImageProvider` 绘图、`AiSpeechProvider` 语音识别、`AiWebSearchProvider` 联网搜索、`AiStructuredTextProvider` 结构化输出等），并由 `AiChatProvider` 组合使用：

1. **声明能力契约**：在 [`packages/types/aiChat/provider.ts`](../../packages/types/aiChat/provider.ts) 中声明可选方法，并在函数类型中显式标注 `this: void`。
2. **实现能力接入**：仅在支持该特性的 Provider 实现中编写具体逻辑并在其 `index.ts` 导出；不支持该特性的厂商无需实现对应字段（保持 `undefined`）。
3. **按特性判断能力**：上层业务代码一律通过检查具体能力字段是否存在来判断（例如 `if (provider.someCapability) ...`），严禁硬编码判断厂商名字（如 `if (provider.name === "gemini")`）。
4. **缺失降级策略**：
   - 允许容错降级的场景（例如多模态分析或语音识别缺失时），用文字占位提示替代并记录日志，绝不允许为了单项能力在单次会话中临时混用其他厂商跨域调用；
   - 无法降级的场景（例如未配置语音合成模型），在组装工具链时直接不挂载对应工具。
5. **动态挂载工具**：模型工具链在每轮会话开始时动态组装；如果当前模型缺少相关能力或未完成配置，工具定义与执行器都必须从当前轮调用列表中剔除。

---

## 新增一个 AI 工具

1. **工具标识声明**：在 [`packages/consts/tools.ts`](../../packages/consts/tools.ts) 中声明工具常量名；产生副作用（例如群内发言、发图、发表情）的工具需额外加入 `ACTION_TOOL_NAMES` 集合。
2. **定义工具描述（Schema）**：纯查询类工具加入 `TOOL_DECLARATIONS`；回复行动工具在 `packages/aiChat/ai/tools/replyToolset/` 中编写 definition builder。通用的 `AiToolDefinition` 会由具体厂商适配层转换为 OpenAI/Gemini/Anthropic 的专用 Schema。
3. **编写执行逻辑**：在 `packages/aiChat/ai/tools/` 编写工具的具体执行逻辑；若涉及发消息等 Telegram 操作，统一通过跨线程消息委托主线程执行。
4. **注册执行分发**：只读工具接入 `tools/index.ts` 的 `callTool`；行动类工具接入 `replyToolset/orchestrator.ts` 的装配器与 `execute` 分发器。
5. **调用预算控制**：群内产生实际副作用的工具必须受到回复动作总预算的严格约束（执行侧强制硬顶 `HARD_MAX_ACTIONS_PER_REPLY`）；单轮独立频次限制仅在领域有特殊配额时使用（如 `MAX_STICKERS_PER_REPLY`、`MAX_GENERATED_IMAGES_PER_REPLY`、`MAX_VOICES_PER_REPLY`）。
6. **编写 Prompt 说明**：在 `packages/consts/aiChat/prompts/` 中补充该工具的用法指导与触发规范；若涉及消息历史引用，必须复用 `transcript.ts` 的统一格式。
7. **补充单测与文档**：在 `test/aiChat/ai/` 中补充对应的单元测试，并在三语文档中同步该工具的功能说明。

---

## 新增一个通用 JSON API 调用

1. 打开 [`packages/consts/httpFetch.ts`](../../packages/consts/httpFetch.ts)，在 `JSON_API_ALLOWED_ORIGINS` 白名单中显式添加允许访问的 HTTPS 域名与协议；严禁使用通配符或放行明文 HTTP。
2. 调用 [`packages/infra/httpFetch.ts`](../../packages/infra/httpFetch.ts) 提供的安全 JSON 读取器。该读取器已默认禁用跨域重定向，并严格限制了最大响应体积与错误日志截断长度。
3. 编写单测，确保覆盖白名单校验拦截、禁止重定向测试、响应体积超限防御以及网络异常处理。

---

## 修改人设与 JSON 配置

- **人设提示词**：系统默认人设位于 `packages/consts/aiChat/prompts/persona.ts`；若需自定义，只需在项目根目录创建 `prompt/persona.md`（模板参考 [`prompt_example/persona.md`](../../prompt_example/persona.md)），重启服务即可生效。通知风格的配置请参阅 [01 环境搭建](01-getting-started.md#配置-telegram-身份)。
- **语音工具说明**：内置说明位于 `packages/consts/aiChat/prompts/tools.ts` 的 `VOICE_LANGUAGE_PROMPTS`（内含中、英、日三版）；在项目根目录放置 `prompt/voice_tool.md` 后，重启即可完整覆盖 `send_voice` 工具的主体描述，参数与文案仍根据 `bot_language` 选取。模板参考 [`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md)。
- **提示词示例校验**：`prompt_example/` 随版本一起分发，测试 `test/config/promptExamples.test.ts` 会严格校验示例能被 `loadPromptFile` 解析。`voice_tool.md` 中的额度、单轮上限与字符限制必须与代码常量保持一致，语言必须与 `config_example/dynamic/agent.json` 的 `bot_language` 保持一致。调整相关常量时需同步更新示例。
- **配置文件分层**：开发时只修改被 Git 忽略的 `config/` 真实文件；`config_example/` 仅用作格式参照，不得直接作为工作数据。
  - `config/dynamic/` 下的文件支持运行时热重载（`assets.json`、`ad_samples.json`、`agent.json`、`mood.json`、`stickers.json`、`cron.json`）。
  - `config/static/` 下的文件修改后需要重启进程生效（`bot.json`、`g-auth.json`）。
- **表情与黑白名单**：AI 允许发送的表情符号由常量 `AI_REACTION_EMOJIS` 约束。黑名单与权限白名单权威存储在 SQLite 数据库中，不通过 JSON 文件维护。

---

## 新增部署 JSON 配置

1. 在 `packages/config/<domain>.ts` 中为新增配置编写严格的解析与校验逻辑（明确必填/可选字段、取值范围，严禁忽略未声明的未知字段）。
2. 在 `config_example/static/` 或 `config_example/dynamic/` 中补充对应的脱敏示例文件，并同步更新三语的 `config_example/README/` 说明。
3. 如果配置需要支持动态热重载，在 `packages/config/reload.ts` 中注册重载逻辑与广播通知机制。
4. 同步更新三语环境搭建文档中的配置说明。

---

## 新增运行时缓存

1. 新增缓存文件统一存放在 `packages/cache/<owner 线程>/<domain>.ts`。文件首行必须标明所有者注释：`/** owner: <main|perThread|workers/<线程>>。…`（必须与所在目录保持一致，由 `bun run check:conventions` 静态核验）；可变单例统一使用 `{ current: T | null }` 结构。
2. 每个导出对象与方法都需附带中文 JSDoc，明确说明数据生命周期、写入填充时机、逐出清理策略以及所在 Worker 异常重启后的重建方案。
3. 必须设置明确的容量上限（如 Map 容量、队列深度），满足“有界、有属主、可重建”的状态设计规范。
4. 若涉及进程停止时的持久化排空（flush），统一接入 `packages/libs/flushBarrier.ts` 管理。

---

## 变更持久化 schema

> [!CAUTION]
> **重要原则**：代码中**绝不保留历史旧格式的兼容逻辑，也不在运行时做静默自动升级**。一旦发现持久化数据与当前代码版本不兼容，服务会直接拒绝启动。

1. 修改 `packages/types/` 中定义的数据结构，并同步更新加载时的严格校验规则。
2. 完善相关测试用例，并在本地运行故障注入门禁 `bun run test:fault-injection`。
3. **先停止正在运行的服务**，确认旧进程已经完全退出且 `bot.lock` 已被释放。
4. 在外部安全目录做好数据备份，再手动（或通过脱机脚本）将已有的 `memory/global/state.json` 及相关文件转换为新版本格式。
5. 启动新版服务进行启动校验；如遇校验拦截，根据报错日志定位并修正缺失或非法字段。
6. 观察至少 2 个 supervisor 进程重启监控周期，确认服务稳定运行、无非预期重启后再清理外部临时备份。

---

## 新增一张 SQLite 表

系统在运行时不执行动态数据库迁移；如果数据库表结构与当前代码版本不匹配，启动阶段会立即终止：

1. 在 `packages/database/schema/<domain>.ts` 中定义表结构定义，并导入到 `schema/storage.ts` 集中管理。
2. 生成对应的迁移文件 `schema/migrations/000N_<name>.sql`，并在 `migrations/meta/_journal.json` 中记录版本变动。
3. 在本地测试数据库上应用该迁移，从 `__drizzle_migrations` 表中读取真实的 `created_at` 时间戳与 `hash` 哈希值，回填至 `packages/consts/identityStorage.ts`，同时将 `IDENTITY_DATABASE_SCHEMA_VERSION` 版本号加 1。
4. 编写专门的停机冷迁移脚本，在 `scripts/migrations/active.ts` 中登记最新的一条迁移边（同时清理已被完全覆盖的旧迁移逻辑）。
5. 迁移脚本中必须使用对应历史版本的专用 Schema 结构解析待迁移数据，不得混用新版类型。
6. 迁移完成后，必须经过双向哈希一致性核验，确认无误后方可生成 `ready.json` 标识完成。
7. 所有持久化修改均遵循统一的 Write-Through 事务机制，确保数据落盘一致性。

---

## 改动 Worker 间协议

跨线程通信的数据类型统一归属于 `packages/types/`。修改跨线程协议时，需要同步修改以下模块：
1. `packages/types/` 中的消息载荷类型定义。
2. 主线程通信代理模块（`packages/infra/` 或 `packages/cache/main/`）。
3. 对应 Worker 线程内的消息接收与派发逻辑（`packages/workers/<domain>/`）。
请求-响应模式必须遵循“先登记 Waiter、统一超时处理、线程崩溃时批量定向结算”的可靠交互模式。

---

<div align="center">

[← 上一页：05 开发流程](05-dev-workflow.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#06-常见修改配方) · [下一页：07 运维与排障 →](07-operations.md)

</div>
