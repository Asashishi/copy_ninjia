<div align="center">

<p><b>简体中文</b> · <a href="docs/en/README.md">English</a> · <a href="docs/ja/README.md">日本語</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/banner_dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="public/banner_light.jpg">
  <img alt="Copy Ninjia Banner" src="public/banner_light.jpg" width="100%">
</picture>

<h1>
  <a href="https://t.me/copy_ninjia_bot" title="点击头像跳转至示例 Bot"><img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="44" height="44" alt="Copy Ninjia 示例 Bot 头像"></a>
  Copy Ninjia
</h1>

<p><sub>点击头像即可跳转至示例 Bot：<a href="https://t.me/copy_ninjia_bot">@copy_ninjia_bot</a></sub></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/tagline_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="public/tagline_light.svg">
  <img alt="会偷头像、会复读、会看图、会守群，还会一本正经损人的 Telegram 群聊机器人" src="public/tagline_light.svg" width="780">
</picture>

**生产代码、测试与文档均由 AI 编写的纯 AI 开发项目** — 人类负责架构设计，并与 AI 共同审查每一次提交

<p align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-v1.4+-f9f1e1?style=flat-square&logo=bun&logoColor=000000" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/Database-SQLite-003b57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite"></a>
  <a href="https://grammy.dev/"><img src="https://img.shields.io/badge/Telegram-grammY-26a5e4?style=flat-square&logo=telegram&logoColor=white" alt="grammY"></a>
  <a href="https://ai.google.dev/"><img src="https://img.shields.io/badge/AI-Gemini-8e75ff?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini"></a>
  <a href="https://platform.openai.com/docs/"><img src="public/openai_badge.svg" alt="OpenAI"></a>
</p>

<p align="center">
  <a href="#-纯-ai-开发"><img src="https://img.shields.io/badge/Code-100%25_AI--written-e91e63?style=flat-square" alt="100% AI-written"></a>
  <a href="#-纯-ai-开发"><img src="https://img.shields.io/badge/Audits-Fable--5.1_/_Gpt--6--astra-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="docs/cn/05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-4531_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="docs/cn/05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-98.03%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="LICENSES/LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

复读与人格模仿只是表面；其下是一套由多个 Worker 协作、支持故障恢复、采用有界缓存并具备竞态防护的群聊自动化系统。

---

