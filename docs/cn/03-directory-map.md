# 03 目录导览与代码放置

<p align="center">
  <b>简体中文</b> · <a href="../en/03-directory-map.md">English</a> · <a href="../ja/03-directory-map.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="02-architecture.md">← 上一页：02 架构总览</a> · <a href="04-invariants.md">下一页：04 权威约束 →</a>
</p>

---

本页回答「这段代码住在哪、新代码该放哪」。风格细则（引号、参数上限、import type 等）由 eslint 与 [`AGENTS.md`](../../AGENTS.md) 约束，此处不重复。

## 目录职责

- **`LICENSES/`**
  - **内容**：项目 MIT 许可证 [`LICENSE`](../../LICENSES/LICENSE)，以及汉字变体数据使用的 [`Unicode-3.0.txt`](../../LICENSES/Unicode-3.0.txt)。
- **`packages/app/`**
  - **职责**：启动/退出生命周期、已存在部署输入的启动校验出口、`config/` 热重载监听与分发、
    handler 注册、命令菜单与 update runner，以及生命周期副作用依赖装配。
  - **典型文件**：`lifecycle.ts`、`lifecycleDependencies.ts`、`configReload.ts`、
    `registerHandlers.ts`、`updateRunner.ts` / `updateFetcher.ts`。`ApplicationLifecycleDependencies` 从装配对象
    推导并与其同住，避免共享类型层反向依赖 `app/`。
- **`packages/commands/`**
  - **职责**：显式命令按命令族组织，同一入口的子命令在该领域内分派；开关命令共用的权限与配置门禁另成文件。
  - **典型文件**：`copy.ts`、`icon.ts`、`mood.ts`、`prompt.ts`、`qa.ts`、`block.ts`、`hImage.ts` 与 `hImage/`（抽图、收图）、`info.ts`、`deferredCommands.ts`（抽图、收图与 `/info` 共用的延迟命令执行器）、`mute.ts`、`batchKick.ts`、
    `targetResolution.ts`、`configGate.ts`、`arguments.ts`；较大的 gag 领域以 `gag.ts` 保留命令入口，
    `gag/runtime.ts`、`gag/inline.ts`、`gag/rendering.ts` 分别承接生命周期、inline 与纯渲染；
    inline 抽签同理由 `luckChallenge/` 承接（`cache.ts`、`draw.ts`、`key.ts`、`rateLimit.ts`、
    `receipt.ts`、`rendering.ts`、`telegramAdapter.ts`，`index.ts` 只做薄入口）。
- **`packages/auto/`**
  - **职责**：非命令的自动行为，包括复读、AI 转录与触发、反应同步。
  - **典型文件**：`message/`（含 `triggerPolicy.ts`）、`reactionSync.ts`。
- **`packages/aiChat/`**
  - **职责**：AI 闲聊主线程代理与模型能力，包括 Worker 监督、记忆镜像、启动与热重载的状态灌入、可用性判定，
    以及供应商实现包（`gemini/`、`openai/`）、provider 选取、贴纸、工具和媒体实现。
  - **典型文件**：`workerBridge.ts`、`hydration.ts`、`messageIngress.ts`、`botImages.ts`（命令与定时任务发图的占位自录入口）、
    `voiceSynthesis.ts`（`/send` 与 cron 向 AI Worker 请求语音合成的等待与结算）、
    `memoryMirror.ts`、`availability.ts`、`provider.ts`、`gemini/`、`openai/`、`ai/`；
    `index.ts` 只提供薄公开入口。
- **`packages/antiRaid/`**
  - **职责**：Anti-Raid 主线程代理与广告模型能力，包括 Worker 监督、持久化交接、
    update 入口，以及黑名单/验证/广告/刷屏编排。
  - **典型文件**：`workerBridge/`（`controller.ts`、`events.ts`、`observers.ts`、
    `replay.ts`）、`durableDelivery.ts`、`updateIngress.ts`、`adCandidate.ts`、`ai/`；
    `index.ts` 只提供薄公开入口。
- **`packages/cron/`**
  - **职责**：`cron.json` 定时任务的主线程调度（Bun 原生 cron、just_once、rand_cron 随机等待）、一轮动作的顺序执行与重试，以及唯一的 Telegram 发送边界。
  - **典型文件**：`scheduler.ts`、`run.ts`、`delivery.ts`、`targets.ts`（`chat_id: ["all"]` 与 `["except", ...]` 的发送权限现查）；解析在 `packages/config/cron.ts`，状态在 `packages/cache/main/cron.ts`。
