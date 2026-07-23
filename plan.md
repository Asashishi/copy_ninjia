# 全仓 Review 与整改计划

## 1. 审查范围与基线

- 审查日期：2026-07-23
- 审查基线：`4696d4a feat(ai): preserve multi-level reply chains`
- 审查范围：生产代码、测试、构建与 lint 配置、持久化格式、Worker 生命周期、缓存与常量组织，以及 `AGENTS.md`、`docs/architecture.md` 中的约束。
- 本轮已完成 F1—F3 的修复及回归测试。F3 经明确授权后停止生产服务，备份并迁移 `state.json`、`state.json.bak`、`memory/` 和 `bot.lock`；未读取或改动 `.env`、`g-auth.json` 等凭据。

已完成的基线验证：

| 检查 | 结果 |
| --- | --- |
| `bun run lint` | 通过 |
| `bun run typecheck` | 通过 |
| `bun run test:coverage` | 780 passed、0 failed；函数 93.53%，行 95.42% |
| 生产模块导入副作用测试 | 通过 |
| 测试数据隔离 | `test/preload.ts` 在导入生产模块前将数据根目录切换到独立临时目录 |
| 跟踪文件秘密扫描 | 未发现被 Git 跟踪的真实凭据；仅 `.env.example` 被跟踪 |
| 依赖漏洞审计 | `bun audit --audit-level=moderate` 通过，未发现漏洞 |

## 2. 结论摘要

审查发现两项高优先级运行时风险，以及多项没有被现有规则自动覆盖的项目规范偏差；当前 lint、类型检查和测试均通过：

| 编号 | 等级 | 状态 | 问题 |
| --- | --- | --- | --- |
| F1 | 高 | 修复完成 | Worker 重放和关键初始化消息投递失败后，实例仍可能被标记为可用 |
| F2 | 高 | 修复完成 | 按日追加文件没有验证顶层必须为普通对象，错误格式可能在下一次追加时被破坏 |
| F3 | 中 | 修复完成 | 持久化类型仍保留旧格式兼容分支，与“手动迁移、不保留兼容逻辑”冲突 |
| F4 | 中 | 修复完成 | 长期存活的 Map、Set、timer、Worker 引用和单例已集中到领域 cache，并补齐停止/重建边界 |
| F5 | 中低 | 修复完成 | `src/cache` 顶层导出已由 AST 门禁保证逐项 JSDoc |
| F6 | 中低 | 修复完成 | 常量归属、显式类型、不可变性、JSDoc 和长数字格式已整改并纳入门禁 |
| F7 | 中低 | 修复完成 | catch、参数接口、共享类型归属和生产注释已整改并纳入门禁 |
| F8 | 中 | 修复完成 | 故障注入清单已扩充，规范门禁纳入全量 check，并补充日志/清理失败测试 |

F1—F3 已完成修复，F3 按“先停机备份和人工迁移、再删除兼容代码”的顺序落地。其余规范问题适合按领域分批机械整改，避免一次超大变更掩盖行为变化。

## 3. 详细问题与整改要求

### F1. Worker 重放和关键投递失败未进入不可用状态（修复完成）

证据：

- `src/libs/supervisedWorker.ts` 的重启路径先替换当前 Worker，再把直接调用 `next.postMessage` 的函数交给 `onRespawn`。该调用绕过统一的安全投递函数，也不能用返回值表达同步拒绝。
- 如果重放中的任意 `postMessage` 同步抛错，异常会逃出重启回调；新 Worker 已被安装，重放可能只完成一部分，但上层仍可能认为它可写。
- `src/aiChat.ts` 的初始化、内存 hydrate、贴纸目录 hydrate、消息记录、媒体记录和回复请求没有处理 `post` 的布尔结果。
- `src/antiRaid.ts` 的初始化 adopt、停用通知及部分持久化确认同样没有处理投递拒绝。
- 现有测试覆盖普通投递拒绝和正常重放，没有覆盖“重启重放过程中同步拒绝”。

影响：

- AI Worker 可能在没有完整初始化或 hydrate 的情况下继续服务。
- AntiRaid Worker 的内存镜像可能与主线程持久化状态分叉。
- 关键消息可能静默丢失，违背 `docs/architecture.md` 对关键业务投递、恢复重放和可写状态的约束。

