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

<p align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-v1.4+-f9f1e1?style=flat-square&logo=bun&logoColor=000000" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/Database-SQLite-003b57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite"></a>
  <a href="https://grammy.dev/"><img src="https://img.shields.io/badge/Telegram-grammY-26a5e4?style=flat-square&logo=telegram&logoColor=white" alt="grammY"></a>
  <a href="https://ai.google.dev/"><img src="https://img.shields.io/badge/AI-Gemini-8e75ff?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini"></a>
  <a href="https://platform.openai.com/docs/"><img src="pictures/openai_badge.svg" alt="OpenAI"></a>
</p>

<p align="center">
  <a href="docs/cn/05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-3495_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="docs/cn/05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-97.37%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

复读与人格模仿只是表面；其下是一套由多个 Worker 协作、支持故障恢复、采用有界缓存并具备竞态防护的群聊自动化系统。

---

✨ [它能做什么](#-它能做什么) • 🎮 [命令与权限](#-命令与权限) • 🚀 [快速开始](#-快速开始) • 📚 [开发者文档](docs/cn/content-table.md)

</div>

---

## 🧪 项目质量

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="pictures/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="pictures/coverage_light.svg">
    <img alt="bun run test:coverage：3495 项测试全部通过 / 345 个测试文件 / 125,930 次 expect() 调用 / 函数覆盖率 97.17% / 行覆盖率 97.37%" src="pictures/coverage_light.svg" width="780">
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
  <p>基于人设自主决策：发言、贴纸、表情反应、生图、写歌都是工具，由模型自行决定这一轮做几件事、按什么顺序做；生图与写歌工具只在群友直接 @ 或回复机器人时按配置能力开放。模型层是可替换的 provider：<code>config/agent.json</code> 按能力各自声明 <code>google</code> 或 <code>openai</code>，能力之间不继承、也不做运行时故障切换。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>👁️ 多模态与创作</b></p>
  <p>识别图片、动态贴纸、GIF 帧与语音消息（逐字转写进上下文），能按需生成新图片或对现有素材智能编辑；Gemini 侧还能按点歌写一首带人声的完整歌曲，连封面一起发进群。</p>
</td>
<td align="left" valign="top">
  <p><b>🔎 实时查证</b></p>
  <p>接入 provider 服务端联网检索与东京天气等工具；固定查证规则要求时效事实先检索、结果优先于记忆，证据不足时明确不确定。Gemini 在已查证的后续工具轮使用较低采样温度。</p>
</td>
<td align="left" valign="top">
  <p><b>🧠 群聊记忆</b></p>
  <p>滚动维护有界逐字上下文与多轮压缩摘要，保留消息中的回复关系、转发来源和精确引用，并通过原子落盘可靠恢复。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🎭 心情与拟人化</b></p>
  <p>群心情每 2~4 小时随机轮换，权重受东京天气与时段影响；发言前按字数模拟打字停顿，偶尔还会打错字再补正。</p>
</td>
<td align="left" valign="top">
  <p><b>🛡️ 入群验证</b></p>
  <p>新成员 3 分钟限时按钮验证：「我是良民」只能本人点击，「通过」只能由本群非匿名管理员代点（机器人账号只有这一条路）；可归属的非匿名管理员邀请与关联频道评论区活动免验。每群缺省关闭，<code>/antiraid enable</code> 打开。</p>
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
  <p><code>/set_qa</code> 开一张表单，由发起者按「问题:」「回答:」分两条消息登记问答，每群最多 15 条，答案里可以直接塞 <code>```json</code> 代码块。有人一字不差地问出来就直接答，不经过 AI；意思相近但字面不同的问法才交给模型的两个查询工具判断。</p>
</td>
<td align="left" valign="top"></td>
<td align="left" valign="top"></td>
</tr>
</table>

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🎮 命令与权限

命令分四档：**群成员**（复读、动作命令、安静模式、`/bot_status` 等）、**白名单权限键**（`/mute`、`/gag`、`/block`、各功能开关）、**`SUPER_ADMIN_USER_ID` 专属**（`/init`、`/white`、`/permission`、`/batch_kick`），以及只在私聊生效的 `/send`。

复读目标全局唯一，`/copy` 系列在发起命令的群里逐条复读并同步头像；`/luck_challenge` 走 Inline Mode，中文动作命令（`/咬`、`/揪住`）不需要预先登记。

`/wed` 在已初始化的群里仅支持个人身份，随机抽取群友并展示头像及确认、更换、移除按钮。每群最多保存 15 万个已发言成员 ID，实际增删后批量写入 `memory/wed/<chatId>.json`，重启恢复候选；结果会话只保存在内存中。命令与按钮全局最多同时处理 32 项，出站复用统一队列和 429 等待。

完整命令表、权限口径与每条命令的行为细节见 **[📖 08 命令与行为参考](docs/cn/08-commands.md)**。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🚀 快速开始

需要 Linux（带可读的 `/proc`；实例锁在其他平台 fail closed）、Bun 1.4.2、一个 Bot Token 与一个超级管理员用户 ID；启用 AI 能力还需要对应 provider 的 API Key，`/ja_copy` 另需 Google Cloud 服务账号 JSON。硬件参考见 [07 运维手册](docs/cn/07-operations.md#硬件参考)。

一键安装（缺什么装什么，问完配置直接启动）：

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

安装器取得 **GitHub Latest Release** 后，转交目标工作树自己的脚本；已有工作树保持 checkout 不变。它按目标代码校验 Bun 精确版本并安装锁定依赖，然后交互配置 Telegram 与 AI、初始化缺少的身份数据库。既有配置仅在明确重填时经备份、校验和原子替换更新。最后注册或复用 systemd unit 并观察运行状态；无 systemd 时以前台运行。目录参数与备份留存规则见 [环境搭建](docs/cn/01-getting-started.md)。

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

Copy Ninjia 的架构总览、模块导览、运行时权威约束、测试流程与运维手册，集中收录在 **[开发者文档中心](docs/cn/content-table.md)**：

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