- **`packages/copy/`**
  - **职责**：普通复制、复读文本变换与头像更新队列。
  - **典型文件**：`echo.ts`、`copyModes.ts`、`avatarQueue.ts`。
- **`packages/translate/`**
  - **职责**：按群翻译会话、恢复目标、正则语言识别与惰性 Google 翻译客户端。
  - **典型文件**：`state.ts`、`recovery.ts`、`message.ts`、`language.ts`、`client.ts`；普通复制复用 `copy/echo.ts`。
- **`packages/users/`**
  - **职责**：发送者身份缓存、可见发送者判定、用户标签生成，以及名单与广告判定共用的身份元数据、消息内容与来源解析。
  - **典型文件**：`senderIdentity.ts`、`visibleSender.ts`、`userLabel.ts`、`identityMetadata.ts`、`messageContent.ts`、`messageOrigin.ts`。
- **`packages/states/`**
  - **职责**：**无 I/O** 的纯状态转移与准入规则，包括验证、锁定、AI 回复准入、
    广告检测准入和临时广告免检累计。
  - **典型文件**：`verification.ts` 与 `verification/`（`join`/`pending`/`terminal`/`disable`
    四段生命周期，外加 `adopt.ts` 把落盘快照重建成内存状态）、`lockdown.ts` 与 `lockdown/`（`apply`/`persistence`/`restore`/`announcement`/`adopt`
    五段生命周期）、`replyAdmission.ts`、`adDetectAdmission.ts`、`temporaryAdBypass.ts`。
- **`packages/config/`**
  - **职责**：部署 `config/*.json` 的严格 schema、进程快照、热重载判定与按功能聚合的可用性判定；身份策略不在这里。
  - **典型文件**：`bot.ts`、`botInput.ts`、`agent.ts`、`stickers.ts`、`adSamples.ts`、`readiness.ts`、`reload.ts`。
- **`packages/database/`**
  - **职责**：共享 SQLite（身份策略 + 群状态）的 schema、codec、行校验与 Drizzle 交互边界；运行时句柄只由 Disk I/O Worker 持有。
  - **典型目录**：`schema/`（含 `migrations/`）、`codec/identity.ts`、`codec/chatState.ts`、
    `codec/chatQa.ts`、`codec/temporaryAdBypass.ts`、`interact/`（`connection.ts`、`transaction.ts`、`identityPolicy.ts`、
    `chatState.ts`、`chatQa.ts`、`temporaryAdBypass.ts`、`aiContext.ts`、`migration.ts`、`initialization.ts`、
    `inspection.ts`）、
    `validation/storageRows.ts`。
- **`packages/libs/`**
  - **职责**：领域无关的基础设施，包括原子文件、有界 I/O 与并发工具。
  - **典型文件**：`flushBarrier.ts`、`linkedQueue.ts`、`acknowledgedBatchQueue.ts`、
    `boundedResponse.ts`、`boundedSettledBatch.ts`、`monotonicDeadline.ts`、`text.ts`、
    `errorMessage.ts`（catch 到的 `unknown` 归一化成文案或 Error 的唯一边界）。
- **`packages/workers/`**
  - **职责**：三个 Worker 的线程内实现。
  - **典型文件**：`aiChatWorker.ts`、`antiRaidWorker.ts`、`diskIOWorker.ts`、`businessWorkerPort.ts`
    （两条业务 Worker 共用的线程端口：Telegram 代理、双工出口与入站路由），以及
    `aiChat/`、`antiRaid/verificationEffects/`、`diskIO/storageDatabase.ts` 与
    `diskIO/storageDatabase/`、`diskIO/verification{Codec,Recovery,Writes}.ts`。
- **`packages/aiChat/ai/` / `packages/antiRaid/ai/`**
  - **职责**：模型与能力按所属功能放置，避免共享目录模糊线程和生命周期边界。
  - **典型文件**：`tools/replyToolset/`、`utils/`、`provider.ts`、`voiceSynthesis.ts`（语音合成公共实现）；AI 闲聊的模型收发不在
    这里，而在与供应商同名的 `packages/aiChat/{gemini,openai}/` 实现包。
- **`packages/workers/antiRaid/adDetect/`**
  - **职责**：广告检测流水线，包括排队批处理、消息串整形、provider 判定与命中处置。
  - **典型文件**：`queue.ts`（入口与节拍）、`queueState.ts`（接纳判据）、
    `verdict.ts`（判定与处置编排）、`bundle.ts`、`classifier.ts`、`disposal.ts`、
    `config.ts`（接管主线程投递的配置快照）。
