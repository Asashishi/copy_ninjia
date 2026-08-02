# 项目须知

## 数据、配置与发布安全

- 改动运行时状态/数据（`state.json`、`memory/`、`bot.lock` 等），或会触发相关写路径前，先 `cp` 备份或读入 scratchpad；所有可能被运行进程写入、且无版本控制兜底的文件同理，确认无误后再清理备份。
- `config/`、`.env`、`g-auth.json` 和运行时状态都是部署方数据；即使受 Git 跟踪，也不能用 Git 历史、目标分支或 `config_example/` 代替部署备份。
- 仓库若是 systemd/supervisor 的 `WorkingDirectory`，优先在独立 clone/worktree 合并、测试、打 tag、发布。确需原地更新，必须先停服务并确认 inactive；无权限则暂停并说明，禁止 supervisor 在半迁移工作树上反复拉起。
- 执行 `pull`、`checkout`/`switch`、`merge`、`reset`、`rebase`、`clean` 等改写工作树的 Git 操作前，至少检查：`git status --short`、`git diff --name-status <current>..<target>`、`git ls-files config .env g-auth.json`。部署路径有新增/删除/重命名、`.gitignore` 变化，或文件将从“受跟踪”变为“忽略”时，必须走下列迁移流程。
- 迁移前用 `mktemp -d` 在工作树外备份部署文件，并记录清单、权限/属主、SHA-256；复制仅因无法保留属主而非零时也要逐文件核对哈希。敏感内容不得进入仓库、提交或输出正文。
- “受跟踪 → 忽略”的文件可能在首次切换到目标提交时被删除，目标分支已忽略它也不会阻止删除；必须提前外部备份，并在 Release 的 Compatibility / Migration Notes 写明备份、恢复和权限步骤。
- Git 操作后先恢复部署文件，再按新结构手工迁移；禁止 `cp -r config_example config` 覆盖现有配置。补缺也须使用不覆盖语义或逐项确认，并核对哈希/预期差异、严格解析与权限；`/white`、`/permission` 等会原子改写的目录和文件须对服务账号可写。
- 配置和状态全部就位后才能启动。启动后确认 `ActiveState=active`、`SubState=running`，观察至少两个 supervisor 重启间隔，并确认 `NRestarts` 不增长、journal 无新非零退出。只有哈希/迁移、配置校验和服务稳定性均确认后才能删外部备份；任一步失败都保留备份与现场并停止发布。
- 文件结构变化只做手工迁移，不在代码中保留旧格式兼容逻辑。

## 功能实现前先核查依赖

- 先查 `package.json`、锁文件、已安装版本的本地类型声明/源码及官方文档，确认当前技术栈和精确版本；OpenAI、Telegram/grammY 等 SDK 必须优先查官方文档，不凭记忆猜接口，也不引入无关或版本不匹配的实现。
- 若库或平台 API 已完整覆盖所需职责、行为和生命周期，直接调用 API，不得复制、重写或套一层等价功能；同时清理失去用途的实现、常量、缓存、类型、测试和说明。
- 仅当 API 缺少项目特有的组合语义、错误归一化、权限边界或生命周期约束时，才增加复用底层 API 的最薄适配层，并用实现和测试明确覆盖真实差异。

## Telegram 提示留存

- Bot 发到群里的非功能性提示（含命令校验失败、权限拒绝、用法提示、操作回执）发送成功后必须统一在 **30 秒后删除**；统一复用发送/清理边界，不得遗漏旁路或重复实现定时删除。
- 长期保留的命令内容只有 `/permission help` 与成功的中文动作命令结果（如 `/咬`、`/揪住`）；动作命令的目标校验失败和 `/x` 用法提示仍在 30 秒后删除。新增例外须由用户明确授权，并在调用点和测试中显式标记。
- 删除任务不得阻止进程退出；发送失败不创建删除任务，删除失败走统一 Telegram 错误日志。私聊和功能性内容不受此规则约束；入群验证等带按钮消息由按钮/状态机自己的路径删除，inline 运势由 inline API 生成，二者都禁止挂固定延迟删除。

## 分支、提交与发布