整改：

1. 让重放使用与正常投递相同的受保护入口，并明确返回成功或失败。
2. 重放失败时不得发布新实例为可用；应结算相关 barrier/waiter、终止失败实例，并进入既定重试或 fatal 路径。
3. 将“尽力投递”和“关键投递”分成显式 API。关键投递拒绝必须使相应子系统不可用或阻止应用启动，不能只返回 `false` 后被调用方忽略。
4. AI 的 init/hydrate 和 AntiRaid 的 adopt 应在 runner 接受更新前完成；任一步失败都由 `ApplicationLifecycle` 收敛并终止启动。
5. 为运行期关键消息定义一致策略：可安全重试的进入有界队列；不可重放的立即 fatal；所有 waiter 必须在失败和销毁时结算。

验收：

- 注入“第一次重放成功、第二次同步抛错”时，新 Worker 不会进入 available 状态，也不会留下悬挂 waiter。
- 初始化消息、hydrate、adopt 任一投递失败时，应用不会开始接收更新。
- Worker 退出、重启失败、投递拒绝和正常关闭路径均可重复调用，且不泄漏 timer/listener。
- 所有关键 `post` 调用点都显式处理结果，代码中不再依赖忽略布尔返回值的约定。

### F2. 按日追加文件会接受并破坏错误顶层 JSON 结构（修复完成）

用户备注：修复不可增加当前 O(1) 的追记复杂度。

证据：

- `src/workers/diskIO/appendOnlyDayFile.ts` 的 `openDayFile` 只判断解析结果是非空 `object`，数组也会通过。
- 后续追加逻辑假设文件以对象的 `\n}` 结尾，并从末尾两个字节开始覆盖。
- `src/workers/diskIO/snapshotFiles.ts` 恢复 luck 文件时，非空数组会被当作无法恢复而返回空结果，但原文件仍会被下一次追加打开。
- 已在 `/tmp` 中用隔离文件复现：输入合法 JSON 数组后追加一个键，结果变成语法无效的对象/数组混合文本；仓库运行时数据未被触碰。

影响：

- 一个语法合法但结构不兼容的历史文件可能在下一次业务写入时被不可逆破坏。
- luck、verification 和日志等共用该 helper 的路径均需审计。
- 这与架构文档“持久化格式不兼容时阻止启动，不猜测迁移”的要求冲突。

整改：

1. `openDayFile` 只接受普通对象：非 `null`、非数组，并满足该文件领域的值结构约束。
2. 数组、`null`、字符串、数字及结构不合法的对象均返回有类型的“不兼容格式”错误。
3. 发现不兼容格式后保留原始字节，不执行规范化重写，不开始追加，并由启动流程给出明确的人工迁移提示。
4. 将“空对象”和“文件不存在”作为唯一可安全初始化的情况；不要把空数组或其他 JSON 值视为空文件。
5. 分别为 luck、verification、log 恢复路径确认错误传播和启动阻断策略。

验收：

- 为数组、空数组、`null`、字符串、数字、错误 value schema 和截断对象添加测试。
- 每个不兼容用例都断言调用前后文件字节完全一致。
- 有效对象、尾部缺少格式化换行的有效对象和正常追加仍通过。
- 不兼容持久化文件会让相应启动阶段明确失败，不会静默重置或覆盖。

### F3. 旧文件兼容逻辑违反人工迁移约束（修复完成）

证据：

- `src/types/chatState.ts` 将 `phase`、`intentId` 设为可选，并注明旧记录缺失。
- `src/libs/stateFileCodec.ts` 及下游使用 `phase ?? "active"`、`intentId ?? 0` 接受旧记录。
- `src/types/aiChat/memory.ts` 和 `src/workers/diskIO/snapshotFiles.ts` 仍含面向旧快照缺字段的兼容说明或可选字段。
- 部分字段同时具有真实业务可选语义，例如 `username`、`replyTo`、`forwardedFrom`；不能仅依据可选类型机械改为必填。

影响：

- 代码会长期维护多个隐含格式，无法从类型上确认磁盘数据已完成迁移。
- 缺失字段被默认值填充，可能掩盖无法可靠推断的历史状态。

