# 05 开发流程与质量门禁

<p align="center">
  <b>简体中文</b> · <a href="en/05-dev-workflow.md">English</a> · <a href="ja/05-dev-workflow.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 开发者文档首页</a> · <a href="04-invariants.md">← 上一页：04 权威约束</a> · <a href="06-modification-guide.md">下一页：06 修改配方 →</a>
</p>

---

## 命令速查

| 命令 | 作用 |
| :--- | :--- |
| `bun run start` | 启动长轮询 |
| `bun run lint` / `lint:fix` | ESLint 检查 / 自动修复 |
| `bun run typecheck` | `tsc --noEmit`，全严格模式 |
| `bun run test` | 全量测试（强制文件隔离） |
| `bun run test:coverage` | 测试 + 全源码覆盖率 |
| `bun run check:conventions` | 仓库约定自检（`scripts/checkProjectConventions.ts`） |
| `bun run check` | conventions + lint + typecheck + coverage，**提交前必跑** |
| `bun run test:fault-injection` | 确定性故障注入套件 |
| `bun run perf:join-log` | 25 万项入群日志容量/快照的独立进程对照基准 |
| `bun run release:check` | frozen lockfile 安装 + check + 故障注入，发布前必跑 |
| `bun run audit:release` | 依赖漏洞审计（moderate 及以上） |

## 质量门禁的口径

