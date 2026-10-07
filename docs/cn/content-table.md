<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../public/tagline_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../public/tagline_light.svg">
  <img alt="Copy Ninjia Tagline" src="../../public/tagline_light.svg" width="780">
</picture>

# 📚 Copy Ninjia 开发者文档

<p align="center">
  <b>简体中文</b> · <a href="../en/content-table.md">English</a> · <a href="../ja/content-table.md">日本語</a> · <a href="../../README.md">🏠 根目录 README</a>
</p>

面向开发者的完整多页指南：从环境搭建、架构设计、工程规范，到功能扩展与运维排障。

</div>

---

## 🧭 开发者快速导航

<table width="100%">
<thead>
  <tr>
    <th width="24%" align="left">目标场景</th>
    <th width="44%" align="left">推荐路径</th>
    <th width="32%" align="center">直达链接</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🚀 <b>首次运行</b></nobr></td>
    <td>环境依赖、配置填写、Telegram 权限配置与快速启动</td>
    <td align="center"><nobr><a href="01-getting-started.md">📖 01 环境搭建</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🏗️ <b>理解架构</b></nobr></td>
    <td>主线程与 3 个 Worker 的分工、消息处理链路与数据恢复机制</td>
    <td align="center"><nobr><a href="02-architecture.md">📖 02 架构总览</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🗺️ <b>查找代码</b></nobr></td>
    <td>目录结构、模块分工与新增代码的归属约定</td>
    <td align="center"><nobr><a href="03-directory-map.md">📖 03 目录导览</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>遵守不变量</b></nobr></td>
    <td>跨模块核心约束、并发防护与全局状态机规则</td>
    <td align="center"><nobr><a href="04-invariants.md">📖 04 权威约束</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🧪 <b>开发与测试</b></nobr></td>
    <td><code>bun run check</code> 质量门禁、测试沙盒隔离机制与覆盖率要求</td>
    <td align="center"><nobr><a href="05-dev-workflow.md">📖 05 开发流程</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛠️ <b>新增/修改功能</b></nobr></td>
    <td>添加新命令、调整参数、新增 AI 工具或修改数据结构的操作指南</td>
    <td align="center"><nobr><a href="06-modification-guide.md">📖 06 修改配方</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>生产运维</b></nobr></td>
    <td>systemd 配置、硬件选型、数据根目录规范、备份与故障排查</td>
    <td align="center"><nobr><a href="07-operations.md">📖 07 运维手册</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🖼️ <b>图库与定时任务</b></nobr></td>
    <td>图库收录、内容去重、定时图文与语音推送、时区配置</td>
    <td align="center"><nobr><a href="08-images-and-cron.md">📖 08 图库与定时任务</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🎮 <b>命令查阅</b></nobr></td>
    <td>全部命令列表、权限要求与详细行为说明（根目录 README 仅提供简述）</td>
    <td align="center"><nobr><a href="09-commands.md">📖 09 命令参考</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>📊 <b>性能基准</b></nobr></td>
    <td>冷启动、高频热路径、端到端耗时与吞吐量的基准测试结果</td>
    <td align="center"><nobr><a href="10-performance.md">📖 10 性能基准</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>❓ <b>排障指引</b></nobr></td>
    <td>当机器人已启动但没有回复消息时的逐项排查步骤</td>
    <td align="center"><nobr><a href="11-faq.md">📖 11 常见问题</a></nobr></td>
  </tr>
</tbody>
</table>

---

## 📑 页面清单与核心内容

1. **[01 环境搭建与首次运行](01-getting-started.md)**
   - 基础依赖要求（Bun 1.4.2 / Linux 系统 / Telegram Bot Token / AI 模型 API Key）
   - `install.sh` 自动化安装向导与手动源码安装步骤
   - `config/static/bot.json` 等配置文件的说明与校验规则
   - Telegram 机器人设置（隐私模式、管理员权限、内联模式与 Bot 间通信）
   - 首次启动与入群后通过 `/init enable` 激活服务的流程

2. **[02 架构总览](02-architecture.md)**
   - 1 个主线程 (Main Thread) 与 3 个专用 Worker (AI / Anti-Raid / Disk I/O) 的多线程协作模型
   - Telegram 消息从拉取、校验、安全过滤到业务分发的完整生命周期
   - 启动加载与停机排空的全流程串行刷新屏障 (Flush Barrier)