迁移前置步骤：

1. 停止所有可能读写这些文件的进程，并确认锁文件与进程状态一致。
2. 按 `AGENTS.md` 备份 `state.json`、`state.json.bak`、`memory/` 及相关快照；备份目录必须位于明确、非运行时读取的位置。
3. 先运行只读 inventory，列出每种旧记录、缺失字段、文件数量和无法无损推断的条目，不在扫描阶段写文件。
4. 由维护者明确迁移决策：
   - lockdown 旧记录是否可统一补为 `phase: "active"`、`intentId: 0`；
   - 缺少 `messageId` 的旧 memory buffer 是删除、只保留 summary，还是从可靠来源恢复；
   - 具有当前业务可选语义的字段继续保持可选，不纳入旧格式兼容清理。
5. 在旧进程停止期间，以临时文件加原子替换方式完成一次性人工迁移；逐文件校验后再启动新代码。
6. 验证新版本正常启动、读取和完成一次持久化周期后，才清理备份。

代码整改：

- 迁移完成后，将新格式的必填字段改为必填，并让 codec 拒绝缺失字段。
- 删除所有旧格式默认值、兼容分支及“兼容旧快照”的注释。
- 同步更新格式说明和架构文档，明确当前唯一 schema 及人工迁移记录。

验收：

- 旧格式 fixture 在新 codec 下明确失败。
- 迁移后 fixture 和实际文件均通过严格解析。
- 仓库中不再存在本次格式的 fallback/default 兼容逻辑。
- 迁移脚本或操作记录只作为一次性维护材料，不进入生产读取路径。

### F4. 长期存活状态没有集中到 `src/cache`

重点位置：

- `src/copy/translate.ts`：client、accepting 标志、generation、任务 `Set`。
- `src/infra/diskIO.ts`：Worker 引用、可用标志、timer、fatal handler、pending business 队列、listener、request id。
- `src/infra/storage/stateStore.ts`：state store 单例、chat state `Map`、global copy state。
- `src/commands/copySlot.ts`：pending claim。
- `src/workers/antiRaid/verificationRuntime.ts`：confirmation 和 reminder delivery 集合。
- `src/workers/antiRaidWorker.ts`：cache sweep timer。
- `src/infra/telegram/client.ts`：初始化标志。
- `src/workers/antiRaid/lockdownRuntime.ts`：最近 intent id。
- `src/ai/weather.ts`：创建 interval，但没有持有句柄，也没有显式幂等启动和停止入口。
- `src/cache/botAdmin.ts`：generation map 没有容量、TTL 或 teardown 清理策略。

整改：

1. 按 owner 建立或补全领域 cache 模块，把长期引用统一封装为 holder/runtime 对象；不得使用 `export let`。
2. timer、listener、pending queue 和 generation 计数必须有显式初始化、停止、清空和重建路径。
3. Worker 内状态同样遵循 cache 规则；“进程退出会清理”不能替代显式所有权说明。
4. 为可能按 chat/user 持续增长的 map/set 定义容量、TTL、逐出或 teardown 清理策略。
5. `weather` interval 应保存句柄，保证重复初始化不会创建多个 timer，并在 shutdown 时清除。

验收：

- 业务模块中不再直接声明长期存活的可变 Map、Set、队列、timer、Worker 或单例引用。
- 初始化—运行—关闭—重新初始化测试中，状态不会跨生命周期泄漏。
- Worker 崩溃重启后的重建来源在每个 cache 导出上有明确说明。
- 所有无界容器都有上限或可证明的生命周期上界。

### F5. Cache 导出缺少逐项生命周期文档

静态盘点显示，`src/cache/**/*.ts` 约 168 个顶层导出声明中，约 63 个没有自己的 JSDoc。典型位置包括：

- `src/cache/copy/avatar.ts`
- `src/cache/reactionQueue.ts`
- `src/cache/diskIO/snapshots.ts`
- `src/cache/diskIO/luck.ts`
- `src/cache/diskIO/verification.ts`
- `src/cache/aiChat/replies.ts`

整改：

