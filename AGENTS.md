# 项目规则

## 协作与操作边界

- 本项目按单租户云原生人机协作环境处理。
- 只修改完成当前任务所需的仓库文件。
- 普通源码、测试、类型、脚本、依赖清单修改和只读检查均按开发工作处理。
- 普通开发任务不得停、启或重启服务，不得调用 systemd/supervisor，不得创建或删除系统账号，不得修改属主或权限，不得迁移数据根，不得备份或搬运部署数据。
- 仅在请求明确包含部署、发布、迁移或线上运维，或操作会直接写入、覆盖、移动、删除真实部署数据或配置，或会运行可能触发这些写路径的生产入口时，执行部署保护流程。
- 已确认使用独立临时数据根的测试不属于部署写路径。

## 数据、配置与迁移安全

- `config/`、`.env`、`g-auth.json` 和运行时状态均视为部署方数据；不得用 Git 历史、目标分支或 `config_example/` 代替部署备份。
- 改动运行时状态或数据（`state.json`、`memory/`、`bot.lock` 等）、触发真实部署写路径，或改动可能被运行进程写入且无版本控制兜底的文件前，先 `cp` 备份或读入 scratchpad；核验完成后才能清理备份。
- 用户明确要求原地部署或发布，且仓库是 systemd/supervisor 的 `WorkingDirectory` 时，优先在独立 clone/worktree 中合并、测试、打 tag 和发布。
- 原地更新前必须停止服务并确认 inactive；无权限时停止操作并说明，不得让 supervisor 在半迁移工作树上反复拉起。
- 执行 `pull`、`checkout`/`switch`、`merge`、`reset`、`rebase`、`clean` 前，必须检查 `git status --short`、`git diff --name-status <current>..<target>`、`git ls-files config .env g-auth.json`。
- 部署路径发生新增、删除或重命名，`.gitignore` 发生变化，或文件从“受跟踪”变为“忽略”时，必须执行迁移流程。
- 迁移前必须用 `mktemp -d` 在工作树外备份部署文件，并记录文件清单、权限、属主和 SHA-256。
- 备份复制因无法保留属主而返回非零时，必须逐文件核对哈希。
- 敏感内容不得进入仓库、提交或输出正文。
- 文件从“受跟踪”变为“忽略”前必须完成外部备份，并在 Release 的 Compatibility / Migration Notes 中写明备份、恢复和权限步骤。
- Git 操作后必须先恢复部署文件，再按新结构手工迁移。
- 禁止用 `cp -r config_example config` 覆盖现有配置；补缺必须使用不覆盖语义或逐项确认，并核对哈希、预期差异、严格解析结果和权限。
- `/white`、`/permission` 等会原子改写的目录和文件必须允许服务账号写入。
- 文件结构变化只做手工迁移，不在代码中保留旧格式兼容逻辑。
- 配置和状态全部就位后才能启动服务。
- 启动后必须确认 `ActiveState=active`、`SubState=running`，观察至少两个 supervisor 重启间隔，并确认 `NRestarts` 不增长、journal 无新增非零退出。
- 只有哈希、迁移、配置校验和服务稳定性全部确认后才能删除外部备份；任一步失败时必须保留备份和现场并停止发布。

## 依赖与平台 API

- 实现功能前必须检查 `package.json`、锁文件、已安装版本的本地类型声明或源码以及官方文档，确认当前技术栈和精确版本。
- OpenAI、Telegram/grammY 等 SDK 必须优先查官方文档，不得凭记忆猜接口，不得引入无关或版本不匹配的实现。
- 库或平台 API 已完整覆盖所需职责、行为和生命周期时，必须直接调用该 API，不得复制、重写或包装等价功能，并清理失去用途的实现、常量、缓存、类型、测试和说明。
- 仅在 API 缺少项目特有的组合语义、错误归一化、权限边界或生命周期约束时增加最薄适配层，并用实现和测试覆盖差异。

### 安装冻结期 *重要*

- 2026-08-05 至 2026-08-19 为依赖安装冻结期，起因是 2026-08-04 的 keyv/cacheable 投毒事件需要冷却观察。
- 冻结期内不得安装、新增、升级或移除任何依赖，包括 `bun add`、`bun update`、`bun remove`、放宽 semver 范围，以及任何会重新解析或改写 `bun.lock`、`package.json` 的操作。
- 实现功能一律只用已安装依赖；确需新包时必须停止并向用户说明用途和替代方案，由用户决定，不得自行安装。
- `bun install --frozen-lockfile` 只校验不改锁文件，冻结期内仍必须先取得用户确认再执行。
- `bun run release:check` 内含该校验步骤；冻结期内发布必须先与用户确认是否改跑 `bun run check` 加 `bun run test:fault-injection`。
- 冻结期满不自动解除，必须由用户明确说明后才恢复。

