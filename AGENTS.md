# 项目须知

## 改文件前先备份重要状态

改动运行时状态/数据文件（`state.json`、`memory/` 快照、`bot.lock` 等），或改动会触发代码路径写这类文件（如测试只 mock 了 `infra/diskIO`、没 mock `infra/storage`，进而调到真实 `saveStateInBackground`）时，先 `cp` 备份一份（或读出内容存进 scratchpad）再动手，确认无误后清理备份。适用于一切可能被运行中进程读写、或没有版本控制兜底的文件。

## 新旧文件格式兼容性

文件结构变化时，手动把旧文件迁移到新格式，不在代码中保留任何兼容逻辑。

## 编码规范
- 当一个文件的代码行数超过 500 行，考虑拆分成多个文件；超过 1000 行，必须拆分。
- 风格细则（引号、缩进、逗号、空格等）由 eslint 强制，不在此重复；提交前跑 `bun run lint && bun run typecheck`（或全量 `bun run check`）。以下是放置位置与写法约定，部分有 eslint 规则兜底，其余以现有代码为准；跨模块、跨生命周期的权威约束见 `docs/04-invariants.md`，此处不重复。

### 常量

- 字面量常量集中在 `src/consts/<domain>.ts`，不散落在业务模块；env 派生的配置是例外，统一在 `src/infra/config.ts`。
- SCREAMING_SNAKE_CASE，显式类型标注（`STATE_SAVE_MAX_ATTEMPTS: number`）；容器用 `readonly` / `Readonly<T>`，跨调用方共享的对象常量 `Object.freeze`。
- 每个常量带中文 JSDoc 说明用途与不变量，指明所属模块；长数值字面量用 `_` 分隔（`30_000`）。
- 领域变大后拆成 `src/consts/<domain>/` 子模块，原 `<domain>.ts` 降级为兼容入口（`export * from`），新代码直接从子模块导入。

### 缓存（进程内存状态）

- 长期存活的 Map/Set/队列/timer/单例引用放 `src/cache/<domain>.ts`（或 `<domain>/`），文件头注明 owner 模块，如「AI 闲聊主线程侧代理（src/aiChat.ts）的内存状态」。
- 可变单例用 holder 对象 `{ current: T | null }`，不用 `export let`。
- 每个导出带 JSDoc 说明生命周期：何时填充、何时清理、Worker 崩溃重启后如何重建；容量与清理策略须满足 `docs/04-invariants.md` 的约束。
- 泛型写在类型标注上：`const cache: Map<number, string> = new Map()`。

### 类型安全

- 共享类型按领域放 `src/types/<domain>.ts`；`src/types/index.ts` 仅为测试/渐进迁移保留的汇总入口，生产代码从领域文件直接导入。
- 类型导入用独立的 `import type` 语句，与值导入分开。
- 导出函数显式标注返回类型（含 `Promise<T>`）；`catch (error: unknown)`。
- 生产代码禁 `any`（测试文件豁免）；tsconfig 全严格且开 `noUncheckedIndexedAccess`，索引访问要处理 `undefined`。

### 传参

- 位置参数最多 3 个（eslint `max-params`）；超过就收敛成单个 options 对象，类型用导出的 `XxxParams` interface 定义在函数旁，函数签名处解构。
- 可选项在 interface 上标 `?`，默认值写在解构处（`api = bot.api`）。
- 导出函数用 `function` 声明；箭头函数只用于回调和 IIFE。

### 注释与日志

- 注释用中文，解释局部不变量和「为什么」；涉及跨模块约束时引用 `docs/04-invariants.md`，不在多处重复维护同一套叙述。
- 除特殊情况无法使用 worker ，日志一律使用 `logger`，不直接 `console.log`。
- `logger.error` 等错误日志文案一律英文。

### 文档
- 代码中涉及的约束、流程、设计理念等，写在 `docs/` 下的 Markdown 文档里；代码里只写必要的 JSDoc 注释。
- 更新代码时，若涉及约束、流程、设计理念，相关参数的变更，必须同步更新 `docs/` 下的文档；
