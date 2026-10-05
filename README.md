<div align="center">

<p><b>简体中文</b> · <a href="docs/en/README.md">English</a> · <a href="docs/ja/README.md">日本語</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/banner_dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="public/banner_light.jpg">
  <img alt="Copy Ninjia Banner" src="public/banner_light.jpg" width="100%">
</picture>

<a id="copy-ninjia"></a>

<h1>
  <a href="https://t.me/copy_ninjia_bot" title="点击头像跳转至示例 Bot"><img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="44" height="44" alt="Copy Ninjia 示例 Bot 头像"></a>
  <img src="public/wordmark.svg" width="236" height="44" alt="Copy Ninjia">
</h1>

<p><sub>点击头像即可跳转至示例 Bot：<a href="https://t.me/copy_ninjia_bot">@copy_ninjia_bot</a></sub></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/tagline_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="public/tagline_light.svg">
  <img alt="会偷头像、会复读、会看图、会守群，还会一本正经损人的 Telegram 群聊机器人" src="public/tagline_light.svg" width="780">
</picture>

**生产代码、测试与文档均由 AI 编写的纯 AI 开发项目** — 人类负责架构设计，并与 AI 共同审查每一次提交

<p align="center">
  <a href="https://bun.sh/"><img src="public/bun_badge.svg" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="public/typescript_badge.svg" alt="TypeScript"></a>
  <a href="https://www.sqlite.org/"><img src="public/sqlite_badge.svg" alt="SQLite"></a>
  <a href="https://grammy.dev/"><img src="public/grammy_badge.svg" alt="grammY"></a>
  <a href="https://www.anthropic.com/"><img src="public/anthropic_badge.svg" alt="Anthropic"></a>
  <a href="https://platform.openai.com/docs/"><img src="public/openai_badge.svg" alt="OpenAI"></a>
  <a href="https://ai.google.dev/"><img src="public/gemini_badge.svg" alt="Gemini"></a>
</p>

<p align="center">
  <a href="#-纯-ai-开发"><img src="https://img.shields.io/badge/Code-100%25_AI--written-e91e63?style=flat-square" alt="100% AI-written"></a>
  <a href="#-纯-ai-开发"><img src="https://img.shields.io/badge/Audits-GPT_/_Claude-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="docs/cn/05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-6117_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="docs/cn/05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-98.69%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="LICENSES/LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

复读与人格模仿只是表面；其下是一套由多个 Worker 协作、支持故障恢复、采用有界缓存并具备竞态防护的群聊自动化系统。

---

