<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/tagline_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/tagline_light.svg">
  <img alt="Copy Ninjia Tagline" src="assets/tagline_light.svg" width="780">
</picture>

# 📚 Copy Ninjia 开发者文档

<p align="center">
  <b>简体中文</b> · <a href="en/README.md">English</a> · <a href="ja/README.md">日本語</a> · <a href="../README.md">🏠 根目录 README</a>
</p>

面向开发者的完整多页指南：从环境搭建、架构设计、工程规范，到功能扩展与运维排障。

</div>

---

## 🧭 开发者快速导航

| 目标场景 | 推荐路径 | 直达链接 |
| :--- | :--- | :---: |
| 🚀 **首次运行** | 依赖安装、`.env` 配置、Telegram API 权限及首次启动 | [📖 01 环境搭建](01-getting-started.md) |
| 🏗️ **理解架构** | 主线程与 3 个 Worker 协作模型、消息生命周期及持久化恢复 | [📖 02 架构总览](02-architecture.md) |
| 🗺️ **查找代码** | 模块职责分工、源码目录映射及新代码放置约定 | [📖 03 目录导览](03-directory-map.md) |
| ⚡ **遵守不变量** | 跨模块权威约束、并发防护与全局状态机规则 | [📖 04 权威约束](04-invariants.md) |
| 🧪 **开发与测试** | `bun run check` 质量门禁、测试隔离机制与覆盖率口径 | [📖 05 开发流程](05-dev-workflow.md) |
| 🛠️ **新增/修改功能** | 添加命令、调参、新增 AI 工具及 schema 变更的分步指南 | [📖 06 修改配方](06-modification-guide.md) |
| 🛡️ **生产运维** | systemd 部署、`COPY_NINJIA_DATA_ROOT`、备份与故障排查 | [📖 07 运维手册](07-operations.md) |

---

## 📑 页面清单与核心内容

1. **[01 环境搭建与首次运行](01-getting-started.md)**
   - 基础依赖 (Bun 1.3+ / Linux / Bot Token / Gemini API Key)
   - `.env` 配置文件说明与必填字段
   - Telegram BotFather 配置（Privacy Mode / Admin 权限 / Inline Mode）
   - 首次启动与机器人入群后的 `/init enable` 握手流程

2. **[02 架构总览](02-architecture.md)**
   - 1 个主线程 (Main Thread) + 3 个 Worker (AI / Anti-Raid / Disk I/O) 的多线程协作模型
   - 一条 Telegram update 从接收、校验、分发到 Worker 响应的完整旅程
   - 进程启动与优雅退出的全串行刷新屏障 (Flush Barrier)

3. **[03 目录导览与代码放置](03-directory-map.md)**
   - `packages/` 目录下各子领域的清晰职责边界
   - 「代码该放哪」的决策树：常量、类型、缓存、状态转移与 Worker
   - 向后兼容入口的收敛与导出规则

4. **[04 运行时权威约束](04-invariants.md)**
   - 跨模块与跨生命周期的权威不变量（源码 `@see` 注释指向此处）
   - 启动与 import 边界：启动顺序、可选凭据降级、数据根、出站请求与消息安全
   - Worker 与状态所有权：线程归属、状态机契约、AI 闲聊运行时、入群验证与终态处置、刷屏禁言与自身权限缓存
   - 持久化：落盘与快照契约、黑名单与广告检测、确认边界与停机、文件权限

5. **[05 开发流程与质量门禁](05-dev-workflow.md)**
   - `bun run check` 4 级串行流水线：规范检查 + Lint + Typecheck + 带覆盖率统计的全量测试
   - 测试环境隔离机制与临时数据根沙盒
   - 提交规范与发布前故障注入测试 `bun run test:fault-injection`

6. **[06 常见修改配方](06-modification-guide.md)**
   - 配方 1：新增 Telegram 斜杠命令
   - 配方 2：调整系统硬顶参数或超时时间
   - 配方 3：扩展 Gemini AI 自定义工具函数
   - 配方 4：修改配置 schema 或持久化数据结构（手动迁移策略）
   - 非目标：不做 i18n，换语言请 fork

7. **[07 运维与排障](07-operations.md)**
   - 生产环境推荐硬件配置与部署指南
   - `COPY_NINJIA_DATA_ROOT` 目录能力校验（fsync / hard link / rename）
   - 备份与恢复（`memory/luck/receipt-secret.json` 密钥一致性）
   - 常见启动失败与 `bot.lock` 单实例锁故障排查

---

## 📝 文档维护约定

- **三语同步**：中文文档保留在 `docs/`，英文镜像在 `docs/en/`，日文镜像在 `docs/ja/`。修改架构或数值时需同步更新三语版本。
- **单点维护**：跨模块不变量仅在 [04 权威约束](04-invariants.md) 维护一份，其他文档引用链接，不复述内容。
- **常量引用**：参数数值的权威来源是 `packages/consts/`，文档尽量引用常量名及路径。

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/footer_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/footer_light.svg">
  <img alt="Copy Ninjia Footer" src="assets/footer_light.svg" width="580">
</picture>

</div>
