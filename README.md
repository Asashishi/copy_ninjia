<div align="center">

<p><b>简体中文</b> · <a href="docs/en/README.md">English</a> · <a href="docs/ja/README.md">日本語</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="pictures/banner_dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="pictures/banner_light.jpg">
  <img alt="Copy Ninjia Banner" src="pictures/banner_light.jpg" width="100%">
</picture>

<h1>
  <a href="https://t.me/copy_ninjia_bot" title="点击头像跳转至示例 Bot"><img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="44" height="44" alt="Copy Ninjia 示例 Bot 头像"></a>
  Copy Ninjia
</h1>

<p><sub>点击头像即可跳转至示例 Bot：<a href="https://t.me/copy_ninjia_bot">@copy_ninjia_bot</a></sub></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="pictures/tagline_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="pictures/tagline_light.svg">
  <img alt="会偷头像、会复读、会看图、会守群，还会一本正经损人的 Telegram 群聊机器人" src="pictures/tagline_light.svg" width="780">
</picture>

**生产代码、测试与文档均由 AI 编写的纯 AI 开发项目** — 人类负责架构设计，并与 AI 共同审查每一次提交

<p align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-v1.4+-f9f1e1?style=flat-square&logo=bun&logoColor=000000" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/Database-SQLite-003b57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite"></a>
  <a href="https://grammy.dev/"><img src="https://img.shields.io/badge/Telegram-grammY-26a5e4?style=flat-square&logo=telegram&logoColor=white" alt="grammY"></a>
  <a href="https://ai.google.dev/"><img src="https://img.shields.io/badge/AI-Gemini-8e75ff?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini"></a>
  <a href="https://platform.openai.com/docs/"><img src="pictures/openai_badge.svg" alt="OpenAI"></a>
</p>

<p align="center">
  <a href="#-纯-ai-开发"><img src="https://img.shields.io/badge/Code-100%25_AI--written-e91e63?style=flat-square" alt="100% AI-written"></a>
  <a href="#-纯-ai-开发"><img src="https://img.shields.io/badge/Audits-Fable_5_/_GPT--5.6_/_Opus_5-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="docs/cn/05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-2581_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="docs/cn/05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-96.62%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

复读与人格模仿只是表面；其下是一套由多个 Worker 协作、支持故障恢复、采用有界缓存并具备竞态防护的群聊自动化系统。

---