- **`packages/infra/`**
  - **职责**：主线程唯一 Telegram 客户端与出站闸门、Worker 双工宿主、logger 与主线程 I/O 代理，以及随机图片的目录准备与抽取。
  - **典型文件**：`telegram/`（含 `telegram/avatar/`、`telegram/actions/`）、`diskIO.ts` 与 `diskIO/`（`businessWrite.ts`、`diagnosticChannel.ts`、`fatal.ts`、`host.ts`、`observers.ts`、`recovery.ts`、`requests.ts`、`storageAdmission.ts`、`transport.ts`）、`identityStorage.ts` 与 `identityStorage/`（`read.ts`、`shared.ts`、`sweep.ts`、`write.ts`）、`logger.ts` 与 `logger/`（`forwarding.ts`、`redaction.ts`、`serialization.ts`）、`supervisedWorker.ts`、`workerSupervisor.ts`、`randomImage.ts`（随机图目录准备、抽图与收图写盘）、`mediaGroups.ts`（相册缓存的读写边界）、`telegram/fileDownload.ts`（共享的 Telegram 文件下载）、`telegram/commandPhotos.ts`（带图的 30 秒命令回执）。
- **`packages/infra/identityPolicy/`**
  - **职责**：白名单逐项权限、临时广告免检与黑白名单互斥协调的主线程读取边界。
  - **典型文件**：`whitelist.ts`、`temporaryAdBypass.ts`、`coordination.ts`。
- **`packages/infra/blocklist/`**
  - **职责**：黑名单主线程基础设施，按身份判定、同步名单、durable outbox、群清扫与销号识别拆分。
  - **典型文件**：`membership.ts`、`outbox.ts`、`participantInvalid.ts`、`sweep.ts`、`sweepEligibility.ts`、`sweepReplay.ts`、`sweepRetryState.ts`、`sweepScheduler.ts`。
- **`packages/infra/storage/`**
  - **职责**：数据根预检、实例锁、业务状态门面、可注入的 `state.json` 持久化边界与启动清理。
  - **典型文件**：`dataRoot.ts`、`instanceLock.ts`、`stateStore.ts`、`statePersistence.ts`、`cleanup.ts`。
    `stateStore.ts` 负责业务内存与快照，`statePersistence.ts` 负责严格解码、latest-only 写入、重试与 flush。
- **`packages/cache/`**
  - **职责**：进程内可变状态容器，**第一层目录就是 owner 线程**。
  - **典型目录**：`main/`、`workers/aiChat/`、`workers/antiRaid/`、
    `workers/diskIO/`、`perThread/`。
- **`packages/consts/`**
  - **职责**：字面量常量、调参值与用户可见文案表，按领域分文件/子目录。
  - **典型文件**：`atmosphere/{teasing,plain}/`、`commands.ts`、`whitelist.ts`、`aiChat/rateLimit.ts`、`antiRaid/`、`diskIO/`。
- **`packages/types/`**
  - **职责**：跨模块协议、领域类型、状态机契约（`types/states/`）。
  - **典型文件**：`chatState.ts`、`commands.ts`、`lifecycle.ts`、`diskIO.ts`。
- **`test/`**
  - **职责**：与 `packages/` 镜像的 Bun 单元测试。
  - **典型文件**：`test/commands/copyShared.test.ts`。
- **`scripts/`**
  - **安装器**：`install.sh` 定位目标工作树并转交该版本入口；`scripts/install/` 的 repository、service、config、runtime、configure、start 六个 shell 模块由入口统一检查可读性和语法后按序加载。`installSources.ts` 为语法检查与隔离夹具提供相同模块清单。
  - **冷迁移**：`migrateTranslateSessions.ts` 校验停机备份里的主备 state 与 schema v11 数据库并生成独立产物与校验清单；`migrations/translateSessions/state.ts` 拆出 state 的 `translate` 块，`migrations/translateSessions/database.ts` 在一个事务里把会话写进 `chat_states`，`migrations/files.ts` 是两条边共用的文件清单与路径包含判定，均不进入应用启动依赖图。`migrateRandomImageNames.ts` 把随机图库的旧文件名重建成按内容 SHA-256 命名的独立产物，同样只读源目录、以 `ready.json` 作为唯一完成标记。
  - **职责**：仓库自检、性能基准与必须停机执行的显式数据迁移。
  - **典型文件**：`checkProjectConventions.ts` 与 `conventions/`、`checkCoverageMetrics.ts` 与 `coverageSummary.ts`、`perf/identityDatabase.ts`、`perf/joinLog.ts`、`perf/hotPaths.ts`、`perf/hotPathProfileGate.ts` 与 `perf/hotPaths/gateResult.ts`（`performance-result.json` 中门禁那一节的严格解析）、`perf/performanceResult.ts`（该文件的共享写入边界，两套基准各只换自己那一格），只在发布时跑的全量基准 `perf/fullSuite.ts` 与 `perf/fullSuite/`，以及两套基准根共用的 `fixtures/copyTree.ts`（目录树复制）与 `fixtures/pathBoundary.ts`（写入边界的真实路径分量核对）。

