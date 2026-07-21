<div align="center">

<a href="https://t.me/copy_ninjia_bot">
  <img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="128" height="128" alt="Copy Ninjia Bot 当前头像" style="border-radius: 50%; object-fit: cover; object-position: center;">
</a>

# 🥷 Copy Ninjia

### 会偷头像、会复读、会看图、会守群，还会一本正经损人的 Telegram 群聊机器人

由 **Asashishi** 与 **Claude Code**、**Codex**、**Antigravity** 共同开发

[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000000&labelColor=ffffff)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=3178c6&labelColor=ffffff)](https://www.typescriptlang.org/)
[![grammY](https://img.shields.io/badge/Telegram-grammY-26a5e4?logo=telegram&logoColor=26a5e4&labelColor=ffffff)](https://grammy.dev/)
[![Gemini](https://img.shields.io/badge/AI-Gemini_3.1_Flash_Lite-8e75ff?logo=googlegemini&logoColor=8e75ff&labelColor=ffffff)](https://ai.google.dev/)

复读与人格模仿只是表面；底下是一套多 Worker、可恢复、有界缓存、带竞态防护的群聊自动化系统。

</div>

---

## ✨ 它能做什么

| 能力 | 说明 |
| --- | --- |
| 🪞 精准复读 | 锁定用户或频道后逐条复读，支持原样、反转、加「喵~」、翻译日语四种模式 |
| 🥷 偷头像 | `/copy` 自动换成目标头像；`/steal_icon` 也能只偷头像、不进入复读状态 |
| 🤖 AI 群聊 | Gemini 人设回复、实时 Google 搜索、东京天气工具、文字/贴纸/反应/生图统一 function calling |
| 👁️ 多模态与生图 | 识别图片、静态/动态贴纸和 GIF 封面帧；也能按明确请求生成或参考现有素材编辑图片 |
| 🧠 群聊记忆 | 50～100 条逐字上下文 + 最多 5 轮压缩摘要，并定期原子落盘恢复 |
| 🛡️ 入群验证 | 新成员 90 秒按钮验证，支持机器人由白名单用户代点、管理员拉人豁免、评论区感知 |
| 🚨 Anti-Raid | 60 秒内第 46 位新人触发 5 分钟邀请锁定，重启后自动接管并恢复原权限 |
| 🎲 今日运势 | Telegram Inline Mode 抽签，日级密钥保证重启前后预览一致，选中或签名回执后落盘 |
| 🌐 跨群管理 | `/kick` 在机器人拥有管理员权限的所有已知群中同步封禁目标 |

## 🎭 复读模式

复读目标是全局唯一的：同一实例同时只能“变成”一个目标，但复读只发生在发起命令的群中。`/stop_copy` 可在任意群停止当前复读。

| 命令 | 行为 |
| --- | --- |
| `/copy` | 原样复读 |
| `/r_copy` | 按字形簇反转纯文本 |
| `/nya_copy` | 在纯文本末尾追加「喵~」 |
| `/ja_copy` | 使用 Google Cloud Translate 翻译为日语后复读 |
| `/steal_icon` | 只复制头像 |
| `/stop_copy` | 停止全局复读状态 |

目标可通过“回复 TA 的消息”或 `@username` 指定。按用户名查找依赖机器人此前观察到该账号；回复消息不受这个限制。普通用户受 5 分钟 copy 类命令冷却，`PRIVILEGED_USERS_ID` 白名单不受限。

## 🧠 AI 流水线

AI 闲聊默认按群关闭，由超级管理员执行 `/ai_chat enable` 开启。关闭时不记录该群对话，也不会产生 AI 请求。

```text
Telegram update
      │
      ├─ 文本 ───────────────┐
      ├─ 图片/贴纸/GIF ──> 异步视觉描述 ──┐
      │                                    │
      └────────────────> AI Worker 滚动记忆
                                           │
                         Gemini + googleSearch + 自定义工具
                                           │
                    ┌─────────┬─────────┬─────────┬─────────┐
                    ▼         ▼         ▼         ▼         ▼
                发文字消息  添加反应  查看贴纸包  发送贴纸  生成图片
```

- 模型：回复、摘要、视觉描述使用 `gemini-3.1-flash-lite`；生成或编辑图片使用 `gemini-3.1-flash-lite-image`。
- 触发：回复机器人或 `@机器人` 时必定触发；普通文字和媒体评价共用按群活跃度的动态概率。当前消息先计入近 1 小时窗口，因此冷群第一条为 1/174；窗口内达到 165 条后封底为 1/10。活跃度只存内存，空闲满一小时或重启后回到冷启动。
- 同群并发：每群最多 3 轮 Gemini 工具对话在途；直接触发进入有界队列，随机触发在满载时丢弃。
- 限频：每群 5 分钟最多启动 150 轮；超限提示本身也有冷却。
- 工具：同一请求真实注册内置 `googleSearch`，并提供东京天气、`send_message`、`add_reaction`、`view_sticker_pack`、`send_sticker`、`generate_image` 等函数工具；提示词要求需要查证时先搜索再行动，所有面向群友的文字必须显式经过 `send_message`，图片、贴纸或反应完成后的最终正文不会被当作额外发言。
- 安全过滤：Google 可调的骚扰、仇恨、露骨和危险内容统一设为 `BLOCK_NONE`，应用不按概率等级主动拒绝；Gemini API 不可调的核心伤害保护与服务端策略仍然生效。
- 时间：每次请求注入东京当前时间，每条转录消息保留记录时刻。
- 记忆：50～100 条逐字消息，加最多 5 × 50 条冷历史摘要，总跨度约 300～350 条；Worker 最多常驻 100 个群，超出按最后活动时间淘汰并删除磁盘快照，淘汰时优先避开仍有回复轮次在途的群。
- 多模态：图片描述最多 125 字，贴纸/GIF 最多 100 字；聊天媒体的下载、转码、视觉描述与生图参考素材的下载、转码，共用最多 75 个执行槽与 150 项等待队列。未命中本地贴纸目录的媒体共享 1500 项 LRU 去重缓存（命中即续命，超额淘汰最久未使用的一项，不设 TTL）。`memory/stickers/` 中配置包的描述启动后常驻内存，仅在线上贴纸包对账发现更新时增删，群消息里的同款贴纸会直接命中该目录。
- 生图：只有直接回复或 `@机器人` 的消息才开放工具资格，且模型仅在当前消息明确要求生成或编辑图片时调用；当前或被回复的图片/贴纸可作为本轮短期参考素材，不进入滚动记忆或落盘。普通用户按群共享 3 分钟冷却，`SUPER_ADMIN_USER_ID` 不受该冷却限制；参考素材下载、队列或失效等模型调用前失败会释放占位，模型请求一旦开始（包括生成失败或发送失败）仍保留冷却；输出固定为 1K 图片。
- 压缩背压：每群最多保留 5 个压缩任务，API 长时间变慢时有界降级，不无限堆积消息批次。

人设在 [`prompt/persona.md`](prompt/persona.md)，贴纸包和反应集合分别在 [`config/stickers.json`](config/stickers.json) 与 [`config/reactions.json`](config/reactions.json)。

## 🛡️ 入群验证与 Anti-Raid

守群功能只在机器人拥有群管理员权限时运行：没有删消息、踢人权限时不会假装启动一套注定失败的流程。

- 新成员需在 90 秒内点击验证按钮；超时会删除验证期内追踪到的消息并踢出，但不永久封禁。
- 每位待验证成员独立统计最近 60 秒消息；第 46 条会先踢人止损，再尽力清理全部已追踪消息。关联频道评论区的直属评论和楼中楼回复都按既定策略豁免，不计入刷屏窗口。
- 管理员/群主身份、管理员或白名单用户拉入的成员可豁免。
- 其他机器人也必须验证，由白名单用户代点作保。
- 关联频道评论区会识别“留言或回帖导致自动入群”的场景：已经实际评论/回帖的成员直接豁免；只从评论区点击入群但没有发消息，仍按普通成员验证，锁定期间会直接踢出。
- 最近 60 秒入群人数超过 45 时进入 5 分钟锁定，临时关闭普通成员邀请权限。
- 待验证状态、未过期的消息窗口和终态处置进度写入 `memory/anti-raid/YYYY-MM-DD.json`：Worker 或进程重建后按原 `expiresAt` 的剩余时间继续，已过期记录立即处置；成功踢人播报落盘确认后不会在崩溃重放时重复发送；只保留东京当天文件。
- 权限写入按群串行，恢复失败每 30 秒重试；锁定状态写入 `state.json`，进程重启后继续剩余计时。
- 管理员表与关联频道缓存都有 TTL、500 群硬顶和周期淘汰，不按历史群数永久增长。
- 最近评论关联缓存只保留 2 分钟、全局最多 5,000 条；复用 Anti-Raid Worker 的唯一周期 sweeper，不为每位成员创建 timer。

## 🎮 命令与权限

| 命令 | 权限 | 说明 |
| --- | --- | --- |
| `/copy` `/r_copy` `/nya_copy` `/ja_copy` | 群成员 | 启动相应复读模式 |
| `/stop_copy` | 群成员 | 停止当前全局复读 |
| `/steal_icon` | 群成员 | 只偷头像 |
| `/quiet [1-15]` | 群成员 | 暂停随机插话、随机复读等主动行为，默认 3 分钟 |
| `/unquiet` | 群成员 | 提前解除安静模式 |
| `/kick` | `PRIVILEGED_USERS_ID` | 在所有机器人管理的群中永久封禁目标 |
| `/ai_chat enable\|disable` | `SUPER_ADMIN_USER_ID` | 开关本群 AI 闲聊 |
| `/ja_copy enable\|disable` | `SUPER_ADMIN_USER_ID` | 开关本群日语翻译能力（默认关闭） |
| `/init enable\|disable` | `SUPER_ADMIN_USER_ID` | 开关本群整个业务处理入口 |
| `/send <群组id>` `/send finish` | `SUPER_ADMIN_USER_ID`（仅私聊） | 与机器人私聊时开启/结束一轮中转：期间这个私聊发的每条消息都会原样转发进目标群一次。开启前会先探一次目标是否可达，中转期间目标失联会自动终止并告知。中转状态随 `state.json` 持久化，重启不丢；不进 Telegram 命令菜单，群里或非本人触发均无任何反应 |

`/luck_challenge` 不占斜杠命令：在任意聊天输入 `@机器人用户名 [所求事项]` 使用 Inline Mode。需在 BotFather 开启 Inline Mode，并建议通过 `/setinlinefeedback` 开启 100% 结果反馈。内联查询采用全局滑动窗口限流，每 90 秒最多应答 300 次。

## 🚀 快速开始

### 1. 环境

- Bun 1.3+
- Telegram Bot Token
- Gemini API Key
- Google Cloud 服务账号 JSON（仅 `/ja_copy` 需要）
- 入门配置（低活跃、文本为主、仅少量群开启 AI）：2 vCPU / 2 GB RAM / 本地 SSD；可以运行，但多 Worker 会争用 CPU，不适合 15 个活跃群或媒体洪峰
- 轻量生产配置（文本为主、仅少量群开启 AI）：4 vCPU / 2 GB RAM / 本地 SSD；2 GB 不适合作为媒体洪峰下的内存保障
- 推荐生产配置（约 15 个 1000-3000 人活跃群）：4 vCPU / 4 GB RAM / 本地 SSD
- 全部群开启 AI 且图片、贴纸较多：4 vCPU / 8 GB RAM，给媒体下载、Base64 编码和图片转码预留峰值空间
- 单实例仍建议控制在约 15 个上述规模的活跃群以内；主要限制来自 Telegram 单 Bot API、Gemini 配额和实际消息/媒体速率，而不是群成员总数

### 2. 安装

```bash
git clone <your-repository-url>
cd copy_ninjia
bun install
cp .env.example .env
```

### 3. 配置

按 [`.env.example`](.env.example) 填写 `.env`：`TELEGRAM_BOT_TOKEN`、
`GEMINI_API_KEY` 和单个十进制数字 ID `SUPER_ADMIN_USER_ID` 必填；
`PRIVILEGED_USERS_ID` 可留空，多项之间用英文逗号分隔。

`COPY_NINJIA_DATA_ROOT` 可选，用于单独指定运行时生成数据的根目录。设置后，
`state.json`、`bot.lock`、`logs/` 和 `memory/` 都从该目录派生；人设、贴纸/反应配置
与 `g-auth.json` 仍从项目根目录读取。留空时保持原行为，数据直接位于项目根目录。
并行部署多个 Bot 时，每个实例必须使用不同的数据根目录。

贴纸包在 [`config/stickers.json`](config/stickers.json) 中配置，最多配置 5 个；
AI 每轮可以依次查看这 5 个包，但同一个包在一轮内只会查看一次。

如需日语翻译，将 Google Cloud 服务账号密钥保存为项目根目录的 `g-auth.json`。`.env` 与 `g-auth.json` 均已加入 `.gitignore`。

Telegram 侧还需要按功能配置：

1. 关闭 Bot Privacy Mode，机器人才能观察完整群消息并复读普通成员。
2. 授予删消息、封禁成员、管理群权限，入群验证和 Anti-Raid 才会启用。
3. 启用 Inline Mode 才能使用运势抽签。
4. 启用 inline feedback，抽签结果才能可靠确认并落盘。

### 4. 启动与检查

```bash
bun run check     # ESLint + TypeScript 严格检查 + 全源码覆盖率测试
bun run start     # 启动长轮询
```

首次拉入群后，由 `SUPER_ADMIN_USER_ID` 在群内执行：

```text
/init enable
/ai_chat enable
```

## 🏗️ 架构

```text
主线程
├─ grammY runner + 按群 sequentialize
├─ 命令与自动消息流水线
├─ 全局 copy 状态 / 群状态镜像
├─ StateStore：state.json latest-only 原子写与失败重试
│
├── AI Worker
│   ├─ Gemini 多轮工具调用
│   ├─ 对话滚动、摘要压缩、视觉理解
│   └─ 分群限频、并发闸与溢出排队
│
├── Anti-Raid Worker
│   ├─ 验证状态机
│   ├─ 锁定状态机
│   └─ Telegram 管理副作用解释器
│
└── Disk I/O Worker
    ├─ error 日志
    ├─ AI 记忆 / 贴纸目录原子快照
    └─ 每日运势 / 待验证状态的按日追加文件与截断修复
```

关键目录：

| 路径 | 职责 |
| --- | --- |
| `src/app/` | 启动/退出生命周期、handler 注册与命令菜单 |
| `src/commands/` | 显式命令处理 |
| `src/auto/` | 自动复读、AI 记录与触发、反应同步 |
| `src/states/` | 无 I/O 的验证、锁定状态机与回复准入规则 |
| `src/config/` | 贴纸/反应配置的严格 schema、惰性加载与启动校验 |
| `src/libs/` | 原子文件、有界 I/O、通用 schema 辅助及并发工具 |
| `src/workers/` | AI、守群、磁盘三个独立 Worker |
| `src/ai/` | Gemini、视觉、贴纸目录及工具 |
| `src/infra/` | Telegram 客户端、Worker 宿主与持久化基础设施；`storage/` 收口实例锁、状态存储和启动清理 |
| `src/cache/` | 按领域拆分的运行时状态容器 |
| `src/consts/` | 调参常量与路径 |
| `src/types/` | 跨模块协议与领域类型 |
| `test/` | 与源码结构对应的 Bun 单元测试 |

## 💾 数据与可靠性

下表中的位置均相对于运行时数据根目录；默认是项目根目录，可通过
`COPY_NINJIA_DATA_ROOT` 修改。

| 数据 | 位置 | 写入策略 |
| --- | --- | --- |
| 群状态 / copy 状态 / 锁定镜像 | `state.json` | 只保留“在写 + 最新待写”两份快照，失败后台重试，临时文件 + fsync + 原子 rename |
| AI 群聊记忆 | `memory/ai/` | 每群独立快照，30 秒周期 + 停机 flush |
| 贴纸描述目录 | `memory/stickers/` | 每包独立原子快照；启动恢复后常驻内存，与线上贴纸包对账时更新，并供群消息解析复用 |
| 今日运势 | `memory/luck/` | 结果按东京日期增量追加并修复尾部截断；`receipt-secret.json` 原子保存当日确定性抽签/HMAC 密钥，权限固定为普通用户可读、仅属主可写的 `0644` |
| 待验证成员 | `memory/anti-raid/` | 当日 JSON 按 `chatId:userId` 键增量追加；普通更新 250ms 合并，创建立即写，终结追加 tombstone；达到 4 MiB 或 10,000 条历史时收敛 active 快照，跨日删除旧文件 |
| error 日志 | `logs/` | Disk I/O Worker 统一批量追加 |
| 运行实例 | `bot.lock` | 原子维护的多 Bot 进程注册表 |

`memory/` 含群聊逐字内容与运势回执密钥，应视为敏感数据；项目按部署约定将其中的 JSON 写成普通系统用户可读的 `0644`，请通过主机访问控制限制机器上的用户，并控制备份范围与保留周期。备份当天运势时必须把 `memory/luck/receipt-secret.json` 与当天结果文件放在同一一致性备份中；密钥不会写入日志。`logs/`、`memory/`、`state.json`、凭据和运行锁均不会提交到 Git。

待验证热路径复用每日运势和日志已有的 JSON 末尾追加机制，不会每次全量重写，也不会增加新的 IO 线程。终结记录以 `null` tombstone 线性追加，尾部截断修复按 JSON 结构边界扫描，因此会保留最后一条完整 tombstone，不会让已终结验证复活；只有跨日轮换或达到历史阈值时才原子收敛当前 active 镜像。每批追加在成功回执前执行 fsync。同步文件操作始终留在 Disk I/O Worker，不阻塞 Telegram 更新主线程。

持久化 schema 变更不在运行时自动迁移。部署包含结构变更的版本前，应先手工迁移 `state.json` 与对应 `memory/` 快照；任一必需快照不符合当前结构时机器人会拒绝启动，避免用部分状态或空状态覆盖原文件。

`bot.lock` 以严格的 `pid:sha256(token)` 格式记录运行实例。数据目录全局独占：
只要存在活跃 PID，无论 token 相同还是不同，新实例都会拒绝启动。死 PID 会在
下一次启动或退出时清理。更新注册表时短暂出现
的 `.guard`、`.candidate.*` 和 `.tmp` 是并发保护文件，正常操作结束即删除。
锁格式不正确时不会自动猜测或迁移，请停掉相关进程后手工处理。

token 指纹只用于识别锁所有者，不是数据隔离边界。不同 Bot 需要并行部署时，
应使用彼此独立的项目目录，或为每个实例配置不同的 `COPY_NINJIA_DATA_ROOT`。

可靠性护栏包括：官方 SDK 类型边界、配置与持久化 JSON 逐字段校验、数据目录单实例锁、共享 Telegram API 限流/重试与必要的按群串行、Worker 崩溃节流自愈、失效 AI 轮次副作用拦截、反应队列硬顶、头像单执行槽与 latest-only 合并、后台 owner 有界 drain、媒体执行/排队/LRU 容量上限、JSON API 与媒体下载的流式字节上限，以及追加批次 fsync、原子落盘和严格恢复。跨模块生命周期约束见 [`docs/architecture.md`](docs/architecture.md)。

## 🧪 开发

```bash
bun run typecheck
bun run test
bun run check
```

测试必须通过 `bun run test` 执行；该入口强制启用文件隔离，避免 `mock.module` 和模块级状态污染其它测试文件。测试 preload 还会在任何生产模块加载前为每个隔离体创建独立临时数据根，因此未 mock 的真实文件 I/O 也不会读写生产 `state.json`、`bot.lock`、`logs/` 或 `memory/`，结束后临时目录会被清理。项目启用了 `strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` 等检查；`bun run check` 会让所有生产运行时模块进入覆盖率分母，未被专项测试触达的模块也按 0% 计入，函数和行覆盖率门槛均为 90%。新增共享协议放进 `src/types/`，调参值放进 `src/consts/`，运行时状态放进对应 `src/cache/`，避免业务文件继续长出游离状态。

---

<div align="center">

**Copy Ninjia** — 不是只会复读，是把整套群聊现场偷走再演一遍。

</div>
