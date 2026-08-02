<div align="center">

<p><b>简体中文</b> · <a href="README.en.md">English</a> · <a href="README.ja.md">日本語</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner_dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner_light.jpg">
  <img alt="Copy Ninjia Banner" src="docs/assets/banner_light.jpg" width="100%">
</picture>

<h1>
  <a href="https://t.me/copy_ninjia_bot" title="点击头像跳转至示例 Bot"><img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="44" height="44" alt="Copy Ninjia 示例 Bot 头像"></a>
  Copy Ninjia
</h1>

<p><sub>点击头像即可跳转至示例 Bot：<a href="https://t.me/copy_ninjia_bot">@copy_ninjia_bot</a></sub></p>

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
  <a href="#-纯-ai-开发"><img src="https://img.shields.io/badge/Audits-Fable_5_/_GPT--5.6_/_Opus_5-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="docs/05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-1581_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="docs/05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-96.54%25-2ea44f?style=flat-square" alt="Coverage"></a>
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
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/coverage_light.svg">
    <img alt="bun run test:coverage：1581 项测试全部通过 / 169 个测试文件 / 29,945 次 expect() 调用 / 函数覆盖率 95.15% / 行覆盖率 96.54%" src="docs/assets/coverage_light.svg" width="780">
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
  <p>基于 Gemini 人设自主决策：发言、贴纸、表情反应、生图都是工具，由模型自行决定这一轮做几件事、按什么顺序做。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>👁️ 多模态与生图</b></p>
  <p>支持识别图片、动态贴纸和 GIF 帧，能按需生成新图片或对现有素材进行智能编辑。</p>
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
  <p>新成员 90 秒限时按钮验证：真人只能本人点击，机器人账号仅限白名单代点担保；可归属的非匿名管理员邀请与关联频道评论区活动免验。</p>
</td>
<td align="left" valign="top">
  <p><b>🚨 Anti-Raid</b></p>
  <p>监测入群频率，达到阈值后关闭群组邀请并处置异常入群成员，重启后可恢复状态。</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>📮 广告检测</b></p>
  <p>按发送者归并 90 秒消息串交 DeepSeek 判定，非受保护身份命中后按 <code>/block</code> 同权处置，并在触发群播报封禁理由。</p>
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

目标可通过「回复 TA 的消息」或 `@username` 指定：

- **按用户名查找依赖机器人此前观察到该账号**；改名、移除用户名或用户名换绑会立即使旧别名失效。对 `/block`、`/unblock` 这类破坏性操作，优先回复目标消息或直接给用户 id（那两条命令额外接受裸 id），不要依赖历史用户名。
- **匿名管理员以当前群身份发言时，复读目标就是当前群**，因而可取得群头像并复读这层「皮套」；`/block` 会拒绝把当前群身份当作成员目标。
- **普通用户执行 copy 类命令时受 5 分钟全局冷却限制**，`config/whitelist.json` 中的白名单身份不受限。

<p align="right"><sub><a href="#copy-ninjia">⬆️ 回到顶部</a></sub></p>

## 🎮 命令与权限