- 只使用 `master`、`dev`，不开功能分支；开发一律在 `dev`，不直接提交到 `master`。
- 每次发布必须完整走完且顺序固定：先在 `dev` 完成开发与门禁，再以 `git merge --squash` 合入 `master` 并创建单次提交；随后推送 `master`、创建 annotated version tag 和 GitHub Release；只有 Release 确认成功后，才把 `dev` reset 对齐到 `master` 并以 `--force-with-lease` 推送。禁止在 Release 前同步 `dev`，也禁止推完 `master` 就结束发布流程。
- 每次 commit 前运行 `git branch --show-current`。`master` 只允许 `git merge --squash` 后的单次提交；误提交且未推送时，先 cherry-pick 到 `dev`，再以 `git branch -f master origin/master` 复位并走正常 squash。
- 合入 `master` 只能 `git merge --squash` + 单次 commit；提交信息覆盖完整改动集并说明“为什么”。合并前 `bun run check` 必须全绿；涉及持久化、停机或 Worker 生命周期时再跑 `bun run test:fault-injection`，失败不得合并。
- 发布前同步远端 tags，并用 `gh release list` 读取 GitHub Latest Release。版本仅用无 `v` 前缀的 `MAJOR.MINOR.PATCH`：破坏兼容升 MAJOR、兼容新增升 MINOR、仅修复/性能/重构/文档升 PATCH，混合改动取最高级。不得根据本地旧 tag 猜版本；目标 tag 已存在时重新读取 Release 状态并重算，禁止覆盖、移动或复用。
- 门禁通过后依次：推送 `master`；为该提交创建并单独推送 annotated version tag；执行 `gh release create <tag> --verify-tag --target master ...`。Release 标题和说明用英文，仅描述“上一个 Latest tag..本次 `master`”的增量，至少含 Highlights、Compatibility / Migration Notes、Validation；测试数与覆盖率必须来自本次门禁。
- tag 已推送但 Release 创建失败时保留并重试同一 tag，不再递增。`master`、tag、Release 任一未确认成功，都不得宣称发布完成或改写 `dev`。
- Release 已确认成功后，先以 `git diff dev master --quiet` 确认树一致，再在 `dev` 执行 `git reset --hard master` 和 `git push --force-with-lease origin dev`，最终确认本地与远端的 `dev`、`master` 全部指向同一提交；这一步是每次发布的必做收尾，不得遗漏。
- 仅当用户明确要求同步文档/指标时，才按合并前真实 `bun run check` 输出更新徽章、`docs/assets/coverage_{light,dark}.svg`、README `<img alt>` 和三份开发文档；否则不改，只在交付时列出待同步位置。完整清单见 `docs/05-dev-workflow.md` 的“同步 README 指标”。

## 编码规范

- 文件超过 500 行考虑拆分，超过 1000 行必须拆分。风格由 eslint 决定；提交前跑 `bun run lint && bun run typecheck` 或全量 `bun run check`。跨模块/生命周期约束以 `docs/04-invariants.md` 为准。

### 常量

- 字面量常量放 `packages/consts/<domain>.ts`；env 派生配置放 `packages/infra/config.ts`。使用 `SCREAMING_SNAKE_CASE` 和显式类型，长数值用 `_`。
- **不可变性只在编译期表达，`packages/` 下一处 `Object.freeze` 都不许有。** 容器必须声明成只读类型（`readonly T[]`、`Readonly<T>`、`ReadonlyArray<T>`、`ReadonlyMap`/`ReadonlySet`）；元素是对象时用 `readonly Readonly<T>[]`，或直接把元素接口的字段写成 `readonly`（如 `LuckTier`、`MoodOption`），连元素字段一起锁住。
- 这条同时管字面量常量、`packages/config/` 的部署配置解析结果和 `DiskIORecoveryTransport` 那样的句柄对象——它们都是构造完就只被读的东西，运行期再冻一次买不到任何东西，却要为此付一大笔读取成本：JSC 对冻结数组的下标读取和 `for...of` 都没有快路径（Bun 1.3.14 实测，三次独立进程复现，下标读 1.4~3.4 → 26.5~33.6 ns/op，`for...of` 18.5 → 194.1 ns/op，冻结对象属性读 0.9 → 2.5 ns/op）。生产样本：`LUCK_TIERS` 这张 7 项权重表解冻后，加权抽选 206~216 → 15~18 ns/op。
- `bun run check:conventions` 三向强制：consts 容器常量缺只读类型报错、consts 出现 `Object.freeze` 报错、`packages/` 任意位置出现 `Object.freeze` 报错。但它是纯 AST 检查，只看得见容器那一层，判不了元素类型的字段可不可写；**带对象元素的常量表要同时在 `test/consts/immutability.test.ts` 补一行 `@ts-expect-error`**。
- 想验证「调用方确实改不动」一律用 `@ts-expect-error` 断言（范例见 `test/consts/immutability.test.ts`、`test/config/adSamples.test.ts`）：类型被放宽时它会因为「预期的错误没有发生」让 typecheck 报 TS2578，比运行期 `Object.isFrozen` 更早也更准。注意它只压制类型报错、底下那行仍会执行，所以断言要么放进不调用的闭包里，要么挑一份用完即弃的对象来试，别拿共享单例。
- 每个常量带中文 JSDoc，说明用途、不变量和所属模块。领域变大时拆为 `packages/consts/<domain>/`；原文件仅作 `export * from` 兼容入口，新代码直接导入子模块。

### 缓存（进程内状态）

