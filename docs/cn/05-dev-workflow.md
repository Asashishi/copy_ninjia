# 05 开发流程与质量门禁

<p align="center">
  <b>简体中文</b> · <a href="../en/05-dev-workflow.md">English</a> · <a href="../ja/05-dev-workflow.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="04-invariants.md">← 上一页：04 权威约束</a> · <a href="06-modification-guide.md">下一页：06 修改配方 →</a>
</p>

---

## 命令速查

| 命令 | 作用 |
| :--- | :--- |
| `bun run start` | 启动长轮询 |
| `bun run lint` / `lint:fix` | ESLint 检查 / 自动修复 |
| `bun run lint:fast` | 带 `--cache` 的 ESLint，只给本地开发回路用。类型感知规则跨文件，而 ESLint 的缓存按文件失效：只改被依赖方时，依赖方的告警不会重报。**门禁一律用不带缓存的 `lint`** |
| `bun run typecheck` | `tsc --noEmit --incremental`，全严格模式。增量信息写在 `tsconfig.tsbuildinfo`（已 gitignore）；改 tsconfig 或依赖类型会整份判废重算，因此可以进门禁 |
| `bun run test` | 全量测试（强制文件隔离） |
| `bun run test:random` | 固定种子的乱序全量测试，用于暴露测试间残留 |
| `bun run test:coverage` | 测试 + 全源码覆盖率 |
| `bun run check:install-script-syntax` | 只用 `bash -n` 解析 `install.sh` 的 shell 语法；不执行安装脚本 |
| `bun run check:install-isolation` | 在 `copy-ninjia-install-test-*` 专属临时根的夹具里实跑 `install.sh`（`scripts/checkInstallIsolation.ts`），核对暂存失败清理、`telegram.json` 回滚、中断续跑、成功替换、符号链接拓扑、未校验备份保留与凭据隔离；不触碰任何真实部署路径 |
| `bun run check:conventions` | 仓库约定自检（`scripts/checkProjectConventions.ts`） |
| `bun run check` | install-script-syntax + install-isolation + conventions + lint + typecheck + coverage + 热路径门禁，共七段，**合入 master 前必跑** |
| `bun run check:coverage` | 现跑一次覆盖率，核对三语 README 徽章/图注、三份本页与两张覆盖率图的指标与真实读数一致；因为要整跑一遍测试，不进 `check` |
| `bun run test:fault-injection` | 确定性故障注入套件 |
| `bun run perf:hot-paths` | 单个热路径场景的独立进程测量（`--profile` 加采样分析） |
| `bun run perf:hot-path-gate` | `HOT_PATH_PROFILE_SCENARIOS` 精选的 10 个热路径场景的内存/GC/JIT 门禁（注册表共 36 个；其余按全量基准清单或专项命令运行），已并入 `check`；`--write-result` 把本次读数写回根目录 `performance-result.json` |
| `bun run perf:join-log` | 25 万项入群日志容量/快照/追加记账的独立进程对照基准 |
| `bun run perf:identity-database` | 身份数据库六项真实冷热读写的独立进程基准 |
| `bun run perf:full` | 六个分区各跑三轮的全量基准；只在发布和明确指令时跑，`--write-doc` 同时写回三份 09 性能基准页与 `performance-result.json` 的 `fullSuite.lastRun` |
| `bun run migrate:qa-thumbnail` | 从 `state.json` 摘掉退场的 `global.assets.qaThumbnailUrl` 的停机冷迁移 |
| `bun run migrate:temporary-whitelist` | 将共享 SQLite 按 v5 → v7 直接边迁移到当前 schema；只在停服时运行，v6 仅作为同次迁移可续跑的 intermediate 谱系 |
| `bun run release:check` | frozen lockfile 安装 + check + 覆盖率指标核对 + 故障注入，发布前必跑 |
| `bun run audit:release` | 依赖漏洞审计（moderate 及以上） |

## 质量门禁的口径