<table width="100%">
<tr><th width="26%" align="left">命令</th><th width="19%" align="center">权限</th><th width="55%" align="left">说明</th></tr>
<tr><td><code>/copy</code> <code>/r_copy</code> <code>/nya_copy</code> <code>/ja_copy</code></td><td align="center">群成员</td><td>启动相应复读模式</td></tr>
<tr><td><code>/stop_copy</code></td><td align="center">群成员</td><td>停止当前全局复读</td></tr>
<tr><td><code>/steal_icon</code></td><td align="center">群成员</td><td>只偷头像</td></tr>
<tr><td><code>/&lt;1~2 个中文字&gt;</code></td><td align="center">群成员</td><td>动作命令，如 <code>/咬</code>、<code>/揪住</code> 回复「发起人 咬了 目标！」；成功结果长期保留</td></tr>
<tr><td><code>/quiet [1-15]</code></td><td align="center">群成员</td><td>暂停随机插话、随机复读等主动行为，默认 3 分钟</td></tr>
<tr><td><code>/unquiet</code></td><td align="center">群成员</td><td>提前解除安静模式</td></tr>
<tr><td><code>/mute … &lt;时长&gt;</code> <code>/unmute</code></td><td align="center"><code>isCanMute</code> / <code>isCanUnMute</code></td><td>在超级群临时禁言或提前解除；目标支持回复、<code>@username</code>、用户 id，时长支持 <code>m/h/d</code></td></tr>
<tr><td><code>/block</code></td><td align="center"><code>isCanBlock</code></td><td>拉黑：写进永久黑名单，并在所有机器人管理的群中封禁目标；目标可用回复消息、<code>@username</code> 或用户 id 指定</td></tr>
<tr><td><code>/unblock</code></td><td align="center"><code>isCanUnBlock</code></td><td>完整解除拉黑：把 id 从动态黑名单里划掉，并在所有机器人管理的群中解除封禁；目标指定方式同 <code>/block</code>，另外还接受频道的负数 id。静态黑名单身份拒绝解除；超级管理员自动放行</td></tr>
<tr><td><code>/ai_chat enable|disable</code></td><td align="center"><code>isCanControllAIPermission</code></td><td>开关本群 AI 闲聊；超级管理员自动放行</td></tr>
<tr><td><code>/ad_detect enable|disable</code></td><td align="center"><code>isCanControllAdDetectPermission</code></td><td>开关本群广告检测，非受保护身份命中后按 <code>/block</code> 同权处置；超级管理员自动放行</td></tr>
<tr><td><code>/flood_control enable|disable</code></td><td align="center"><code>isCanControllFloodControlPermission</code></td><td>开关本群防刷屏禁言（默认关闭）；超级管理员自动放行</td></tr>
<tr><td><code>/query_mood</code></td><td align="center">群成员</td><td>查询本群 AI 当前有效心情，不触发重抽</td></tr>
<tr><td><code>/switch_mood</code></td><td align="center"><code>isCanSwitchMood</code></td><td>立即重抽本群 AI 心情，并在 Worker 回执后回复新心情名；超级管理员自动放行</td></tr>
<tr><td><code>/ja_copy enable|disable</code></td><td align="center"><code>isCanControllJATranslatePermission</code></td><td>开关本群日语翻译能力（默认关闭）；超级管理员自动放行</td></tr>
<tr><td><code>/init enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>开关本群的业务处理总入口</td></tr>
<tr><td><code>/batch_kick &lt;Nm|Nh|Nd&gt;</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>在超级群中踢出滚动 24 小时内指定时间窗加入且仍在群内的成员；只踢不拉黑</td></tr>
<tr><td><code>/permission query</code><br><code>/permission help</code></td><td align="center">白名单身份</td><td>查询发起用户/频道自己的完整权限，或以 JSON 列出权限说明；<code>help</code> 长期保留，<code>query</code> 30 秒后删除</td></tr>
<tr><td><code>/permission …</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>修改已有白名单用户/频道的一项权限；<code>all</code> 可全部打开</td></tr>
<tr><td><code>/white … enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>新增或删除白名单用户/频道；支持回复、<code>@username</code>、用户 id 与频道 id</td></tr>
<tr><td><code>/send &lt;群组 ID&gt;</code> <code>/send finish</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code>（仅私聊）</td><td>在机器人私聊中开始或结束向目标群的中转</td></tr>
</table>

### 行为细节

- **命令入口**：群命令统一经过 `/init` 网关；未初始化群只接受超级管理员的 `/init`，所以 `/permission`、`/white` 也必须在已初始化群中使用。私聊斜杠命令只放行 `/send`。
- **动作命令**：姓名用 `first_name last_name` 形式，有公开用户名的一方挂上主页链接；目标同样通过「回复 TA 的消息」或 `@username` 指定。成功的动作结果与 `/permission help` 一样长期保留；目标缺失、参数错误和 `/x` 用法提示仍在 30 秒后删除。
- **`/block` 黑名单**：目标可通过回复 TA 的消息、`@username` 或直接给用户 id（正整数，群/频道的负数 id 不算）指定——id 那条最可靠，用户名被释放后可以被别人重新注册，而这条命令不可逆。id 落进持久化黑名单后，TA 出现在任何监听群的入群更新里都会被秒踢。机器人在某个群里「拿到管理权限」和「已 `/init enable`」两件事凑齐的那一刻（先后顺序不限），还会把名单里已经在群里的人补清一遍。`/unblock` 移除时整份名单原子重写回文件，并默认在所有机器人管理的群解除封禁；即使目标不在动态名单里也仍会跨群解封。`/unblock` 比 `/block` 多认一种目标：**频道的负数 id**。频道马甲会以 `sender_chat` 的身份进名单（回复频道消息的 `/block`、广告检测命中），而广告检测会删掉原消息、没有公开 username 的频道也查不到缓存，不认负数 id 的话这类条目就再也划不掉了；反方向不开是因为 `/block` 粘错一个会话 id 就会封掉整个会话身份且不可逆。
- **`/batch_kick` 慢速清理**：只允许超级管理员在已初始化的超级群中使用，参数是 `30m`、`2h`、`1d` 这类不超过 24 小时的单个窗口。命令按入群日志找出窗口内最后一次加入且仍在群中的成员，小并发执行只踢不封；超级管理员、白名单身份和永久黑名单成员都不会被这条命令当作普通目标处理。
- **`/ad_detect` 广告检测**：每条消息按发送者归并成 90 秒消息串交 DeepSeek 判定；非受保护身份命中后执行与 `/block` 相同的处置（永久黑名单 + 各管理群封禁并删除其消息），并在触发群播报封禁理由（30 秒后自撤）。超级管理员恒不送检；白名单的 `isCanBypassAdDetection` 关闭后可以送检和删除本批消息，但仍不会进入永久黑名单。仅在机器人是本群管理员时触发，判定口径见 [`config/ad_samples.json`](config_example/ad_samples.json)。
- **刷屏禁言**：每群默认关闭，由超级管理员或具备 `isCanControllFloodControlPermission` 的白名单身份执行 `/flood_control enable` 开启。同一个人在同一个超级群内一分钟发言达到 15 条，就地禁言 3 分钟并在群里说明一句（公告在禁言解除时自撤）。到点由 Telegram 自动解除，不写黑名单也不删消息。仅在机器人确有「限制成员」权限时触发；群主/管理员、`SUPER_ADMIN_USER_ID`、频道马甲与匿名管理员不计数。白名单身份单独遵循 `isCanBypassFloodControl`，该项缺省为 `true`；显式设为 `false` 后会参与计数。
- **`/send` 中转**：开启前先探测目标是否可达，期间超级管理员发送的每条消息都会原样转发到目标群一次；目标失联时自动终止并通知。中转状态随 `state.json` 持久化，重启后仍可恢复。该命令不进入 Telegram 命令菜单，在群内调用或由其他用户触发时均不响应。

