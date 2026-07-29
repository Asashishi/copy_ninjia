# 03 目录导览与代码放置

<p align="center">
  <b>简体中文</b> · <a href="en/03-directory-map.md">English</a> · <a href="ja/03-directory-map.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 开发者文档首页</a> · <a href="02-architecture.md">← 上一页：02 架构总览</a> · <a href="04-invariants.md">下一页：04 权威约束 →</a>
</p>

---

本页回答「这段代码住在哪、新代码该放哪」。风格细则（引号、参数上限、import type 等）由 eslint 与 [`AGENTS.md`](../AGENTS.md) 约束，此处不重复。

## 目录职责

| 路径 | 职责 | 典型文件 |
| :--- | :--- | :--- |
| `packages/app/` | 启动/退出生命周期、已启用功能的启动前提核对、handler 注册、命令菜单、update runner | `lifecycle.ts`、`featurePreflight.ts`、`registerHandlers.ts`、`updateRunner.ts` |
| `packages/commands/` | 显式命令处理，一命令一文件；开关命令共用的权限与配置门禁另成文件 | `copy.ts`、`block.ts`、`cjkAction.ts`、`send.ts`、`targetResolution.ts`、`superAdminToggle.ts`、`configGate.ts` |
| `packages/auto/` | 非命令的自动行为：复读、AI 转录与触发、反应同步 | `message/`、`triggerPolicy.ts` |
| `packages/aiChat/` | AI 闲聊主线程代理：Worker 监督入口、记忆镜像、「此刻跑不跑」的唯一判定 | `index.ts`、`memoryMirror.ts`、`availability.ts` |
| `packages/antiRaid/` | Anti-Raid 主线程代理：Worker 监督入口、lockdown 恢复、待验证镜像接收、黑名单入群判定与广告判定的投递/处置 | `index.ts`、`lockdownMirror.ts`、`verificationMirror.ts`、`blocklistGuard.ts`、`adDetect.ts`、`memberFacts.ts` |
| `packages/copy/` | 复读模式变换、头像/反应/翻译的执行队列，以及日语翻译「此刻跑不跑」的唯一判定 | `copyModes.ts`、`avatarQueue.ts`、`reactionQueue.ts`、`translate.ts`、`availability.ts` |
| `packages/users/` | 发送者身份缓存、可见发送者判定、用户标签生成 | `senderIdentity.ts`、`visibleSender.ts`、`userLabel.ts` |
| `packages/states/` | **无 I/O** 的纯状态转移与准入规则：验证、锁定、AI 回复准入、广告检测准入 | `verification.ts`、`lockdown.ts`、`replyAdmission.ts`、`adDetectAdmission.ts` |
| `packages/config/` | `config/*.json` 的严格 schema 与惰性加载，以及按功能聚合的可用性判定 | `stickers.ts`、`reactions.ts`、`mood.ts`、`adSamples.ts`、`readiness.ts` |
| `packages/libs/` | 领域无关的基础设施：原子文件、有界 I/O、并发工具 | `flushBarrier.ts`、`linkedQueue.ts`、`text.ts` |
| `packages/workers/` | 三个 Worker 的线程内实现 | `aiChatWorker.ts` + `aiChat/`、`antiRaidWorker.ts` + `antiRaid/verification{Runtime,Events,Effects,Reminders}.ts` + `antiRaid/adDetect/`、`diskIOWorker.ts` + `diskIO/` |
| `packages/ai/` | 各家模型的收发入口与 AI 能力实现：Gemini 客户端、DeepSeek 客户端、视觉描述、生图、贴纸目录、工具实现 | `gemini.ts`、`deepseek.ts`、`tools/replyToolset/`、`imageGeneration.ts` |
| `packages/workers/antiRaid/adDetect/` | 广告检测流水线（DeepSeek）：排队批处理、消息串整形、判定与命中处置 | `queue.ts`、`bundle.ts`、`classifier.ts`、`disposal.ts` |
| `packages/infra/` | Telegram 客户端、Worker 宿主、logger、env 配置 | `telegram/`、`config.ts`、`workerSupervisor.ts` |
| `packages/infra/blocklist/` | 黑名单主线程基础设施，按同步名单、durable outbox、群清扫拆分；`infra/blocklist.ts` 只保留兼容导出 | `membership.ts`、`outbox.ts`、`sweep.ts` |
| `packages/infra/storage/` | 数据根预检、实例锁、StateStore、启动清理 | `dataRoot.ts`、`instanceLock.ts`、`stateStore.ts` |
| `packages/cache/` | 按领域拆分的进程内可变状态容器 | `aiChat/`、`copy/`、`senderIdentity.ts` |
| `packages/consts/` | 字面量常量与调参值，按领域分文件/子目录 | `commands.ts`、`aiChat/rateLimit.ts`、`antiRaid/` |
| `packages/types/` | 跨模块协议、领域类型、状态机契约（`types/states/`） | `chatState.ts`、`lifecycle.ts` |
| `test/` | 与 `packages/` 镜像的 Bun 单元测试 | `test/commands/copyShared.test.ts` |
| `scripts/` | 仓库自检脚本 | `checkProjectConventions.ts` |

