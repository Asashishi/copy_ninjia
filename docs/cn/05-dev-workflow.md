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
| `bun run lint`<br>`bun run lint:fix` | ESLint 检查 / 自动修复 | 严格检查代码规范；门禁一律用不带缓存的 `lint` |
| `bun run lint:fast` | 本地带缓存 ESLint | 带 `--cache`，仅供本地开发调试回路使用 |
| `bun run typecheck` | TypeScript 类型检查 | `tsc --noEmit --incremental`，全严格模式，增量信息缓存于 `tsconfig.tsbuildinfo` |
| `bun run test` | 全量测试 | 强制文件隔离（`bun test --isolate`） |
| `bun run test:random` | 乱序全量测试 | 固定种子的乱序全量测试，用于暴露测试间状态残留与 mock 泄漏 |
| `bun run test:coverage` | 测试 + 覆盖率 | 运行全量测试并统计全源码覆盖率指标 |
| `bun run check:install-script-syntax` | 安装脚本语法检查 | `bash -n` 解析 `install.sh` 及其声明的 shell 模块，不执行实际逻辑 |
| `bun run check:install-isolation` | 安装器隔离验证 | 在专属临时根跑真实 `install.sh` 夹具，核对回滚、中断续跑、备份保留与凭据隔离 |
| `bun run check:conventions` | 仓库约定自检 | 运行 `scripts/checkProjectConventions.ts`，验证常量、缓存归属、链接与架构边界 |
| `bun run check` | **全量集成门禁** | 语法 + 安装隔离 + 约定自检 + lint + typecheck + 覆盖率 + 乱序测试 + 热路径门禁（合入 `master` 必跑） |
| `bun run check:coverage` | 覆盖率指标对账 | 校验三语 README、文档与 SVG 徽章指标与真实读数的一致性 |
| `bun run test:fault-injection` | 确定性故障注入套件 | 验证进程崩溃、异常停机、数据库瞬断与 Worker 重生时的恢复一致性 |
| `bun run perf:hot-paths` | 热路径独立进程测量 | 测量单个热路径场景（支持 `--profile` 采样分析） |
| `bun run perf:hot-path-gate` | **热路径性能门禁** | 12 个精选热路径场景的内存/GC/JIT 硬门禁（已并入 `check`） |
| `bun run perf:join-log` | 入群日志性能基准 | 25 万项入群日志容量/快照/追加记账的独立进程对照基准 |
| `bun run perf:identity-database` | 身份数据库基准 | 身份数据库六项冷热读写的独立进程基准 |
| `bun run perf:full` | 全量性能基准套件 | 六个分区各跑三轮独立子进程（`--write-doc` 写回三语 10 性能页及 `performance-result.json`） |
| `bun run perf:review` | 专项性能复核 | 涵盖热点、AI 回复/载荷/语音编码、完整命令链与 Disk I/O Worker 压力 |
| `bun run build -- --version <tag>` | 构建二进制包 | 必须显式传入无前缀版本号，产出 `dist/` 发行包及 SHA-256 |
| `bun run release:check -- --version <tag>` | 发布前全量自检 | frozen lockfile + check + 覆盖率对账 + 故障注入 + 二进制构建验证 |
| `bun run release:build -- --version <tag>` | 正式构建发行包 | 在干净的 `dev` 分支上原生构建当前平台的二进制资产；其他平台须在对应环境分别构建 |
| `bun run release:verify -- --version <tag> --platforms <列表>` | 发行包校验 | 核对全部目标平台的包、SHA-256、版本与 Git tree 一致性 |
| `bun run release:publish -- --version <tag> --platforms <列表> --notes-file <文件>` | 发布到 GitHub | 校验远端引用，创建草稿，上传并核验资产，正式发布为 Latest |
| `bun run audit:release` | 依赖安全审计 | 扫描依赖漏洞（moderate 及以上级别） |

---

## 质量门禁的口径

