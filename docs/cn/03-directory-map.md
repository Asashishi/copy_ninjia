# 03 目录导览与代码放置

<p align="center">
  <b>简体中文</b> · <a href="../en/03-directory-map.md">English</a> · <a href="../ja/03-directory-map.md">日本語</a>
</p>

<p align="center">
  <a href="conntent-table.md">📚 开发者文档首页</a> · <a href="02-architecture.md">← 上一页：02 架构总览</a> · <a href="04-invariants.md">下一页：04 权威约束 →</a>
</p>

---

本页回答「这段代码住在哪、新代码该放哪」。风格细则（引号、参数上限、import type 等）由 eslint 与 [`AGENTS.md`](../../AGENTS.md) 约束，此处不重复。

## 目录职责

- **`packages/app/`**
  - **职责**：启动/退出生命周期、已存在部署输入的启动校验出口、handler 注册、命令菜单
    与 update runner，以及生命周期副作用依赖装配。
  - **典型文件**：`lifecycle.ts`、`lifecycleDependencies.ts`、`featurePreflight.ts`、
    `registerHandlers.ts`、`updateRunner.ts`。`ApplicationLifecycleDependencies` 从装配对象
    推导并与其同住，避免共享类型层反向依赖 `app/`。
- **`packages/commands/`**
  - **职责**：显式命令处理，一命令一文件；开关命令共用的权限与配置门禁另成文件。
  - **典型文件**：`copy.ts`、`block.ts`、`mute.ts`、`batchKick.ts`、
    `targetResolution.ts`、`configGate.ts`；较大的 gag 领域以 `gag.ts` 保留命令入口，
    `gag/runtime.ts`、`gag/inline.ts`、`gag/rendering.ts` 分别承接生命周期、inline 与纯渲染。
- **`packages/auto/`**
  - **职责**：非命令的自动行为，包括复读、AI 转录与触发、反应同步。
  - **典型文件**：`message/`、`triggerPolicy.ts`。
- **`packages/aiChat/`**
  - **职责**：AI 闲聊主线程代理与模型能力，包括 Worker 监督、记忆镜像、可用性判定，
    以及供应商实现包（`gemini/`、`openai/`）、provider 选取、贴纸、工具和媒体实现。
  - **典型文件**：`workerBridge.ts`、`messageIngress.ts`、`memoryMirror.ts`、
    `availability.ts`、`provider.ts`、`gemini/`、`openai/`、`ai/`；
    `index.ts` 只提供薄公开入口。
- **`packages/antiRaid/`**
  - **职责**：Anti-Raid 主线程代理与广告模型能力，包括 Worker 监督、持久化交接、
    update 入口，以及黑名单/验证/广告/刷屏编排。
  - **典型文件**：`workerBridge.ts`、`durableDelivery.ts`、`updateIngress.ts`、
    `adCandidate.ts`、`ai/`；`index.ts` 只提供薄公开入口。
- **`packages/copy/`**
  - **职责**：复读模式变换、头像/反应/翻译执行队列，以及日语翻译“此刻跑不跑”的
    唯一判定。
  - **典型文件**：`copyModes.ts`、`avatarQueue.ts`、`reactionQueue.ts`、
    `translate.ts`、`availability.ts`。
- **`packages/users/`**
  - **职责**：发送者身份缓存、可见发送者判定、用户标签生成。
  - **典型文件**：`senderIdentity.ts`、`visibleSender.ts`、`userLabel.ts`。
- **`packages/states/`**
  - **职责**：**无 I/O** 的纯状态转移与准入规则，包括验证、锁定、AI 回复准入和
    广告检测准入。
  - **典型文件**：`verification.ts` 与 `verification/`（`join`/`pending`/`terminal`/`disable`
    四段生命周期）、`lockdown.ts`、`replyAdmission.ts`、`adDetectAdmission.ts`。
- **`packages/config/`**
  - **职责**：部署 `config/*.json` 的严格 schema、进程快照与按功能聚合的可用性判定；身份策略不在这里。
  - **典型文件**：`telegram.ts`、`agent.ts`、`stickers.ts`、`adSamples.ts`、`readiness.ts`。
- **`packages/database/`**
  - **职责**：共享 SQLite（身份策略 + 群状态）的 schema、codec、行校验与 Drizzle 交互边界；运行时句柄只由 Disk I/O Worker 持有。
  - **典型目录**：`schema/`（含 `migrations/`）、`codec/identity.ts`、`codec/chatState.ts`、
    `interact/`（`connection.ts`、`transaction.ts`、`identityPolicy.ts`、`chatState.ts`、
    `migration.ts`、`inspection.ts`）、`validation/storageRows.ts`。
