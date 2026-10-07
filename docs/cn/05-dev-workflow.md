# 05 开发流程与质量门禁

<p align="center">
  <b>简体中文</b> · <a href="../en/05-dev-workflow.md">English</a> · <a href="../ja/05-dev-workflow.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="04-invariants.md">← 上一页：04 权威约束</a> · <a href="06-modification-guide.md">下一页：06 修改配方 →</a>
</p>

---

## 命令速查

| 命令 | 作用 | 说明 |
| :--- | :--- | :--- |
| `bun run start` | 启动长轮询 | 生产环境入口 |
| `bun run lint`<br>`bun run lint:fix` | ESLint 检查 / 自动修复 | 严格检查代码规范；CI 与门禁一律使用不带缓存的 `lint` |
| `bun run lint:fast` | 本地带缓存 ESLint | 附加 `--cache`，仅供本地开发调试回路快速迭代使用 |
| `bun run typecheck` | TypeScript 类型检查 | `tsc --noEmit --incremental` 全严格模式，增量信息缓存于 `tsconfig.tsbuildinfo` |
| `bun run test` | 全量测试 | 强制启用进程上下文隔离（`bun test --isolate`） |
| `bun run test:random` | 乱序全量测试 | 固定种子的乱序全量测试，专门用于暴露测试间的全局状态残留与 mock 泄漏 |
| `bun run test:coverage` | 测试 + 覆盖率 | 运行全量测试并统计全源码覆盖率指标 |
| `bun run check:install-script-syntax` | 安装脚本语法检查 | `bash -n` 解析 `install.sh` 及其引用的所有 shell 模块，不执行实际逻辑 |
| `bun run check:install-isolation` | 安装器隔离验证 | 在专属临时根跑真实 `install.sh` 夹具，核对回滚、中断续跑、备份保留、凭据隔离、服务保护与启动观察 |
| `bun run check:conventions` | 仓库约定自检 | 运行 `scripts/checkProjectConventions.ts`，验证常量、缓存归属、文档链接与架构边界 |
| `bun run check` | **全量集成门禁** | 语法 + 安装隔离 + 约定自检 + lint + typecheck + 覆盖率 + 乱序测试 + 热路径门禁（合入 `master` 必跑） |
| `bun run check:coverage` | 覆盖率指标对账 | 校验三语 README、文档与 SVG 徽章指标与真实读数的一致性 |
| `bun run test:fault-injection` | 确定性故障注入套件 | 验证进程崩溃、异常停机、数据库瞬断与 Worker 重生时的恢复一致性 |
| `bun run perf:hot-paths -- <场景> [--profile]` | 热路径独立进程测量 | 测量单个热路径场景（`--profile` 用于采样分析） |
| `bun run perf:hot-path-gate` | **热路径性能门禁** | 精选热路径场景的内存/GC/JIT 硬门禁（已并入 `check`） |
| `bun run perf:join-log` | 入群日志性能基准 | 入群日志容量/快照/追加记账的独立进程对照基准 |
| `bun run perf:identity-database` | 身份数据库基准 | 身份数据库冷热读写、主线程 LRU 读与写透链路的独立进程基准 |
| `bun run perf:full` | 全量性能基准套件 | 各分区按默认轮数跑独立子进程（`--write-doc` 写回三语 10 性能页及 `performance-result.json`） |
| `bun run perf:review` | 专项性能复核 | 涵盖热路径、AI 回复/载荷/语音编码、完整命令链与 Disk I/O Worker 压力 |
| `bun run build -- --version <tag>` | 构建二进制包 | 必须显式传入无前缀版本号，在当前平台产出 `dist/` 发行包及 SHA-256 |
| `bun run release:check -- --version <tag>` | 发布前全量自检 | frozen lockfile + check + 覆盖率对账 + 故障注入 + 二进制构建验证 |
| `bun run release:build -- --version <tag>` | 正式构建发行包 | 在干净的 `dev` 分支上原生构建当前平台的二进制资产；其他平台须在对应环境分别构建 |
| `bun run release:verify -- --version <tag> --platforms <列表>` | 发行包校验 | 核对全部目标平台的包、SHA-256、版本与 Git tree 一致性 |
| `bun run release:publish -- --version <tag> --platforms <列表> --notes-file <文件>` | 发布到 GitHub | 校验远端引用，创建草稿，上传并核验资产，正式发布为 Latest |
| `bun run audit:release` | 依赖安全审计 | 扫描依赖漏洞（moderate 及以上级别） |