3. **[03 目录导览与代码放置](03-directory-map.md)**
   - `packages/` 目录下各业务模块的清晰职责分工
   - 源码存放指南：常量、类型、缓存、纯状态机与 Worker 代码的归属规则
   - 顶层统一导出与兼容约定的边界

4. **[04 运行时权威约束](04-invariants.md)**
   - 跨模块与生命周期的核心不变量约定（源码中的 `@see` 注释统一指向本页）
   - 启动与 import 边界：时区绑定、启动时校验、数据根目录规范、出站安全
   - Worker 与状态所有权：单线程独占原则、纯状态机契约、AI 对话机制、入群验证与防冲群处置
   - 数据持久化：SQLite 事务、状态快照、黑名单与广告风控、停机确认机制

5. **[05 开发流程与质量门禁](05-dev-workflow.md)**
   - `bun run check` 集成门禁：安装脚本检查 + 沙盒验证 + 规范自检 + 代码规范 + 类型检查 + 测试覆盖率 + 乱序测试 + 热路径基准
   - 测试环境隔离机制与独立临时数据根沙盒
   - 提交流程、故障注入测试（`bun run test:fault-injection`）与发布构建指南

6. **[06 常见修改配方](06-modification-guide.md)**
   - 添加新的斜杠命令（含中文动作命令）、富文本消息排版指南
   - 调整系统行为参数、修改人设与 JSON 配置文件
   - 新增 AI 工具能力与调用第三方 API 的规范
   - 添加运行时缓存与修改 Worker 间通信协议的步骤
   - 修改持久化数据结构（冷迁移策略）
   - 多语言说明：本项目不做国际化，修改文案请直接 fork

7. **[07 运维与排障](07-operations.md)**
   - 部署形态与硬件选型参考（入门、生产到高负载）
   - 使用 systemd 托管或直接运行预编译二进制包
   - 数据根目录规范（`COPY_NINJIA_DATA_ROOT`）与目录文件权限控制
   - 身份数据库初始化、冷迁移与版本升级步骤
   - 常见启动故障排查（单实例文件锁、数据格式不符等）

8. **[08 图库与定时任务](08-images-and-cron.md)**
   - 本地图库目录规范、群内自动收图与哈希去重
   - 定时发送单张图片、相册轮播、随机图与语音推送的配置
   - Cron 表达式、时区指定与发送目标群控制

9. **[09 命令与行为参考](09-commands.md)**
   - 复读模式、偷头像与目标指定方式
   - 完整命令列表与权限矩阵（群成员 / 权限键授权 / 超级管理员专属）
   - 禁言（`/mute`）、口球管教（`/gag`）、跨群拉黑（`/block`）、群友老婆（`/wed`）、群问答（`/qa`）等功能的详细运行逻辑

10. **[10 性能基准](10-performance.md)**
    - 基准测试报告：冷启动、高频热路径函数、端到端处理耗时与持久化性能
    - 多轮运行的均值、最小值、最大值与变异系数统计
    - 运行期间的系统 I/O 读写与吞吐量实测数据

11. **[11 常见问题](11-faq.md)**
    - 机器人运行中无响应的排查清单：群初始化、隐私模式、AI 触发条件、私聊限制、自删消息规则与权限缺失
    - 常见运维疑问：切换通知语气、图库报错、定时任务行为与自定义人设配置

---

## 📝 文档维护约定

- **三语同步**：中文文档位于 `docs/cn/`，英文镜像位于 `docs/en/`，日文镜像位于 `docs/ja/`。修改架构设计或技术数值时需同步更新对应文档。
- **单点权威**：跨模块不变量仅在 [04 权威约束](04-invariants.md) 中统一维护，其他页面仅提供引用链接，避免信息多处维护导致不一致。
- **参数来源**：参数与数值的最终权威来源为 `packages/consts/`，文档中优先引用具体的常量名称。

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../public/footer_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../public/footer_light.svg">
  <img alt="Copy Ninjia Footer" src="../../public/footer_light.svg" width="580">
</picture>

</div>