- **`packages/libs/`**
  - **职责**：领域无关的基础设施，包括原子文件、有界 I/O 与并发工具。
  - **典型文件**：`flushBarrier.ts`、`linkedQueue.ts`、`acknowledgedBatchQueue.ts`、
    `boundedSettledBatch.ts`、`monotonicDeadline.ts`、`text.ts`。
- **`packages/workers/`**
  - **职责**：三个 Worker 的线程内实现。
  - **典型文件**：`aiChatWorker.ts`、`antiRaidWorker.ts`、`diskIOWorker.ts`，以及
    `aiChat/`、`antiRaid/verificationEffects/`、`diskIO/storageDatabase.ts` 与
    `diskIO/storageDatabase/`、`diskIO/verification{Codec,Recovery,Writes}.ts`。
- **`packages/aiChat/ai/` / `packages/antiRaid/ai/`**
  - **职责**：模型与能力按所属功能放置，避免共享目录模糊线程和生命周期边界。
  - **典型文件**：`tools/replyToolset/`、`utils/`、`provider.ts`；AI 闲聊的模型收发不在
    这里，而在与供应商同名的 `packages/aiChat/{gemini,openai}/` 实现包。
- **`packages/workers/antiRaid/adDetect/`**
  - **职责**：广告检测流水线，包括排队批处理、消息串整形、provider 判定与命中处置。
  - **典型文件**：`queue.ts`、`bundle.ts`、`classifier.ts`、`disposal.ts`。
- **`packages/infra/`**
  - **职责**：主线程唯一 Telegram 客户端与出站闸门、Worker 双工宿主、logger 与主线程 I/O 代理。
  - **典型文件**：`telegram/`、`diskIO.ts`、`identityStorage.ts`、`supervisedWorker.ts`、`workerSupervisor.ts`。
- **`packages/infra/blocklist/`**
  - **职责**：黑名单主线程基础设施，按身份判定、同步名单、durable outbox 与群清扫拆分。
  - **典型文件**：`membership.ts`、`outbox.ts`、`sweep.ts`、`sweepScheduler.ts`。
- **`packages/infra/storage/`**
  - **职责**：数据根预检、实例锁、业务状态门面、可注入的 `state.json` 持久化边界与启动清理。
  - **典型文件**：`dataRoot.ts`、`instanceLock.ts`、`stateStore.ts`、`statePersistence.ts`。
    前者负责业务内存与快照，后者负责严格解码、latest-only 写入、重试与 flush。
- **`packages/cache/`**
  - **职责**：进程内可变状态容器，**第一层目录就是 owner 线程**。
  - **典型目录**：`main/`、`workers/aiChat/`、`workers/antiRaid/`、
    `workers/diskIO/`、`perThread/`。
- **`packages/consts/`**
  - **职责**：字面量常量、调参值与用户可见文案表，按领域分文件/子目录。
  - **典型文件**：`commands.ts`、`whitelist.ts`、`aiChat/rateLimit.ts`、`antiRaid/`。
- **`packages/types/`**
  - **职责**：跨模块协议、领域类型、状态机契约（`types/states/`）。
  - **典型文件**：`chatState.ts`、`commands.ts`、`lifecycle.ts`、`diskIO.ts`。
- **`test/`**
  - **职责**：与 `packages/` 镜像的 Bun 单元测试。
  - **典型文件**：`test/commands/copyShared.test.ts`。
- **`scripts/`**
  - **职责**：仓库自检、性能基准与必须停机执行的显式数据迁移。
  - **典型文件**：`checkProjectConventions.ts` 与 `conventions/`、`migrateIdentityStorageToSqlite.ts`、`migrateChatStateToSqlite.ts`、`storageDatabaseIntegrity.ts`、`perf/identityDatabase.ts`、`perf/joinLog.ts`、`perf/hotPaths.ts`、`perf/hotPathProfileGate.ts`，以及只在发布时跑的全量基准 `perf/fullSuite.ts` 与 `perf/fullSuite/`。

## 新代码放置决策

按这个顺序问自己：

1. **是字面量参数、或用户可见文案？** → `packages/consts/<domain>.ts`（或领域大了拆 `packages/consts/<domain>/`）。带中文 JSDoc 说明用途与不变量。命令回执与提示按命令收成文案表，不留在 handler 里现造。部署 JSON 的解析与校验进入 `packages/config/<domain>.ts`；仅运行路径覆写由 `packages/consts/paths.ts` 读取进程环境。
2. **是跨模块共享的类型/协议？** → `packages/types/<domain>.ts`。状态机的 `State/Event/Effect/Transition/Decision` 契约放 `packages/types/states/`。
3. **是长期存活的可变状态**（Map/Set/队列/timer/单例）？ → `packages/cache/`，**先按 owner 线程选一层目录**（见下），再在里面按领域分文件；holder 对象而非 `export let`，JSDoc 写清何时填充、何时清理、Worker 重启后如何重建。容量与清理策略必须满足 [04 运行时权威约束](04-invariants.md)。
4. **是纯状态转移逻辑**（无 I/O、可单测）？ → `packages/states/`；副作用由 worker 侧解释器执行。
5. **是副作用/编排**？ → 按 owner 归位：命令进 `packages/commands/`，自动行为进 `packages/auto/`，Worker 线程内逻辑进 `packages/workers/<domain>/`，模型能力进所属功能的 `ai/` 子目录，进程级基础设施进 `packages/infra/`。