---

## 质量门禁的口径

- **安装启动测试隔离**：
  - 测试夹具使用独立的临时配置与数据根，完全 mock 外部系统管理、依赖安装和真实网络出站，运行真实的 `index.ts`、Worker 线程以及退出落盘逻辑。
  - 各 Worker 通过 Bun `preload` 机制注入网络替身：东京天气接口返回固定罐头数据，其余外部网络请求均被严格阻断。
  - 测试套件逐项断言替身正常加载、轮询链路畅通、收到 SIGTERM 信号后优雅排空，以及锁文件安全释放。
- **源码文件行数限制（`MAX_SOURCE_LINES`）**：
  - 手写 TypeScript、JavaScript 与 Shell 文件若超过 `MAX_SOURCE_LINES`（定义于 `scripts/conventions/fileLength.ts`）将被门禁直接拒绝。
  - 文件超过 512 行时应评估拆分，超过 1024 行时必须拆分。
  - 检查范围覆盖所有受 Git 跟踪的文件及暂存区新文件，忽略的文件不纳入扫描。安装语法检查全面覆盖 `install.sh` 及其调用的所有独立 Shell 模块。
- **全源码覆盖率考核**：
  - `test/productionModules.test.ts` 主动加载 `index.ts` 以及 `packages/` 下除 `packages/types/` 外的全部运行时模块；未被任何测试覆盖的模块直接按 0% 计入分母。
  - 函数与行覆盖率必须达到 `bunfig.toml` 中配置的 `coverageThreshold` 阈值。新增业务模块若缺少单元测试，将直接导致整体覆盖率不达标。
- **严格类型与语法规范**：
  - `tsconfig.json` 全面启用 `strict`、`noUncheckedIndexedAccess`、`noUnusedLocals` 与 `noUnusedParameters`。
  - 生产代码中严禁使用 `any`（测试代码豁免）；严禁随意使用原生 `Promise.all`（ESLint 规则拒绝），必须改用具备并发容错控制的 `Promise.allSettled`。
- **类型导入独立声明**：
  - 生产代码、脚本与测试文件均强制使用独立的 `import type` 语法。ESLint 严格拦截混合导入（如 `import { value, type Shape }`）。
- **显式类型标注**：
  - 生产代码中的变量、函数参数与解构赋值必须显式标注类型（由 `@typescript-eslint/typedef` 把守），函数和回调必须显式标注返回值类型（由 `@typescript-eslint/explicit-function-return-type` 把守），均不依赖上下文推导。
  - 语法层面不支持标注的 `for...of` / `for...in` 循环变量自动豁免；初始化器已是全标注箭头函数的 `const` 同样豁免。
- **仓库约定自检（`check:conventions`）**：
  - **结构与链接校验**：检查源码行数、文件归位、Markdown 文档的本地相对链接与锚点有效性；核对文档中提及的文件清单真实存在；校验可执行脚本的权限位与安装步骤编号的一致性。
  - **模块与架构隔离**：核对常量与缓存归属（`packages/cache/<owner>/` 线程单属性边界），按真实模块导入图核验 Worker 与 Telegram 能力隔离；环境变量仅允许在 `consts/paths.ts` 与 `consts/environment.ts` 中读取；`consts/` 运行期只依赖 `consts`（其它 `packages/` 模块只能 `import type`）；`states/` 仅依赖 `consts`、`libs`、`types` 与 `states`；`infra/` 严禁反向依赖业务层；全量基准测试父进程仅允许引入纯常量与类型。
  - **常量表约束**：带对象元素的导出常量表（正则与函数值除外）必须在 `test/consts/immutability.test.ts` 中有一行紧跟 `@ts-expect-error` 注释的访问（`scripts/conventions/constImmutability.ts`）；元素为字面量联合的导出数组表必须写成 `exhaustiveList<U>()([...])`（`packages/consts/exhaustiveList.ts`），`U` 与声明的元素类型一致、实参逐项写字符串或数字字面量，类型新增或删除成员而表没跟上时编译失败。有意只列子集的表按 `<相对路径>#<表名>` 登记在 `scripts/conventions/constExhaustiveLists.ts` 的 `PARTIAL_LITERAL_TABLES`，登记失效同样报错。
  - **运行时安全与 API 规范**：`packages/workers/` 中的定时器必须显式调用 `unref()`；Node 兼容模块与 `Buffer` 仅放行在白名单中登记的调用，未使用的登记同样报错；统一使用 `Bun.argv` 读取命令行参数；运行期裸导入的包必须在根 `package.json` 中直接声明。
  - **门禁与指标对账**：静态检查 Telegram 消息清理例外与话题归属；核对冷迁移脚本与 `package.json` 的 `migrate:*` 入口一一对应；比对三语文档与 `performance-result.json` 中的测试覆盖率和性能指标，确保记录同源。
  - **测试断言规范**：测试用例中严禁将常量与原始字面量进行比对，禁止直接在断言中硬编码与 `packages/consts` 相同的长字符串或中文提示文案片段（必须引用常量或模板辅助函数 `test/helpers/templateText.ts`）。特殊断言豁免必须在 `scripts/conventions/testAssertionFragments.ts` 中显式登记。