### 供应链版本锁定 *重要*

- 2026-08-04 keyv/cacheable 投毒事件的受害版本一律禁止安装：`keyv@6.0.0`、`flat-cache@6.1.24`、`file-entry-cache@11.1.6`、`file-entry-cache@11.1.7`、`cacheable-request@13.0.20`、`cache-manager@7.2.10`、`cacheable@2.5.1`、`@cacheable/memory@2.2.1`、`@cacheable/net@2.1.1`、`@cacheable/node-cache@3.1.2`、`@cacheable/utils@2.5.1`、`@keyv/redis@6.0.0`、`@keyv/sqlite@6.0.0`、`@keyv/mongo@6.0.0`、`@thiennq/docs-viewer@1.6.2`、`@thiennq/docs-viewer@1.6.3`、`@thiennq/docs-viewer@1.6.4`。
- `keyv` 必须保持 `4.5.4`，`flat-cache` 必须保持 `4.0.1`，`file-entry-cache` 必须保持 `8.0.0`；不得通过 `bun update`、放宽 semver 范围或重新解析锁文件升级这三个包。
- 三者均为 `eslint` 的传递依赖；升级 `eslint` 或 `typescript-eslint` 前必须先确认新依赖树不会把这三个包带入受害版本，确认不通过时不得升级。
- 受害版本清单必须至少交叉两个独立来源，不得只信单一厂商：Wiz 的 `wiz-sec-public/wiz-research-iocs` 未收录 `@keyv/*` 作用域包，Socket 记录的 `file-entry-cache@11.1.7` 与 Wiz 的 `11.1.6` 不一致；来源冲突时取并集。
- 解除上述锁定必须同时满足：目标版本不在任一来源的受害清单中，且目标版本的 `integrity` 与 npm registry 的发布记录一致。
- 依赖变更后必须以 `bun install --frozen-lockfile` 复核；锁文件出现上述包的版本漂移时必须回退并说明原因。
- 排查投毒不得只比对版本号，必须同时确认无 `setup.mjs`、`math_init.js`、`Math_Symbol.js`、`gh-token-monitor.sh`、`~/.config/gh-token-monitor/` 等载荷与持久化残留，并确认 `.claude/`、`.vscode/` 下未被植入 autostart hook。

### 依赖冷却期与紧急豁免 *重要*

- `bunfig.toml` 的 `install.minimumReleaseAge` 为 7 天（604_800 秒）：只解析发布满该时长的版本，使投毒版本在被 npm 下架前无法进入依赖树。
- 该闸门会同时挡住刚发布的安全修复版。需要紧急安装尚未满冷却期的修复时，只把**那一个包名**加进 `install.minimumReleaseAgeExcludes`，安装完成后立即移除。
- 不得改用 `bun install --minimum-release-age=<更小值>` 绕过：该 CLI 覆盖是本次安装的全局阈值，会把同一次解析里所有新发布的传递依赖一并放行。
- 豁免不替代核对：被豁免的版本仍须通过上述双来源受害清单核对与 `integrity` 校验，并按投毒排查要求确认无载荷与持久化残留。
- 每次豁免必须记录包名、原因（CVE 编号或事件）与移除时间；豁免条目不得长期留在 `bunfig.toml` 中。
- 冷却期阈值与豁免清单的改动本身不属于依赖安装，但仍受安装冻结期约束：冻结期内不得借豁免执行任何实际安装。

## Telegram 提示留存

- Bot 发到群里的非功能性提示发送成功后必须统一在 30 秒后删除，包括命令校验失败、权限拒绝、用法提示和操作回执。
- 所有延迟删除必须复用统一的发送和清理边界，不得遗漏旁路或重复实现定时删除。
- 仅 `/permission help` 和成功的中文动作命令结果（如 `/咬`、`/揪住`）允许长期保留。
- 动作命令目标校验失败和 `/x` 用法提示必须在 30 秒后删除。
- 新增长期保留例外必须由用户明确授权，并在调用点和测试中显式标记。
- 删除任务不得阻止进程退出；发送失败时不得创建删除任务；删除失败必须走统一 Telegram 错误日志。
- 私聊和功能性内容不适用固定延迟删除。
- 入群验证等带按钮消息必须由按钮或状态机路径删除，不得挂固定延迟删除。
- inline 运势必须由 inline API 生成，不得挂固定延迟删除。

## 编码规范

- 文件超过 500 行时应考虑拆分，超过 1000 行时必须拆分。
- 代码风格以 eslint 为准。
- 跨模块和生命周期约束以 `docs/04-invariants.md` 为准。

### 常量与不可变性