> [!TIP]
> **中文动作命令不需要预先登记**，任意 1~2 个中文字都能用。Telegram 的命令名只收 ASCII（拉丁字母、数字、下划线），因此：
> - 这类命令既不出现在命令菜单里，也不会有输入补全；菜单里只放了一条占位说明项 `/x`，命令名 `x` 就是那个变量，提示把它换成任意 1~2 个中文字。点它会收到一条用法提示并终止链路，不会被当成普通消息进入 AI/复读流水线。
> - `/咬人人` 这种三字及以上的写法不算动作命令，会按普通消息处理。
> - 正因为谁都能随手造一个，它采用全局滑动窗口限流：每 90 秒最多应答 450 次，不分群、不分用户合并计数，超额直接静默丢弃、不回提示。

> [!TIP]
> **`/luck_challenge` 不是斜杠命令**：在任意聊天输入 `@机器人用户名 [所求事项]` 即可使用 Inline Mode。需在 BotFather 中开启 Inline Mode，并建议通过 `/setinlinefeedback` 开启 100% 结果反馈。内联查询采用全局滑动窗口限流，每 90 秒最多应答 300 次。

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
<tr><td>入门（低活跃、文本为主、仅少量群开启 AI）</td><td>2 vCPU / 2 GB RAM / 本地 SSD</td><td>可以运行，但媒体高峰时多个 Worker 可能争用 CPU；建议配备 2 GB Swap</td></tr>
<tr><td>轻量生产（文本为主、仅少量群开启 AI）</td><td>4 vCPU / 2 GB RAM / 本地 SSD</td><td>不建议用 2 GB 内存承载媒体处理高峰；建议配备 2 GB Swap</td></tr>
<tr><td>推荐生产（约 15 个单群日均 1,000～3,000 条消息的活跃群）</td><td>4 vCPU / 4 GB RAM / 本地 SSD</td><td>建议配备 2 GB Swap</td></tr>
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
cp -r config_example config
```

### 3. 配置

按 [`.env.example`](.env.example) 填写 `.env`：

| 变量 | 必填 | 说明 |
| :--- | :---: | :--- |
| `TELEGRAM_BOT_TOKEN` | ✅ | BotFather 发放的 Bot Token |
| `SUPER_ADMIN_USER_ID` | ✅ | 超级管理员的单个十进制用户 ID |
| `AI_CHAT_GEMINI_API_KEY` | — | AI 闲聊 agent 专用；留空则 AI Worker 不启动，`/ai_chat enable`、`/query_mood` 与 `/switch_mood` 被拒 |
| `AD_DETECT_DEEPSEEK_API_KEY` | — | 广告检测专用；留空则 `/ad_detect enable` 被拒 |
| `COPY_NINJIA_DATA_ROOT` | — | 运行时数据根目录；留空时使用项目根目录 |

`config/` 是不受 Git 追踪的部署配置，初次安装必须从 `config_example/` 复制。`whitelist.json` 与 `blocklist.json` 在联网前严格加载；其余四份 JSON 和 `g-auth.json` 按功能惰性校验，坏掉只拒绝对应的开关命令。

> [!IMPORTANT]
> 只有一种情况例外：某个功能在 `state.json` 里还开着，却把它的 key 或配置撤掉了——那是管理员明确按下过的开关，进程会带着群 id 与缺失项拒绝启动，而不是悄悄变成不干活。先 `disable` 再撤，或者把前提补回去。

设置 `COPY_NINJIA_DATA_ROOT` 后，`state.json`、`bot.lock`、`logs/` 和 `memory/` 都从该目录派生；`config/`、人设与 `g-auth.json` 仍从项目根目录读取。

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

> **关于语言**：机器人面向用户的文案只有简体中文，仓库不维护 i18n。回复文本由片段拼接而成、还要同步计算 Telegram `entities` 的偏移，`/咬` 这类中文动作命令又依赖中文形态本身，词条表接不住这类文案。需要别的语言请 fork 后自行改写（生产代码里约 581 个源码行含中文字符串或模板字面量，分布在 65 个文件，外加 `prompt/persona.md` 与 `config/*.json`），理由与改法见 [06 修改配方](docs/06-modification-guide.md)。

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
