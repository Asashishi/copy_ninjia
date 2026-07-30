# 项目须知

## 改文件前先备份重要状态
改动运行时状态/数据文件（`state.json`、`memory/` 快照、`bot.lock` 等），或改动会触发代码路径写这类文件时，先 `cp` 备份一份（或读出内容存进 scratchpad）再动手，确认无误后清理备份。一切可能被运行中进程读写、或没有版本控制兜底的文件都适用。

## 新旧文件格式兼容性
文件结构变化时，手动把旧文件迁移到新格式，不在代码中保留任何兼容逻辑。

## 分支与提交
- 仓库只有 `master` 与 `dev` 两个分支，不开功能分支。一切开发在 `dev` 上进行，不直接向 `master` 提交。
- 每次 `git commit` 前先 `git branch --show-current` 确认所在分支：`master` 上只允许 `git merge --squash` 之后的那一次提交，其余一律在 `dev` 上。误提交到 `master` 且尚未推送时，用 `git cherry-pick` 把提交搬到 `dev`、`git branch -f master origin/master` 复位，再走正常 squash 流程。
- 合并进 `master` 只用 squash（`git merge --squash` + 单次 `git commit`），一次改动收敛成一个提交，开发过程中的中间提交不进 `master` 历史。
- squash 提交的信息要覆盖整个改动集，并说明「为什么这么改」而不只是「改了什么」。
- 合并前必须 `bun run check` 全绿；碰到持久化、停机、Worker 生命周期相关代码时再补 `bun run test:fault-injection`。任一项失败不得合并。
- 每次准备合并 `master` 时，先同步远端 tags，并用 `gh release list` 读取 GitHub 当前 Latest Release 的 tag；版本只允许不带 `v` 前缀的 `MAJOR.MINOR.PATCH`（例如 `1.0.9`）。新版本按本次完整改动的最高语义影响决定：破坏兼容升 `MAJOR`（`1.0.9` → `2.0.0`），向后兼容的新增功能升 `MINOR`（`1.0.9` → `1.1.0`），只有修复、性能、重构或文档时才升 `PATCH`（`1.0.9` → `1.0.10`）；混合改动取其中最高级别。不得凭本地旧 tag 猜版本；目标 tag 已存在时重新拉取 Release 状态并计算，禁止覆盖、移动或复用已有 tag。
- `master` squash 提交经门禁确认后，先推送 `master`，再为该提交创建 annotated version tag 并单独推送。两次推送均成功后，用 `gh release create <tag> --verify-tag --target master ...` 创建 GitHub Release；Release 标题和说明使用英文，只介绍「上一个 Latest Release tag..本次 `master`」的最新增量，至少包含 Highlights、Compatibility / Migration Notes、Validation，测试数与覆盖率必须来自本次真实门禁输出。
- tag 已推送但 GitHub Release 创建失败时，保留该 tag 并针对同一 tag 重试，不得再次递增版本。`master`、version tag、GitHub Release 任一步未确认成功，都不得宣称发布完成，也不得提前改写 `dev`。
- `master`、version tag 与 GitHub Release 全部发布成功后，把 `dev` 重新对齐到 `master` 再继续：先 `git diff dev master --quiet` 确认两边树一致，再在 `dev` 上执行 `git reset --hard master` 与 `git push --force-with-lease origin dev`。
- 覆盖率/测试数分散在徽章、`docs/assets/coverage_{light,dark}.svg`、README 的 `<img alt>` 与三份开发文档里：仅在用户明确要求同步文档或指标时，才按合并前那次 `bun run check` 的真实输出逐处同步，不要凭估计填；未明确要求时不改这些文件，只在交付时提醒用户指标已变化并列出待同步位置。完整位置清单见 [`docs/05-dev-workflow.md`](docs/05-dev-workflow.md) 的「同步 README 指标」。

## 编码规范
- 当一个文件的代码行数超过 500 行，考虑拆分成多个文件；超过 1000 行，必须拆分。
- 风格细则（引号、缩进、逗号、空格等）由 eslint 强制；提交前跑 `bun run lint && bun run typecheck`（或全量 `bun run check`）。以下是放置位置与写法约定，未列出的以现有代码为准；跨模块、跨生命周期的权威约束见 `docs/04-invariants.md`。

### 常量
- 字面量常量集中在 `packages/consts/<domain>.ts`，不散落在业务模块；env 派生的配置是例外，统一在 `packages/infra/config.ts`。
- SCREAMING_SNAKE_CASE，显式类型标注（`STATE_SAVE_MAX_ATTEMPTS: number`）；容器用 `readonly` / `Readonly<T>`，跨调用方共享的对象常量 `Object.freeze`。
- 每个常量带中文 JSDoc 说明用途与不变量，指明所属模块；长数值字面量用 `_` 分隔（`30_000`）。
- 领域变大后拆成 `packages/consts/<domain>/` 子模块，原 `<domain>.ts` 降级为兼容入口（`export * from`），新代码直接从子模块导入。