- 字面量常量放在 `packages/consts/<domain>.ts`；env 派生配置放在 `packages/infra/config.ts`。
- 常量使用 `SCREAMING_SNAKE_CASE` 和显式类型；长数值使用 `_` 分隔。
- `packages/` 下禁止使用 `Object.freeze`。
- 不可变性必须在编译期表达；容器必须声明为 `readonly T[]`、`Readonly<T>`、`ReadonlyArray<T>`、`ReadonlyMap` 或 `ReadonlySet` 等只读类型。
- 对象元素必须使用 `readonly Readonly<T>[]`，或将元素接口字段声明为 `readonly`。
- 字面量常量、`packages/config/` 的部署配置解析结果和构造后只读的句柄对象均适用编译期不可变规则。
- 带对象元素的常量表必须在 `test/consts/immutability.test.ts` 中增加 `@ts-expect-error` 断言。
- 调用方不可变性必须使用 `@ts-expect-error` 验证，不得使用运行期 `Object.isFrozen` 验证。
- `@ts-expect-error` 不可变性断言必须放在不调用的闭包内，或只操作用完即弃的对象；不得修改共享单例。
- 每个常量必须有中文 JSDoc，说明用途、不变量和所属模块。
- 领域变大时拆分为 `packages/consts/<domain>/`；原文件仅保留 `export * from` 兼容入口，新代码直接导入子模块。

### 缓存与线程归属

- 长期 Map、Set、队列、timer 和单例放在 `packages/cache/<owner>/`。
- 第一层 owner 仅允许 `main/`、`workers/aiChat/`、`workers/antiRaid/`、`workers/diskIO/`、`perThread/`。
- 缓存文件头必须注明 owner。
- 缓存只能被 owner 线程 import；跨线程只能传消息，不得共享内存。
- 可变单例必须使用 `{ current: T | null }` holder，不得使用 `export let`；泛型必须写在类型标注上。
- 每个缓存导出必须用 JSDoc 写明填充和清理时机、Worker 崩溃重建方式、容量及清理策略。
- 新增缓存必须按以下顺序决策，前一项可行时不得进入后一项：
  1. 写入方作为 owner；无唯一写入方时拆成两份缓存。
  2. 缓存放在使用线程，不新增跨线程消息。
  3. 仅当观测点与使用点天然跨线程时允许镜像；镜像仅允许 owner 变更时推送且使用侧只读，或用于防丢失的持久化回执。
- 禁止每次读取都使用 request/reply。
- 每条群消息的高频路径禁止镜像同步；接收方所需最终字段必须放入现有消息。
- 镜像 JSDoc 必须写明权威线程、推送时机、全量或增量模式、Worker 或进程重启后的重放方，以及“无条目”的 fail-safe 含义；不得把缺失解释为沿用旧值。
- 纯函数不得与另一线程独占缓存放在同一文件，必须拆为不接触缓存的叶子模块。

### 性能、内存与 Bun/JSC JIT

- 正确性、状态机、生命周期和可维护性优先。
- 优化前必须定位每消息、队列循环、Worker 消息等真实热点；无测量证据不得优化冷启动、低频命令或 I/O 等待路径。
- 热调用点必须保持类型和对象 shape 稳定，并按固定顺序一次初始化所需字段；不得事后增删字段，不得为统一 shape 增加大量无用字段。
- 高频路径可直接读取现值时，不得创建投影对象、临时数组、复合键、一次性闭包或 `map`、`filter`、`flatMap` 中间结果。
- 超过 3 个参数时仍使用 options，并优先传递现有上下文，不得复制同构对象。
- 跨线程只传最终所需载荷，不得反复展开、深拷贝或重建，不得使用共享可变内存减少 clone，不得在每条群消息路径增加同步往返。
- 仅在输入稳定且失效边界明确时缓存重复解析、序列化、规范化或复合键；缓存必须具备 owner、容量、清理和 Worker 重建策略。
- 高频有界队列、窗口或数值缓冲仅在基准支持时使用连续存储、环形缓冲或 TypedArray，且不得改变容量、顺序、淘汰或停机语义。
- 热函数必须保持单一职责和清晰控制流；不得为猜测内联堆叠薄包装，不得合并成巨型函数。
- 性能对照必须固定 Bun 和输入，完成预热并以独立进程重复，记录吞吐、延迟、堆和 GC；差异必须高于噪声。
- 性能分析优先使用 Bun profiler、`performance.now()`、`Bun.nanoseconds()` 和 `bun:jsc`。
- `Bun.gc()`、强制 GC、`--smol` 和人为延长对象生命周期仅限诊断或基准，不得进入生产代码。
- 无测量证据不得使用对象池；不得复用会逃逸或跨异步边界的可变载荷、事件或权限结果。
- 性能改动必须保留语义测试，并为热点增加基准或压力验证。
- 涉及持久化格式、状态机顺序、权限或 Worker 生命周期的性能改动必须执行对应门禁，不得以 JIT 为由绕过。

### 类型与接口