- **覆盖率分母是全源码**：`bun run check` 让所有生产运行时模块进入分母，未被任何测试触达的模块按 0% 计入；函数与行覆盖率门槛均为 90%。这意味着新增模块不写测试会直接拉低全局覆盖率。
- **eslint + tsc 全严格**：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` 全开；生产代码禁 `any`（测试文件豁免）。
- **显式类型标注由 lint 把守**：生产代码（`index.ts`、`packages/`、`scripts/`）的变量、形参、解构由 `@typescript-eslint/typedef` 强制标注，函数与回调的返回类型由 `@typescript-eslint/explicit-function-return-type` 强制，两者都不接受上下文推导。`for...of` / `for...in` 的循环变量 TS 语法不允许标注，规则自动跳过；初始化器已是箭头函数的 const 也放行。测试文件不受此约束。
- **约定自检**：`check:conventions` 检查代码放置、本地 Markdown 链接、tracked 非脚本文件的可执行权限、常量与缓存归属，并按真实线程模块图核对 Worker/Telegram 边界；`packages/workers/` 内每个 timer 句柄的 `unref()`、生产代码与脚本的 Node 兼容 import、`Buffer` 方法白名单、必须改用 `Bun.argv` 的进程参数读取、Telegram 提示清理与长期留存豁免、当前冷迁移入口、14 处覆盖率声明和三语性能记录也在这里做静态一致性检查；注释里「见 `<模块>.ts` 的 `<符号>`」这类交叉引用同样核对，被点名的模块不再声明或再导出该符号即失败（`export *` 兼容入口展开一层）。`check:coverage` 另起一次真实覆盖率运行，确认声明值没有整体过期。
  模块级纯字面量及其组合必须放在领域 `consts`，函数装配和缓存 owner 单独核对。Node 内建模块带或不带 `node:` 前缀使用同一白名单；动态加载、重导出、`require`、`process.hrtime` / `nextTick` 和解构入口同样检查，类型专用声明不进入运行时检查。

  Node API 检查覆盖 `process.getBuiltinModule`、`globalThis.Buffer` 及字面量下标形式；`Buffer.byteLength` 等例外仍按模块、符号和用途登记。`@grammyjs/runner` 仅作为开发依赖用于 SDK 对照测试，生产取数使用项目的 offset 确认边界。

### 依赖冷却期

依赖安装固定使用 `bunfig.toml` 的七天发布冷却期。未满七天的精确版本只有在用户知情批准并核对上游来源、npm integrity 与安装脚本后才能临时加入包级豁免；安装完成立即移除，并记录包名、原因与移除时间。当前 Bun 运行时固定为 1.4.2，`@types/bun` 固定为 1.4.0；版本门禁要求两者主、次版本一致，运行时补丁版本由 `packageManager` 与 `install.sh` 共同锁定。

### Bun 运行边界

项目在 `bunfig.toml` 中设置 `run.bun = true`，依赖 CLI 的 Node shebang 也由当前 Bun 执行。图片转码在 `packages/infra/image.ts` 中按需加载 `sharp`：视觉输入的 JPEG/PNG 原样传递，WebP/GIF 转为 PNG，动画只读取首帧并保留透明度；缩略图保持比例且不放大小图，不按 EXIF 方向自动旋转，透明像素按黑色背景合成，再按质量档生成满足尺寸与体积上限的 JPEG。原生 API 替换必须覆盖相同的输入格式、透明度、动画帧与失败语义。

文件内容写入和普通文件删除使用 [`Bun.write`、`Bun.file`](https://bun.com/docs/runtime/file-io)。独占创建后的写入使用 `Bun.write(Bun.file(handle.fd), content)`，由原句柄完成 fsync、关闭及原子发布；目录遍历、路径、同步持久化、权限与 hard link 等原生文件 API 未覆盖的操作使用 `node:` 接口。`AsyncLocalStorage`、PEM 私钥解析和无分配 UTF-8 字节计数保留 Bun 支持的兼容接口。Disk I/O 启动、午夜与跨日维护逐项等待异步删除，删除完成后才进入后续领域或发送持久化回执。

运行时升级后，性能校准必须针对相同 Bun version/revision 重新实测；在完成前，约定检查与热路径门禁会拒绝旧校准记录。只验证更新而不运行基准时，分别执行安装隔离检查、lint、typecheck、覆盖率与故障注入测试，不宣称完整 `check` 通过，也不改写旧性能读数。

### 当前文档版本实测

`bun run test:coverage`：**3495 tests / 345 files / 125930 次 `expect()`**；全源码**函数覆盖率 97.17% / 行覆盖率 97.37%**。三语项目 README 的 Coverage 徽章展示行覆盖率。

## 测试隔离机制

测试必须通过 `bun run test`（即 `bun test --isolate`）执行，四层保护：

1. **文件隔离**：Bun 为每个测试文件创建新的 global object；`mock.module` 与模块级状态不会污染其它测试文件。这里没有启用 `--parallel`，因此不宣称每个文件各占一个进程。
2. **临时数据根**：`test/preloadEnv.ts` 在任何生产模块加载前为每个隔离体注入独立临时数据根，因此未 mock 的真实文件 I/O 也只会读写临时目录，绝不触碰生产 `state.json`、`bot.lock`、`logs/`、`memory/`、`database/`；结束后临时目录被清理。**路径注入单独成文件**是因为 ESM 的 import 一律先于同文件语句求值：只要 `test/preload.ts` 静态 import 了任何生产模块，写在文件里的环境变量赋值就已经晚了一步，`CONFIG_ROOT` 会指向开发机上的真实部署目录。
3. **只读配置根**：同一份注入还把 `COPY_NINJIA_CONFIG_ROOT` 指向仓库内的 `config_example/`（见 `packages/consts/paths.ts` 的 `CONFIG_ROOT`）。部署 `config/` 不受版本控制，这一层既保证干净检出即可跑测试，也避免测试与测试 Worker 误读开发机上的真实 Telegram 与功能配置；身份策略数据库已由上一层临时数据根隔离。该环境变量只服务于测试，不是部署开关，因此不列入 README 的环境变量表。
4. **agent 配置快照**：`agent.json` 是唯一不由运行时读盘取得的部署配置（真实进程里由主线程解析后经 Worker 初始化消息投递，见 [04 运行时权威约束](04-invariants.md)）。测试 isolate 收不到那两条消息，因此 `test/preload.ts` 把同一份 `config_example/agent.json` 一次 adopt 进本 isolate 的 holder，等价于「快照已经送到」；要验证「没配」的用例自行把 holder 置空。

`test/scripts/installStartup.test.ts` 复用安装隔离夹具，在独立临时配置和数据根中运行 `install.sh`、`bun run start` 及真实 Worker；Telegram 应答和系统服务命令由测试替身接管。它覆盖不启用 AI、正常 AI 配置、重复安装启动，以及非法可选配置在联网前拒绝，核对正常停机和实例锁释放。

直接 `bun test` 单文件调试可以，但合并前必须过完整 `bun run check`。

### 写测试的约定

- 路径镜像 `packages/`：`packages/foo/bar.ts` → `test/foo/bar.test.ts`。
- 跨领域共用的替身、夹具与 harness 放 `test/helpers/`，与领域无关的通用小工具放 `test/libs/helpers.ts`；不要在测试间共享可变模块状态（隔离机制会掩盖这类错误直到有人不用 `--isolate` 运行）。
- 触发真实文件 I/O 的测试可以放心写——preload 的临时数据根兜底；但涉及 `infra/storage` 的测试注意 mock 边界（只 mock `infra/diskIO` 而漏掉 `infra/storage` 会调到真实 `saveStateInBackground`，这正是 [`AGENTS.md`](../../AGENTS.md) 要求先备份运行时文件的场景）。

## 故障注入套件

`bun run test:fault-injection` 重点回归崩溃恢复与持久化边界：生命周期失败、update runner 确认边界、StateStore 与清理、AI/Anti-Raid Worker 的镜像恢复与生命周期、Disk I/O 的追加/快照/日志文件、flush barrier 等（完整清单见 [`package.json`](../../package.json) 的脚本定义）。改动 [04 运行时权威约束](04-invariants.md) 涉及的路径时，本套件必须绿。

`/wed` 交互回归覆盖 1,024 项 LRU 容量、命令和按钮命中续期、淘汰取消排队与在途交互、迟到结果清理、单条删除失败后的继续清理、update 取消隔离和停机排空；成员权威表单独验证 25 群满额拒绝。持久化回归覆盖每群集合引用复用、15 万人容量、退群腾位、dirty 的 TTL/累计条数、静默跳过、投递失败、Worker 恢复水位、停机 flush，以及非法文件在全域启动门禁中保留原样并拒绝联网。`test/app/registerHandlersDispatch.test.ts` 另外验证初始化网关拒绝期间只清理退群 ID。性能验证复用 `wed-member-hit`、`wed-member-growth`、`wed-member-churn`、`wed-member-chat-switch` 和 `registered-middleware` 场景；`wed-member-churn` 检查满额时拒绝新 ID、保留已有成员。

## 热路径门禁

`bun run perf:hot-path-gate` 是 `bun run check` 的最后一段，合入 `master` 前必须执行。它按 `packages/consts/performance.ts` 的 `HOT_PATH_PROFILE_SCENARIOS` 逐场景、逐次重复各起两个独立子进程：`steadyProfile` 只判断正式循环的 GC 与 JIT，`retained` 在没有 profiler 自身内存干扰时判断 RSS、heapUsed 波峰与 full-GC 后留存。

校准记录保存在 [`performance-result.json`](../../performance-result.json)，由 `scripts/perf/hotPaths/gateResult.ts` 严格解析。`gateRuntime.ts` 在约定检查和热路径子进程启动前核对 `packageManager`、当前 Bun version/revision 与校准构建；不一致时先重新实测校准。记录保留采样进程数、逐场景延迟来源和 GC/RSS/留存硬上限。历史 `fullSuite` 全量读数保留各自的运行时间和 Bun 构建。

`hotPathProfileGate` 这一节是双向的，但两半 owner 不同：`calibration` 由人重标后手工修改，门禁只读；`lastRun` 记录最近一次门禁读数，只有显式传 `bun run perf:hot-path-gate -- --write-result` 才覆盖写，因此 `bun run check` 跑完不会产生工作树改动。回写一个字节都不碰 `calibration`——让门禁拿一次运行的读数自动改自己的判据，等于把闸门焊死在当前性能上。

同一份文件的另一节 `fullSuite.lastRun` 属于[全量基准](#全量性能基准)，由 `bun run perf:full -- --write-doc` 写入。两套基准在不同进程、不同时刻运行，因此写入统一走 `scripts/perf/performanceResult.ts` 的「读整份 → 只换自己那一格 → 整份写回」：谁都不按解析结果重建文档，否则后跑的那个会把另一节连同 `calibration` 里那些给人看的说明一起抹掉。

设闸门的项：GC 采样占比、采样 RSS 峰值与进程生命周期 RSS 高水位（共用同一上限，后者能拦住完整落在两次节拍之间的瞬时分配）、采样 heapUsed 增长、full-GC 后的 JSC heap/堆外内存/对象数留存、最少采样数，以及逐生产探针的「预热后已进 DFG」与「采样期无重编译或去优化」。

输出里带 `Diagnostic` 后缀的字段只报告、不设闸门。汇总 FTL 比例是其中之一：它对纯叶子场景接近 100%、对异步主链只有个位数（采样里混着 native Promise 与调度帧），单一阈值对两类场景没有共同含义。`reoptRetries` 的绝对值同理——采样前的 JIT 稳定轮已经要求它连续两轮不变，剩下的只是预热期历史。

`profile` / `retained` 前缀标明读数取自哪个子进程；两者预热轮数相差一个数量级（profiler 场景要多跑 JIT 稳定轮），不能混读。

新增或改写场景时有一条**必须守住的收口口径**：被测函数返回字符串时，基准不能只读 `.length` 收口。JSC 的 rope 自带长度，读长度不会让它 materialize——那样量到的是「建了一棵拼接树」而不是「拿到一个可用的字符串」。实测同一份输入下，转录渲染改用逐行 `+=` 之后两种口径差着 42.0 vs 57.5 µs/op（27%），而改之前只差 3.1%：只读长度的基准会把那次改动量成快 42%，其中一多半是还没做的活。收口一律用 `charCodeAt(length - 1)` 之类强制解析（见 `scripts/perf/hotPaths/transcriptScenarios.ts` 的 `transcript-render`）。同一条理由也适用于任何「攒起来最后才用」的惰性结构：**基准必须把生产真正会付的那一步付掉**，否则一次把该步骤从链路里摘掉的回归会表现成读数变快而不是失败。

## 入群日志性能基准

`bun run perf:join-log` 固定使用 250,000 条容量、300 条溢出和 10,000 条预热输入；快照（`snapshot`）、容量（`capacity`）与追加记账（`append-accounting`）三条路径的 baseline/current 各运行 5 个独立 Bun 进程，父进程逐样本比对两个变体的 checksum，不一致即整体失败。`append-accounting` 的单批规模取生产的 `JOIN_LOG_MAX_BUFFERED_ENTRIES`，重复到与另两条同在 25 万条量级。输出记录完整 Bun version/revision、耗时的中位数与范围，以及强制 GC 前后的 JSC heap/object 变化。baseline 固化的是分配优化前的算法——整表复制、全量排序与完整 JSON 字符串（快照与容量），以及按记录重新序列化一次只为量出它的字节数（追加记账）——只用于同一 Bun build 内的前后对照；`Bun.gc(true)` 只存在于该基准，不进入生产控制流。改动入群索引、容量裁剪、快照序列化、追加后的字节记账或分块原子写时必须运行，并确认差异明显大于 5 轮样本范围所显示的噪声。

## 身份数据库性能基准

`bun run perf:identity-database` 在临时数据根和临时 SQLite 中测六项真实操作：8 个身份一批的双表读（同一连接的热读、每批换新连接的冷读）、128 行显式事务写入（同样分热连接与冷连接两种）、主线程 8,192 项 LRU 热读，以及经过 Worker、JSONB transaction 与精确 ACK 的写透。「冷」只表示连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。每项先预热，再跑 5 个独立 Bun 进程；报告固定 Bun version/revision、吞吐、批延迟、样本范围/变异系数，以及强制 GC 前后的 JSC heap、extra memory、object 与 GC 耗时。`--single-process` 让每项在同一测量进程内连续复测 3 次，用于排查跨轮 retained growth，不替代独立进程性能对照。`Bun.gc(true)` 只在计时边界外诊断，生产代码不得调用。改动身份 LRU、冷预取、编码、事务批量、ACK 或 Worker 重放时必须运行，并把同一 Bun build 的差异与样本噪声、heap/GC 一起判断。

写透场景固定执行 65,536 次操作，工作集为 4,096 个主键；每个工作集完成后等待 durable flush，再进入下一轮，最终核对全部操作的 ACK 和 checksum。

## 专项场景与传输压力验证

注册表包含 `wed-member-hit`、`wed-member-growth`、`wed-member-churn`、`wed-member-chat-switch`、`registered-middleware` 和 `storage-sqlite-flush`。前四项覆盖成员集合命中、填充、满额拒绝和切群；middleware 场景运行真实注册链并断言活动路径；SQLite 场景对空库提交 128 个删除，主要衡量事务调度，不能作为磁盘吞吐读数。

运行 `bun scripts/perf/isolatedHotPath.ts <场景>`，加 `--profile` 单独采样。该入口复用 `gateFixture.ts` 建立独立配置和数据根，注入三个独立子进程并在结束后清理 run 目录；出站由基准罐头接管。固定 Bun 与输入、完成预热，分别观察 retained 与 profile 输出；采样数不足时不得用零 GC 样本断言没有 GC。

`bun scripts/perf/diskTransport.ts` 跑三轮独立 mock 进程，验证单批 ACK、正常排空和停止 ACK 后的容量拒收，并报告延迟、堆、GC 与 JIT。它复用同一份不可变载荷，只测队列与确认开销，不包含 Worker clone、真实负载载荷体积或磁盘等待。

## 全量性能基准

`bun run perf:full` 只在发布和明确指令时运行，不进 `bun run check`，也不设失败阈值——热路径的硬门禁仍是上面的 `perf:hot-path-gate`。它把六个分区各跑三轮独立子进程再取平均：冷启动、生产热路径、端到端落盘链路、SQLite 与主线程缓存、容器与算法、入群日志容量线。每一项除平均值外还给最小值、最大值与变异系数，CV 明显变大的那一行不能拿去和历史比。

被测实现全部复用现有代码：热路径直接跑 `perf:hot-paths` 的场景与迭代规模，存储调 `perf:identity-database` 的实现，容量线调 `perf:join-log` 的子进程，链路由 `recordJoinLog`、`persistChatState`、`queueIdentityPolicyWrite`、`postDiskIO`、`relayLogMessage` 这些主线程生产入口驱动真实 Disk I/O Worker，计时到落盘 durable 回执为止。另有两条**完整命令**链路：`ad-detect-command` 走 `enqueueAdCandidate` 到 `runAdDetectBatch` 再到主线程 `handleAdDetected` 的处置排空，`ai-reply-command` 走 `recordChatMessage` 与 `generateAndSendReply` 到回复真的发出。这两条的模型调用与 Telegram 出站由 `scripts/perf/outboundGuard.ts` 的进程内罐头就地应答——基准从不发起真实请求，也不产生任何调用费用；`ai-reply-command` 另外按实测扣掉发送前的拟人停顿，口径见 [09 性能基准](09-performance.md)。冷启动在满库 fixture 上按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时，不含联网握手与两个业务 Worker 的创建。

数据全部写在仓库根的 `performance/`（已进 `.gitignore`），配置读 `config_example/`，每轮跑完删除整棵目录，运行结束后该目录下不应有残留。父进程不 import 任何生产实现模块，因此它没有能力写到真实数据根。加 `--write-doc` 会把三语区块写回 `docs/{cn,en,ja}/09-performance.md`；读数与各分区口径见 [09 性能基准](09-performance.md)。

## 提交流程

1. 开发在 `dev` 分支上进行，不直接提交 `master`；合并进 `master` 只用 squash，一次改动一个提交。分支约定见 [`AGENTS.md`](../../AGENTS.md) 的「分支、验证、提交与发布」，此处不重复。
2. 开发中用户可能随手改参——编辑前重读文件，别覆盖未提交的现场改动。
3. 提交前 `git diff --stat` 全量过一遍，无关文件不混进本次提交。
4. 每次提交前运行 `git branch --show-current`，确认位于 `dev`；通过 `bun run lint && bun run typecheck` 或完整 `bun run check`。合入 `master` 前必须通过完整 `check`，涉及持久化、停机或 Worker 生命周期时同时通过 `bun run test:fault-injection`。
5. 提交信息用 conventional commits 风格（`feat(ai): ...`、`fix(runtime): ...`、`docs: ...`），主题行英文。

### 同步 README 指标

三语项目 README 徽章与上方测试数/断言数/覆盖率是实测值；测试、生产模块或覆盖率口径变化后按此更新：

```bash
bun run test:coverage 2>&1 | tail -5        # 测试数、文件数、expect() 调用数
bun run test:coverage 2>&1 | grep 'All files'  # 函数/行覆盖率
```

需要同步的位置是同一组实测数值，改一处就要全部改到：

- **三语 README 的徽章行**（Tests / Coverage）。Coverage 徽章固定采用 `All files` 的行覆盖率。
- **覆盖率图**：[`pictures/coverage_light.svg`](../../pictures/coverage_light.svg) 与 [`pictures/coverage_dark.svg`](../../pictures/coverage_dark.svg)。一对图由三语 README 共用（同 banner），改动要同时落在两个主题文件的数值上。
- **三份 README 里 `<img alt>` 的等价文案**：图以图片加载，SVG 内部的 `<title>` / `aria-label` 读屏软件读不到，alt 是唯一的无障碍出口。
- **三语本文的「当前文档版本实测」**。

另有两组独立于覆盖率、同样容易悄悄过期的实测数值：

- **中文字符串统计**：数值只写在三语 [06 常见修改配方](06-modification-guide.md) 的「不做 i18n」节；三语 README 的「关于语言」注只链到那一节，不重复数值。生产代码文案增删后重算：按 TypeScript AST 的字符串/模板字面量节点统计它们所在的源码行（不含注释）。别用 grep 数反引号——正则字面量里的反引号会把计数带偏。
- **行为数值**（概率、容量、时长）：README 引用的这类数字与 `packages/consts/` 保持一致，见 [06 常见修改配方](06-modification-guide.md#调整行为参数)。

## 发布

本仓库不依赖 GitHub Actions。发布环境把 `bun run release:check` 作为显式构建或 pre-deploy 步骤；联网环境追加 `bun run audit:release`（网络失败只表示审计未完成，不等于零漏洞；忽略 CVE 要记录原因与到期时间）。包含持久化结构变更的版本，先走 [06 常见修改配方](06-modification-guide.md#变更持久化-schema) 的迁移流程。

在 `dev` 完成门禁后，停止服务与其他重负载，等待机器空闲，再运行默认三轮的
`bun run perf:full -- --write-doc`。该命令同时更新三语 [09 性能基准](09-performance.md)
与 `performance-result.json` 的 `fullSuite.lastRun`，两者与代码改动一起提交。
全量基准与 `bun run check` 不得连续或同时运行；后续检查须等机器恢复空闲。
性能对照须使用同一机器、同一 Bun 构建；运行时升级后的读数作为当前构建的基准，
不得把跨构建差异归为代码优化收益。失败或异常读数查清并重跑后才能发布。

每次 squash 合并进 `master` 都要创建一个 GitHub Release：

1. 同步远端 tags，并通过 `gh release list` 读取当前 Latest Release tag。tag 严格使用不带 `v` 的 `MAJOR.MINOR.PATCH`；按本次完整改动的最高语义影响选择版本：破坏兼容升 `MAJOR`（`1.0.9` → `2.0.0`），向后兼容的新增功能升 `MINOR`（`1.0.9` → `1.1.0`），只有修复、性能、重构或文档时才升 `PATCH`（`1.0.9` → `1.0.10`）。
2. 推送 `master` squash 提交后，为该提交创建、推送不可变的 annotated version tag；已有 tag 不得覆盖、移动或复用。
3. 使用 `gh release create <tag> --verify-tag --target master ...` 创建英文 Release。Release notes 只总结上一个 Latest Release tag 到当前 `master` 的增量，至少包含 Highlights、Compatibility / Migration Notes、Validation；门禁数值使用本次真实输出。
4. tag 推送成功但 Release 创建失败时，针对同一 tag 重试，不再递增版本。只有 `master`、tag 和 Release 都确认成功后，才按 [`AGENTS.md`](../../AGENTS.md) 的流程把 `dev` 对齐到 `master`。

---

<div align="center">

[← 上一页：04 权威约束](04-invariants.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#05-开发流程与质量门禁) · [下一页：06 修改配方 →](06-modification-guide.md)

</div>