## 新代码放置决策

按这个顺序问自己：

1. **是字面量参数？** → `packages/consts/<domain>.ts`（或领域大了拆 `packages/consts/<domain>/`）。带中文 JSDoc 说明用途与不变量。env 派生的配置是唯一例外，进 `packages/infra/config.ts`。
2. **是跨模块共享的类型/协议？** → `packages/types/<domain>.ts`。状态机的 `State/Event/Effect/Transition/Decision` 契约放 `packages/types/states/`。
3. **是长期存活的可变状态**（Map/Set/队列/timer/单例）？ → `packages/cache/<domain>/`，holder 对象而非 `export let`，JSDoc 写清何时填充、何时清理、Worker 重启后如何重建。容量与清理策略必须满足 [04 运行时权威约束](04-invariants.md)。
4. **是纯状态转移逻辑**（无 I/O、可单测）？ → `packages/states/`；副作用由 worker 侧解释器执行。
5. **是副作用/编排**？ → 按 owner 归位：命令进 `packages/commands/`，自动行为进 `packages/auto/`，Worker 线程内逻辑进 `packages/workers/<domain>/`，AI 能力进 `packages/ai/`，进程级基础设施进 `packages/infra/`。

反例（都在历史审查中被清理过）：业务文件里长出模块级 Map、常量散落在使用处、worker 里直接 `fs` 写共享目录绕过 Disk I/O Worker。

## 兼容入口（barrel）约定

大文件拆分成子模块后，原文件降级为纯 `export * from` 兼容入口（如 `packages/consts/aiChat.ts` 对 `packages/consts/aiChat/`）。规则：

- 兼容入口只服务旧 import 的渐进迁移；**新代码一律直接从领域子文件导入**。
- 兼容入口不得重新持有状态、解析配置或引入 import 副作用。
- `packages/types/index.ts` 同理，仅为测试/渐进迁移保留。
- 包内 `index.ts` 是另一回事：主线程代理这类模块的入口本身就是实现（如 `packages/aiChat/index.ts`、`packages/antiRaid/index.ts`），与同包的子模块一起构成一个包，不受上面三条约束。

## 测试的镜像结构

`test/` 与 `packages/` 路径一一对应：改 `packages/workers/diskIO/verificationFiles.ts` 就去 `test/workers/diskIO/verificationFiles.test.ts`。新模块的测试文件跟随此结构创建，公共测试辅助在 `test/libs/helpers.ts`，全局隔离机制见 [05 开发流程](05-dev-workflow.md#测试隔离机制)。

---

<div align="center">

[← 上一页：02 架构总览](02-architecture.md) · [📚 开发者文档首页](README.md) · [⬆️ 回到顶部](#03-目录导览与代码放置) · [下一页：04 权威约束 →](04-invariants.md)

</div>