`scripts/migrations/active.ts` 是当前冷迁移入口清单，供构建、发行校验和约定门禁共用。发行包携带两条边的 CLI，通过 `BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/<入口>.js` 执行，部署步骤见 [07 运维与排障](07-operations.md)。

`botInput.ts` 提供安装器和运行时共用的严格读取、解析入口，导入时不读部署文件或填充缓存；`bot.ts` 负责运行时快照。`libs/inflight.ts` 统一在途任务的有界等待，领域 owner 保留自己的接纳、取消和零预算策略；`infra/backgroundTasks.ts` 负责后台任务错误记录和结算后摘除。群开关命令共用 `commands/superAdminToggle.ts` 的授权、配置门禁、写入、持久化与回执顺序。

`commands/wed.ts` 持有交互状态机，`wed/dispatch.ts` 负责接纳，`wed/chats.ts` 负责群交互缓存的创建、LRU 淘汰和会话清理，`wed/members.ts` 只观察成员变更，`wed/runtime.ts` 将共用有界执行器接入应用生命周期，`wed/rendering.ts` 保持纯渲染。交互状态与执行器句柄放在 `cache/main/wed.ts`；每群长期成员集合与 dirty 窗口放在 `cache/main/wedMembers.ts`，由 `wed/persistence.ts` 负责启动接管、批量投递和 Worker 重建重放。`workers/diskIO/wedMemberFiles.ts` 负责文件严格校验与原子替换，待写快照只放在 `cache/workers/diskIO/wed.ts`。头像读取和出站复用 `infra/telegram/`。

`wed/memberReview.ts` 接收 Disk I/O Worker 统一午夜维护通知，在 Bot 就绪后串行复核所有成员集合；启动接纳门、单轮进度与在途目标由 `cache/main/wedMemberReview.ts` 持有。复核任务登记到既有 wed 运行时，停机先取消再排空，删除与落盘复用 `wed/persistence.ts`。

## 新代码放置决策

按这个顺序问自己：

1. **是字面量参数、或用户可见文案？** → `packages/consts/<domain>.ts`（或领域大了拆 `packages/consts/<domain>/`）。带中文 JSDoc 说明用途与不变量。命令回执与提示按命令收成文案表，不留在 handler 里现造。部署 JSON 的解析与校验进入 `packages/config/<domain>.ts`；仅运行路径覆写由 `packages/consts/paths.ts` 读取进程环境。
2. **是跨模块共享的类型/协议？** → `packages/types/<domain>.ts`。状态机的 `State/Event/Effect/Transition/Decision` 契约放 `packages/types/states/`。
3. **是长期存活的可变状态**（Map/Set/AsyncLocalStorage/队列/timer/单例）？ → `packages/cache/`，**先按 owner 线程选一层目录**（见下），再在里面按领域分文件；holder 对象而非 `export let`，JSDoc 写清何时填充、何时清理、Worker 重启后如何重建。容量与清理策略必须满足 [04 运行时权威约束](04-invariants.md)。
4. **是纯状态转移逻辑**（无 I/O、可单测）？ → `packages/states/`；副作用由 worker 侧解释器执行。
5. **是副作用/编排**？ → 按 owner 归位：命令进 `packages/commands/`，自动行为进 `packages/auto/`，Worker 线程内逻辑进 `packages/workers/<domain>/`，模型能力进所属功能的 `ai/` 子目录，进程级基础设施进 `packages/infra/`。

禁止的放置方式：业务文件里长出模块级 Map、常量散落在使用处、worker 里直接 `fs` 写共享目录绕过 Disk I/O Worker。

## 缓存按线程分权