🧬 [纯 AI 开发](#-纯-ai-开发) • ✨ [它能做什么](#-它能做什么) • 🎮 [命令与权限](#-命令与权限) • 🚀 [快速开始](#-快速开始) • 📚 [开发者文档](docs/cn/conntent-table.md)

</div>

---

## 🧬 纯 AI 开发

这个仓库里的每一行生产代码、每一个测试用例，连同这份 README 本身，都出自 AI 之手。人类不写代码，但从未离席：负责架构设计，并和 AI 一起审查了每一次提交。

<table width="100%">
<tr><th width="18%" align="left">环节</th><th width="32%" align="left">由谁完成</th><th width="50%" align="left">做了什么</th></tr>
<tr><td>📐&nbsp;架&#8288;构&#8288;设&#8288;计</td><td><b>Asashishi</b>（本项目唯一的人类）</td><td>系统边界、Worker 拆分、持久化与恢复策略的设计与裁决</td></tr>
<tr><td>⌨️&nbsp;编&#8288;码&#8288;实&#8288;现</td><td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td><td>100% 的生产代码、测试与文档</td></tr>
<tr><td>🧾&nbsp;提&#8288;交&#8288;审&#8288;查</td><td><b>Asashishi</b> × AI</td><td>每一次提交都经人类与 AI 共同审查后才落库</td></tr>
<tr><td>🔬&nbsp;全&#8288;仓&#8288;审&#8288;查</td><td><b>Fable 5</b> · <b>GPT-5.6（Sol）</b> · <b>Opus 5</b> 等尖端模型</td><td>多轮全仓代码交叉审查，发现的问题直接转化为加固提交</td></tr>
<tr><td>🛰️&nbsp;安&#8288;全&#8288;推&#8288;演</td><td>同一批尖端模型</td><td>推演生产环境中的安全场景：崩溃恢复、并发竞态、恶意输入、资源耗尽等逐一过审</td></tr>
</table>

审查不是一次性仪式：从逐条提交的人机共审，到尖端模型的多轮全仓审查与安全推演，每一层结论都会转化为新的约束。

### 🧪 项目质量

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="pictures/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="pictures/coverage_light.svg">
    <img alt="bun run test:coverage：2581 项测试全部通过 / 271 个测试文件 / 95,642 次 expect() 调用 / 函数覆盖率 95.23% / 行覆盖率 96.62%" src="pictures/coverage_light.svg" width="780">
  </picture>
</p>

性能基准（冷热路径 · 总吞吐与总读写 · 端到端链路耗时）见 **[📊 09 性能基准](docs/cn/09-performance.md)**。

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
  <p>基于人设自主决策：发言、贴纸、表情反应、生图、写歌都是工具，由模型自行决定这一轮做几件事、按什么顺序做。模型层是可替换的 provider：<code>config/agent.json</code> 按能力各自声明 <code>google</code> 或 <code>openai</code>，能力之间不继承、也不做运行时故障切换。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>👁️ 多模态与创作</b></p>
  <p>识别图片、动态贴纸、GIF 帧与语音消息（逐字转写进上下文），能按需生成新图片或对现有素材智能编辑；Gemini 侧还能按点歌写一首带人声的完整歌曲，连封面一起发进群。</p>
</td>
<td align="left" valign="top">
  <p><b>🔎 实时查证</b></p>
  <p>接入 Google 搜索与东京天气等工具；查证过的轮次自动压低采样温度，让回答照着搜索结果讲。</p>
</td>
<td align="left" valign="top">
  <p><b>🧠 群聊记忆</b></p>
  <p>滚动维护有界逐字上下文与多轮压缩摘要，追踪有界多层回复链，并通过原子落盘可靠恢复。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🎭 心情与拟人化</b></p>
  <p>群心情每 2~4 小时随机轮换，权重受东京天气与时段影响；发言前按字数模拟打字停顿，偶尔还会打错字再补正。</p>
</td>
<td align="left" valign="top">
  <p><b>🛡️ 入群验证</b></p>
  <p>新成员 3 分钟限时按钮验证：真人只能本人点击，机器人账号仅限白名单代点担保；可归属的非匿名管理员邀请与关联频道评论区活动免验。每群缺省关闭，<code>/antiraid enable</code> 打开。</p>
</td>
<td align="left" valign="top">
  <p><b>🚨 Anti-Raid</b></p>
  <p>监测入群频率，达到阈值后关闭群组邀请并处置异常入群成员，重启后可恢复状态。与入群验证合用 <code>/antiraid</code> 这一个开关。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>📮 广告检测</b></p>
  <p>按发送者归并消息串持续送检，交配置的广告检测模型判定；非受保护身份命中后按 <code>/block</code> 同权处置，并在触发群播报封禁理由。</p>
</td>
<td align="left" valign="top">
  <p><b>🎲 今日运势</b></p>
  <p>采用 Inline Mode 实现确定性抽签，通过每日轮换的 HMAC 签名密钥保证重启后状态与签名回执一致。</p>
</td>
<td align="left" valign="top">
  <p><b>🌐 跨群管理</b></p>
  <p><code>/block</code> 一条命令即可在所有管理群联动封禁并写入持久化黑名单，之后进任何监听群都会被秒踢；新接管的群还会自动补扫。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>💬 群问答</b></p>
  <p><code>/set_qa</code> 用两按钮表单登记问答，每群最多 5 条。有人一字不差地问出来就直接答，不经过 AI；意思相近但字面不同的问法才交给模型的两个查询工具判断。</p>
</td>
<td align="left" valign="top"></td>
<td align="left" valign="top"></td>
</tr>
</table>

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🎮 命令与权限

命令分四档：**群成员**（复读、动作命令、安静模式、`/bot_status` 等）、**白名单权限键**（`/mute`、`/gag`、`/block`、各功能开关）、**`SUPER_ADMIN_USER_ID` 专属**（`/init`、`/white`、`/permission`、`/batch_kick`），以及只在私聊生效的 `/send`。

复读目标全局唯一，`/copy` 系列在发起命令的群里逐条复读并同步头像；`/luck_challenge` 走 Inline Mode，中文动作命令（`/咬`、`/揪住`）不需要预先登记。

完整命令表、权限口径与每条命令的行为细节见 **[📖 08 命令与行为参考](docs/cn/08-commands.md)**。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🚀 快速开始

需要 Linux（带可读的 `/proc`；实例锁在其他平台 fail closed）、Bun 1.4+、一个 Bot Token 与一个超级管理员用户 ID；启用 AI 能力还需要对应 provider 的 API Key，`/ja_copy` 另需 Google Cloud 服务账号 JSON。硬件参考见 [07 运维手册](docs/cn/07-operations.md#硬件参考)。

一键安装（缺什么装什么，问完配置直接启动）：

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

只做三件事：配好环境（补齐 `git`/`curl`/`unzip`、clone 仓库到 `./copy_ninjia`、装 Bun、`bun install`）、交互问 Telegram 与 AI 配置、建空身份数据库后启动。不注册 systemd、不动既有配置，重跑安全。已经 clone 过就在仓库根跑 `bash install.sh`，会跳过 clone。

手工安装：

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
mkdir -p config
cp -n config_example/*.json config/   # 填好 telegram.json 的 bot_token 与 super_admin_user_id
bun run check                          # 项目规约 + ESLint + TypeScript 严格检查 + 覆盖率测试 + 热路径门禁
bun run start                          # 启动长轮询
```

手工安装时首次启动前还要初始化身份数据库、在 BotFather 侧关闭 Privacy Mode 并开启 Inline Mode。
配置逐项含义、必填关系与严格校验规则见 [`config_example/README/zh.md`](config_example/README/zh.md)，
完整步骤（含运行时数据根、素材直链与迁移命令）见 [01 环境搭建与首次运行](docs/cn/01-getting-started.md)。

机器人首次加入群聊后，由 `SUPER_ADMIN_USER_ID` 在群内执行：

```text
/init enable
/ai_chat enable
/antiraid enable
```

> **关于语言**：机器人面向用户的文案只有简体中文，仓库不维护 i18n。理由与改法见 [06 修改配方](docs/cn/06-modification-guide.md)。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 📚 开发者文档与架构指南

Copy Ninjia 的架构总览、模块导览、运行时权威约束、测试流程与运维手册，集中收录在 **[开发者文档中心](docs/cn/conntent-table.md)**：

| 专题领域 | 描述与包含内容 | 快捷入口 |
| :--- | :--- | :---: |
| 🏗️ **架构总览** | 主线程与 3 个 Worker 协作拓扑、消息旅程与启动/停机顺序 | [📖 02 架构总览](docs/cn/02-architecture.md) |
| 🗺️ **源码导览** | `packages/` 各子领域的职责分工与代码放置决策树 | [📖 03 目录导览](docs/cn/03-directory-map.md) |
| ⚡ **权威约束** | 跨模块状态隔离、并发硬顶、持久化与防竞态契约 | [📖 04 权威约束](docs/cn/04-invariants.md) |
| 🧪 **开发与测试** | `bun run check` 质量门禁、测试沙盒与故障注入套件 | [📖 05 开发流程](docs/cn/05-dev-workflow.md) |
| 🛠️ **修改配方** | 新增命令、调参、新增 AI 工具与 Schema 迁移指南 | [📖 06 修改配方](docs/cn/06-modification-guide.md) |
| 🛡️ **运维手册** | systemd 部署、硬件参考、`COPY_NINJIA_DATA_ROOT`、备份与排障 | [📖 07 运维手册](docs/cn/07-operations.md) |
| 🎮 **命令参考** | 全部命令、权限口径与行为细节 | [📖 08 命令与行为参考](docs/cn/08-commands.md) |
| 📊 **性能基准** | 发布时重跑的冷热路径、吞吐、读写与链路耗时读数 | [📖 09 性能基准](docs/cn/09-performance.md) |

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="pictures/footer_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="pictures/footer_light.svg">
  <img alt="Copy Ninjia — 不是只会复读，是把整套群聊现场偷走再演一遍。" src="pictures/footer_light.svg" width="580">
</picture>

*人类没有写下任何一行代码，但也从未退场——画完图纸之后，还和 AI 一起审过每一次提交。*

</div>