### 缓存（进程内存状态）
- 长期存活的 Map/Set/队列/timer/单例引用放 `packages/cache/`，**第一层目录必须是 owner 线程**：`main/`、`workers/aiChat/`、`workers/antiRaid/`、`workers/diskIO/`、`perThread/`（每线程各一份、彼此无关的状态）。文件头注明 owner 模块，如「AI 闲聊主线程侧代理（packages/aiChat/index.ts）的内存状态」。
- 一份缓存只能被它所属的那条线程 import——跨线程只传消息不共享内存，别的线程拿到的是同一份代码的另一个实例，写进去对面永远读不到。`bun run check:conventions` 会从四个线程入口算运行时 import 闭包核对这件事，违例时打印完整引入链；完整规则见 `docs/04-invariants.md` 的「线程与状态归属」。
- 可变单例用 holder 对象 `{ current: T | null }`，不用 `export let`。
- 每个导出带 JSDoc 说明生命周期：何时填充、何时清理、Worker 崩溃重启后如何重建；容量与清理策略须满足 `docs/04-invariants.md` 的约束。
- 泛型写在类型标注上：`const cache: Map<number, string> = new Map()`。

#### 新增缓存的最低跨线程要求
按顺序过这几条，前一条能满足就不要往下走：

1. **先定 owner：谁写它就归谁。** 判不出唯一写者，说明这不该是一份缓存，而是两份。目录第一层写上这条线程，门禁按真实模块图核对。
2. **默认不许为一份新缓存新增任何跨线程消息。** 先问「能不能放在用它的那条线程」——能就放那儿，到此为止。绝大多数缓存止于这一条。
3. **只有观测点与使用点天生不在同一条线程时才允许镜像**（例如只有主线程收得到 Telegram update，只有 Anti-Raid Worker 发得出踢人请求）。允许的形态只有两种：owner 侧**变更时推送**、使用侧只读；或为了不丢数据的**持久化回执**往返。
4. **禁止「按需向对面要」（每次读取一条 request/reply）。** 一次内存访问换一次 IPC 往返，量级差着数个数量级；真需要这么做，说明缓存放错了线程，回到第 2 条重选，而不是加协议。
5. **每条群消息级的高频路径上不得新增镜像同步。** 判定要的字段直接放进那条消息里——现成范例是 `floodCandidate`/`adCandidate` 的 `label` 由主线程算好带过去，Worker 不为此另养一份身份缓存。
6. **镜像的 JSDoc 必须写清四件事，缺一不可**：权威副本在哪条线程；何时推、推全量还是增量；Worker 崩溃重建与进程重启后由谁重放补齐；**「没有条目」表示什么**——必须落在安全的那一侧（「此刻未知 / 这个动作做不了」），绝不能折算成沿用旧值。现成范例见 `packages/cache/workers/antiRaid/botPermissions.ts`。
7. **别让纯函数和别的线程的缓存同住一个文件。** 主线程 import 一个纯函数，就会把同文件里 Worker 独占的 Map 在主线程也实例化一份、且永远是空的。拆成不碰缓存的叶子模块，范例见 `packages/ai/stickers/describe.ts`。

### 类型安全
- 变量类型应该显式写明，不依赖类型推导；函数参数、返回值、对象属性、数组元素等都要标注类型，包括 for (let i: number)。三处例外：`for...of` / `for...in` 的循环变量（TS 语法不允许标注）、初始化器已是全标注箭头函数的 const（不再重复写一遍函数类型）、类型定义反过来引用自身的 `typeof` 常量。
- 共享类型按领域放 `packages/types/<domain>.ts`；`packages/types/index.ts` 汇总入口只留给测试与渐进迁移，生产代码从领域文件直接导入。
- 类型导入用独立的 `import type` 语句，与值导入分开。
- 导出函数显式标注返回类型（含 `Promise<T>`）；`catch (error: unknown)`。
- 生产代码禁 `any`（测试文件豁免）；tsconfig 全严格且开 `noUncheckedIndexedAccess`，索引访问要处理 `undefined`。

### 传参
- 位置参数最多 3 个（eslint `max-params`）；超过就收敛成单个 options 对象，类型用导出的 `XxxParams` interface 定义在函数旁，函数签名处解构。
- 可选项在 interface 上标 `?`，默认值写在解构处（`api = bot.api`）。
- 导出函数用 `function` 声明；箭头函数只用于回调和 IIFE。

### 注释与日志
- 注释用中文，解释局部不变量和「为什么」；涉及跨模块约束时引用 `docs/04-invariants.md`，不重复叙述。
- 日志一律使用 `logger`，不直接 `console.log`；`packages/workers/diskIOWorker.ts` 与 `packages/workers/diskIO/` 自身的报错例外，用 `console.error`。
- `logger.error` 等错误日志文案一律英文。

### 文档
- 代码中涉及的约束、流程、设计理念等，写在 `docs/` 下的 Markdown 文档里；代码里只写必要的 JSDoc 注释。
- 本节是文档改动的执行门禁；仓库其他文件中“需同步”“应更新”等说明只用于定位待同步范围，不构成用户未明确要求时主动修改文档的授权。
- 用户未显式要求修改或同步文档时，不主动改动 `docs/`、README、文档资产或其他说明文件；若代码变更导致文档、参数说明或实测指标失真，只在交付时明确提醒用户有哪些内容需要同步。
- 只有用户明确提出“更新文档”“同步文档 / README / 指标”等要求时，才在本次任务中同步；同步内容必须依据本次真实代码与门禁输出，不得凭估计填写。