---

### 依赖冷却期

依赖安装严格执行 `bunfig.toml` 中配置的 7 天发布冷却期（`minimumReleaseAge = 604_800`）：
- **紧急安全补丁豁免**：未满 7 天冷却期的紧急漏洞修复，仅允许将该单一包名加入 `install.minimumReleaseAgeExcludes`，完成安装后必须立即移除，禁止使用命令行参数 `--minimum-release-age` 全局绕过。
- **安全核验要求**：被豁免的包版本必须交叉核对至少两个独立的安全受害清单，校验 npm registry 的 `integrity` 哈希，排查安装脚本与持久化后门，并在提交记录中注明包名、CVE 编号及移除时间。
- **运行时版本锁定**：Bun 运行时及 `@types/bun` 严格固定为 `package.json` 声明的版本；`packageManager` 与 `install.sh` 共同锁定运行环境。
- **TypeScript 编译器**：`bun run typecheck` 使用 `@typescript/native`（`npm:typescript@~7.0.2`）提供的编译器；ESLint 与约定检查工具通过 `@typescript/old` 使用 TypeScript 6 编译器 API。

---

### Bun 运行边界

- **执行模式**：项目在 `bunfig.toml` 中配置了 `run.bun = true`，所有依赖 CLI 的 Node shebang 脚本均由 Bun 直接运行。
- **图片编解码**：使用 Bun 原生 `Bun.Image` 进行图片转码处理（`packages/infra/image.ts`）：
  - JPEG 与 PNG 图片原样透传；WebP 与 GIF 转码为 PNG 并完整保留 Alpha 透明通道；GIF 提取首帧，动图 WebP 提取首个 `ANMF` 帧重封装为静态 WebP 后解码。
  - 单张图片解码像素上限为 `VISION_TRANSCODE_MAX_PIXELS`，超限在分配内存前立即拒绝。编解码能力由 Bun 内置提供，不依赖 `node_modules` 中的外部原生 C/C++ 扩展。
- **原生文件 I/O 规范**：文件读取、写入和删除优先使用 `Bun.write` 与 `Bun.file`；原子写入（`atomicWriteText`）通过 `Bun.write(Bun.file(handle.fd), content)` 配合 fsync 与原子 rename；同步文件 I/O、目录遍历、路径操作与硬链接等 Bun 原生未覆盖的功能统一按规范使用 `node:` 兼容模块。
- **性能基准校准**：运行时版本升级后，所有性能基准数据必须在相同的 Bun 版本与提交修订上重新实测校准。

---

### 当前文档版本实测

`bun run test:coverage`：**6269 tests / 526 files / 446227 次 `expect()`**；全源码**函数覆盖率 98.24% / 行覆盖率 98.75%**。三语项目 README 的 Coverage 徽章展示行覆盖率。

---

## 测试隔离机制

所有测试必须通过 `bun run test`（底层调用 `bun test --isolate`）运行，享受全自动化隔离保护：

1. **测试文件上下文隔离**：Bun 为每个测试文件创建完全独立的全局对象，`mock.module` 与模块级全局变量绝不跨文件产生污染。
2. **专属临时数据根**：`test/preloadEnv.ts` 在加载任何业务代码之前，为当前测试进程创建独立的临时数据目录（`mkdtempSync`）并设置环境变量 `COPY_NINJIA_DATA_ROOT`。所有文件 I/O 均局限于临时目录中，绝不触碰生产环境文件（`memory/`、`logs/`、`database/`、`bot.lock`），测试结束后整棵临时目录自动清理。
3. **独立配置根目录**：自动将 `config_example/` 完整复制到临时目录的 `config/`，通过 `COPY_NINJIA_CONFIG_ROOT` 引导程序读取测试专用配置。占位密钥替换为安全的虚拟凭据，屏蔽 `g-auth.json`，并将 `cron.json` 初始化为空任务表。
4. **配置快照同步与空库初始化**：`test/preload.ts` 将测试副本中的 `agent.json`、`ad_samples.json`、`mood.json`、`stickers.json`、`cron.json`、机器人语气及内置人设一次性加载至测试环境的 holder 中，并在临时数据根创建带时区标记的空 SQLite 数据库，各功能 readiness 状态直接置为就绪。

