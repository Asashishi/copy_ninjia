# 03 目录导览与代码放置

<p align="center">
  <b>简体中文</b> · <a href="../en/03-directory-map.md">English</a> · <a href="../ja/03-directory-map.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="02-architecture.md">← 上一页：02 架构总览</a> · <a href="04-invariants.md">下一页：04 权威约束 →</a>
</p>

---

本文档旨在帮助你快速了解项目的代码组织结构，明确各模块的职责分工，以及在新增功能时「代码应该放在哪个目录」。关于 ESLint 与格式规范，请参阅 [`AGENTS.md`](../../AGENTS.md)。

## 目录职责

- **`LICENSES/`**
  - **内容**：存放项目主许可证 [`LICENSE`](../../LICENSES/LICENSE)（MIT），以及第三方字符数据与音频编解码库的许可证：汉字变体表使用的 [`Unicode-3.0.txt`](../../LICENSES/Unicode-3.0.txt)、Opus 编码依赖的 [`audio-encode-opus-MIT.txt`](../../LICENSES/audio-encode-opus-MIT.txt) 与 [`libopus-BSD.txt`](../../LICENSES/libopus-BSD.txt)。
- **`packages/app/`**
  - **职责**：整个应用的启动与停机生命周期编排、启动前配置文件校验、`config/dynamic/` 动态热重载分发、中间件注册、命令菜单装配，以及 Telegram update 消费 Runner。
  - **代表文件**：`lifecycle.ts` 与 `lifecycle/`（`maintenance.ts`、`shutdown.ts`）、`lifecycleDependencies.ts`、`configReload.ts`、`registerHandlers.ts`、`updateRunner.ts` / `updateFetcher.ts`。
- **`packages/commands/`**
  - **职责**：所有用户显式触发的 Telegram 斜杠命令实现，按命令领域组织；子命令在各自领域内分发，公用的权限门禁独立抽离。
  - **代表文件**：`copy.ts`、`icon.ts`、`mood.ts`、`qa.ts`、`block.ts`、`hImage.ts` 与 `hImage/`（抽图、收图）、`info.ts`、`deferredCommands.ts`、`blocklistFanOut.ts`、`mute.ts`、`batchKick.ts`、`targetResolution.ts`、`configGate.ts`、`arguments.ts`；口球功能由 `gag.ts`（入口）、`gag/runtime.ts`（运行时生命周期）、`gag/inline.ts` 与 `gag/rendering.ts` 承接；运势抽签由 `luckChallenge/` 承接（`cache.ts`、`draw.ts`、`key.ts`、`rateLimit.ts`、`receipt.ts`、`rendering.ts`、`telegramAdapter.ts`）。
- **`packages/auto/`**
  - **职责**：非命令形式的自动响应行为，包括自动复读、AI 聊天转录与智能触发、群表情反应同步。
  - **代表文件**：`message/`（含 `triggerPolicy.ts`）、`reactionSync.ts`。
- **`packages/aiChat/`**
  - **职责**：AI 闲聊模块在主线程侧的代理组件与模型能力集成，包括 Worker 监督管理、记忆镜像、启动与热重载状态注入、可用性检查，以及各模型供应商（`gemini/`、`openai/`、`anthropic/`）的具体客户端与工具实现。
  - **代表文件**：`workerBridge.ts`、`hydration.ts`、`messageIngress.ts`、`botImages.ts`、`voiceSynthesis.ts`、`webDigest.ts`、`memoryMirror.ts`、`stickerMirror.ts`、`workerJob.ts`、`availability.ts`、`provider.ts`、`providerLanes.ts`、`capabilityClient.ts`、`gemini/`、`openai/`、`anthropic/`、`ai/`；`index.ts` 仅提供统一的薄接口导出。
- **`packages/antiRaid/`**
  - **职责**：Anti-Raid（防冲群与风控）在主线程侧的代理组件，包括 Worker 监督、数据持久化同步、进群消息流转、广告候选排队送检，以及黑名单处置与成员验证调度。
  - **代表文件**：`workerBridge/`（`controller.ts`、`events.ts`、`observers.ts`、`replay.ts`）、`durableDelivery.ts`、`updateIngress.ts`、`adCandidate.ts`、`adDetect.ts`；`index.ts` 仅提供统一的薄接口导出。
- **`packages/cron/`**
  - **职责**：`cron.json` 定时任务在主线程的调度执行（支持标准 cron 表达式、一次性任务 `just_once` 与随机间隔 `rand_cron`），动作按序执行与重试，以及 Telegram 出站发送。
  - **代表文件**：`scheduler.ts`、`run.ts`、`delivery.ts`、`targets.ts`。
- **`packages/copy/`**
  - **职责**：普通复读、反转/猫娘文字变换逻辑，以及偷头像更新队列。
  - **代表文件**：`echo.ts`、`copyModes.ts`、`avatarQueue.ts`。