- 长期 Map/Set/队列/timer/单例放 `packages/cache/<owner>/`；第一层 owner 只能是 `main/`、`workers/aiChat/`、`workers/antiRaid/`、`workers/diskIO/`、`perThread/`。文件头注明 owner。
- 缓存只能被 owner 线程 import；跨线程只传消息，不共享内存。`bun run check:conventions` 会按线程入口的真实 import 闭包检查；完整规则见 `docs/04-invariants.md`“线程与状态归属”。
- 可变单例用 `{ current: T | null }` holder，不用 `export let`；泛型写在类型标注上。每个导出须用 JSDoc 说明填充/清理时机、Worker 崩溃重建方式、容量与清理策略。

新增缓存按顺序满足，前一项可行就不进入下一项：

1. 谁写谁是 owner；没有唯一写者就拆成两份缓存。
2. 默认不新增跨线程消息；缓存能放在使用线程就放在那里。
3. 仅当观测点与使用点天然跨线程时允许镜像，且只能“owner 变更时推送、使用侧只读”或“为防丢失的持久化回执”。
4. 禁止每次读取都 request/reply；需要这样做说明 owner 选错，应回到第 2 项。
5. 每条群消息的高频路径禁止镜像同步；把接收方需要的最终字段放进现有消息（如 `floodCandidate`/`adCandidate.label`）。
6. 镜像 JSDoc 必须写清权威线程、推送时机与全量/增量、Worker/进程重启的重放者，以及“无条目”的 fail-safe 含义；不得把缺失解释为沿用旧值。范例：`packages/cache/workers/antiRaid/botPermissions.ts`。
7. 纯函数不得与另一线程独占缓存同文件；拆为不接触缓存的叶子模块。范例：`packages/aiChat/ai/stickers/describe.ts`。

### 性能、内存与 Bun/JSC JIT

- 正确性、状态机、生命周期和可维护性优先。先定位每消息、队列循环、Worker 消息等真实热点；无测量证据不优化冷启动、低频命令或 I/O 等待路径。
- 热调用点保持类型和对象 shape 稳定；按固定顺序一次初始化所需字段，不事后增删，也不为统一 shape 补大量无用字段。
- 高频路径能直接读现值就不创建投影对象、临时数组、复合键、一次性闭包或 `map`/`filter`/`flatMap` 中间结果；超过 3 参数仍用 options，但优先传现有上下文而非复制同构对象。
- 跨线程只传最终所需载荷，不反复展开/深拷贝/重建；禁止用共享可变内存减少 clone，也禁止在每条群消息路径增加同步往返。
- 仅在输入稳定且失效边界明确时缓存重复解析/序列化/规范化/复合键；缓存须有 owner、容量、清理与 Worker 重建策略。高频有界队列/窗口/数值缓冲仅在基准支持时采用连续存储、环形缓冲或 TypedArray，且不得改变容量、顺序、淘汰或停机语义。
- 热函数保持单一职责和清晰控制流，不为猜测内联而堆薄包装，也不合并成巨型函数。性能对照须固定 Bun 和输入、预热、独立进程重复，记录吞吐/延迟与堆/GC，差异须高于噪声；优先用 Bun profiler、`performance.now()`/`Bun.nanoseconds()`、`bun:jsc`。
- `Bun.gc()`、强制 GC、`--smol`、人为延长对象生命周期仅用于诊断/基准，不进生产；无证据禁止对象池，尤其不得复用会逃逸或跨异步边界的可变载荷/事件/权限结果。
- 性能改动保留语义测试，并为热点补基准/压力验证；若收益依赖持久化格式、状态机顺序、权限或 Worker 生命周期变化，按对应变更处理，不得以 JIT 为由绕过门禁。

### 类型与接口

- 变量、参数、返回值、对象属性、数组元素和普通 `for` 变量显式标注类型。仅豁免：`for...of`/`for...in` 变量、初始化器已是全标注箭头函数的 `const`、自引用 `typeof` 常量。
- 共享类型按领域放 `packages/types/<domain>.ts`；生产代码直接导入领域文件，`packages/types/index.ts` 只供测试和渐进迁移。类型导入单独使用 `import type`。
- 导出函数标注返回类型（含 `Promise<T>`）；使用 `catch (error: unknown)`。生产代码禁 `any`（测试豁免）；保持 strict 与 `noUncheckedIndexedAccess`，处理索引的 `undefined`。
- 位置参数最多 3 个；更多参数改为函数旁导出的 options interface，并在签名处解构。可选项用 `?`，默认值写在解构处。导出函数用 `function`，箭头函数仅用于回调/IIFE。

### 注释、日志与文档

- 注释和 JSDoc 用中文，解释不变量与“为什么”；跨模块约束引用 `docs/04-invariants.md`，不重复全文。
- 日志统一用 `logger`，不直接 `console.log`；仅 `packages/workers/diskIOWorker.ts`、`packages/workers/diskIO/` 内错误可用 `console.error`。`logger.error` 等错误文案用英文。
- 约束、流程、设计写入 `docs/`，代码只留必要 JSDoc。除用户明确要求更新文档/README/指标外，不主动修改；其它文件的“需同步”仅用于定位，不构成授权。若代码使文档失真，交付时列出待同步项；获授权后也只能依据真实代码与门禁输出更新。