### 关键测试套件分布

- **安装与升级测试**：`test/scripts/installStartup.test.ts` 与 `test/scripts/installMigration.test.ts` 验证安装脚本、新库初始化与完整启动流程，确保安装器在遇到非当前格式的配置或数据库时能提前拒绝并不修改数据。
- **冷迁移测试**：`test/scripts/migrateChatPersonaRemoval.test.ts` 验证仅接受 16.3.2 产出的数据库 schema（`CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION`）向当前版本（`IDENTITY_DATABASE_SCHEMA_VERSION`）迁移的完整链路（含 Asia/Tokyo 时区校验），以及启动前后的版本判定。
- **媒体与出站测试**：`test/aiChat/ai/mediaAdmission.test.ts`、`test/aiChat/ai/imageDescription.test.ts` 与 `test/infra/telegramWorkerCapabilities.test.ts` 验证多模态内容审查与 Telegram 双工出站闸门。
- **统一出站集成测试**：`test/infra/telegramOutboundIntegration.test.ts` 使用真实客户端初始化、出站调度器与发送车道，仅在最内层替换网络响应，验证主线程与各 Worker 之间的同群 FIFO、分类 429 退避重试、下载限流及停机排空。
- **安全与日志脱敏测试**：`test/infra/loggerSecurity.test.ts` 验证敏感凭据在各类异常展开下的脱敏完整性。

---

## 故障注入套件

`bun run test:fault-injection` 全面验证服务崩溃、异常中断与极端边界下的系统一致性（完整清单见 [`package.json`](../../package.json)）：
- **生命周期与恢复边界**：覆盖应用与 Worker 生命周期、群锁定恢复、AI 回复容量与取消、凭据快照一致性、Telegram 出站与自毁消息的停机排空、群 teardown 清理。
- **数据持久化与一致性**：验证入群日志未确认镜像与处置回执、Anti-Raid 任务排空与验证恢复、双工 Worker 重建取消、SQLite 启动检查与停机关库（残余写提交、WAL checkpoint）、冷迁移以及 Disk I/O Worker 的原子写入故障恢复。
- **交互状态机稳定性**：包含 `test/workers/antiRaid/verificationWelcome.test.ts`（双工协议与临时提示自毁）以及 `/wed` 交互状态机（群容量上限 `STATE_MANAGED_CHAT_LIMIT`、排队取消、头像抓取与停机排空）。

---

## 热路径门禁

`bun run perf:hot-path-gate` 是 `bun run check` 集成门禁中的硬性关卡。测试按照 `packages/consts/performance.ts` 中的 `HOT_PATH_PROFILE_SCENARIOS` 场景，每个场景独立启动两个子进程重复运行 `HOT_PATH_PROFILE_REPEATS` 次：
- `steadyProfile`：在开启 `BUN_JSC_logGC=1` 的环境下，高精度测量核心循环中的 GC 暂停时间占比与 JIT 编译层级。
- `retained`：在无 profiler 侵入的干净环境下，测量真实的物理内存（RSS）峰值、堆内存（heapUsed）波峰以及 full-GC 触发后的残留内存。

### 门禁指标与分档

- **GC 暂停占比预算**：依据可用 CPU 核心数自动分档计算（`HOT_PATH_GC_CPU_BUDGETS`）。单进程测量值若超过预算加 `HOT_PATH_GC_SOFT_OVERRUN_PERCENT` 百分点，直接判定门禁失败；仅轻微超出但未达硬上限时作为软上报提示。
- **硬性指标门禁**：考核 GC 暂停时间占比、RSS 采样峰值、进程物理内存峰值、堆增长率、full-GC 后堆/额外内存/对象存留数量，以及生产探针在预热阶段成功进入 DFG JIT。具体数值基线来自 [`performance-result.json`](../../performance-result.json) 中的 `calibration.limits`。
- **软性指标告警**：当场景的中位耗时超过 `calibration.medianNsPerOpReportThresholds` 阈值，或校准基线相较实测显著过松（`HOT_PATH_CALIBRATION_STALE_RATIO`）时，仅在 stderr 输出预警提示，不改变门禁退出码。
- **校准读数管理**：`calibration` 必须在低负载环境下人工重标并审阅提交；门禁平时只读。仅在附带 `--write-result` 时更新 `lastRun` 记录。