反例（都在历史审查中被清理过）：业务文件里长出模块级 Map、常量散落在使用处、worker 里直接 `fs` 写共享目录绕过 Disk I/O Worker。

## 缓存按线程分权

`packages/cache/` 的第一层目录声明这份状态归哪条线程所有——跨线程只传消息、不共享内存，同一个 cache 模块被两条线程 import 就是两份互不相干的实例：

- **`main/`**
  - **owner**：主线程。
  - **内容**：命令与自动流水线状态、由 `stateStore.ts` 门面管理的 `state.json` 全局镜像与 `chatState.ts` 的 `chat_states` 群状态 LRU（容量 25）、Disk I/O 宿主，以及
    **主线程侧的 Worker 代理与镜像**（`main/aiChat.ts`、`main/antiRaid/`）。
- **`workers/aiChat/`**
  - **owner**：AI 闲聊 Worker。
  - **内容**：滚动记忆、回复准入、心情、贴纸目录与集合、两家供应商的客户端单例。
- **`workers/antiRaid/`**
  - **owner**：Anti-Raid Worker。
  - **内容**：验证/锁定状态机、刷屏窗口、广告检测队列、Google/OpenAI 客户端。
- **`workers/diskIO/`**
  - **owner**：Disk I/O Worker。
  - **内容**：各领域文件的写入缓冲、索引与脏标记。
- **`perThread/`**
  - **owner**：每条线程各一份。
  - **内容**：Telegram 能力实现 holder（主线程真实适配器、业务 Worker 双工代理）、
    Worker 双工 waiter、部署配置单例、自发消息登记；同一份代码在每条线程独立实例化。

注意 `main/antiRaid/` 与 `workers/antiRaid/` 是**两拨完全不共享的状态**：权威状态机在 Worker 内，主线程那份只是供崩溃重放的纯数据镜像。放错目录不是风格问题——写进去的东西对面永远读不到。`bun run check:conventions` 按真实模块图核对这条归属（详见 [04 运行时权威约束](04-invariants.md#线程与状态归属)），违例时打印完整引入链。

`packages/aiChat/ai/` 这类被多条线程复用的领域代码要留意：一个只被主线程用到的纯函数，若与 Worker 独占的缓存同住一个文件，主线程 import 它就会把那份缓存一并实例化。范例是 [`packages/aiChat/ai/stickers/describe.ts`](../../packages/aiChat/ai/stickers/describe.ts)——它从 `sets.ts` 拆出来，就是为了让主线程的消息流水线拿到贴纸描述函数时不碰 AI Worker 的贴纸集合缓存。

## 兼容入口（barrel）约定

大文件拆分成子模块后，原文件可以降级为无状态的薄兼容导出入口（如 `packages/infra/telegram/actions.ts` 对 `packages/infra/telegram/actions/`，以及验证文件领域的 `verificationFiles.ts`）。规则：

- 兼容入口只服务旧 import 的渐进迁移；**新代码一律直接从领域子文件导入**。
- 兼容入口不得重新持有状态、解析配置或引入 import 副作用。
- `packages/types/index.ts` 同理，仅为测试/渐进迁移保留。
- 包内 `index.ts` 只有在调用方确实需要单一 package surface 时才作为稳定公开入口；当前 `packages/aiChat/index.ts` 与 `packages/antiRaid/index.ts` 都只做显式薄导出、不持有状态。生产代码内部仍直接 import 对应 owner 叶子模块，且不使用无边界的 `export *`。

## 测试的镜像结构

`test/` 与 `packages/` 路径原则上一一对应；同一拆分领域可以共享领域级测试，例如 `packages/workers/diskIO/verificationCodec.ts`、`verificationRecovery.ts`、`verificationWrites.ts` 统一由 `test/workers/diskIO/verificationFiles.test.ts` 覆盖。其余新模块的测试文件跟随目录结构创建，公共测试辅助在 `test/libs/helpers.ts`，全局隔离机制见 [05 开发流程](05-dev-workflow.md#测试隔离机制)。

---

<div align="center">

[← 上一页：02 架构总览](02-architecture.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#03-目录导览与代码放置) · [下一页：04 权威约束 →](04-invariants.md)

</div>