- **`packages/translate/`**
  - **职责**：按群维护的多语言翻译会话、正则语种识别与 Google 翻译客户端封装。
  - **代表文件**：`state.ts`、`recovery.ts`、`message.ts`、`language.ts`、`client.ts`。
- **`packages/users/`**
  - **职责**：发言者身份缓存、发送者身份提取与标签生成，以及风控共用的身份元数据解析。
  - **代表文件**：`senderIdentity.ts`、`visibleSender.ts`、`userLabel.ts`、`identityMetadata.ts`、`messageContent.ts`、`messageOrigin.ts`。
- **`packages/states/`**
  - **职责**：**无任何 I/O 的纯状态机与准入规则**，包括入群验证阶段转换、锁定状态转换、AI 回复准入判据、广告送检准入及临时免检累计规则。
  - **代表文件**：`verification.ts` 与 `verification/`（`join`/`pending`/`terminal`/`disable` 各阶段与 `adopt.ts` 恢复）、`lockdown.ts` 与 `lockdown/`（`apply`/`persistence`/`restore`/`announcement`/`adopt` 各阶段）、`replyAdmission.ts`、`adDetectAdmission.ts`、`temporaryAdBypass.ts`。
- **`packages/config/`**
  - **职责**：`config/{static,dynamic}/*.json` 配置文件的严格 schema 校验、内存快照封装、热重载差异判定与功能可用性检查。
  - **代表文件**：`bot.ts`、`botInput.ts`、`layout.ts`、`agent.ts`、`agentCapability.ts`、`assets.ts`、`cron.ts`、`mood.ts`、`stickers.ts`、`adSamples.ts`、`googleAuth.ts`、`readiness.ts`、`reload.ts`。
- **`packages/database/`**
  - **职责**：本地共享 SQLite 数据库的 schema、编解码器（codec）、数据行校验及 Drizzle ORM 交互边界；运行时数据库句柄仅归 Disk I/O Worker 独占。
  - **代表目录**：`schema/`（含 `migrations/`）、`codec/identity.ts`、`codec/chatState.ts`、`codec/chatQa.ts`、`codec/temporaryAdBypass.ts`、`interact/`（`connection.ts`、`transaction.ts`、`identityPolicy.ts`、`chatState.ts`、`chatQa.ts`、`temporaryAdBypass.ts`、`aiContext.ts`、`migration.ts`、`initialization.ts`、`inspection.ts`）、`validation/storageRows.ts`。
- **`packages/libs/`**
  - **职责**：与具体业务无关的通用底层基础设施，包括原子文件写入、有界并发队列与通信工具。
  - **代表文件**：`flushBarrier.ts`、`linkedQueue.ts`、`acknowledgedBatchQueue.ts`、`boundedResponse.ts`、`boundedSettledBatch.ts`、`monotonicDeadline.ts`、`text.ts`、`errorMessage.ts`、`telegramMarkdown.ts`、`webDigest.ts` 与 `webDigestMarkdown.ts`、`webDigestUrls.ts`、`workerRequestTable.ts`。
- **`packages/workers/`**
  - **职责**：三个 Worker 线程内部的实现逻辑。
  - **代表文件**：`aiChatWorker.ts`、`antiRaidWorker.ts`、`diskIOWorker.ts`、`businessWorkerPort.ts`、`aiChat/`、`antiRaid/verificationEffects/`、`diskIO/storageDatabase.ts` 与 `diskIO/storageDatabase/`、`diskIO/verification{Codec,Recovery,Writes}.ts`。
- **`packages/aiChat/ai/`**
  - **职责**：AI 模型具体功能的工具与提示词实现。
  - **代表文件**：`tools/replyToolset/`、`tools/webSearch.ts`、`webDigest.ts`、`utils/`、`stickers/`、`voiceSynthesis.ts`、`ttsUsage.ts`。
- **`packages/workers/antiRaid/adDetect/`**
  - **职责**：广告检测处理流水线，包括排队批处理、消息串拼接、模型判定与违规处置。
  - **代表文件**：`queue.ts`、`queueState.ts`、`verdict.ts`、`bundle.ts`、`classifier.ts`、`disposal.ts`、`config.ts`。