---

## 入群日志性能基准

`bun run perf:join-log` 的测试夹具规模完全对齐生产常量：单群单日容量线 `JOIN_LOG_MAX_USERS_PER_CHAT_DAY`、刷盘阈值 `FLUSH_MAX_ENTRIES` 以及追加批次大小 `JOIN_LOG_MAX_BUFFERED_ENTRIES`。针对快照（`snapshot`）、容量（`capacity`）与追加记账（`append-accounting`）三条核心路径，在独立子进程中交替对比基准版本与当前版本，校验数据校验和（checksum）并衡量吞吐量与堆内存波动。

---

## 身份数据库性能基准

`bun run perf:identity-database` 在独立临时数据根与临时 SQLite 数据库中，端到端测量高频操作性能：主线程 LRU 读取、主线程写透链路（包含 Worker 通信、JSONB 事务与 ACK 回执）、数据库热连接读写以及冷连接读写。测试样本基数取自生产常量 `IDENTITY_READ_CACHE_MAX_ENTRIES` 与 `IDENTITY_WRITE_BATCH_MAX_ENTRIES`；各测试项在独立进程中采样，并在非计时阶段执行垃圾回收与数据校验。

---

## 专项场景与传输压力验证

`bun run perf:review` 用于对核心性能瓶颈进行深度复核，每项测试按 `FULL_SUITE_ROUNDS` 轮在独立子进程中执行；默认依次运行 `--hot-paths`、`--chains`、`--ai` 与 `--worker`：
- `--hot-paths`：覆盖发送者解析、消息滑动窗口、权限检查、AI 活跃窗口、入群待验证快照、流式有界响应及中间件流水线。
- `--ai`：测量 AI 回复准入门禁、出站发送性能、并发容量负载、Base64 编解码与 Opus 音频压缩。
- `--chains`：端到端压测完整业务链路，包括广告检测（`ad-detect-command`）、AI 闲聊（`ai-reply-command`）与定时语音（`cron-send-voice`）。
- `--worker`：通过真实的 Disk I/O Worker 压测批量事务写入、回执确认以及 Worker 崩溃重建后的快速恢复（受管群上限为 `STATE_MANAGED_CHAT_LIMIT`）。
- `--cooldown` / `--text`：冷却表操作与文本清洗专项基准（按需显式指定运行），在生产容量与时间窗口下验证命令冷却命中、续期与满载排队。
- `bun run perf:disk-transport`：在 mock Worker 环境下专门测量主线程内部业务传输通道的队列开销、ACK 吞吐与延迟，隔离磁盘 I/O 等待干扰。

---

## 全量性能基准

`bun run perf:full` 仅在发布新版本或明确接收到性能评测指令时运行，不设硬性失败阈值。基准分为六大分区，在独立子进程中按 `FULL_SUITE_ROUNDS` 轮默认轮数执行，并输出平均值、极值与变异系数报告：
1. **冷启动分区**：在预置完整数据的真实夹具上测量服务冷启动与状态恢复耗时。
2. **生产热路径分区**：测量高频消息进入主干流水线并完成分发的核心耗时。
3. **端到端落盘链路**：测量主线程发出变更经由 Worker 到达磁盘并返回确认的完整链路时延，以及各类完整命令链路。
4. **SQLite 与主线程缓存**：评估 SQLite 数据库与主线程热 LRU 缓存之间的交互效率。
5. **容器与算法分区**：评估系统核心状态容器的插入、检索与高频算法运算开销。
6. **入群日志容量线**：在大规模入群日志堆积下的读写与处理性能。

所有基准测试数据均写入仓库根目录的 `performance/` 临时目录（运行结束后自动删除整棵目录）。添加 `--write-doc` 参数可同步更新三语 `10-performance.md` 文档与 `performance-result.json`。`--rounds <n>` 参数仅用于本地快速排查，非默认轮数的测试数据严禁提交至版本控制。

---

## 提交流程

