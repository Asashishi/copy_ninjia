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
| `bun run release:check` | frozen lockfile 安装 + check + 故障注入，发布前必跑 |
| `bun run audit:release` | 依赖漏洞审计（moderate 及以上） |

## 质量门禁的口径

- **覆盖率分母是全源码**：`bun run check` 让所有生产运行时模块进入分母，未被任何测试触达的模块按 0% 计入；函数与行覆盖率门槛均为 90%。这意味着新增模块不写测试会直接拉低全局覆盖率。
- **eslint + tsc 全严格**：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` 全开；生产代码禁 `any`（测试文件豁免）。
- **约定自检**：`check:conventions` 检查放置约定类问题，先于 lint 运行。

## 测试隔离机制

测试必须通过 `bun run test`（即 `bun test --isolate`）执行，两层保护：

1. **文件隔离**：Bun 为每个测试文件创建新的 global object；`mock.module` 与模块级状态不会污染其它测试文件。这里没有启用 `--parallel`，因此不宣称每个文件各占一个进程。
2. **临时数据根**：`test/preload.ts` 在任何生产模块加载前为每个隔离体注入独立临时数据根，因此未 mock 的真实文件 I/O 也只会读写临时目录，绝不触碰生产 `state.json`、`bot.lock`、`logs/`、`memory/`；结束后临时目录被清理。

直接 `bun test` 单文件调试可以，但合并前必须过完整 `bun run check`。

### 写测试的约定

- 路径镜像 `src/`：`src/foo/bar.ts` → `test/foo/bar.test.ts`。
- 公共辅助在 `test/libs/helpers.ts`；不要在测试间共享可变模块状态（隔离机制会掩盖这类错误直到有人不用 `--isolate` 运行）。
- 触发真实文件 I/O 的测试可以放心写——preload 的临时数据根兜底；但涉及 `infra/storage` 的测试注意 mock 边界（只 mock `infra/diskIO` 而漏掉 `infra/storage` 会调到真实 `saveStateInBackground`，这正是 [`AGENTS.md`](../AGENTS.md) 要求先备份运行时文件的场景）。

## 故障注入套件

`bun run test:fault-injection` 重点回归崩溃恢复与持久化边界：生命周期失败、update runner 确认边界、StateStore 与清理、AI/Anti-Raid Worker 的镜像恢复与生命周期、Disk I/O 的追加/快照/日志文件、flush barrier 等（完整清单见 [`package.json`](../package.json) 的脚本定义）。改动 [04 运行时权威约束](04-invariants.md) 涉及的路径时，本套件必须绿。

## 提交流程

1. 开发中用户可能随手改参——编辑前重读文件，别覆盖未提交的现场改动。
2. 提交前 `git diff --stat` 全量过一遍，无关文件不混进本次提交。
3. `bun run check` 全绿。
4. 提交信息用 conventional commits 风格（`feat(ai): ...`、`fix(runtime): ...`、`docs: ...`），主题行英文。
5. 每次提交经人机共同审查后才落库（项目惯例，见根 README「纯 AI 开发」节）。

### 同步 README 指标

根 README 的测试数/断言数/覆盖率是实测值；测试、生产模块或覆盖率口径变化后按此更新：

```bash
bun run test:coverage 2>&1 | tail -5        # 测试数、文件数、expect() 调用数
bun run test:coverage 2>&1 | grep 'All files'  # 函数/行覆盖率
```

需要同步的位置：徽章行（Tests / Coverage）、「开发」节的统计条与「当前主干实测」列表项。README 中引用的行为数值（概率、容量、时长）与 `src/consts/` 保持一致，见 [06 常见修改配方](06-modification-guide.md#调整行为参数)。

## 发布

本仓库不依赖 GitHub Actions。发布环境把 `bun run release:check` 作为显式构建或 pre-deploy 步骤；联网环境追加 `bun run audit:release`（网络失败只表示审计未完成，不等于零漏洞；忽略 CVE 要记录原因与到期时间）。包含持久化结构变更的版本，先走 [06 常见修改配方](06-modification-guide.md#变更持久化-schema) 的迁移流程。

---

<div align="center">

[← 上一页：04 权威约束](04-invariants.md) · [📚 开发者文档首页](README.md) · [⬆️ 回到顶部](#05-开发流程与质量门禁) · [下一页：06 修改配方 →](06-modification-guide.md)

</div>