- 变量、参数、返回值、对象属性、数组元素和普通 `for` 变量必须显式标注类型。
- 仅豁免 `for...of`/`for...in` 变量、初始化器为全标注箭头函数的 `const`、自引用 `typeof` 常量。
- 共享类型按领域放在 `packages/types/<domain>.ts`；生产代码直接导入领域文件；`packages/types/index.ts` 仅供测试和渐进迁移。
- 类型导入必须单独使用 `import type`。
- 导出函数必须标注返回类型，包括 `Promise<T>`。
- 必须使用 `catch (error: unknown)`。
- 生产代码禁止 `any`；测试代码豁免。
- 必须保持 strict 和 `noUncheckedIndexedAccess`，并处理索引返回的 `undefined`。
- 位置参数最多 3 个；更多参数必须改为函数旁导出的 options interface，并在签名处解构。
- 可选项使用 `?`，默认值写在解构处。
- 导出函数使用 `function`；箭头函数仅用于回调和 IIFE。

### 注释、日志与文档

- 注释和 JSDoc 使用中文，并说明不变量和设计依据。
- 跨模块约束必须引用 `docs/04-invariants.md`，不得在代码中重复全文。
- 日志必须使用 `logger`，不得直接使用 `console.log`。
- 仅 `packages/workers/diskIOWorker.ts` 和 `packages/workers/diskIO/` 内的错误允许使用 `console.error`。
- `logger.error` 等错误文案使用英文。
- 约束、流程和设计写入 `docs/`；代码仅保留必要 JSDoc。
- 未经用户明确要求，不得更新文档、README 或指标。
- 代码使文档失真时，交付中列出待同步项。
- 获得文档更新授权后，只能依据真实代码和门禁输出修改文档。

## 分支、验证、提交与发布

### 分支与验证

- 只使用 `master` 和 `dev`，不得创建功能分支。
- 开发必须在 `dev` 进行，不得直接提交到 `master`。
- 每次 commit 前必须运行 `git branch --show-current`。
- 提交前必须运行 `bun run lint && bun run typecheck` 或完整的 `bun run check`。
- 合入 `master` 前必须确保 `bun run check` 全绿。
- 涉及持久化、停机或 Worker 生命周期时，合入前必须运行 `bun run test:fault-injection`。
- 门禁失败时不得合入。

### 提交与合并

- `master` 只允许通过 `git merge --squash` 合入并创建单次提交。
- 提交信息必须覆盖完整改动集并说明改动依据。
- 误在 `master` 提交且尚未推送时，必须先 cherry-pick 到 `dev`，再执行 `git branch -f master origin/master`，然后按正常 squash 流程处理。

### 发布

- 每次发布必须按以下顺序完整执行：
  1. 在 `dev` 完成开发和门禁。
  2. 以 `git merge --squash` 合入 `master` 并创建单次提交。
  3. 推送 `master`。
  4. 创建并单独推送 annotated version tag。
  5. 创建并确认 GitHub Release。
  6. 将 `dev` reset 对齐到 `master`，并以 `--force-with-lease` 推送。
- Release 确认成功前不得同步 `dev`，不得在只推送 `master` 后结束发布。
- 发布前必须同步远端 tags，并通过 `gh release list` 读取 GitHub Latest Release。
- 版本号仅使用无 `v` 前缀的 `MAJOR.MINOR.PATCH`。
- 破坏兼容时升 MAJOR，兼容新增时升 MINOR，仅修复、性能、重构或文档变更时升 PATCH；混合改动取最高级。
- 不得依据本地旧 tag 推断版本。
- 目标 tag 已存在时必须重新读取 Release 状态并重算版本，不得覆盖、移动或复用已有 tag。
- 门禁通过后，必须依次推送 `master`、为该提交创建并单独推送 annotated version tag、执行 `gh release create <tag> --verify-tag --target master ...`。
- Release 标题和说明使用英文，只描述上一个 Latest tag 到本次 `master` 的增量，并包含 Highlights、Compatibility / Migration Notes、Validation。
- Release 中的测试数量和覆盖率必须来自本次门禁。
- tag 已推送但 Release 创建失败时，必须保留并重试同一 tag，不得递增版本。
- `master`、tag、Release 任一未确认成功时，不得宣称发布完成，不得改写 `dev`。
- Release 确认成功后，必须先执行 `git diff dev master --quiet` 确认树一致，再在 `dev` 执行 `git reset --hard master` 和 `git push --force-with-lease origin dev`。
- 发布结束前必须确认本地和远端的 `dev`、`master` 全部指向同一提交。
- 仅在用户明确要求同步文档或指标时，依据合并前真实 `bun run check` 输出更新徽章、`docs/assets/coverage_{light,dark}.svg`、README `<img alt>` 和三份开发文档；完整清单以 `docs/05-dev-workflow.md` 的“同步 README 指标”为准。