1. **分支管理**：全仓仅使用 `master` 与 `dev` 两个分支，禁止创建功能分支。所有开发与调试均在 `dev` 分支进行，严禁直接向 `master` 提交代码。
2. **提交前自检**：
   - 运行 `git diff --stat` 确认无多余的未跟踪文件或部署配置残留；
   - 运行 `git branch --show-current` 确保位于 `dev` 分支；
   - 运行 `bun run lint && bun run typecheck` 或执行完整的 `bun run check`。
3. **合入门禁要求**：合入 `master` 前必须确保 `bun run check` 全部通过；若代码改动涉及持久化格式、停机流程或 Worker 生命周期，必须单独执行并通过 `bun run test:fault-injection`。
4. **合入机制**：合入 `master` 统一采用 `git merge --squash` 方式，合并为单次清晰提交。
5. **提交信息规范**：提交信息必须详细涵盖改动内容与依据，使用规范的语义化前缀（如 `feat:`、`fix:`、`perf:`、`docs:` 等）；发布版本时使用 `release: <版本号>` 前缀。

### 同步 README 指标

仅在用户明确要求同步文档或指标时，依据本地全量门禁实测输出同步下列位置：
```bash
bun run test:coverage 2>&1 | tail -5          # 获取测试用例数、文件数、expect() 调用数
bun run test:coverage 2>&1 | grep 'All files'  # 获取函数与行覆盖率
```
- **三语 README 徽章**（Tests 与 Coverage 徽章数值）；
- **覆盖率矢量图**：`public/coverage_light.svg` 与 `public/coverage_dark.svg`；
- **三语 README 中的 `<img alt>` 说明文本**；
- **三语本文档中的「当前文档版本实测」段落**。

---

## 发布

发布新版本必须遵循完整的发布保障流程，产出携带跨平台原生二进制包的 GitHub Release：

1. **版本确定与门禁核验**：
   - 同步远端 Git tags，通过 `gh release list` 获取当前的 Latest Release；
   - 确定递增的语义化版本号，不带 `v` 前缀（格式为 `MAJOR.MINOR.PATCH`）；
   - 在 `dev` 分支完成开发并通过 `bun run check`，必要时运行 `bun run test:fault-injection`。
2. **更新性能基准读数**：
   - 停止本地服务进程及其他高负载任务，确保机器处于空闲状态；
   - 运行 `bun run perf:full -- --write-doc`，将三份语言的 `10-performance.md` 与 `performance-result.json` 同步至最新实测读数，并与代码变更一同提交到 `dev`。
3. **逐平台原生构建**：
   - 目标平台涵盖 `RELEASE_PLATFORMS` 声明的平台（`linux-x64`、`linux-arm64`、`linux-x64-musl`、`linux-arm64-musl`）；
   - 在各原生操作系统环境中，检出干净的对应提交并运行 `bun run release:build -- --version <tag>`；
   - 收集各平台生成的发行包与 `.sha256` 校验文件至同一汇总目录中。
4. **发行包完整性校验**：
   - 在干净的工作树下校验汇总目录中的所有二进制资产：
     ```bash
     bun run release:verify -- --version <tag> --platforms <逗号分隔的平台列表> --directory <汇总目录>
     ```
   - 脚本将逐一核对各包的 SHA-256 哈希、版本、目标架构、依赖完整性以及是否存在泄露的 `.map` 或 `node_modules`。
5. **合入主干与打标签**：
   - 检查工作树差异，通过 `git merge --squash` 将 `dev` 合入 `master` 并提交，确保 Git tree 哈希与构建时一致；
   - 推送 `master` 分支，并在该提交上创建并推送附注式版本标签（annotated version tag）。
6. **创建 Release 并公开**：
   - 编写英文 Release 说明，明确 Highlights、Compatibility / Migration Notes 及测试覆盖率数据；
   - 运行发布脚本创建草稿、上传资产、下载复验并正式公开为 Latest：
     ```bash
     bun run release:publish -- --version <tag> --platforms <逗号分隔的平台列表> --notes-file <说明文件> --directory <汇总目录>
     ```
7. **对齐开发分支**：
   - 确认 Release 发布无误后，检查 `git diff dev master --quiet` 确认代码一致；
   - 在 `dev` 分支执行 `git reset --hard master`，并通过 `git push --force-with-lease origin dev` 强推对齐。

---

<div align="center">

[← 上一页：04 权威约束](04-invariants.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#05-开发流程与质量门禁) · [下一页：06 修改配方 →](06-modification-guide.md)

</div>