🧬 [纯 AI 开发](#-纯-ai-开发) • ✨ [它能做什么](#-它能做什么) • 🎮 [命令与权限](#-命令与权限) • 🚀 [快速开始](#-快速开始) • 🤖 [BotFather 配置](#botfather-setup) • ❓ [常见问题](docs/cn/11-faq.md) • 📚 [开发者文档](docs/cn/content-table.md)

</div>

---

## 🧬 纯 AI 开发

这个仓库里的每一行生产代码、每一个测试用例，连同这份 README 本身，都出自 AI 之手：

<table width="100%">
<thead>
  <tr>
    <th width="18%" align="left">环节</th>
    <th width="32%" align="left">由谁完成</th>
    <th width="50%" align="left">做了什么</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>📐 <b>架构设计</b></nobr></td>
    <td><b>Asashishi</b></td>
    <td>系统边界、Worker 拆分、持久化与恢复策略的设计与裁决</td>
  </tr>
  <tr>
    <td><nobr>⌨️ <b>编码实现</b></nobr></td>
    <td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td>
    <td>100% 的生产代码、测试与文档编写</td>
  </tr>
  <tr>
    <td><nobr>🧾 <b>提交审查</b></nobr></td>
    <td><nobr><b>Asashishi</b> × AI</nobr></td>
    <td>每一次提交都经人类与 AI 共同审查后才落库</td>
  </tr>
  <tr>
    <td><nobr>🔬 <b>全仓审查</b></nobr></td>
    <td><b>GPT</b> · <b>Claude</b></td>
    <td>多轮全仓代码交叉审查，发现的问题直接转化为加固提交</td>
  </tr>
  <tr>
    <td><nobr>🛰️ <b>安全推演</b></nobr></td>
    <td>同一批尖端模型</td>
    <td>推演生产环境中的安全场景：崩溃恢复、并发竞态、恶意输入与资源耗尽</td>
  </tr>
</tbody>
</table>

从逐条提交的人机共审，到尖端模型的多轮全仓审查与安全推演，每一层推演结论都会直接沉淀为系统权威约束。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🧪 项目质量

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="public/coverage_light.svg">
    <img alt="bun run test:coverage：6117 项测试全部通过 / 515 个测试文件 / 436,787 次 expect() 调用 / 函数覆盖率 98.24% / 行覆盖率 98.69%" src="public/coverage_light.svg" width="780">
  </picture>
</p>

性能基准（冷热路径 · 总吞吐与总读写 · 端到端链路耗时）见 **[📊 10 性能基准](docs/cn/10-performance.md)**。

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
  <sub>看得懂图片和语音，也能画图、发语音回群里。</sub></p>
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
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🖼️ 随机图库</b><br>
  <sub>用 /h_image 随机发一张带剧透遮罩的图；授权成员可回复图片或相册收图，按内容去重。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>⏰ 定时发送</b><br>
  <sub>按时区定时发送文字、文件、语音、随机图或 1–10 张固定图片，支持一次性任务与随机间隔。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🎨 人设与通知语气</b><br>
  <sub>内置雌小鬼人设，可用 <code>prompt/persona.md</code> 替换（<a href="prompt_example/persona.md">示例</a>）；Bot 通知优先使用显式配置；未配置时，自定义人设使用普通语气，内置人设使用雌小鬼语气。</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🤐 发言管教</b><br>
  <sub>用 /gag 限制目标直接发文字，改由专属按钮发送变形后的文字，到期或解除后恢复。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🫧 中文动作</b><br>
  <sub>回复群友发 /咬、/贴贴 等一两个中文字的动作命令，无需预先登记。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌊 防刷屏</b><br>
  <sub>按群开启发言频率检测，达到阈值自动短时禁言，豁免权限可单独控制。</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🔎 身份资料</b><br>
  <sub>用 /info 查询用户、频道的公开资料与头像，也能查询群资料；回执 30 秒后删除。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🔐 细粒度权限</b><br>
  <sub>按身份分配功能开关、收图、群问答和管理权限，通过权限看板查询。</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>📨 私聊中转</b><br>
  <sub>超级管理员在私聊开启 /send 后，可把消息转发到指定的已接管群，也能让机器人把一段文字念成语音发过去。</sub></p>
</td>
</tr>
</table>

### AI 提示词缓存率（结合实测的保守估计）

| 模型提供商 | 保守参考范围 |
| --- | --- |
| Gemini | 60%–70% |
| OpenAI | 80%–90% |
| Claude | 80%–90% |

- **Gemini**：未命中包括服务端隐式缓存过期和首轮隐式缓存未预热。当前每轮首个请求在缓存可用时复用固定前缀的显式缓存，后续请求使用隐式缓存缓解。另有约 8% 概率发生的偶发 0 缓存现象，与项目实现无关。
- **Claude**：未命中主要来自 5 分钟缓存有效期结束后的过期。
- **OpenAI**：当前没有已知缓存缺陷。首次填充、前缀变化和新增动态内容仍会产生正常未命中。

### 语音、图片与记忆

<table width="100%">
<thead>
  <tr>
    <th width="24%" align="left">能力模块</th>
    <th width="76%" align="left">当前行为与规格</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🎙️ <b>AI 语音</b></nobr></td>
    <td>支持配置音色与语气；每轮最多 1 条，单句最多 64 个 UTF-16 码元；发送成功后自动写入记忆。</td>
  </tr>
  <tr>
    <td><nobr>📢 <b>管理与定时语音</b></nobr></td>
    <td><code>/send</code> 与 cron 共享 TTS 资源，上限 256 码元；定时语音每轮仅合成 1 次并复用 Telegram <code>file_id</code>。</td>
  </tr>
  <tr>
    <td><nobr>🖼️ <b>图片多模态记忆</b></nobr></td>
    <td>AI 生图记录实际画面；<code>/wed</code>、<code>/h_image</code> 和定时图片先记录占位，有人回复该图片时再做识图。</td>
  </tr>
</tbody>
</table>

- **TTS 语音配置**：需要在 `config/dynamic/agent.json` 中配置 `agent.tts`（支持 Google 原生、OpenAI 兼容 `audio/speech` 及 xAI Grok `/v1/tts`；Google 支持配置 `base_url` 与 `headers` 走网关代理）。可选 `bot_language`（`en` / `zh` / `ja`，默认 `ja`）指定 AI 语音台词的语言；项目根的 `prompt/voice_tool.md` 可整份替换 AI `send_voice` 的工具说明（重启生效，示例见 [`prompt_example/voice_tool.md`](prompt_example/voice_tool.md)）。AI 回复的合成会按 `bot_language` 自动追加朗读语言要求；`style` 与 `/send`、cron 共用，只写声线，更换 `bot_language` 时建议把 `style` 与 `voice_tool.md` 一并改成对应语言。
- **配额独立隔离**：`daily_limit`（默认 100 次）中预留 `daily_reserve_quota`（默认 25 次）给 `/send` 和 cron，AI 使用剩余额度；两边独立计数，从首次计数起满 24 小时后一起重置。
- **记忆准入规则**：`/send` 复制消息与定时语音不写入 AI 上下文；图片自录需要群内已启用 AI 且未处于复读状态。详见 [11 常见问题](docs/cn/11-faq.md)。

每项功能的行为细节、配置与边界见 **[📚 开发者文档](docs/cn/content-table.md)**。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🎮 命令与权限

命令按入口授权与执行级别分级：

- **群成员基础权限**：复读、多语翻译、中文动作、`/info` 查资料、`/wed` 抽群友、`/h_image` 看图等基础群聊交互。
- **身份策略权限（`isCanXxx`）**：群管理与运维命令，包括 `/bot_status` 查看状态、`/mute` / `/unmute` 禁言控制、`/gag` 发言管教、`/block` 黑名单控制、`/h_image add` 图库入库及各功能开关。
- **超级管理员专属（`SUPER_ADMIN_USER_ID`）**：`/init` 初始化纳管、`/permission` 权限修改、`/white disable` 删除白名单成员、`/batch_kick` 清理本群近期入群成员，以及私聊专属的 `/send` 中转。持有 `isCanWhiteOther` 的白名单身份也可用 `/white enable` 新增成员，但只能授予默认权限。

图库与 cron 定时任务的配置和使用见 [08 图库与定时任务](docs/cn/08-images-and-cron.md)，源码与二进制的冷迁移步骤见 [运维手册](docs/cn/07-operations.md)。

完整命令表、权限口径与每条命令的行为细节见 **[📖 09 命令与行为参考](docs/cn/09-commands.md)**。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🚀 快速开始

### 环境要求

- **操作系统**：Linux 系统（必须具备可读的 `/proc` 目录；其他平台实例锁将 fail-closed）。
- **Telegram 凭据**：Bot Token 与超级管理员的 Telegram User ID。
- **运行时环境**：源码运行需 [Bun](https://bun.sh/) 1.4.2；二进制发行包已内置运行时，无需预装。
- **外部依赖**：启用 AI 需对应供应商 API Key；翻译功能需 Google Cloud 服务账号 JSON。硬件配置参考 [07 运维手册](docs/cn/07-operations.md#硬件参考)。

### 一键安装

```bash
# 自动检测环境并进入交互式配置
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash

# 亦可显式指定安装模式：--binary（二进制包，推荐）或 --source（源码克隆）
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --binary
```

> [!TIP]
> - **安装模式**：默认交互询问。传 `--binary` 下载对应平台的预编译包，无需系统 Bun 或 git；传 `--source` 克隆源码，安装器会尝试补装缺少的 git 和 Bun。
> - **向导配置**：安装器会自动引导配置凭据、初始化 SQLite 身份数据库；有 systemd 时注册常驻服务，无 systemd 时以前台运行。已有部署复用当前版本，不自动覆盖。

### 手工源码安装

```bash
# 1. 克隆代码仓库并安装依赖
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install

# 2. 准备配置目录并复制模板（只复制缺失项）
mkdir -p config/static config/dynamic
for example in config_example/static/*.json config_example/dynamic/*.json; do
  case "${example##*/}" in g-auth.json | cron.json) ;; *) cp -n "$example" "config/${example#config_example/}" ;; esac
done

# 3. 编辑 config/static/bot.json，填入 bot_token 与 super_admin_user_id
```

初次运行前，请在 BotFather 侧关闭隐私模式（Privacy Mode）并开启内联模式（Inline Mode），详见 [BotFather 与群权限配置](#botfather-setup)。配置字段规范参见 [`config_example/README/zh.md`](config_example/README/zh.md)，完整运维部署参见 [01 环境搭建与首次运行](docs/cn/01-getting-started.md)。

完成配置与身份数据库初始化后，启动校验与服务：

```bash
bun run check                          # 运行项目规约、ESLint、TypeScript 与单测门禁
bun run start                          # 启动长轮询
```

### 机器人入群初始化

将机器人拉入群组后，由超级管理员在群内依次执行以下命令完成纳管：

```text
/init enable
/ai_chat enable
/antiraid enable
```

> [!NOTE]
> 机器人面向用户的交互文案均为简体中文。如需调整或客制化，参见 [06 修改配方](docs/cn/06-modification-guide.md)。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 📚 开发者文档与架构指南

Copy Ninjia 的架构总览、模块导览、运行时权威约束、测试流程与运维手册，集中收录在 **[开发者文档中心](docs/cn/content-table.md)**：

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
    <td>依赖安装、部署配置、Telegram API 权限及首次启动</td>
    <td align="center"><nobr><a href="docs/cn/01-getting-started.md">📖 01 环境搭建</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🏗️ <b>理解架构</b></nobr></td>
    <td>主线程与 3 个 Worker 协作模型、消息生命周期及持久化恢复</td>
    <td align="center"><nobr><a href="docs/cn/02-architecture.md">📖 02 架构总览</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🗺️ <b>查找代码</b></nobr></td>
    <td>模块职责分工、源码目录映射及新代码放置约定</td>
    <td align="center"><nobr><a href="docs/cn/03-directory-map.md">📖 03 目录导览</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>遵守不变量</b></nobr></td>
    <td>跨模块权威约束、并发防护与全局状态机规则</td>
    <td align="center"><nobr><a href="docs/cn/04-invariants.md">📖 04 权威约束</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🧪 <b>开发与测试</b></nobr></td>
    <td><code>bun run check</code> 质量门禁、测试隔离机制与覆盖率口径</td>
    <td align="center"><nobr><a href="docs/cn/05-dev-workflow.md">📖 05 开发流程</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛠️ <b>新增/修改功能</b></nobr></td>
    <td>添加命令、调参、新增 AI 工具及 schema 变更的分步指南</td>
    <td align="center"><nobr><a href="docs/cn/06-modification-guide.md">📖 06 修改配方</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>生产运维</b></nobr></td>
    <td>systemd 部署、硬件参考、<code>COPY_NINJIA_DATA_ROOT</code>、备份与故障排查</td>
    <td align="center"><nobr><a href="docs/cn/07-operations.md">📖 07 运维手册</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🖼️ <b>图库与定时任务</b></nobr></td>
    <td>收图、内容去重、单图与相册发送、定时语音、时区与路径基准</td>
    <td align="center"><nobr><a href="docs/cn/08-images-and-cron.md">📖 08 图库与定时任务</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🎮 <b>查命令</b></nobr></td>
    <td>全部命令、权限口径与行为细节（根 README 只留概述）</td>
    <td align="center"><nobr><a href="docs/cn/09-commands.md">📖 09 命令参考</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>📊 <b>看性能读数</b></nobr></td>
    <td>冷热路径、总吞吐与总读写、端到端链路耗时的发布基准</td>
    <td align="center"><nobr><a href="docs/cn/10-performance.md">📖 10 性能基准</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>❓ <b>排查没有回复</b></nobr></td>
    <td>机器人在运行却不回应时的逐条排查清单</td>
    <td align="center"><nobr><a href="docs/cn/11-faq.md">📖 11 常见问题</a></nobr></td>
  </tr>
</tbody>
</table>

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

<a id="botfather-setup"></a>

## 🤖 BotFather 与群权限配置

### BotFather 设置

<table width="100%">
<thead>
  <tr>
    <th width="26%" align="left">设置项</th>
    <th width="32%" align="left">在 @BotFather 中的操作</th>
    <th width="42%" align="left">用途与说明</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr><b>关闭群隐私模式</b></nobr></td>
    <td><kbd>/setprivacy</kbd> → <b>Disable</b></td>
    <td>接收群内普通消息（复读、翻译、AI 插话、问答依赖此项）。<br><sub>*注：修改后需退群重新拉入生效；若 Bot 已是群管理员则无此限制。*</sub></td>
  </tr>
  <tr>
    <td><nobr><b>开启 Inline Mode</b></nobr></td>
    <td><kbd>/setinline</kbd></td>
    <td>支持今日运势（<code>@机器人 所求事项</code>）及 <code>/gag</code> 发言按钮。</td>
  </tr>
  <tr>
    <td><nobr><b>内联反馈 100%</b></nobr></td>
    <td><kbd>/setinlinefeedback</kbd> → <b>100%</b></td>
    <td>运势结果确认与落盘的核心回执链路。</td>
  </tr>
  <tr>
    <td><nobr><b>允许加入群组</b></nobr></td>
    <td><kbd>/setjoingroups</kbd> → <b>Enable</b></td>
    <td>允许将机器人拉入群组（默认已开启）。</td>
  </tr>
  <tr>
    <td><nobr><b>Bot-to-Bot 通讯</b></nobr><br><sub>（可选模式）</sub></td>
    <td>Bot Settings → Bot-to-Bot</td>
    <td>当 <code>/translate</code> 或 <code>/copy</code> 的目标是另一个机器人时开启。</td>
  </tr>
</tbody>
</table>

命令菜单无需在 BotFather 中手动使用 `/setcommands` 配置：Bot 在启动时会根据进程配置的通知语气自动注册对应语言的菜单（未配置通知语气且使用自定义人设时采用普通版菜单）。菜单仅在群聊中可见；私聊仅向超级管理员开放 `/send`，默认不显示普通菜单。

> [!WARNING]
> **Bot-to-Bot 跨机器人通讯模式说明**：
> 开启此模式后，Bot 可在已获管理员权限或已关闭隐私模式的群里接收其他 Bot 的普通发言。收到的其他 Bot 消息先经过全局入口限流：每个 Bot 连续活跃期间前 15 条进入业务，第 16 条起静默忽略；停止发言满 90 分钟后重新计数。最多记录 512 个其他 Bot，满载时不接收新 Bot 的消息；本 Bot 自己的消息不计数，也不受此闸限制。详见 [消息分发约束](docs/cn/04-invariants.md)。

### 群内管理员权限

将 Bot 提升为群管理员，并根据所需功能按需勾选以下权限：

<table width="100%">
<thead>
  <tr>
    <th width="28%" align="left">管理员权限项</th>
    <th width="72%" align="left">对应触发功能</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🗑️ <b>删除消息</b></nobr></td>
    <td><code>/gag</code> 发言管教、广告检测自动撤回、自动清理黑名单频道身份发言。</td>
  </tr>
  <tr>
    <td><nobr>🚫 <b>限制与封禁成员</b></nobr></td>
    <td>入群验证超时踢人、防冲群自动转私密、<code>/block enable|disable</code>、<code>/mute</code> / <code>/unmute</code>、<code>/batch_kick</code>、刷屏禁言、广告处置封禁。</td>
  </tr>
</tbody>
</table>

> [!TIP]
> - **入群事件监听**：入群验证功能依赖管理员身份（Telegram 仅向管理员 Bot 推送成员进出群事件）。
> - **权限排查诊断**：权限不足时 Bot 将明确提示缺失的具体权限项。持有 `isCanViewBotStatus` 权限的成员可发送 `/bot_status` 实时查看当前群的授权快照。
> - 若机器人在运行但无任何交互响应，请按 [11 常见问题](docs/cn/11-faq.md) 逐项排障。

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/footer_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="public/footer_light.svg">
  <img alt="Copy Ninjia — 不是只会复读，是把整套群聊现场偷走再演一遍。" src="public/footer_light.svg" width="580">
</picture>

*人类没有写下任何一行代码，但也从未退场——画完图纸之后，还和 AI 一起审过每一次提交。*

</div>