- **覆盖率分母是全源码**：`bun run check` 让所有生产运行时模块进入分母，未被任何测试触达的模块按 0% 计入；函数与行覆盖率门槛均为 90%。这意味着新增模块不写测试会直接拉低全局覆盖率。
- **eslint + tsc 全严格**：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` 全开；生产代码禁 `any`（测试文件豁免）。
- **显式类型标注由 lint 把守**：生产代码（`index.ts`、`packages/`、`scripts/`）的变量、形参、解构由 `@typescript-eslint/typedef` 强制标注，函数与回调的返回类型由 `@typescript-eslint/explicit-function-return-type` 强制，两者都不接受上下文推导。`for...of` / `for...in` 的循环变量 TS 语法不允许标注，规则自动跳过；初始化器已是箭头函数的 const 也放行。测试文件不受此约束。
- **约定自检**：`check:conventions` 检查代码放置、本地 Markdown 链接与 tracked 非脚本文件的可执行权限，先于 lint 运行。

### 当前文档版本实测

`bun run test:coverage`：**1679 tests / 172 files / 30519 次 `expect()`**；全源码**函数覆盖率 95.56% / 行覆盖率 96.63%**。根 README 的 Coverage 徽章展示行覆盖率。

## 测试隔离机制

测试必须通过 `bun run test`（即 `bun test --isolate`）执行，三层保护：

1. **文件隔离**：Bun 为每个测试文件创建新的 global object；`mock.module` 与模块级状态不会污染其它测试文件。这里没有启用 `--parallel`，因此不宣称每个文件各占一个进程。
2. **临时数据根**：`test/preload.ts` 在任何生产模块加载前为每个隔离体注入独立临时数据根，因此未 mock 的真实文件 I/O 也只会读写临时目录，绝不触碰生产 `state.json`、`bot.lock`、`logs/`、`memory/`；结束后临时目录被清理。
3. **只读配置根**：同一份 preload 还把 `COPY_NINJIA_CONFIG_ROOT` 指向仓库内的 `config_example/`（见 `packages/consts/paths.ts` 的 `CONFIG_ROOT`）。部署 `config/` 不受版本控制，这一层既保证干净检出即可跑测试，也避免测试与测试 Worker 误读或改写开发机上真实的 `whitelist.json`、`blocklist.json`。该环境变量只服务于测试，不是部署开关，因此不列入 README 的环境变量表。

直接 `bun test` 单文件调试可以，但合并前必须过完整 `bun run check`。

### 写测试的约定

- 路径镜像 `packages/`：`packages/foo/bar.ts` → `test/foo/bar.test.ts`。
- 公共辅助在 `test/libs/helpers.ts`；不要在测试间共享可变模块状态（隔离机制会掩盖这类错误直到有人不用 `--isolate` 运行）。
- 触发真实文件 I/O 的测试可以放心写——preload 的临时数据根兜底；但涉及 `infra/storage` 的测试注意 mock 边界（只 mock `infra/diskIO` 而漏掉 `infra/storage` 会调到真实 `saveStateInBackground`，这正是 [`AGENTS.md`](../AGENTS.md) 要求先备份运行时文件的场景）。

## 故障注入套件

`bun run test:fault-injection` 重点回归崩溃恢复与持久化边界：生命周期失败、update runner 确认边界、StateStore 与清理、AI/Anti-Raid Worker 的镜像恢复与生命周期、Disk I/O 的追加/快照/日志文件、flush barrier 等（完整清单见 [`package.json`](../package.json) 的脚本定义）。改动 [04 运行时权威约束](04-invariants.md) 涉及的路径时，本套件必须绿。

## 入群日志性能基准

`bun run perf:join-log` 固定使用 250,000 条容量、300 条溢出和 10,000 条预热输入；快照与容量路径的 baseline/current 各运行 5 个独立 Bun 进程。输出记录完整 Bun version/revision、耗时的中位数与范围，以及强制 GC 前后的 JSC heap/object 变化。baseline 固化的是分配优化前的整表复制、全量排序与完整 JSON 字符串算法，只用于同一 Bun build 内的前后对照；`Bun.gc(true)` 只存在于该基准，不进入生产控制流。改动入群索引、容量裁剪、快照序列化或分块原子写时必须运行，并确认差异明显大于 5 轮样本范围所显示的噪声。

## 提交流程

1. 开发在 `dev` 分支上进行，不直接提交 `master`；合并进 `master` 只用 squash，一次改动一个提交。分支约定见 [`AGENTS.md`](../AGENTS.md) 的「分支与提交」，此处不重复。
2. 开发中用户可能随手改参——编辑前重读文件，别覆盖未提交的现场改动。
3. 提交前 `git diff --stat` 全量过一遍，无关文件不混进本次提交。
4. `bun run check` 全绿。
5. 提交信息用 conventional commits 风格（`feat(ai): ...`、`fix(runtime): ...`、`docs: ...`），主题行英文。
6. 每次提交经人机共同审查后才落库（项目惯例，见根 README「纯 AI 开发」节）。

### 同步 README 指标

根 README 徽章与上方测试数/断言数/覆盖率是实测值；测试、生产模块或覆盖率口径变化后按此更新：

```bash
bun run test:coverage 2>&1 | tail -5        # 测试数、文件数、expect() 调用数
bun run test:coverage 2>&1 | grep 'All files'  # 函数/行覆盖率
```

需要同步的位置是同一组实测数值，改一处就要全部改到：

- **三语 README 的徽章行**（Tests / Coverage）。Coverage 徽章固定采用 `All files` 的行覆盖率。
- **覆盖率图**：[`docs/assets/coverage_light.svg`](assets/coverage_light.svg) 与 [`coverage_dark.svg`](assets/coverage_dark.svg)。一对图由三语 README 共用（同 banner），改动要同时落在两个主题文件的数值上。
- **三份 README 里 `<img alt>` 的等价文案**：图以图片加载，SVG 内部的 `<title>` / `aria-label` 读屏软件读不到，alt 是唯一的无障碍出口。
- **三语本文的「当前文档版本实测」**。

另有两组独立于覆盖率、同样容易悄悄过期的实测数值：

- **中文字符串统计**（当前约 641 处 / 64 个文件）：出现在三语 README 的「关于语言」注与三语 [06 常见修改配方](06-modification-guide.md) 的「不做 i18n」节。生产代码文案增删后重算：按 TypeScript AST 的字符串/模板字面量节点统计它们所在的源码行（不含注释）。别用 grep 数反引号——正则字面量里的反引号会把计数带偏。
- **行为数值**（概率、容量、时长）：README 引用的这类数字与 `packages/consts/` 保持一致，见 [06 常见修改配方](06-modification-guide.md#调整行为参数)。

## 发布

本仓库不依赖 GitHub Actions。发布环境把 `bun run release:check` 作为显式构建或 pre-deploy 步骤；联网环境追加 `bun run audit:release`（网络失败只表示审计未完成，不等于零漏洞；忽略 CVE 要记录原因与到期时间）。包含持久化结构变更的版本，先走 [06 常见修改配方](06-modification-guide.md#变更持久化-schema) 的迁移流程。

每次 squash 合并进 `master` 都要创建一个 GitHub Release：

1. 同步远端 tags，并通过 `gh release list` 读取当前 Latest Release tag。tag 严格使用不带 `v` 的 `MAJOR.MINOR.PATCH`；按本次完整改动的最高语义影响选择版本：破坏兼容升 `MAJOR`（`1.0.9` → `2.0.0`），向后兼容的新增功能升 `MINOR`（`1.0.9` → `1.1.0`），只有修复、性能、重构或文档时才升 `PATCH`（`1.0.9` → `1.0.10`）。
2. 推送 `master` squash 提交后，为该提交创建、推送不可变的 annotated version tag；已有 tag 不得覆盖、移动或复用。
3. 使用 `gh release create <tag> --verify-tag --target master ...` 创建英文 Release。Release notes 只总结上一个 Latest Release tag 到当前 `master` 的增量，至少包含 Highlights、Compatibility / Migration Notes、Validation；门禁数值使用本次真实输出。
4. tag 推送成功但 Release 创建失败时，针对同一 tag 重试，不再递增版本。只有 `master`、tag 和 Release 都确认成功后，才按 [`AGENTS.md`](../AGENTS.md) 的流程把 `dev` 对齐到 `master`。

---

<div align="center">

[← 上一页：04 权威约束](04-invariants.md) · [📚 开发者文档首页](README.md) · [⬆️ 回到顶部](#05-开发流程与质量门禁) · [下一页：06 修改配方 →](06-modification-guide.md)

</div>