🧬 [纯 AI 开发](#-纯-ai-开发) • ✨ [它能做什么](#-它能做什么) • 🎮 [命令与权限](#-命令与权限) • 🚀 [快速开始](#-快速开始) • 🤖 [BotFather 配置](#botfather-setup) • ❓ [常见问题](docs/cn/10-faq.md) • 📚 [开发者文档](docs/cn/content-table.md)

</div>

---

## 🧬 纯 AI 开发

这个仓库里的每一行生产代码、每一个测试用例，连同这份 README 本身，都出自 AI 之手。人类不写代码，但从未离席：负责架构设计，并和 AI 一起审查了每一次提交。

<table width="100%">
<tr><th width="18%" align="left">环节</th><th width="32%" align="left">由谁完成</th><th width="50%" align="left">做了什么</th></tr>
<tr><td>📐&nbsp;架&#8288;构&#8288;设&#8288;计</td><td><b>Asashishi</b></td><td>系统边界、Worker 拆分、持久化与恢复策略的设计与裁决</td></tr>
<tr><td>⌨️&nbsp;编&#8288;码&#8288;实&#8288;现</td><td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td><td>100% 的生产代码、测试与文档</td></tr>
<tr><td>🧾&nbsp;提&#8288;交&#8288;审&#8288;查</td><td><b>Asashishi</b> × AI</td><td>每一次提交都经人类与 AI 共同审查后才落库</td></tr>
<tr><td>🔬&nbsp;全&#8288;仓&#8288;审&#8288;查</td><td><b>Fable-5.1</b> · <b>Gpt-6-astra</b> 等尖端模型</td><td>多轮全仓代码交叉审查，发现的问题直接转化为加固提交</td></tr>
<tr><td>🛰️&nbsp;安&#8288;全&#8288;推&#8288;演</td><td>同一批尖端模型</td><td>推演生产环境中的安全场景：崩溃恢复、并发竞态、恶意输入、资源耗尽等逐一过审</td></tr>
</table>

审查不是一次性仪式：从逐条提交的人机共审，到尖端模型的多轮全仓审查与安全推演，每一层结论都会转化为新的约束。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🧪 项目质量

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="public/coverage_light.svg">
    <img alt="bun run test:coverage：4531 项测试全部通过 / 389 个测试文件 / 158,942 次 expect() 调用 / 函数覆盖率 97.23% / 行覆盖率 98.03%" src="public/coverage_light.svg" width="780">
  </picture>
</p>

性能基准（冷热路径 · 总吞吐与总读写 · 端到端链路耗时）见 **[📊 09 性能基准](docs/cn/09-performance.md)**。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## ✨ 它能做什么

<table width="100%">
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🪞 精准复读</b><br>
  <sub>锁定一个目标后，逐条复读 TA 的消息并同步头像。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌐 多语翻译</b><br>
  <sub>在本群开一个翻译会话，把消息翻成五种目标语言。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🥷 偷头像</b><br>
  <sub>只把对方的头像换到自己身上，不进入复读状态。</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🤖 AI 群聊</b><br>
  <sub>这一轮开不开口、说什么、用什么工具都由人设决定。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>👁️ 多模态与创作</b><br>
  <sub>看得懂图片和语音，也能画图、写歌发回群里。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🔎 实时查证</b><br>
  <sub>需要事实时自己联网检索，也能查天气等实时信息。</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🧠 群聊记忆</b><br>
  <sub>保留逐字上下文，超出部分压成摘要接着聊。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🎭 心情与拟人化</b><br>
  <sub>心情会自己轮换，回话前还带一段打字停顿。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>💒 群友抽取</b><br>
  <sub>从发过言的群友里随机抽一位，并展示 TA 的头像。</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🛡️ 入群验证</b><br>
  <sub>新成员要在限时内点按钮，超时自动踢出。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🚨 Anti-Raid</b><br>
  <sub>入群频率异常时自动切私密模式，收回邀请权限。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>📮 广告检测</b><br>
  <sub>把连续消息串起来送检，命中广告立即删除并处置。</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🎲 今日运势</b><br>
  <sub>Inline Mode 抽签，同一个人当天结果固定不变。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌐 跨群管理</b><br>
  <sub>一条命令在已接管的多个群里同步封禁同一身份。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>💬 群问答</b><br>
  <sub>预先登记的问题命中后直接作答，不经过 AI。</sub></p>
</td>
</tr>
</table>

每项功能的行为细节、配置与边界见 **[📚 开发者文档](docs/cn/content-table.md)**。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🎮 命令与权限

命令按入口授权：**群成员**可用复读、动作命令、安静模式和 `/info` 资料查询；**身份权限键**控制 `/bot_status`、`/prompt`、`/clear_context`、`/mute`、`/gag`、`/block` 和功能开关。**`SUPER_ADMIN_USER_ID` 专属**包括 `/init`、权限修改、删除白名单成员、`/batch_kick`；`/white enable` 可按 `isCanWhiteOther` 委托。`/send` 仅超级管理员私聊可用。

群专属 AI 提示词由 `/prompt config <提示词>` 设置，`/prompt remove` 恢复 `prompt/persona.md`；两者受默认关闭的 `isCanConfigAiPrompt` 控制。`/bot_status` 可查看当前群是否已设置。

复读目标全局唯一，`/copy` 系列在发起命令的群里逐条复读并同步头像；`/luck_challenge` 走 Inline Mode，中文动作命令（`/咬`、`/揪住`）不需要预先登记。

`/wed` 在已初始化的群里仅支持个人身份，随机抽取群友并展示头像及确认、更换、移除按钮。每群最多保存 15 万个已发言成员 ID，实际增删后批量写入 `memory/wed/<chatId>.json`，重启恢复候选；结果会话只保存在内存中。命令与按钮全局最多同时处理 32 项，出站复用统一队列和 429 等待。

`/h_image` 从随机图片目录（`state.json` 的 `global.assets.randomImageDir`，缺省为数据根下的 `images/`，启动时自动创建）均匀抽一张图发到本群，图片长期保留；只认 `jpg`、`jpeg`、`png`、`webp`，放图不用重启；持有 `isCanAddHImage` 的身份回复带图的消息发 `/h_image add`，可以直接把图（相册则整组）收进图库。

完整命令表、权限口径与每条命令的行为细节见 **[📖 08 命令与行为参考](docs/cn/08-commands.md)**。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🚀 快速开始

需要 Linux（带可读的 `/proc`；实例锁在其他平台 fail closed）、一个 Bot Token 与一个超级管理员用户 ID。源码安装需要 Bun 1.4.2，二进制发行包自带运行时；启用 AI 能力还需要对应 provider 的 API Key，`/translate` 另需 Google Cloud 服务账号 JSON。硬件参考见 [07 运维手册](docs/cn/07-operations.md#硬件参考)。

一键安装（缺什么装什么，问完配置直接启动）：

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

新安装会询问源码或二进制方式，也可把末尾改为 `bash -s -- --binary` 或 `bash -s -- --source`。二进制方式直接下载 **GitHub Latest Release** 的当前平台包与 SHA-256 文件，不检出源码、不在安装机打包；源码方式取得该 tag 并安装锁定依赖。已有部署保持当前版本。两种方式都转交目标目录的安装器，交互配置 Telegram 与 AI、初始化缺少的身份数据库，再注册或复用 systemd unit 并观察运行状态；无 systemd 时以前台运行。既有配置仅在明确重填时经备份、校验和原子替换更新。平台、目录参数与备份留存规则见 [环境搭建](docs/cn/01-getting-started.md)。

手工安装：

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
mkdir -p config
for example in config_example/*.json; do   # 只补缺失的示例；g-auth.json、cron.json 只示意写法，不复制
  case "${example##*/}" in g-auth.json | cron.json) ;; *) cp -n "$example" config/ ;; esac
done                                       # 填好 telegram.json 的 bot_token 与 super_admin_user_id
bun run check                          # 项目规约 + ESLint + TypeScript 严格检查 + 覆盖率测试 + 热路径门禁
bun run start                          # 启动长轮询
```

手工安装时首次启动前还要初始化身份数据库、在 BotFather 侧关闭 Privacy Mode 并开启 Inline Mode（完整清单见 [BotFather 与群权限配置](#botfather-setup)）。
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
| ❓ **常见问题** | 机器人在运行却没有回复时的排查清单 | [📖 10 常见问题](docs/cn/10-faq.md) |

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

<a id="botfather-setup"></a>

## 🤖 BotFather 与群权限配置

### BotFather 设置

| 设置 | 在 @BotFather 中 | 用途 |
| :--- | :--- | :--- |
| 关闭群隐私模式 | `/setprivacy` → Disable | 收到群里的普通消息；复读、翻译、AI 记忆与插话、群问答都依赖它。改完要把机器人移出群再拉回才生效；机器人是群管理员时本来就能收到全部消息 |
| 开启 Inline Mode | `/setinline` | 今日运势 `@机器人 所求事项`，以及 `/gag` 目标的「发言」按钮 |
| 内联结果反馈 100% | `/setinlinefeedback` | 运势结果确认与落盘的主路径 |
| 允许加入群组 | `/setjoingroups` → Enable（默认开启） | 能把机器人拉进群 |
| Bot-to-Bot Communication Mode（可选） | 机器人设置中开启 | `/translate` 或 `/copy` 的目标是另一个机器人时需要，见下方说明 |

命令菜单不需要在 BotFather 里 `/setcommands`：机器人启动时自动注册，配置了自定义人设的群会换成普通版菜单。菜单只在群聊里显示；私聊只接受超级管理员的 `/send`，因此不显示菜单。

> **关于 Bot-to-Bot**：Telegram 默认不把其他机器人的消息推给本机器人；对方开启这个模式时，也只有回复本机器人或 `/命令@本机器人` 的消息能送达，所以翻译另一个机器人会时有时无。本机器人开启后，在它是管理员或已关闭隐私模式的群里会收到其他机器人的全部消息，而 AI 插话、复读、广告检测与刷屏计数不区分发送者是不是机器人：群里若有会自动接话的机器人，两边可能互相回复，开启前先确认。

### 群内管理员权限

把机器人设为群管理员，并按要用的功能勾选：

| 管理员权限 | 用到它的功能 |
| :--- | :--- |
| 删除消息 | `/gag`、广告检测删除广告、删除黑名单频道身份的发言 |
| 限制与封禁成员 | 入群验证踢人、防冲群私密模式、`/block enable|disable`、`/mute`、`/unmute`、`/batch_kick`、刷屏禁言、广告处置封禁 |

入群验证还依赖管理员身份本身：Telegram 只向管理员机器人推送成员进出事件。缺权限时，机器人的提示会点名缺的是哪一项；持有 `isCanViewBotStatus` 的身份可用 `/bot_status` 查看本群已授予的权限。

机器人在运行却没有回复时，按 [10 常见问题](docs/cn/10-faq.md) 逐条排查。

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/footer_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="public/footer_light.svg">
  <img alt="Copy Ninjia — 不是只会复读，是把整套群聊现场偷走再演一遍。" src="public/footer_light.svg" width="580">
</picture>

*人类没有写下任何一行代码，但也从未退场——画完图纸之后，还和 AI 一起审过每一次提交。*

</div>