- **安装启动隔离**：安装夹具使用独立临时配置与数据根，mock 系统管理、依赖安装和网络出站，执行真实 `index.ts`、Worker 与退出落盘。每个 Worker 通过 Bun `preload` 安装网络替身，天气返回固定应答，其他请求被拒绝；测试核对替身已加载、轮询成功、SIGTERM 排空和锁文件清除。
- **文件长度与扫描范围**：手写 TS、JS、shell 文件超过 1,024 行即拒绝；超过 512 行应评估拆分。检查覆盖受跟踪文件与尚未加入索引的新文件，Git 忽略的部署数据不进入扫描。安装语法检查同时覆盖 `install.sh` 和它声明的全部 shell 模块。
- **覆盖率分母是全源码**：`bun run check` 让所有生产运行时模块进入分母，未被任何测试触达的模块按 0% 计入；函数与行覆盖率门槛均为 95%。这意味着新增模块不写测试会直接拉低全局覆盖率。
- **eslint + tsc 全严格**：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` 全开；生产代码禁 `any`（测试文件豁免）。
- **类型导入独立声明**：源码、脚本和测试都使用独立 `import type`；ESLint 的 `no-restricted-syntax` 拒绝 `import { value, type Shape }` 等 inline type specifier。
- **显式类型标注由 lint 把守**：生产代码（`index.ts`、`packages/`、`scripts/`）的变量、形参、解构由 `@typescript-eslint/typedef` 强制标注，函数与回调的返回类型由 `@typescript-eslint/explicit-function-return-type` 强制，两者都不接受上下文推导。`for...of` / `for...in` 的循环变量 TS 语法不允许标注，规则自动跳过；初始化器已是箭头函数的 const 也放行。测试文件不受此约束。
- **约定自检（`check:conventions`）**：
  - **结构与链接**：检查代码放置、本地 Markdown 链接、文档点名文件存在性、tracked 文件执行权限。
  - **边界隔离**：核对常量与缓存归属（`packages/cache/<owner>/` 线程单属性边界），按真实模块图校验 Worker 与 Telegram 能力隔离。
  - **调用安全**：`packages/workers/` 内每个 timer 必须 `unref()`；检查 Node API 兼容模块与 `Buffer` 白名单；强制使用 `Bun.argv` 读取参数。
  - **门禁对账**：静态核对 Telegram 提示清理例外、当前冷迁移入口、故障注入套件清单、package.json 直接依赖声明、14 处覆盖率数字和性能记录。测试中禁止将大写常量与数字字面量比对；匹配器实参不得写出与 `packages/consts` 字符串常量逐字相同的字面量，也不得抄写其中含 6 个以上汉字或假名的文案片段（从常量或模板常量渲染出的固定片段取期望值，见 `test/helpers/templateText.ts`）。断言提示词措辞本身的契约用例按文件与用例名登记在 `scripts/conventions/testAssertionFragments.ts` 的 `CONSTANT_TEXT_CONTRACT_EXEMPTIONS`，未被命中的豁免同样报错。

---

### 依赖冷却期

依赖安装固定使用 `bunfig.toml` 的七天发布冷却期（`minimumReleaseAge = 604800`）：
- 未满七天的精确版本只有在用户知情批准并核对上游来源、npm integrity 与安装脚本后才能临时加入 `install.minimumReleaseAgeExcludes`；安装完成立即移除，并记录包名、原因与移除时间。
- 当前 Bun 运行时与 `@types/bun` 均固定为 1.4.2；`packageManager` 与 `install.sh` 共同锁定运行时版本。
- `bun run typecheck` 使用 `@typescript/native`（`npm:typescript@~7.0.2`）提供的 TypeScript 7.0.2 编译器。`typescript` 依赖使用 `npm:@typescript/typescript6@^6.0.2`，锁文件解析为 `@typescript/typescript6` 6.0.2；该包通过 `@typescript/old` 提供 TypeScript 6.0.3 编译器 API，供 ESLint 与约定检查使用。当前 `typescript-eslint` 为 8.70.1。

---

### Bun 运行边界

- **运行模式**：项目在 `bunfig.toml` 中设置 `run.bun = true`，依赖 CLI 的 Node shebang 也由当前 Bun 执行。
- **图片编解码**：使用 Bun 内置的 `Bun.Image` 处理图片转码（`packages/infra/image.ts`）：
  - JPEG/PNG 原样传递，WebP/GIF 转为 PNG 并保留透明度；GIF 取首帧，动态 WebP 取首个 `ANMF` 帧重新封装为静态 WebP 后解码。
  - 单张解码像素数上限为 `VISION_TRANSCODE_MAX_PIXELS`（8K UHD，7680×4320），超限拒绝。编解码器随 Bun 运行时提供，无需依赖原生 C++ 模块。
- **原生文件 I/O**：文件内容写入和删除优先使用 `Bun.write` 与 `Bun.file`；独占写入使用 `Bun.write(Bun.file(handle.fd), content)` 配合 fsync 与原子 rename；目录遍历、路径、同步持久化、权限与 hard link 等使用 `node:` 兼容模块。
- **性能基准校准**：运行时升级后，性能校准必须针对相同 Bun version/revision 重新实测。

---

### 当前文档版本实测

`bun run test:coverage`：**6117 tests / 515 files / 436787 次 `expect()`**；全源码**函数覆盖率 98.24% / 行覆盖率 98.69%**。三语项目 README 的 Coverage 徽章展示行覆盖率。

---

## 测试隔离机制

测试必须通过 `bun run test`（即 `bun test --isolate`）执行，享受四层全自动隔离保护：

1. **文件上下文隔离**：Bun 为每个测试文件创建全新的 global object，`mock.module` 与模块级全局状态不会跨文件污染。
2. **临时数据根注入**：`test/preloadEnv.ts` 在加载任何生产模块之前，为每个隔离体注入独立临时数据根（`mktemp -d`），真实文件 I/O 绝不触碰生产目录（`state.json`、`bot.lock`、`logs/`、`memory/`、`database/`），测试结束后自动清理。
3. **独立配置根**：将 `config_example/` 完整复制到临时数据根下的 `config/`，并通过 `COPY_NINJIA_CONFIG_ROOT` 环境变量引导程序读取测试配置副本；凭据自动替换为测试占位值。
4. **配置快照同步**：`test/preload.ts` 将测试副本中的 `agent.json`、`ad_samples.json`、`mood.json`、`stickers.json`、Bot 语气与时区以及人设一次性 adopt 进测试 isolate 的 holder，模拟主线程消息注入。

### 关键测试套件分布

- **安装与升级测试**：`test/scripts/installStartup.test.ts`、`test/scripts/installMigration.test.ts` 验证安装脚本、新库初始化与跨大版本升级流程。
- **冷迁移测试**：`test/scripts/migrateChatPersonaRemoval.test.ts` 验证只接受 16.3.2 的 schema v11 谱系、v11 → v13 数据库迁移（含 Asia/Tokyo 时区标记），以及生产启动校验对迁移前后数据库的判定。
- **媒体与出站测试**：`test/aiChat/ai/mediaAdmission.test.ts`、`test/aiChat/ai/imageDescription.test.ts` 与 `test/infra/telegramWorkerCapabilities.test.ts` 验证多模态识别与 Telegram 双工出站闸。
- **统一出站集成测试**：`test/infra/telegramOutboundIntegration.test.ts` 使用真实客户端初始化、throttler 与出站闸，仅替换最内层网络响应；验证主线程、上下文、两类 Worker 与 cron 的同群 FIFO、分类 429 重放、目标查询、默认头像与文件下载共享退避，以及取消和停机排空。
- **安全与日志测试**：`test/infra/loggerSecurity.test.ts` 验证凭据脱敏。

---

## 故障注入套件

`bun run test:fault-injection` 覆盖应用/Worker 生命周期、锁定恢复、回复容量与取消、凭据快照、Telegram 出站与延迟删除的停机排空、群 teardown、入群日志未确认镜像与处置回执、Anti-Raid 任务排空与验证恢复、双工 Worker 重建取消，以及 SQLite 启动行校验、冷迁移和 Disk I/O 的检查、原子写入与恢复故障；完整清单见 [`package.json`](../../package.json)。

- **约定核验**：`check:conventions` 对登记的 harness 和生产恢复/生命周期边界按真实引用路径检查漏列。
- **欢迎文案与通知**：`test/workers/antiRaid/verificationWelcome.test.ts` 贯通真实双工协议、主线程临时消息及删除边界。
- **`/wed` 交互状态机**：验证 25 群容量上限、teardown 取消排队、头像读取机制与停机排空。

---

## 热路径门禁

`bun run perf:hot-path-gate` 是 `bun run check` 的硬门禁。它按 `packages/consts/performance.ts` 的 `HOT_PATH_PROFILE_SCENARIOS` 逐场景启动两个独立子进程：
- `steadyProfile`：在 `BUN_JSC_logGC=1` 下测量正式循环的 GC 暂停时间占比与 JIT 层级。
- `retained`：在无 profiler 干扰下测量真实 RSS 峰值、heapUsed 波峰与 full-GC 后的内存留存。

### 门禁指标与分档

- **GC 暂停占比预算**：按可用 CPU 核心数自动分档（4 核及以上 25%，2～3 核 30%，单核 35%）。超过预算加 5 个百分点判定失败。
- **硬指标门禁**：GC 暂停时间占比、采样 RSS 峰值与生命周期 RSS 高水位、采样 heapUsed 增长、full-GC 后堆/对象留存、DFG/FTL 编译稳定性。
- **读数沉淀**：基准校准记录保存在 [`performance-result.json`](../../performance-result.json)。使用 `--write-result` 可将本次读数回写。

---

## 入群日志性能基准

`bun run perf:join-log` 固定使用 250,000 条容量、`FLUSH_MAX_ENTRIES`（256）条溢出和 10,000 条预热输入；快照（`snapshot`）、容量（`capacity`）与追加记账（`append-accounting`）三条路径的 baseline/current 各运行 5 个独立 Bun 进程，比对 checksum 并核验吞吐与堆变化。

---

## 身份数据库性能基准

`bun run perf:identity-database` 在临时数据根和临时 SQLite 中测六项真实操作：双表读（冷/热）、128 行事务写（冷/热）、主线程 8,192 项 LRU 热读以及写透链路。写透场景固定执行 65,536 次操作，工作集为 4,096 个主键。

---

## 专项场景与传输压力验证

`bun run perf:review` 用于对特定系统瓶颈进行专项深入复核：
- `--hot-paths`：覆盖发送者、消息滑窗、权限读取、AI 活跃窗口、待验证快照等 12 项场景。
- `--ai`：测量回复准入判定、正常发送、容量压力、Base64 转码与 Opus 语音编码。
- `--chains`：运行 `ad-detect-command`、`ai-reply-command` 与 `cron-send-voice` 完整命令链路。
- `--worker`：经真实 Disk I/O Worker 压测批量写入、优雅停机与 25 群恢复。
- `--cooldown` / `--text`：冷却表操作与文本清洗专项基准。冷却场景按 `STATE_MANAGED_CHAT_LIMIT` 分布身份，使用生产容量与窗口，覆盖命中、续期、建表、满载拒绝和整批到期。
- `bun run perf:disk-transport`：测量单批 ACK、正常排空与容量拒收机制。

---

## 全量性能基准

`bun run perf:full` 只在发布和明确指令时运行，不设失败阈值，把六个分区各跑三轮独立子进程再取平均：
1. **冷启动**：满库 fixture 上跑真实启动恢复耗时。
2. **生产热路径**：消息进入主干并完成分发的高频路径耗时。
3. **端到端落盘链路**：主线程触发经过 Worker 到最终落盘的回执耗时。
4. **SQLite 与主线程缓存**：数据库与 LRU 缓存交互。
5. **容器与算法**：核心状态容器与计算耗时。
6. **入群日志容量线**：25 万项规模下的入群日志处理性能。

数据全部写在仓库根的 `performance/`（自动清理），出数通过 `--write-doc` 同时写回 `docs/{cn,en,ja}/10-performance.md` 与 `performance-result.json`。

---

## 提交流程

1. **分支原则**：开发必须在 `dev` 分支进行，严禁直接提交到 `master`。
2. **提交前检查**：运行 `git diff --stat` 确认无多余文件，运行 `git branch --show-current` 确认当前分支。
3. **本地完整门禁**：合入前必须运行并通过 `bun run check`；涉及持久化、停机或 Worker 生命周期改动时，必须通过 `bun run test:fault-injection`。
4. **提交信息规范**：遵循 Conventional Commits 风格（如 `feat(ai): ...`、`fix(runtime): ...`、`docs: ...`）。

### 同步 README 指标

仅在用户明确要求同步文档或指标时，依据本次门禁的实测输出同步以下位置：
```bash
bun run test:coverage 2>&1 | tail -5          # 测试数、文件数、expect() 调用数
bun run test:coverage 2>&1 | grep 'All files'  # 函数/行覆盖率
```
- **三语 README 徽章行**（Tests / Coverage）。
- **覆盖率矢量图**：`public/coverage_light.svg` 与 `public/coverage_dark.svg`。
- **三语 README 中的 `<img alt>` 说明文本**。
- **三语本文档中的「当前文档版本实测」段落**。

---

## 发布

每次发布必须创建带二进制资产的 GitHub Release，按以下流程执行：

1. **版本与门禁**：同步远端 tags，通过 `gh release list` 读取 Latest Release，选择尚不存在的无 `v` 前缀 `MAJOR.MINOR.PATCH` tag。在 `dev` 完成开发并通过 `bun run check`；涉及持久化、停机或 Worker 生命周期时另运行 `bun run test:fault-injection`。
2. **更新基准读数**：停掉本仓库服务进程和同机其他重负载，待门禁结束、机器空闲后运行 `bun run perf:full -- --write-doc`，将三份 10 性能页与 `performance-result.json` 的读数和代码一起提交到 `dev`。
3. **逐平台原生构建**：在本次声明的**每个平台对应环境**，使用相同 Git tree 与 Bun version/revision、干净且已提交的 `dev` 运行 `bun run release:build -- --version <tag>`。每次只生成当前平台的包及 `.sha256`；收集到同一汇总目录。
4. **汇总校验**：在干净的同一 Git tree 上，按本次实际声明的完整平台列表校验汇总目录；缺少任何声明平台的资产即停止：
   ```bash
   bun run release:verify -- --version <tag> --platforms <逗号分隔的平台列表> --directory <汇总目录>
   ```
5. **合入与远端引用**：按部署保护流程检查工作树与目标差异，以 `git merge --squash` 合入 `master` 并创建单次提交，确认 Git tree 与构建时一致。依次推送 `master`，创建并单独推送该提交上的 annotated version tag。
6. **发布与确认**：用英文说明上一个 Latest 到本次的增量，并包含 Highlights、Compatibility / Migration Notes 和 Validation。执行下列命令，确认 Release 为 Latest、远端引用正确且所有声明资产下载校验通过：
   ```bash
   bun run release:publish -- --version <tag> --platforms <逗号分隔的平台列表> --notes-file <说明文件> --directory <汇总目录>
   ```
7. **对齐 `dev`**：Release 全部确认后，先以 `git diff dev master --quiet` 核对树一致，再在 `dev` 执行 `git reset --hard master` 和 `git push --force-with-lease origin dev`；最后确认本地与远端 `dev`、`master` 指向同一提交。

---

<div align="center">

[← 上一页：04 权威约束](04-invariants.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#05-开发流程与质量门禁) · [下一页：06 修改配方 →](06-modification-guide.md)

</div>
