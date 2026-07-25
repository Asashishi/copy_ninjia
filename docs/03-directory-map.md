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
| `src/app/` | 启动/退出生命周期、handler 注册、命令菜单、update runner | `lifecycle.ts`、`registerHandlers.ts`、`updateRunner.ts` |
| `src/commands/` | 显式命令处理，一命令一文件 | `copy.ts`、`kick.ts`、`send.ts`、`targetResolution.ts` |
| `src/auto/` | 非命令的自动行为：复读、AI 转录与触发、反应同步 | `message/`、`triggerPolicy.ts` |
| `src/aiChat/` | AI 闲聊主线程代理：Worker 监督入口与记忆镜像 | `index.ts`、`memoryMirror.ts` |
| `src/antiRaid/` | Anti-Raid 主线程代理：Worker 监督入口、lockdown 恢复与待验证镜像接收 | `index.ts`、`lockdownMirror.ts`、`verificationMirror.ts` |
| `src/copy/` | 复读模式变换与头像/反应/翻译的执行队列 | `copyModes.ts`、`avatarQueue.ts`、`reactionQueue.ts`、`translate.ts` |
| `src/users/` | 发送者身份缓存、可见发送者判定、用户标签生成 | `senderIdentity.ts`、`visibleSender.ts`、`userLabel.ts` |
| `src/states/` | **无 I/O** 的纯状态转移：验证、锁定、回复准入 | `verification.ts`、`lockdown.ts` |
| `src/config/` | `config/*.json` 的严格 schema、惰性加载与启动校验 | `stickers.ts`、`reactions.ts`、`mood.ts` |
| `src/libs/` | 领域无关的基础设施：原子文件、有界 I/O、并发工具 | `flushBarrier.ts`、`linkedQueue.ts`、`text.ts` |
| `src/workers/` | 三个 Worker 的线程内实现 | `aiChatWorker.ts` + `aiChat/`、`antiRaidWorker.ts` + `antiRaid/verification{Runtime,Events,Effects,Reminders}.ts`、`diskIOWorker.ts` + `diskIO/` |
| `src/ai/` | Gemini 客户端、视觉描述、生图、贴纸目录、工具实现 | `gemini.ts`、`tools/replyToolset/`、`imageGeneration.ts` |
| `src/infra/` | Telegram 客户端、Worker 宿主、logger、env 配置 | `telegram/`、`config.ts`、`workerSupervisor.ts` |
| `src/infra/storage/` | 数据根预检、实例锁、StateStore、启动清理 | `dataRoot.ts`、`instanceLock.ts`、`stateStore.ts` |
| `src/cache/` | 按领域拆分的进程内可变状态容器 | `aiChat/`、`copy/`、`senderIdentity.ts` |
| `src/consts/` | 字面量常量与调参值，按领域分文件/子目录 | `commands.ts`、`aiChat/rateLimit.ts`、`antiRaid/` |
| `src/types/` | 跨模块协议、领域类型、状态机契约（`types/states/`） | `chatState.ts`、`lifecycle.ts` |
| `test/` | 与 `src/` 镜像的 Bun 单元测试 | `test/commands/copyShared.test.ts` |
| `scripts/` | 仓库自检脚本 | `checkProjectConventions.ts` |

## 新代码放置决策

按这个顺序问自己：

1. **是字面量参数？** → `src/consts/<domain>.ts`（或领域大了拆 `src/consts/<domain>/`）。带中文 JSDoc 说明用途与不变量。env 派生的配置是唯一例外，进 `src/infra/config.ts`。
2. **是跨模块共享的类型/协议？** → `src/types/<domain>.ts`。状态机的 `State/Event/Effect/Transition/Decision` 契约放 `src/types/states/`。
3. **是长期存活的可变状态**（Map/Set/队列/timer/单例）？ → `src/cache/<domain>/`，holder 对象而非 `export let`，JSDoc 写清何时填充、何时清理、Worker 重启后如何重建。容量与清理策略必须满足 [04 运行时权威约束](04-invariants.md)。
4. **是纯状态转移逻辑**（无 I/O、可单测）？ → `src/states/`；副作用由 worker 侧解释器执行。
5. **是副作用/编排**？ → 按 owner 归位：命令进 `src/commands/`，自动行为进 `src/auto/`，Worker 线程内逻辑进 `src/workers/<domain>/`，AI 能力进 `src/ai/`，进程级基础设施进 `src/infra/`。

反例（都在历史审查中被清理过）：业务文件里长出模块级 Map、常量散落在使用处、worker 里直接 `fs` 写共享目录绕过 Disk I/O Worker。

## 兼容入口（barrel）约定

大文件拆分成子模块后，原文件降级为纯 `export * from` 兼容入口（如 `src/consts/aiChat.ts` 对 `src/consts/aiChat/`）。规则：

- 兼容入口只服务旧 import 的渐进迁移；**新代码一律直接从领域子文件导入**。
- 兼容入口不得重新持有状态、解析配置或引入 import 副作用。
- `src/types/index.ts` 同理，仅为测试/渐进迁移保留。
- 包内 `index.ts` 是另一回事：主线程代理这类模块的入口本身就是实现（如 `src/aiChat/index.ts`、`src/antiRaid/index.ts`），与同包的子模块一起构成一个包，不受上面三条约束。

## 测试的镜像结构

`test/` 与 `src/` 路径一一对应：改 `src/workers/diskIO/verificationFiles.ts` 就去 `test/workers/diskIO/verificationFiles.test.ts`。新模块的测试文件跟随此结构创建，公共测试辅助在 `test/libs/helpers.ts`，全局隔离机制见 [05 开发流程](05-dev-workflow.md#测试隔离机制)。

---

<div align="center">

[← 上一页：02 架构总览](02-architecture.md) · [📚 开发者文档首页](README.md) · [⬆️ 回到顶部](#03-目录导览与代码放置) · [下一页：04 权威约束 →](04-invariants.md)

</div>
