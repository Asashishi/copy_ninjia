<div align="center">

<p><b>简体中文</b> · <a href="README.en.md">English</a> · <a href="README.ja.md">日本語</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner_dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner_light.jpg">
  <img alt="Copy Ninjia Banner" src="docs/assets/banner_light.jpg" width="100%">
</picture>

<h1>
  <a href="https://t.me/copy_ninjia_bot"><img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="44" height="44" alt="Copy Ninjia Bot 头像"></a>
  Copy Ninjia
</h1>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tagline_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/tagline_light.svg">
  <img alt="会偷头像、会复读、会看图、会守群，还会一本正经损人的 Telegram 群聊机器人" src="docs/assets/tagline_light.svg" width="780">
</picture>

**生产代码、测试与文档均由 AI 编写的纯 AI 开发项目** — 人类负责架构设计，并与 AI 共同审查每一次提交

<p align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-v1.3+-f9f1e1?style=flat-square&logo=bun&logoColor=000000" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://grammy.dev/"><img src="https://img.shields.io/badge/Telegram-grammY-26a5e4?style=flat-square&logo=telegram&logoColor=white" alt="grammY"></a>
  <a href="https://ai.google.dev/"><img src="https://img.shields.io/badge/AI-Gemini-8e75ff?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini"></a>
</p>

<p align="center">
  <a href="#-纯-ai-开发"><img src="https://img.shields.io/badge/Code-100%25_AI--written-e91e63?style=flat-square" alt="100% AI-written"></a>
  <a href="#-纯-ai-开发"><img src="https://img.shields.io/badge/Audits-Fable_5_/_GPT--5.6-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="docs/05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-896_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="docs/05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-96.67%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

复读与人格模仿只是表面；其下是一套由多个 Worker 协作、支持故障恢复、采用有界缓存并具备竞态防护的群聊自动化系统。

---

