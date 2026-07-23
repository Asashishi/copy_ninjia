# 06 常见修改配方

**简体中文** · [English](en/06-modification-guide.md) · [日本語](ja/06-modification-guide.md)

[← 05 开发流程](05-dev-workflow.md) · [返回目录](README.md) · 下一页：[07 运维与排障](07-operations.md)

每个配方给出触碰的文件与顺序。通用前提：改动前读 [`AGENTS.md`](../AGENTS.md)；涉及运行时数据文件（`state.json`、`memory/`、`bot.lock`）或会间接写它们的代码路径时，动手前先备份；完成后 `bun run check` 全绿并按需同步根 README。

## 新增一个斜杠命令

1. **handler**：在 `src/commands/` 新建一文件，`function` 声明导出 `handleXxxCommand`，显式返回类型。权限门禁参考现成模式：白名单看 `kick.ts`，超管看 `superAdminToggle.ts` / `switchMood.ts`，仅私聊看 `send.ts`（非本人/非私聊静默 return，不回错误提示）。
2. **导出**：加入 `src/commands/index.ts`。
3. **注册**：在 [`src/app/registerHandlers.ts`](../src/app/registerHandlers.ts) 加 `bot.command("xxx", ...)`。注意注册点位于 init 网关、按群串行、私聊网关与入群验证 middleware 之后——新命令自动获得这些语义，不要在 handler 里重复做网关判断。
4. **私聊网关**：新命令若要在私聊中使用，还必须同步调整 [`src/infra/updateGate.ts`](../src/infra/updateGate.ts) 并补网关测试；当前私聊中的斜杠命令只显式放行 `/send`，仅注册 handler 不会到达命令处理器。纯群聊命令无需改这里。
5. **菜单**：要出现在 Telegram 命令菜单就在 [`src/consts/commands.ts`](../src/consts/commands.ts) 的 `BOT_COMMANDS` 加一项；像 `/send` 这类隐藏命令则不加。
6. **参数常量**：冷却、阈值等进 `src/consts/commands.ts` 或对应领域 consts，带中文 JSDoc。
7. **测试**：`test/commands/xxx.test.ts`，至少覆盖权限拒绝、参数解析与主路径。
8. **文档**：根 README「命令与权限」表加一行。

## 调整行为参数

参数全部集中在 `src/consts/`，改值不动业务代码。常用位置：

| 想调什么 | 文件 |
| :--- | :--- |
| AI 触发概率、限频、并发、队列 | `src/consts/aiChat/rateLimit.ts` |
| AI 记忆容量、快照周期、压缩背压 | `src/consts/aiChat/memory.ts` |
| 媒体描述长度、执行槽、LRU 容量 | `src/consts/aiChat/media.ts` |
| 生图冷却与字节上限 | `src/consts/aiChat/imageGeneration.ts` |
| 心情时长与开关超时 | `src/consts/aiChat/mood.ts` |
| 工具调用上限、模型名、请求超时 | `src/consts/aiChat/tools.ts` |
| 验证窗口、刷屏阈值、追加/收敛策略 | `src/consts/antiRaid/` |
| copy 冷却、/quiet 范围、用户名规则 | `src/consts/commands.ts` |
| 随机触发的发言人冷却 | `src/consts/auto.ts` |

步骤：改常量 → 更新它的中文 JSDoc（不变量变了就改说明）→ 检查根 README 是否引用了该数值并同步 → `bun run check`。