- **`packages/infra/`**
  - **职责**：主线程唯一的 Telegram 客户端连接与出站闸门、Worker 双工通信宿主、系统日志输出、主线程 I/O 代理与专用图库文件管理。
  - **代表文件与目录**：
    - `telegram/`（含 `telegram/avatar/`、`telegram/actions/`）
    - `diskIO.ts` 与 `diskIO/`（`businessWrite.ts`、`diagnosticChannel.ts`、`fatal.ts`、`host.ts`、`observers.ts`、`recovery.ts`、`requests.ts`、`storageAdmission.ts`、`transport.ts`）
    - `identityStorage.ts` 与 `identityStorage/`（`read.ts`、`shared.ts`、`sweep.ts`、`write.ts`）
    - `logger.ts` 与 `logger/`（`forwarding.ts`、`redaction.ts`、`serialization.ts`）
    - `supervisedWorker.ts`、`workerSupervisor.ts`
    - `aiCacheUsage.ts`、`geminiContextCache.ts`
    - `randomImage.ts`、`mediaGroups.ts`
    - `telegram/fileDownload.ts`、`telegram/commandPhotos.ts`、`commandExecutor.ts`
- **`packages/infra/identityPolicy/`**
  - **职责**：主线程读取白名单权限、临时免检身份与名单互斥状态的判定边界。
  - **代表文件**：`whitelist.ts`、`temporaryAdBypass.ts`、`coordination.ts`。
- **`packages/infra/blocklist/`**
  - **职责**：黑名单主线程基础设施，包括名单判定、持久化待办队列（outbox）、全群成员清扫与销号检测。
  - **代表文件**：`membership.ts`、`outbox.ts`、`participantInvalid.ts`、`sweep.ts`、`sweepEligibility.ts`、`sweepReplay.ts`、`sweepRetryState.ts`、`sweepScheduler.ts`。
- **`packages/infra/storage/`**
  - **职责**：数据根目录预检、单实例锁排他保护、全局状态（`memory/global/state.json`）门面与启动清理。
  - **代表文件**：`dataRoot.ts`、`instanceLock.ts`、`stateStore.ts`、`statePersistence.ts`、`cleanup.ts`。
- **`packages/cache/`**
  - **职责**：进程内可变状态容器，**第一层目录严格对应持有该状态的宿主线程**。
  - **代表目录**：`main/`、`workers/aiChat/`、`workers/antiRaid/`、`workers/diskIO/`、`perThread/`。
- **`packages/consts/`**
  - **职责**：字面量常量、运行参数与用户可见文案表，按业务领域分文件存放。
  - **代表文件**：`atmosphere/{teasing,plain}/`、`commands.ts`、`whitelist.ts`、`aiChat/rateLimit.ts`、`antiRaid/`、`diskIO/`。
- **`packages/types/`**
  - **职责**：跨模块契约、业务领域模型类型、状态机状态与事件定义（`types/states/`）。
  - **代表文件**：`chatState.ts`、`commands.ts`、`lifecycle.ts`、`diskIO/`（`messages.ts`、`replies.ts`）。
- **`test/`**
  - **职责**：与 `packages/` 镜像对应的 Bun 单元测试与集成测试。
- **`scripts/`**
  - **职责**：代码规范自检、构建打包、性能基准套件、安装器脚本与停机数据冷迁移脚本。

---

## 新代码放置决策

在新增功能或重构代码时，请按以下顺序判断文件归属：

1. **是字面量参数、阈值或用户可见文案？**
   - 放置在 `packages/consts/<domain>.ts`（若领域庞大则拆分至 `packages/consts/<domain>/`）。
   - 必须附带中文 JSDoc 说明其用途与约束。命令提示与回执应统一汇总在文案表中，禁止在业务代码中临时拼凑。
   - 部署 JSON 文件的读取与校验放入 `packages/config/<domain>.ts`；环境变量仅允许在 `packages/consts/paths.ts` 与 `packages/consts/environment.ts` 中读取。
2. **是跨模块共享的类型定义或协议？**
   - 放置在 `packages/types/<domain>.ts`。纯状态机的状态、事件与决策契约放入 `packages/types/states/`。
3. **是长期存活的可变状态（如 Map、Set、队列、计时器或单例）？**
   - 放置在 `packages/cache/` 对应宿主线程的子目录下（`main/`、`workers/...` 或 `perThread/`）。
   - 必须使用 `{ current: T | null }` 容器封装，严禁直接使用 `export let`；并在 JSDoc 中写明何时初始化、何时清理以及 Worker 重启后的恢复策略。
4. **是纯状态转移逻辑（不包含任何 I/O 操作、纯计算、便于单元测试）？**
   - 放置在 `packages/states/`。实际的 I/O 副作用由主线程或 Worker 解释器执行。
5. **是具体的业务逻辑、副作用或外部交互？**
   - 按所属领域放置：用户命令放入 `packages/commands/`，非命令自动响应放入 `packages/auto/`，Worker 线程内部逻辑放入 `packages/workers/<domain>/`，模型能力放入对应功能的 `ai/` 目录，通用基础设施放入 `packages/infra/`。

> [!CAUTION]
> **严禁的编写方式**：
> - 在普通的业务文件内随意定义全局 Map 或 Set 变量。
> - 常量散落在业务逻辑深处。
> - 在 Worker 线程中直接通过 `fs` 读写共享数据，绕过 Disk I/O Worker 的串行化保护。

