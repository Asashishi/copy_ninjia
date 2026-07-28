# 01 环境搭建与首次运行

<p align="center">
  <b>简体中文</b> · <a href="en/01-getting-started.md">English</a> · <a href="ja/01-getting-started.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 开发者文档首页</a> · <b>← 上一页：无</b> · <a href="02-architecture.md">下一页：02 架构总览 →</a>
</p>

---

本页把一个全新环境带到「机器人在群里正常工作」。只求最短路径；每一步背后的设计原因见 [02 架构总览](02-architecture.md)。

## 前置条件

- **Linux（带可读的 `/proc`）**：实例锁依赖 `/proc/<pid>/stat` 与 boot ID；其它平台会 fail-closed 拒绝启动。
- **Bun 1.3+**：`curl -fsSL https://bun.sh/install | bash`。项目所有脚本、测试与运行时都走 Bun，不需要 Node.js。
- **Telegram Bot Token**：找 [@BotFather](https://t.me/BotFather) `/newbot` 创建。
- **Gemini API Key**：从 [Google AI Studio](https://aistudio.google.com/) 获取。
- **（可选）Google Cloud 服务账号 JSON**：只有 `/ja_copy` 日语翻译需要。

## 安装

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
cp .env.example .env
```

## 配置 `.env`

项目只读取下面 6 个环境变量，不存在未文档化的开关。其中 5 项凭据/权限配置由 [`packages/infra/config.ts`](../packages/infra/config.ts) 解析；`COPY_NINJIA_DATA_ROOT` 必须在运行时路径常量冻结前生效，因此由 [`packages/consts/paths.ts`](../packages/consts/paths.ts) 提前读取：

| 变量 | 必填 | 说明 |
| :--- | :---: | :--- |
| `TELEGRAM_BOT_TOKEN` | ✅ | BotFather 下发的 token |
| `GEMINI_API_KEY` | ✅ | Gemini API 密钥，AI 闲聊 agent 专用：`/ai_chat` 的回复生成、图片理解、记忆压缩 |
| `DEEPSEEK_API_KEY` | 可空 | DeepSeek API 密钥（OpenAI 兼容接口），广告检测专用：`/ad_detect` 的判定。留空时 `/ad_detect enable` 被拒绝，其余功能照常运行 |
| `SUPER_ADMIN_USER_ID` | ✅ | 超级管理员，单个十进制用户 ID；`/init`、`/ai_chat`、`/ad_detect`、`/switch_mood`、`/send` 等只认它 |
| `PRIVILEGED_USERS_ID` | 可空 | 白名单用户，逗号分隔；豁免 copy 冷却、可用 `/block`、可为其他机器人担保验证 |
| `COPY_NINJIA_DATA_ROOT` | 可空 | 运行时数据根目录；留空时数据落在项目根。详见 [07 运维与排障](07-operations.md#数据根) |

如需日语翻译，把服务账号密钥存为项目根目录的 `g-auth.json`。`.env` 与 `g-auth.json` 都已在 `.gitignore` 中。

## 项目侧配置文件

| 文件 | 内容 | 校验 |
| :--- | :--- | :--- |
| [`prompt/persona.md`](../prompt/persona.md) | AI 闲聊的基础人设 | 纯文本，无 schema |
| [`config/stickers.json`](../config/stickers.json) | AI 可用的贴纸包，最多 5 个 | [`packages/config/stickers.ts`](../packages/config/stickers.ts) |
| [`config/reactions.json`](../config/reactions.json) | AI 可用的 emoji 反应集合 | [`packages/config/reactions.ts`](../packages/config/reactions.ts) |
| [`config/mood.json`](../config/mood.json) | 心情档位：文案、权重与天气/时段倍率 | [`packages/config/mood.ts`](../packages/config/mood.ts)；权重必须是正整数且总和恰好 100 |
| [`config/ad_samples.json`](../config/ad_samples.json) | 广告检测的判定口径示例，顶层就是字符串数组 | [`packages/config/adSamples.ts`](../packages/config/adSamples.ts)；条目非空、不重复，最多 500 条 |

四个 JSON 都走严格 schema 校验，启动时在联网之前预热；配错会直接拒绝启动并说明字段，不会带病运行。

## Telegram 侧配置（BotFather 与群内）

1. `/setprivacy` 关闭 Privacy Mode——否则机器人看不到普通群消息，复读与 AI 记忆都不工作。
2. 把机器人拉进群并授予管理员权限（删消息、封禁成员、管理群）——入群验证与 Anti-Raid 只在有权限时启用。
3. `/setinline` 开启 Inline Mode——运势抽签 `@机器人 所求事项` 依赖它。
4. `/setinlinefeedback` 设为 100%——`chosen_inline_result` 是抽签结果确认与落盘的主路径；消息内的签名回执是补充确认路径。

## 首次启动

```bash
bun run check     # 约定检查 + ESLint + tsc + 全源码覆盖率测试，首次跑一遍确认环境完好
bun run start     # 启动长轮询
```

启动成功后，由 `SUPER_ADMIN_USER_ID` 在目标群里执行：

```text
/init enable      # 打开本群业务入口；未 init 的群普通业务 update 在入口网关直接丢弃
/ai_chat enable   # （可选）打开本群 AI 闲聊
/ad_detect enable # （可选）打开本群广告检测；需要机器人在本群是管理员才会真正触发
```

## 验证跑通了

- 群里发 `/copy`（回复某人的消息）——机器人开始复读并同步头像。
- `logs/` 目录出现错误日志文件（无错误时可能为空）；`state.json` 在首个权威状态变更后生成。
- 停止用 `Ctrl+C`：进程会 quiesce 入口、drain 各队列、flush 状态后退出，属正常停机路径。

启动失败时（数据根预检、`bot.lock`、state 校验的报错都设计为快速失败），对照 [07 运维与排障](07-operations.md#启动失败排查) 处理。

---

<div align="center">

**← 上一页：无** · [📚 开发者文档首页](README.md) · [⬆️ 回到顶部](#01-环境搭建与首次运行) · [下一页：02 架构总览 →](02-architecture.md)

</div>