> [!WARNING]
> **容量类常量可能与磁盘数据耦合。** 例如调小 `AI_MEMORY_HYDRATE_BUFFER_MAX` 或 `MAX_SUMMARY_ROUNDS` 前，必须按 [04 运行时权威约束](04-invariants.md#持久化) 的要求在旧进程停止后原子重写现有 `memory/ai/` 快照。改这类值前先在 04 里确认没有踩到迁移要求。

## 新增一个 AI 工具

1. **名称常量**：在 [`src/consts/tools.ts`](../src/consts/tools.ts) 定义工具名；若工具产生可见副作用，确认是否应加入 `ACTION_TOOL_NAMES`。
2. **定义**：无状态的静态查询工具把 `ToolDefinition` 放进 [`src/ai/tools/index.ts`](../src/ai/tools/index.ts)；需要 chat 上下文、动态 schema 或逐轮状态的行动工具，在 `src/ai/tools/replyToolset/` 提供 definition builder。reply toolset 的 orchestrator 会把这些领域定义统一转换成 SDK `FunctionDeclaration`。
3. **实现**：在 `src/ai/tools/` 实现执行逻辑；面向 Telegram 的副作用经主线程代理执行，Worker 内不直接持有 Bot 实例。
4. **注册**：静态查询工具接入 `src/ai/tools/index.ts` 的分发；行动工具接入 `src/ai/tools/replyToolset/` 的 definitions、dispatch 与按轮状态。
5. **预算**：确认 `src/consts/aiChat/tools.ts` 里的动作预算、单函数调用上限对新工具的适用性；成功副作用要计入统一动作预算（约束见 [04](04-invariants.md#worker-与状态所有权)）。
6. **提示词**：如需使用规则，在 `src/consts/aiChat/prompts/` 补充；涉及转录格式的必须复用 `transcript.ts` 共享模板，两侧不得各自手写。
7. **测试 + 文档**：`test/ai/`（或对应 workers 路径）补测试；根 README「工具」行按需更新。

## 修改人设与 JSON 配置

- 人设：改 [`prompt/persona.md`](../prompt/persona.md)，重启生效。与转录格式、身份标记耦合的互动规则由代码注入，不写进人设文件。
- `config/stickers.json` / `reactions.json` / `mood.json`：schema 在 `src/config/` 对应文件，启动时严格校验（贴纸包最多 5 个；mood 权重必须为正整数且总和恰好 100）。改结构时先改 `src/config/` 的 schema 与 `src/types/`，再改 JSON，配错会拒绝启动。

## 新增环境变量

1. `src/infra/config.ts` 声明并解析（必填/可空、格式校验都在这里，解析失败拒绝启动）。
2. [`.env.example`](../.env.example) 加注释示例。
3. 根 README「配置」节与 [01 环境搭建](01-getting-started.md#配置-env) 的变量表同步。

## 新增运行时缓存

1. 放 `src/cache/<domain>/`（或领域文件），文件头注明 owner 模块；可变单例用 holder 对象 `{ current: T | null }`。
2. 每个导出写 JSDoc 生命周期：何时填充、何时清理、Worker 崩溃重启后如何重建。
3. 给出容量上限与清理策略，并核对 [04 运行时权威约束](04-invariants.md#worker-与状态所有权) 对长期容器的要求（有界、有 owner、有重建语义）。
4. 需要随停机 flush/结算的，统一走 `src/libs/flushBarrier.ts`，不自建 resolver Map。

## 变更持久化 schema

铁律（[AGENTS.md](../AGENTS.md) 与 [04](04-invariants.md#持久化)）：**代码不保留旧格式兼容逻辑，也不做运行时自动迁移**；不兼容输入直接拒绝启动。因此流程是：

1. 改 `src/types/` 中的持久化类型与对应校验，写好新格式的严格校验。
2. 补/改测试（`test/infra/storage/`、`test/workers/diskIO/` 等），跑 `bun run test:fault-injection`。
3. **停掉旧进程**（确认 `bot.lock` 释放）。
4. 手动把现有 `state.json`、`state.json.bak` 与受影响的 `memory/` 快照迁移到新格式；迁移前先复制备份。
5. 部署新版并启动。若报两份 state 副本均无效，说明迁移不完整——程序不会动原文件，修好再启。
6. 观察 `.corrupt` 隔离件与 `logs/`，确认无恢复异常后删除临时备份。

## 改动 Worker 间协议

`src/types/` 持有跨线程消息协议。改协议时同步三处：类型定义、主线程侧代理（`src/infra/` 或 `src/cache/` 对应模块）、Worker 侧处理（`src/workers/<domain>/`）。请求/回执式交互遵循 [04](04-invariants.md#worker-与状态所有权) 的 waiter 先登记再投递、超时/崩溃统一结算模式（现成范例：`/switch_mood` 握手）。

---

[← 05 开发流程](05-dev-workflow.md) · [返回目录](README.md) · 下一页：[07 运维与排障](07-operations.md)