🧬 [纯 AI 开发](#-纯-ai-开发) • ✨ [它能做什么](#-它能做什么) • 🎭 [复读模式](#-复读模式) • 🎮 [命令与权限](#-命令与权限) • 🚀 [快速开始](#-快速开始) • 📚 [开发者文档](docs/README.md)

</div>

---

## 🧬 纯 AI 开发

这个仓库里的每一行生产代码、每一个测试用例，连同这份 README 本身，都出自 AI 之手。人类不写代码，但从未离席：负责架构设计，并和 AI 一起审查了每一次提交。

<table width="100%">
<tr><th width="14%" align="left">环节</th><th width="32%" align="left">由谁完成</th><th width="54%" align="left">做了什么</th></tr>
<tr><td>📐&nbsp;架构设计</td><td><b>Asashishi</b>（本项目唯一的人类）</td><td>系统边界、Worker 拆分、持久化与恢复策略的设计与裁决</td></tr>
<tr><td>⌨️&nbsp;编码实现</td><td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td><td>100% 的生产代码、测试与文档</td></tr>
<tr><td>🧾&nbsp;提交审查</td><td><b>Asashishi</b> × AI</td><td>每一次提交都经人类与 AI 共同审查后才落库</td></tr>
<tr><td>🔬&nbsp;全仓审查</td><td><b>Fable 5</b> · <b>GPT-5.6（Sol）</b> 等尖端模型</td><td>多轮全仓代码交叉审查，发现的问题直接转化为加固提交</td></tr>
<tr><td>🛰️&nbsp;安全推演</td><td>同一批尖端模型</td><td>推演生产环境中的安全场景：崩溃恢复、并发竞态、恶意输入、资源耗尽等逐一过审</td></tr>
</table>

审查不是一次性仪式：从逐条提交的人机共审，到尖端模型的多轮全仓审查与安全推演，每一层结论都会转化为新的约束。

### 🧪 项目质量

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/coverage_light.svg">
    <img alt="bun run test:coverage：896 项测试全部通过 / 123 个测试文件 / 8,479 次 expect() 调用 / 函数覆盖率 94.81% / 行覆盖率 96.67%" src="docs/assets/coverage_light.svg" width="780">
  </picture>
</p>

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## ✨ 它能做什么

<table width="100%">
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🪞 精准复读</b></p>
  <p>锁定用户或频道后逐条复读，支持原样、反转、追加「喵~」和日语翻译四种模式。</p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🥷 偷头像</b></p>
  <p><code>/copy</code> 自动同步目标头像，或通过 <code>/steal_icon</code> 仅复制头像而不启动复读状态。</p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🤖 AI 群聊</b></p>
  <p>基于 Gemini 人设进行智能回复，集成实时搜索与工具调用，统一处理文字、贴纸、反应等交互。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>👁️ 多模态与生图</b></p>
  <p>支持识别图片、动态贴纸和 GIF 帧，能按需生成新图片或对现有素材进行智能编辑。</p>
</td>
<td align="left" valign="top">
  <p><b>🧠 群聊记忆</b></p>
  <p>滚动维护有界逐字上下文与多轮压缩摘要，追踪有界多层回复链，并通过原子落盘可靠恢复。</p>
</td>
<td align="left" valign="top">
  <p><b>🛡️ 入群验证</b></p>
  <p>提供新成员 90 秒限时按钮验证；真人只能本人点击，机器人账号仅允许白名单用户代点担保，并支持可归属的非匿名管理员邀请免验和评论区感知。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🚨 Anti-Raid</b></p>
  <p>监测入群频率，达到阈值后关闭群组邀请并处置异常入群成员，重启后可恢复状态。</p>
</td>
<td align="left" valign="top">
  <p><b>🎲 今日运势</b></p>
  <p>采用 Inline Mode 实现确定性抽签，通过每日轮换的 HMAC 签名密钥保证重启后状态与签名回执一致。</p>
</td>
<td align="left" valign="top">
  <p><b>🌐 跨群管理</b></p>
  <p><code>/kick</code> 可在机器人已知且具备管理权限的所有群中联动封禁目标，形成一体化群组防线。</p>
</td>
</tr>
</table>

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🎭 复读模式

复读目标是全局唯一的：同一实例同时只能「变成」一个目标，但复读只发生在发起命令的群中。`/stop_copy` 可在任意群停止当前复读。

| 命令 | 行为 |
| :---: | :--- |
| `/copy` | 原样复读 |
| `/r_copy` | 按字素簇反转纯文本 |
| `/nya_copy` | 在纯文本末尾追加「喵~」 |
| `/ja_copy` | 使用 Google Cloud Translate 翻译为日语后复读 |
| `/steal_icon` | 只复制头像 |
| `/stop_copy` | 停止全局复读状态 |

目标可通过「回复 TA 的消息」或 `@username` 指定。按用户名查找依赖机器人此前观察到该账号；改名、移除用户名或用户名换绑会立即使旧别名失效。匿名管理员以当前群身份发言时，复读目标就是当前群，因而可取得群头像并复读这层「皮套」；`/kick` 会拒绝把当前群身份当作成员目标。对 `/kick` 这类破坏性操作，优先回复目标消息，不要依赖历史用户名。普通用户执行 copy 类命令时受 5 分钟全局冷却限制，`PRIVILEGED_USERS_ID` 白名单不受限。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🎮 命令与权限

<table width="100%">
<tr><th width="26%" align="left">命令</th><th width="19%" align="center">权限</th><th width="55%" align="left">说明</th></tr>
<tr><td><code>/copy</code> <code>/r_copy</code> <code>/nya_copy</code> <code>/ja_copy</code></td><td align="center">群成员</td><td>启动相应复读模式</td></tr>
<tr><td><code>/stop_copy</code></td><td align="center">群成员</td><td>停止当前全局复读</td></tr>
<tr><td><code>/steal_icon</code></td><td align="center">群成员</td><td>只偷头像</td></tr>
<tr><td><code>/&lt;单个中文字&gt;</code></td><td align="center">群成员</td><td>动作命令，如 <code>/咬</code> 回复「发起人 咬了 目标！」；姓名用 first_name last_name 形式，有公开用户名的一方挂上主页链接</td></tr>
<tr><td><code>/quiet [1-15]</code></td><td align="center">群成员</td><td>暂停随机插话、随机复读等主动行为，默认 3 分钟</td></tr>
<tr><td><code>/unquiet</code></td><td align="center">群成员</td><td>提前解除安静模式</td></tr>
<tr><td><code>/kick</code></td><td align="center"><code>PRIVILEGED_USERS_ID</code></td><td>在所有机器人管理的群中永久封禁目标</td></tr>
<tr><td><code>/ai_chat enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>开关本群 AI 闲聊</td></tr>
<tr><td><code>/switch_mood</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>为已开启 AI 闲聊的群立即重抽当前心情，并在 Worker 明确回执后回复新心情名</td></tr>
<tr><td><code>/ja_copy enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>开关本群日语翻译能力（默认关闭）</td></tr>
<tr><td><code>/init enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>开关本群的业务处理总入口</td></tr>
<tr><td><code>/send &lt;群组 ID&gt;</code> <code>/send finish</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code>（仅私聊）</td><td>在机器人私聊中开始或结束中转；期间超级管理员发送的每条消息都会原样转发到目标群一次</td></tr>
</table>

`/send` 开启前会先探测目标是否可达；中转期间目标失联时会自动终止并通知超级管理员。中转状态随 `state.json` 持久化，重启后仍可恢复。该命令不进入 Telegram 命令菜单；在群内调用或由其他用户触发时均不响应。

> [!TIP]
> 单字中文动作命令（`/咬`、`/摸`……）不需要预先登记：任意一个中文字都能用，目标同样通过「回复 TA 的消息」或 `@username` 指定。Telegram 的命令名只收 ASCII（只能用拉丁字母、数字、下划线），因此这类命令既不出现在命令菜单里、也不会有输入补全——菜单里只放了一条占位说明项 `/x`——命令名 `x` 就是那个变量，提示把它换成任意一个中文字；它本身不做任何处理，点了不会有反应，也不会被当成普通消息进入 AI/复读流水线；`/咬人` 这种多字写法不算动作命令，会按普通消息处理。正因为不需要登记、谁都能随手造一个，它采用全局滑动窗口限流，每 90 秒最多应答 450 次，不分群、不分用户合并计数；超额直接静默丢弃，不回提示。

> [!TIP]
> `/luck_challenge` 不是斜杠命令：在任意聊天输入 `@机器人用户名 [所求事项]` 即可使用 Inline Mode。需在 BotFather 中开启 Inline Mode，并建议通过 `/setinlinefeedback` 开启 100% 结果反馈。内联查询采用全局滑动窗口限流，每 90 秒最多应答 300 次。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🚀 快速开始

### 1. 环境

- Linux（带可读的 `/proc`；实例锁在其他平台 fail closed）
- Bun 1.3+
- Telegram Bot Token
- Gemini API Key
- Google Cloud 服务账号 JSON（仅 `/ja_copy` 需要）

<details>
<summary><b>📦 硬件配置参考</b>（按部署规模展开）</summary>

<table width="100%">
<tr><th width="33%" align="left">部署规模</th><th width="26%" align="left">建议配置</th><th width="41%" align="left">说明</th></tr>
<tr><td>入门（低活跃、文本为主、仅少量群开启 AI）</td><td>2 vCPU / 2 GB RAM / 本地 SSD</td><td>可以运行，但媒体高峰时多个 Worker 可能争用 CPU</td></tr>
<tr><td>轻量生产（文本为主、仅少量群开启 AI）</td><td>4 vCPU / 2 GB RAM / 本地 SSD</td><td>不建议用 2 GB 内存承载媒体处理高峰</td></tr>
<tr><td>推荐生产（约 15 个 1,000～3,000 人活跃群）</td><td>4 vCPU / 4 GB RAM / 本地 SSD</td><td>—</td></tr>
<tr><td>全部群开启 AI 且图片、贴纸较多</td><td>4 vCPU / 8 GB RAM</td><td>给媒体下载、Base64 编码和图片转码预留峰值空间</td></tr>
</table>

单实例仍建议控制在约 15 个上述规模的活跃群以内；主要限制来自单个 Telegram Bot API、Gemini 配额和实际消息/媒体速率，而不是群成员总数。

</details>

### 2. 安装

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
cp .env.example .env
```

### 3. 配置

按 [`.env.example`](.env.example) 填写 `.env`：`TELEGRAM_BOT_TOKEN`、`GEMINI_API_KEY` 和表示单个十进制用户 ID 的 `SUPER_ADMIN_USER_ID` 必填；`PRIVILEGED_USERS_ID` 可留空，多项之间用英文逗号分隔。

`COPY_NINJIA_DATA_ROOT` 可选，用于单独指定运行时数据根目录。设置后，`state.json`、`bot.lock`、`logs/` 和 `memory/` 都从该目录派生；人设、贴纸/反应/心情配置与 `g-auth.json` 仍从项目根目录读取。留空时，运行时数据直接位于项目根目录。

如需日语翻译，将 Google Cloud 服务账号密钥保存为项目根目录的 `g-auth.json`。`.env` 与 `g-auth.json` 均已加入 `.gitignore`。

Telegram 侧还需要按功能配置：

1. 关闭 Bot Privacy Mode，机器人才能观察完整群消息并复读普通成员。
2. 授予删消息、封禁成员、管理群权限，入群验证和 Anti-Raid 才会启用。
3. 启用 Inline Mode 才能使用运势抽签。
4. 建议把 inline feedback 设为 100%，让 `chosen_inline_result` 作为抽签确认与落盘的主路径。

### 4. 启动与检查

```bash
bun run check     # 项目规约 + ESLint + TypeScript 严格检查 + 覆盖率测试
bun run start     # 启动长轮询
```

机器人首次加入群聊后，由 `SUPER_ADMIN_USER_ID` 在群内执行：

```text
/init enable
/ai_chat enable
```

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 📚 开发者文档与架构指南

Copy Ninjia 的架构总览、模块导览、运行时权威约束、测试流程与运维手册，集中收录在 **[开发者文档中心](docs/README.md)**：

| 专题领域 | 描述与包含内容 | 快捷入口 |
| :--- | :--- | :---: |
| 🏗️ **架构总览** | 主线程与 3 个 Worker 协作拓扑、消息旅程与启动/停机顺序 | [📖 02 架构总览](docs/02-architecture.md) |
| 🗺️ **源码导览** | `packages/` 各子领域的职责分工与代码放置决策树 | [📖 03 目录导览](docs/03-directory-map.md) |
| ⚡ **权威约束** | 跨模块状态隔离、并发硬顶、持久化与防竞态契约 | [📖 04 权威约束](docs/04-invariants.md) |
| 🧪 **开发与测试** | `bun run check` 质量门禁、测试沙盒与故障注入套件 | [📖 05 开发流程](docs/05-dev-workflow.md) |
| 🛠️ **修改配方** | 新增命令、调参、新增 AI 工具与 Schema 迁移指南 | [📖 06 修改配方](docs/06-modification-guide.md) |
| 🛡️ **运维手册** | systemd 部署、`COPY_NINJIA_DATA_ROOT`、备份与排障 | [📖 07 运维手册](docs/07-operations.md) |

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/footer_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/footer_light.svg">
  <img alt="Copy Ninjia — 不是只会复读，是把整套群聊现场偷走再演一遍。" src="docs/assets/footer_light.svg" width="580">
</picture>

*人类没有写下任何一行代码，但也从未退场——画完图纸之后，还和 AI 一起审过每一次提交。*

</div>