## 缓存按线程分权

`packages/cache/` 的第一层目录声明这份状态归哪条线程所有——跨线程只传消息、不共享内存，同一个 cache 模块被两条线程 import 就是两份互不相干的实例：

- **`main/`**
  - **owner**：主线程。
  - **内容**：命令与自动流水线状态、由 `stateStore.ts` 门面管理的 `memory/global/state.json` 全局镜像、`assets.ts` 的 `config/dynamic/assets.json` 素材快照、`chatState.ts` 的 `chat_states` 群状态热读副本（`Map`，上限 `STATE_MANAGED_CHAT_LIMIT` 个群，含按群翻译会话）、Disk I/O 宿主，以及
    **主线程侧的 Worker 代理与镜像**（`main/aiChat.ts`、`main/antiRaid/`）。
- **`workers/aiChat/`**
  - **owner**：AI 闲聊 Worker。
  - **内容**：滚动记忆、回复准入、回复机器人图片时的识图回填登记、心情、贴纸目录与集合、主线程转交的在途语音合成与摘要组稿、语音合成每日计数，以及三家供应商的客户端单例。
- **`workers/antiRaid/`**
  - **owner**：Anti-Raid Worker。
  - **内容**：验证/锁定状态机、刷屏窗口、广告检测队列、Google/OpenAI/Anthropic 客户端。
- **`workers/diskIO/`**
  - **owner**：Disk I/O Worker。
  - **内容**：各领域文件的写入缓冲、索引与脏标记，以及到点定时 flush 的合并集合（`timedFlush.ts`）。
- **`perThread/`**
  - **owner**：每条线程各一份。
  - **内容**：Telegram 能力实现 holder（主线程真实适配器、业务 Worker 双工代理）、
    Worker 双工 waiter、部署配置单例、自发消息登记、update 取消上下文存储、AI 缓存用量上报出口；同一份代码在每条线程独立实例化。

注意 `main/antiRaid/` 与 `workers/antiRaid/` 是**两拨完全不共享的状态**：权威状态机在 Worker 内，主线程那份只是供崩溃重放的纯数据镜像。放错目录不是风格问题——写进去的东西对面永远读不到。`bun run check:conventions` 按真实模块图核对这条归属（详见 [04 运行时权威约束](04-invariants.md#线程与状态归属)），违例时打印完整引入链。

`packages/aiChat/ai/` 这类被多条线程复用的领域代码要留意：一个只被主线程用到的纯函数，若与 Worker 独占的缓存同住一个文件，主线程 import 它就会把那份缓存一并实例化。范例是 [`packages/aiChat/ai/stickers/describe.ts`](../../packages/aiChat/ai/stickers/describe.ts)：主线程消息流水线直接使用它的纯描述函数，`sets.ts` 的贴纸集合缓存由 AI Worker 独占。

## 兼容入口（barrel）约定

大文件拆分成子模块后，原文件可以降级为无状态的薄兼容导出入口（如 `packages/infra/telegram/actions.ts` 对 `packages/infra/telegram/actions/`，`packages/workers/diskIO/storageDatabase.ts` 对 `packages/workers/diskIO/storageDatabase/`）。规则：

- 兼容入口只服务旧 import 的渐进迁移；**新代码一律直接从领域子文件导入**。
- 兼容入口不得重新持有状态、解析配置或引入 import 副作用。
- 包内 `index.ts` 只有在调用方确实需要单一 package surface 时才作为稳定公开入口；当前 `packages/aiChat/index.ts`、`packages/antiRaid/index.ts` 与 `packages/infra/telegram/index.ts` 都只做显式薄导出、不持有状态；`infra/telegram/index.ts` 只重导出现有业务模块经它使用的客户端、常规动作与命令回执符号，新代码直接从 `client`、`actions/*`、`commandMessages` 等叶子模块导入。aiChat 与 antiRaid 的生产代码内部仍直接 import 对应 owner 叶子模块；这三个入口都不使用无边界的 `export *`。

## 测试的镜像结构

`test/` 与 `packages/` 路径原则上一一对应；同一拆分领域可以共享领域级测试，例如 `packages/workers/diskIO/verificationCodec.ts`、`verificationRecovery.ts`、`verificationWrites.ts` 统一由 `test/workers/diskIO/verificationFiles.test.ts` 覆盖。其余新模块的测试文件跟随目录结构创建，跨领域共用的替身、夹具与 harness 放 `test/helpers/`，与领域无关的通用小工具放 `test/helpers/common.ts`，全局隔离机制见 [05 开发流程](05-dev-workflow.md#测试隔离机制)。

---

<div align="center">

[← 上一页：02 架构总览](02-architecture.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#03-目录导览与代码放置) · [下一页：04 权威约束 →](04-invariants.md)

</div>
