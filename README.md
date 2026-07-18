<div align="center">

<a href="https://t.me/copy_ninjia_bot">
  <img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="128" alt="Copy Ninjia Bot 当前头像">
</a>

# 🥷 Copy Ninjia

### 会偷头像、会复读、会看图、会守群，还会一本正经损人的 Telegram 群聊机器人

由 **Asashishi** 与 **Claude Code**、**Codex**、**Antigravity** 共同开发

[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=fff)](https://www.typescriptlang.org/)
[![grammY](https://img.shields.io/badge/Telegram-grammY-26a5e4?logo=telegram&logoColor=fff)](https://grammy.dev/)
[![Gemini](https://img.shields.io/badge/AI-Gemini_3.1_Flash_Lite-8e75ff?logo=google&logoColor=fff)](https://ai.google.dev/)

复读与人格模仿只是表面；底下是一套多 Worker、可恢复、有界缓存、带竞态防护的群聊自动化系统。

</div>

---

## ✨ 它能做什么

| 能力 | 说明 |
| --- | --- |
| 🪞 精准复读 | 锁定用户或频道后逐条复读，支持原样、反转、加「喵~」、翻译日语四种模式 |
| 🥷 偷头像 | `/copy` 自动换成目标头像；`/steal_icon` 也能只偷头像、不进入复读状态 |
| 🤖 AI 群聊 | Gemini 人设回复、实时 Google 搜索、东京天气工具、文字/贴纸/反应统一 function calling |
| 👁️ 多模态理解 | 识别图片、静态/动态贴纸和 GIF 封面帧；占位先入上下文，异步描述后原位回填 |
| 🧠 群聊记忆 | 50～100 条逐字上下文 + 最多 5 轮压缩摘要，并定期原子落盘恢复 |
| 🛡️ 入群验证 | 新成员 90 秒按钮验证，支持机器人由白名单用户代点、管理员拉人豁免、评论区感知 |
| 🚨 Anti-Raid | 60 秒内第 46 位新人触发 5 分钟邀请锁定，重启后自动接管并恢复原权限 |
| 🎲 今日运势 | Telegram Inline Mode 抽签，按东京日期缓存，选中或签名回执确认后落盘，同日结果稳定 |
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
                       ┌───────────┬───────────┬───────────┐
                       ▼           ▼           ▼           ▼
                  发文字消息    添加反应    查看贴纸包    发送贴纸
```

- 模型：回复、摘要、视觉描述均使用 `gemini-3.1-flash-lite`。
- 触发：回复机器人或 `@机器人` 时触发；普通文字和媒体评价默认概率为 `1/7`。
- 同群并发：每群最多 5 轮 Gemini 工具对话在途；直接触发进入有界队列，随机触发在满载时丢弃。
- 限频：每群 5 分钟最多启动 150 轮；超限提示本身也有冷却。
- 工具：同一请求真实注册内置 `googleSearch`，并提供东京天气、`send_message`、`add_reaction`、`view_sticker_pack`、`send_sticker` 等函数工具；提示词要求需要查证时先搜索再行动。
- 时间：每次请求注入东京当前时间，每条转录消息保留记录时刻。
- 记忆：50～100 条逐字消息，加最多 5 × 50 条冷历史摘要，总跨度约 300～350 条；Worker 最多常驻 100 个群，超出按最后活动时间淘汰并删除磁盘快照。
- 多模态：图片描述最多 120 字，贴纸/GIF 最多 100 字；未命中本地贴纸目录的媒体共享 1500 项 LRU 去重缓存（命中即续命，超额淘汰最久未使用的一项，不设 TTL）。`memory/stickers/` 中配置包的描述启动后常驻内存，仅在线上贴纸包对账发现更新时增删，群消息里的同款贴纸会直接命中该目录。
- 压缩背压：每群最多保留 4 个压缩任务，API 长时间变慢时有界降级，不无限堆积消息批次。

人设在 [`prompt/persona.md`](prompt/persona.md)，贴纸包和反应集合分别在 [`config/stickers.json`](config/stickers.json) 与 [`config/reactions.json`](config/reactions.json)。

## 🛡️ 入群验证与 Anti-Raid

守群功能只在机器人拥有群管理员权限时运行：没有删消息、踢人权限时不会假装启动一套注定失败的流程。

- 新成员需在 90 秒内点击验证按钮；超时会删除验证期内追踪到的消息并踢出，但不永久封禁。
- 管理员/群主身份、管理员或白名单用户拉入的成员可豁免。
- 其他机器人也必须验证，由白名单用户代点作保。
- 关联频道评论区会识别“留言导致自动入群”的场景，并把按钮锚定到频道侧可见的评论线程。
- 最近 60 秒入群人数超过 45 时进入 5 分钟锁定，临时关闭普通成员邀请权限。
- 权限写入按群串行，恢复失败每 30 秒重试；锁定状态写入 `state.json`，进程重启后继续剩余计时。
- 管理员表与关联频道缓存都有 TTL、500 群硬顶和周期淘汰，不按历史群数永久增长。

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
| `/ja_copy enable\|disable` | `SUPER_ADMIN_USER_ID` | 开关本群日语翻译能力 |
| `/init enable\|disable` | `SUPER_ADMIN_USER_ID` | 开关本群整个业务处理入口 |
| `/send <群组id>` `/send finish` | `SUPER_ADMIN_USER_ID`（仅私聊） | 与机器人私聊时开启/结束一轮中转：期间这个私聊发的每条消息都会原样转发进目标群一次。开启前会先探一次目标是否可达，中转期间目标失联会自动终止并告知。中转状态随 `state.json` 持久化，重启不丢；不进 Telegram 命令菜单，群里或非本人触发均无任何反应 |

`/luck_challenge` 不占斜杠命令：在任意聊天输入 `@机器人用户名 [所求事项]` 使用 Inline Mode。需在 BotFather 开启 Inline Mode，并建议通过 `/setinlinefeedback` 开启 100% 结果反馈。内联查询采用全局滑动窗口限流，每 90 秒最多应答 300 次。

## 🚀 快速开始

### 1. 环境

- Bun 1.3+
- Telegram Bot Token
- Gemini API Key
- Google Cloud 服务账号 JSON（仅 `/ja_copy` 需要）
- 推荐生产起步：4 vCPU（程序吃 4 个内核线程，不满足可能造成更多切换开销，没有 4 个也能跑） / 2 GB RAM；单实例建议控制在约 15 个 1000-3000 人的活跃群以内（TG单Bot的API请求限制，不是架构能处理的并发上限）

### 2. 安装

```bash
git clone <your-repository-url>
cd copy_ninjia
bun install
cp .env.example .env
```

### 3. 配置

按 [`.env.example`](.env.example) 填写 `.env`；所有变量均为必填项。用户 ID
使用 Telegram 的十进制数字 ID，`PRIVILEGED_USERS_ID` 多项之间用英文逗号分隔。

如需日语翻译，将 Google Cloud 服务账号密钥保存为项目根目录的 `g-auth.json`。`.env` 与 `g-auth.json` 均已加入 `.gitignore`。

Telegram 侧还需要按功能配置：

1. 关闭 Bot Privacy Mode，机器人才能观察完整群消息并复读普通成员。
2. 授予删消息、封禁成员、管理群权限，入群验证和 Anti-Raid 才会启用。
3. 启用 Inline Mode 才能使用运势抽签。
4. 启用 inline feedback，抽签结果才能可靠确认并落盘。

### 4. 启动与检查

```bash
bun run check     # TypeScript 严格检查 + 全部测试
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
│
├── AI Worker
│   ├─ Gemini 多轮工具调用
│   ├─ 对话滚动、摘要压缩、视觉理解
│   └─ 分群冷却、限频与回复单飞
│
├── Anti-Raid Worker
│   ├─ 验证状态机
│   ├─ 锁定状态机
│   └─ Telegram 管理副作用解释器
│
└── Disk I/O Worker
    ├─ error 日志
    ├─ AI 记忆 / 贴纸目录原子快照
    └─ 每日运势追加文件与截断修复
```

关键目录：

| 路径 | 职责 |
| --- | --- |
| `src/commands/` | 显式命令处理 |
| `src/auto/` | 自动复读、AI 记录与触发、反应同步 |
| `src/states/` | 无 I/O 的验证与锁定纯状态机 |
| `src/libs/` | 原子文件、有界 I/O、严格 schema 解码及通用并发工具 |
| `src/workers/` | AI、守群、磁盘三个独立 Worker |
| `src/ai/` | Gemini、视觉、贴纸目录及工具 |
| `src/infra/` | Telegram、状态、日志、Worker 宿主 |
| `src/cache/` | 按领域拆分的运行时状态容器 |
| `src/consts/` | 调参常量与路径 |
| `src/types/` | 跨模块协议与领域类型 |
| `test/` | 与源码结构对应的 Bun 单元测试 |

## 💾 数据与可靠性

| 数据 | 位置 | 写入策略 |
| --- | --- | --- |
| 群状态 / copy 状态 / 锁定镜像 | `state.json` | 只保留“在写 + 最新待写”两份快照，失败后台重试，临时文件 + fsync + 原子 rename |
| AI 群聊记忆 | `memory/ai/` | 每群独立快照，30 秒周期 + 停机 flush |
| 贴纸描述目录 | `memory/stickers/` | 每包独立原子快照；启动恢复后常驻内存，与线上贴纸包对账时更新，并供群消息解析复用 |
| 今日运势 | `memory/luck/` | 按东京日期增量追加，启动时修复尾部截断 |
| error 日志 | `logs/` | Disk I/O Worker 统一批量追加 |
| 运行实例 | `bot.lock` | 原子维护的多 Bot 进程注册表 |

`memory/` 含群聊逐字内容，应视为敏感数据；请限制目录权限、备份范围与保留周期。`logs/`、`memory/`、`state.json`、凭据和运行锁均不会提交到 Git。

持久化 schema 变更不在运行时自动迁移。部署包含结构变更的版本前，应先手工迁移 `state.json` 与对应 `memory/` 快照；任一必需快照不符合当前结构时机器人会拒绝启动，避免用部分状态或空状态覆盖原文件。

`bot.lock` 以严格的 `pid:sha256(token)` 格式记录运行实例。数据目录全局独占：
只要存在活跃 PID，无论 token 相同还是不同，新实例都会拒绝启动。死 PID 会在
下一次启动或退出时清理。更新注册表时短暂出现
的 `.guard`、`.candidate.*` 和 `.tmp` 是并发保护文件，正常操作结束即删除。
锁格式不正确时不会自动猜测或迁移，请停掉相关进程后手工处理。

token 指纹只用于识别锁所有者，不是数据隔离边界。不同 Bot 需要并行部署时，
应使用彼此独立的项目/数据目录。

可靠性护栏包括：官方 SDK 类型边界、外部 JSON 逐字段校验、按 token 的实例注册表、按群 API 串行、Worker 崩溃节流自愈、失效 AI 轮次副作用拦截、反应队列硬顶、媒体缓存 LRU 容量上限、HTTP 响应流式大小限制，以及原子落盘和严格恢复。

## 🧪 开发

```bash
bun run typecheck
bun test
bun run check
```

项目启用了 `strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` 等检查；`bun run check` 还要求函数与行覆盖率均不低于 80%。新增共享协议放进 `src/types/`，调参值放进 `src/consts/`，运行时状态放进对应 `src/cache/`，避免业务文件继续长出游离状态。

---

<div align="center">

**Copy Ninjia** — 不是只会复读，是把整套群聊现场偷走再演一遍。

</div>
