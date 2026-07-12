# copy_ninjia

一个基于 [grammY](https://grammy.dev/) 的 Telegram 群聊复读机机器人：锁定某个用户/频道后逐条复读其消息，支持文本反转、加喵~后缀、日语翻译三种复读变体，并附带入群验证、反刷群私密模式、AI 闲聊等群管理功能。

## 功能特性

- **复读（Copy）**：通过 `/copy`（回复目标消息，或 `/copy @username`）锁定某个用户或频道，之后 TA 发的每条消息都会被机器人复读一遍。
  - `/copy` — 原样复读
  - `/r_copy` — 复读并按字形簇反转文本
  - `/nya_copy` — 复读并在文本末尾追加 " 喵~"
  - `/ja_copy` — 复读并翻译为日语（基于 Google Cloud Translate）
  - `/stop` — 停止当前复读
  - `/kick` — 将目标移出群聊并永久封禁（仅白名单用户可用）
- **消息反应同步**：复读目标消息收到的 reaction 会同步复制到复读出来的消息上。
- **入群验证**：新成员需在限定时间内发送指定验证文本，否则自动踢出。
- **反刷群（Anti-Raid）**：短时间内入群人数超过阈值时，自动临时开启私密模式（禁止普通成员拉人），到期后恢复原权限。
- **AI 闲聊**：基于 DeepSeek API 和自定义人设（`prompt/persona.txt`），概率性地在群里生成闲聊回复；回复机器人或 @ 机器人时必回，纯按概率命中的随机搭话则不挂 Telegram 回复引用，改为在文字里点名称呼触发者。
  - 内置基础工具（`src/tools/`）供模型按需调用：查当前时间（东京时区）、查东京今日天气（Open-Meteo，1 小时缓存）。时间类问题会把真实时间直接注入上下文，保证不瞎编。
  - 上下文为本群最近 75 条消息的滚动缓存（仅内存）；机器人发出的回复和贴纸会自录入缓存，并在提示词中注明自己的账号（@username + id），能在上下文中认出自己说过的话、以及谁在 @ 或回复自己。
  - 群友发的贴纸以元数据描述行（情绪 emoji、所属贴纸包）记入上下文，供模型参考情绪走向，不触发回复。
  - 分群三重限频：1.5 秒冷却 + 每分钟最多 45 次 + 每 5 分钟最多 150 次（滑动窗口），超限的触发静默丢弃，防止恶意刷屏烧穿 API 配额。
- **应景贴纸**：每次 AI 回复后，按概率（默认 1/2）从白名单贴纸包里挑一枚跟发。按回复文本命中的情绪关键词匹配贴纸的 emoji 元数据来做到「应景」，没命中就随机挑。白名单、概率、关键词映射见 `config/stickers.json`，改配置不需要碰代码。
- **应景反应**：AI 回复触发时（含随机搭话），按概率（默认 1/3）给触发消息扣一个应景的 emoji 反应，情绪匹配逻辑同上。emoji 限于 Telegram 允许 bot 设置的固定反应表情集合，配置见 `config/reactions.json`。
- **`/balance`**：查询当前 DeepSeek API Key 绑定账号的余额，结果缓存 30 秒，避免连续查询触发接口限流。
- **多群独立状态**：每个群聊的复读目标、冷却时间等状态互相独立，重启后从 `state.json` / `users.json` 恢复。

## 环境要求

- [Bun](https://bun.com) 运行时
- Telegram Bot Token（通过 [@BotFather](https://t.me/BotFather) 获取）
- DeepSeek API Key（用于 AI 闲聊功能）
- Google Cloud 服务账号凭据（用于 `/ja_copy` 日语翻译功能，`g-auth.json`）

## 安装

```bash
bun install
```

## 配置

复制 `.env.example` 为 `.env`，并填写以下变量：

| 变量名 | 说明 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `PRIVILEGED_USERS_ID` | 白名单用户 ID，多个用逗号分割（可免受 `/copy` 冷却限制、使用 `/kick`） |
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥，供 AI 闲聊功能使用 |

日语翻译功能还需要将 Google Cloud 服务账号密钥文件放置为项目根目录下的 `g-auth.json`（已加入 `.gitignore`，不会被提交）。

## 运行

```bash
bun run index.ts
```

## 项目结构

```
index.ts               # 入口：注册命令/更新处理器，启动 grammY runner
src/
  telegram.ts           # Telegram Bot API 封装与限流
  handlers.ts           # 复读/踢人/余额查询等命令与消息处理逻辑
  copyModes.ts           # 反转 / 喵~ / 日语翻译等复读文本变换
  translate.ts           # Google Cloud Translate 封装
  joinVerification.ts    # 入群验证逻辑
  antiRaid.ts             # 反刷群私密模式
  aiChat.ts               # AI 闲聊入口（主线程侧代理，向 AI Worker 投递事件）
  aiChatWorker.ts          # AI 闲聊流水线 Worker 线程（限频、DeepSeek 调用、发送）
  stickers.ts             # AI 回复后概率跟发应景贴纸（白名单见 config/stickers.json）
  reactions.ts            # AI 回复触发时概率给触发消息扣应景 emoji 反应（config/reactions.json）
  stickerSets.ts          # 贴纸包拉取缓存 + 情绪关键词匹配等公共积木
  tools/                  # 供 aiChatWorker.ts 调用的 AI 工具
    index.ts               # 工具定义清单 + 按名分发执行
    time.ts                 # 查当前时间（东京时区）
    weather.ts               # 查东京今日天气（Open-Meteo，1 小时缓存）
  deepseekBalance.ts       # 查询 DeepSeek 账户余额（30 秒缓存），供 /balance 使用
  reactionQueue.ts        # 消息反应同步队列
  linkedQueue.ts          # 通用链式队列
  storage.ts              # 状态持久化（state.json / users.json）
  userLabel.ts            # 用户显示名格式化
  logger.ts                # 统一日志门面，error 级别经 Worker 线程按日落盘
  loggerWorker.ts           # 日志落盘 Worker 线程
  config.ts               # 环境变量读取
  types.ts                # 共享类型定义
prompt/persona.txt       # AI 闲聊人设文本
config/
  stickers.json           # 应景贴纸配置：贴纸包白名单、触发概率、情绪关键词映射
  reactions.json          # 应景反应配置：触发概率、情绪关键词 -> 反应 emoji 映射
```

本项目基于 `bun init`（Bun v1.3.14）创建。