- 每个导出分别添加中文 JSDoc，说明 owner、何时填充、何时清理、Worker 崩溃后如何重建，以及容量/清理策略。
- 不用一个文件级注释代替多个导出的生命周期说明。
- 跨模块共享的结构类型移到 `src/types/<domain>.ts`；仅实现私有的 holder/runtime 类型可留在 cache 模块。
- 增加 AST lint 或仓库检查脚本，阻止新增无 JSDoc 的 cache 导出。

验收：

- AST 检查对 `src/cache` 顶层导出实现 100% JSDoc 覆盖。
- 文档明确回答填充、清理、重建和容量四个问题；不使用无信息量模板。

### F6. 常量规范存在系统性偏差

静态盘点显示，`src/consts/**/*.ts` 约 260 个顶层变量声明中，约 95 个没有自己的 JSDoc，8 个缺少显式类型标注。还包括：

- `src/consts/luckChallenge.ts` 的 `LUCK_TIERS` 使用可变数组类型。
- `src/consts/lifecycle.ts` 的 timeout 对象没有只读类型和运行时冻结。
- 多个共享 prompt/object 只使用 `as const`，但没有按跨调用方共享对象要求 `Object.freeze`。
- `src/ai/gemini.ts` 的 safety settings、`src/config/mood.ts` 的 key 数组、`src/ai/tools/replyToolset/orchestrator.ts` 的 action set、`src/workers/diskIO/verificationFiles.ts` 的时间常量和正则、`src/libs/stateFileCodec.ts` 的 permission keys、`src/libs/chatState.ts` 的时长常量仍散落在业务模块。
- `src/consts/telegram.ts` 和 `src/consts/luckChallenge.ts` 各有一个 `15000` 未写成 `15_000`。

整改：

1. 将领域字面量移动到对应 `src/consts/<domain>.ts` 或子模块。
2. 为每个常量添加显式类型和独立中文 JSDoc。
3. 数组、Map、Set 和对象使用 `readonly`/`Readonly<T>`；跨调用方共享对象在运行时 `Object.freeze`。
4. 对领域较大的文件按现有规则拆子模块，兼容入口只做 `export *`，新生产代码直接导入子模块。
5. 增加 AST 检查：命名、显式类型、JSDoc、长数字分隔、共享容器只读性。

验收：

- `src/consts` 顶层常量的显式类型和 JSDoc 覆盖率均为 100%。
- 业务模块不再定义可复用的领域字面量常量。
- 跨模块共享容器无法被调用方修改。

### F7. 类型、参数和 catch 约束没有完全落实

证据：

- 生产代码中有 11 个 catch binding 没有显式 `: unknown`，集中在 `src/workers/diskIOWorker.ts` 和 `src/workers/diskIO/*`。
- 约 18 个导出函数使用包含四个以上字段的内联对象类型，而不是函数旁导出的 `XxxParams` interface；涉及 copy、luck、auto、diskIO、verification、AI reply、reaction queue、HTTP helper 等。
- `src/aiChat.ts` 的 `generateAndSendReply` 使用未导出的参数 type alias。
- `FlushResult`、`FlushTimeouts`、部分 cache waiter/recovery 类型和跨模块配置类型仍位于 `consts`、`cache` 或实现模块，而不是领域 types 文件。
- 个别生产注释使用英文；错误日志本身已主要遵守英文要求。

整改：

1. 所有生产 catch binding 显式写成 `catch (error: unknown)`。
2. 超过三个逻辑参数的导出函数统一接受一个 options 对象，并在函数旁声明、导出 `XxxParams` interface；默认值写在解构处。
3. 跨模块共享类型迁移到 `src/types/<domain>.ts`，生产代码直接从领域文件导入。
4. 参数 interface 按 `AGENTS.md` 保留在函数旁，不为追求统一而错误搬入 `src/types`。
5. 将生产注释统一为中文；`logger.error` 等错误日志继续使用英文。
6. 补充 lint/AST 规则，覆盖 catch annotation 和导出函数参数 interface，避免仅靠人工 review。

验收：

- 生产代码中不存在未显式标注 `unknown` 的 catch binding。
- 不存在超过三个位置参数的函数，也不存在导出函数的四字段以上匿名参数对象。
- 共享类型均有清晰的领域归属，生产代码不从 `src/types/index.ts` 导入。

### F8. 高风险路径覆盖率不足