`packages/cache/` 的第一层目录声明这份状态归哪条线程所有——跨线程只传消息、不共享内存，同一个 cache 模块被两条线程 import 就是两份互不相干的实例：

- **`main/`**
  - **owner**：主线程。
  - **内容**：命令与自动流水线状态、由 `stateStore.ts` 门面管理的 `state.json` 全局镜像、`chatState.ts` 的 `chat_states` 群状态热读副本（`Map`，至多 25 个群，含按群翻译会话）、Disk I/O 宿主，以及
    **主线程侧的 Worker 代理与镜像**（`main/aiChat.ts`、`main/antiRaid/`）。
- **`workers/aiChat/`**
  - **owner**：AI 闲聊 Worker。
  - **内容**：滚动记忆、回复准入、回复机器人图片时的识图回填登记、心情、贴纸目录与集合、主线程转交的在途语音合成，以及两家供应商的客户端单例。
- **`workers/antiRaid/`**
  - **owner**：Anti-Raid Worker。
  - **内容**：验证/锁定状态机、刷屏窗口、广告检测队列、Google/OpenAI 客户端。
- **`workers/diskIO/`**
  - **owner**：Disk I/O Worker。
  - **内容**：各领域文件的写入缓冲、索引与脏标记。
- **`perThread/`**
  - **owner**：每条线程各一份。
  - **内容**：Telegram 能力实现 holder（主线程真实适配器、业务 Worker 双工代理）、
    Worker 双工 waiter、部署配置单例、自发消息登记、update 取消上下文存储；同一份代码在每条线程独立实例化。

注意 `main/antiRaid/` 与 `workers/antiRaid/` 是**两拨完全不共享的状态**：权威状态机在 Worker 内，主线程那份只是供崩溃重放的纯数据镜像。放错目录不是风格问题——写进去的东西对面永远读不到。`bun run check:conventions` 按真实模块图核对这条归属（详见 [04 运行时权威约束](04-invariants.md#线程与状态归属)），违例时打印完整引入链。

`packages/aiChat/ai/` 这类被多条线程复用的领域代码要留意：一个只被主线程用到的纯函数，若与 Worker 独占的缓存同住一个文件，主线程 import 它就会把那份缓存一并实例化。范例是 [`packages/aiChat/ai/stickers/describe.ts`](../../packages/aiChat/ai/stickers/describe.ts)：主线程消息流水线直接使用它的纯描述函数，`sets.ts` 的贴纸集合缓存由 AI Worker 独占。

## 兼容入口（barrel）约定

大文件拆分成子模块后，原文件可以降级为无状态的薄兼容导出入口（如 `packages/infra/telegram/actions.ts` 对 `packages/infra/telegram/actions/`，`packages/workers/diskIO/storageDatabase.ts` 对 `packages/workers/diskIO/storageDatabase/`）。规则：

- 兼容入口只服务旧 import 的渐进迁移；**新代码一律直接从领域子文件导入**。
- 兼容入口不得重新持有状态、解析配置或引入 import 副作用。
- `packages/types/index.ts` 同理，仅为测试/渐进迁移保留。
- 包内 `index.ts` 只有在调用方确实需要单一 package surface 时才作为稳定公开入口；当前 `packages/aiChat/index.ts`、`packages/antiRaid/index.ts` 与 `packages/infra/telegram/index.ts` 都只做显式薄导出、不持有状态；`infra/telegram/index.ts` 只重导出现有业务模块经它使用的客户端、常规动作与命令回执符号，新代码直接从 `client`、`actions/*`、`commandMessages` 等叶子模块导入。aiChat 与 antiRaid 的生产代码内部仍直接 import 对应 owner 叶子模块；这三个入口都不使用无边界的 `export *`。

## 测试的镜像结构

`test/` 与 `packages/` 路径原则上一一对应；同一拆分领域可以共享领域级测试，例如 `packages/workers/diskIO/verificationCodec.ts`、`verificationRecovery.ts`、`verificationWrites.ts` 统一由 `test/workers/diskIO/verificationFiles.test.ts` 覆盖。其余新模块的测试文件跟随目录结构创建，跨领域共用的替身、夹具与 harness 放 `test/helpers/`，与领域无关的通用小工具放 `test/libs/helpers.ts`，全局隔离机制见 [05 开发流程](05-dev-workflow.md#测试隔离机制)。

---

<div align="center">

[← 上一页：02 架构总览](02-architecture.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#03-目录导览与代码放置) · [下一页：04 权威约束 →](04-invariants.md)

</div>