虽然全局覆盖率已超过阈值，但以下关键文件的行覆盖率明显偏低：

| 文件 | 行覆盖率 |
| --- | ---: |
| `src/workers/diskIO/logFiles.ts` | 39.58% |
| `src/workers/diskIOWorker.ts` | 64.65% |
| `src/infra/storage/cleanup.ts` | 70.69% |
| `src/libs/atomicFile.ts` | 73.17% |
| `src/infra/storage/stateStore.ts` | 80.27% |
| `src/infra/diskIO.ts` | 83.82% |
| `src/workers/antiRaid/verificationRuntime.ts` | 80.69% |
| `src/infra/telegram/avatar.ts` | 70.28% |

整改重点不是追求统一百分比，而是覆盖故障边界：

- 同步 `postMessage` 拒绝、Worker 在 init/hydrate/replay 中退出、重启次数耗尽。
- 原子替换前后失败、目录同步失败、临时文件残留、恢复备份失败。
- 日志/快照文件结构不兼容、截断、部分写入和权限错误。
- shutdown 与业务写入竞态、重复 flush、waiter 超时和取消。
- cleanup 中部分文件删除失败和重复执行。

验收：

- 上述故障分支均有确定性测试，不依赖真实运行时数据或外部服务。
- 为持久化、Worker supervisor 和 lifecycle 文件设置风险清单或按文件阈值，避免全局覆盖率掩盖回归。
- 测试继续在 preload 创建的临时数据根目录运行，并断言清理完整。

## 4. 推荐实施顺序

### 阶段 0：保护运行时数据并冻结格式变更

1. 在开始任何可能触发真实存储路径的工作前，确认测试 preload 仍早于生产模块导入。
2. 涉及实际格式迁移时先停进程，再备份所有相关状态、快照和锁文件。
3. 建立只读 inventory 和恢复演练；没有迁移决策前，不收紧实际运行文件的 codec。

完成标准：备份可恢复、inventory 结果可审阅、测试不会触碰真实数据。

### 阶段 1：先添加失败回归测试（已完成）

1. 为 Worker 重放中途拒绝、关键 init/hydrate/adopt 拒绝添加测试。
2. 为 append-only 顶层数组、primitive、错误 value schema 和原文件不变性添加测试。
3. 为 shutdown、waiter 结算和 timer/listener 清理补充生命周期测试。

完成标准：新测试在旧实现上以预期原因失败，且不会写入仓库运行时数据。

### 阶段 2：修复 Worker 投递与生命周期（已完成）

1. 收敛 supervisor 的安全投递、重放、重试和 fatal 状态机。
2. 将启动期关键消息纳入 ApplicationLifecycle barrier。
3. 逐一处理 AI、AntiRaid、diskIO 的关键投递结果。
4. 验证正常关闭、异常退出和重复初始化。

完成标准：F1 的所有验收用例通过，且现有行为测试无回归。

### 阶段 3：修复 append-only 格式验证（已完成）

1. 收紧共享 helper 的顶层结构校验。
2. 明确各领域的 schema error 传播方式。
3. 保证错误文件原字节不变，并阻止后续业务追加。

完成标准：F2 的所有 fixture 通过，损坏或不兼容输入不会被覆盖。

### 阶段 4：执行一次性人工数据迁移（已完成）

1. 停止进程、备份、只读盘点。
2. 审批无法无损推断字段的处理决策。
3. 原子迁移旧文件并逐项校验。
4. 合入严格类型和 codec，删除兼容逻辑。
5. 启动验证并保留备份至完整持久化周期结束。

完成标准：线上/本地实际数据只剩唯一新格式，代码没有兼容分支。

### 阶段 5：收敛 cache 所有权和资源生命周期

1. 优先迁移 Worker/timer/listener/pending queue。
2. 再迁移 state store、translate、verification 和 command pending 状态。
3. 为无界集合增加容量/TTL/清理策略。
4. 补齐所有 cache 导出的逐项 JSDoc。

完成标准：F4、F5 验收全部满足，重复启动/关闭测试不泄漏资源。

### 阶段 6：机械化整改常量和类型规范

1. 按领域分小批移动常量、冻结容器、补类型和 JSDoc。
2. 修正 catch binding、参数 interface、共享类型归属和中文注释。
3. 每批只做一种机械变更，避免与行为修改混合。
4. 增加 AST/lint 规则后再清理最后的存量例外。

完成标准：F6、F7 的静态盘点归零，新增违规会被 CI 阻止。

### 阶段 7：补强质量门禁

1. 为高风险文件补故障注入测试和风险型覆盖门禁。
2. 运行全量 `bun run check` 和 `bun run test:coverage`。
3. 在获得明确授权后运行依赖漏洞审计；若发现问题，按可利用性和升级破坏性另立修复项。
4. 最后执行秘密扫描、未跟踪运行时文件检查和 `git diff --check`。

完成标准：所有检查通过，依赖审计有可追溯结果或明确记录为经风险接受的未执行项。

## 5. 执行记录（2026-07-23）

- F1：Worker 重放、替换实例创建和关键投递同步失败时统一 fail closed；失败实例会被移除并终止，业务域进入 give-up/fatal 路径，应用生命周期停止接收更新。
- F1：AI init/hydrate、消息与媒体记录、回复触发，以及 AntiRaid adopt、持久化确认、停用与 lockdown 重放均显式处理关键投递拒绝。
- F2：共享 append-only helper 只接受非空普通对象；数组、primitive 和不可修复语法均抛出有类型的格式错误并保留原始字节。
- F2：luck 恢复先验证顶层结构和逐条记录；verification 保持 fail closed；日志 Worker 在启动阶段验证当天文件，验证失败时不会清理旧日志。
- 用户备注落实：完整 JSON/schema 扫描仅发生在文件打开、启动或恢复阶段；成功的 `appendToDayFile` 追加热路径没有增加与已有文件大小相关的扫描，复杂度继续为 O(1)（不计本次写入内容本身）。
- 测试策略：新增测试先在旧实现上得到 6 个预期失败，再完成修复；所有测试均通过 `test/preload.ts` 使用隔离临时数据目录。
- F3：`tg-bot.service` 于 14:47 JST 停止；`state.json` 主副本一致且无活动 lockdown，anti-raid 当日文件没有 active 记录，因此两类数据无需改写。
- F3：4 份 AI 快照共 372 条热区消息；其中 150 条旧记录缺少无法可靠推断的 Telegram `message_id`。迁移按“不猜测”原则删除这些记录，保留全部 summaries、pending summary 和其余 222 条完整记录。
- F3：真实数据和运行锁曾备份到 `/tmp/copy-ninjia-f3-backup-20260723T1445JST`，大小 304 KiB；新版本完成正常持久化周期并通过严格盘点后，已按 `AGENTS.md` 清理该临时备份及一次性迁移脚本。
- F3：lockdown 的 `phase`/`intentId`、AI 热区消息的 `messageId`、verification 的 `phase`/`trackedMessageTimes` 已改为当前格式必填；codec 和恢复路径不再保留旧格式 fallback。
- 最终验证：`bun run check` 通过，780 passed、0 failed、7537 expect；全局函数覆盖率 93.53%，行覆盖率 95.42%。
- 重启验证：`tg-bot.service` 于 14:56 JST 启动，PID 3277673；4 分 27 秒后的复查仍为 active/running，`NRestarts=0`，当前格式 `bot.lock` 已重新建立。
- 持久化周期验证：AI 热区消息从迁移后的 222 条增长到 236 条；4 份 AI 快照、state 主备和 anti-raid 当日文件再次严格盘点，缺失/非法新格式字段均为 0，且没有迁移临时文件残留。
- F4：translate、Disk I/O、StateStore、copy slot、Telegram 初始化、天气 timer、AI/Anti-Raid
  Worker timer、验证提醒 owner、lockdown/compaction 串行执行器、Gemini 客户端和 flush barrier
  等长期运行态已迁入领域 cache；停止与 Worker 重建路径显式清理或重建。
- F4：bot admin 代际记录会在旧/新在途检查全部 settle 后回收，不再按历史用户无界增长。
- F5：新增 `scripts/checkProjectConventions.ts`，对 `src/cache/**/*.ts` 的每个顶层导出强制
  独立 JSDoc；现有缺口已归零。
- F6：`src/consts` 顶层常量已实现 SCREAMING_SNAKE_CASE、显式类型和独立中文 JSDoc
  100% 覆盖；共享数组/对象改为只读并冻结，业务模块中的 Gemini 安全设置、心情字段、
  动作工具名、verification 时间/正则、权限键和 quiet 时长等字面量已归位。
- F7：生产 catch binding 全部显式标注 `unknown`；匿名对象参数已替换为函数旁导出的
  interface；生命周期、生图、频道评论等共享类型迁入领域 types，生产代码不从
  `src/types/index.ts` 导入。
- F7：规范脚本同时阻止匿名对象参数、导出函数缺失返回类型、生产代码导入 types
  汇总入口，以及 cache/const/catch 规则回归；`bun run check` 已包含该门禁。
- F8：`test:fault-injection` 已纳入 lifecycle、Worker 重建、flush barrier、append-only、
  verification、日志、清理和两个业务 Worker 的生命周期测试；新增日志批次/timer/失败保持
  原文件与启动清理的扫描/删除失败测试。
- 最终验证：`bun run check` 通过，785 passed、0 failed；故障注入清单 150 passed、
  0 failed；全局函数与行覆盖率继续高于 90% 门槛，`git diff --check` 通过。
- 秘密扫描：跟踪文件未发现真实密钥；唯一命中是 `test/preload.ts` 中的显式测试占位 token。
- 部署验证：`tg-bot.service` 于 15:55 JST 正常停止并释放 `bot.lock`，静止状态下备份
  state 主备、memory 与 logs；15:55:51 JST 以 PID 3317086 启动。跨过完整 30 秒维护周期后
  仍为 active/running、`NRestarts=0`、journal 无 warning，新配置的 `DeveloperPJSK` 目录已落盘。
- 运行时严格校验：state 主备、264 条 AI 热区消息、5 份贴纸目录和 anti-raid 当日数据均符合
  当前唯一格式；确认后已清理两份临时备份，它们不可恢复。
- 依赖漏洞审计：维护者在获知会向 npm/Bun 审计服务发送 lockfile 派生的依赖名称与版本
  元数据后明确要求继续；`bun audit --audit-level=moderate` 执行成功，结果为
  `No vulnerabilities found`。

## 6. 提交拆分建议

为降低 review 风险，建议至少拆成以下独立提交：

1. `test(worker): cover replay and critical post refusal`
2. `fix(worker): fail closed on replay and critical delivery errors`
3. `test(storage): reject incompatible append-only day files`
4. `fix(storage): preserve incompatible files and block startup`
5. `chore(data): migrate persisted state to the strict schema`
6. `refactor(cache): centralize long-lived runtime ownership`
7. `docs(cache): document lifecycle and capacity for every export`
8. `refactor(constants): centralize and freeze domain constants`
9. `refactor(types): enforce params, catches, and domain imports`
10. `test: strengthen persistence and lifecycle quality gates`

数据迁移提交必须与生产兼容逻辑删除协调发布；不能先部署严格 codec 再迁移文件，也不能在生产代码中临时保留双格式读取。

## 7. 总体验收清单

- [x] Worker 关键投递和重放失败时 fail closed，不再出现“可用但未完成初始化”的状态。
- [x] append-only 子系统拒绝所有非普通对象，并由各领域接管流程拒绝 schema 不兼容文件；原文件字节保持不变，追加热路径保持 O(1)。
- [x] 实际旧数据已在停机、备份和人工决策后迁移；代码只接受唯一新格式。
- [x] 长期存活的可变状态均位于 `src/cache`，并有显式 teardown/rebuild。
- [x] 每个 cache 导出都有完整中文生命周期 JSDoc。
- [x] 每个常量都有正确归属、显式类型、中文 JSDoc 和不可变容器。
- [x] 生产 catch、参数对象、共享类型和注释全部符合 `AGENTS.md`。
- [x] 本轮修复涉及的高风险持久化与 Worker 故障分支有确定性测试。
- [x] `bun run check`、`bun run test:coverage` 和秘密扫描通过。
- [x] `git diff --check` 通过。
- [x] 依赖漏洞审计在获得外部元数据发送授权后完成，结果已处理或记录风险接受。
