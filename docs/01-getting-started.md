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
- **（可选）Gemini API Key**：从 [Google AI Studio](https://aistudio.google.com/) 获取；只有 `/ai_chat` AI 闲聊需要。
- **（可选）Google Cloud 服务账号 JSON**：只有 `/ja_copy` 日语翻译需要，存为项目根的 `g-auth.json`。缺失或写坏时 `/ja_copy` 直接拒绝并点名这个文件，自动复读的 ja 变换退化成普通复制；若已有群开着 `/ja_copy enable`，则拒绝启动。

## 安装

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
cp .env.example .env
cp -r config_example config
```

## 配置 `.env`

项目只读取下面 5 个环境变量，不存在未文档化的开关。变量名以所服务的功能打头（`AI_CHAT_` / `AD_DETECT_`），缺哪一把就只瘸对应的那个功能。其中 4 项凭据/身份配置由 [`packages/infra/config.ts`](../packages/infra/config.ts) 解析；`COPY_NINJIA_DATA_ROOT` 必须在运行时路径常量冻结前生效，因此由 [`packages/consts/paths.ts`](../packages/consts/paths.ts) 提前读取：

| 变量 | 必填 | 说明 |
| :--- | :---: | :--- |
| `TELEGRAM_BOT_TOKEN` | ✅ | BotFather 下发的 token |
| `AI_CHAT_GEMINI_API_KEY` | 可空 | Gemini API 密钥，AI 闲聊 agent 专用：`/ai_chat` 的回复生成、图片理解、记忆压缩。留空时 AI Worker 不启动、`/ai_chat enable` 与 `/switch_mood` 被拒绝，磁盘上的 AI 记忆原样保留，其余功能照常运行 |
| `AD_DETECT_DEEPSEEK_API_KEY` | 可空 | DeepSeek API 密钥（OpenAI 兼容接口），广告检测专用：`/ad_detect` 的判定。留空时 `/ad_detect enable` 被拒绝，其余功能照常运行 |
| `SUPER_ADMIN_USER_ID` | ✅ | 超级管理员，单个十进制用户 ID；拥有全部命令权限，且只有它能使用 `/init`、`/permission`、`/white` 与 `/send` |
| `COPY_NINJIA_DATA_ROOT` | 可空 | 运行时数据根目录；留空时数据落在项目根。详见 [07 运维与排障](07-operations.md#数据根) |

如需日语翻译，把服务账号密钥存为项目根目录的 `g-auth.json`。`.env` 与 `g-auth.json` 都已在 `.gitignore` 中。

## 项目侧配置文件

`config/` 是部署方自己的配置目录，已从 Git 追踪中排除；初次安装从 `config_example/` 复制，之后只改 `config/`，不要直接把示例目录当运行时配置。

| 文件 | 内容 | 校验 |
| :--- | :--- | :--- |
| [`prompt/persona.md`](../prompt/persona.md) | AI 闲聊的基础人设 | 纯文本，无 schema |
| `config/whitelist.json`（[示例](../config_example/whitelist.json)） | 用户/频道白名单及逐项权限；身份存在本身还代表 copy 冷却豁免、验证代点与自动处置保护 | [`packages/config/whitelist.ts`](../packages/config/whitelist.ts)；联网前严格加载，缺失或损坏会拒绝启动 |
| `config/blocklist.json`（[示例](../config_example/blocklist.json)） | 部署方手工维护的静态用户/频道黑名单 ID 数组 | [`packages/config/blocklist.ts`](../packages/config/blocklist.ts)；联网前严格加载，并与 `memory/` 动态层合并 |
| `config/stickers.json`（[示例](../config_example/stickers.json)） | AI 可用的贴纸包，最多 5 个 | [`packages/config/stickers.ts`](../packages/config/stickers.ts) |
| `config/reactions.json`（[示例](../config_example/reactions.json)） | AI 可用的 emoji 反应集合 | [`packages/config/reactions.ts`](../packages/config/reactions.ts) |
| `config/mood.json`（[示例](../config_example/mood.json)） | 心情档位：文案、权重与天气/时段倍率 | [`packages/config/mood.ts`](../packages/config/mood.ts)；权重必须是正整数且总和恰好 100 |
| `config/ad_samples.json`（[示例](../config_example/ad_samples.json)） | 广告检测的判定口径示例，顶层就是字符串数组 | [`packages/config/adSamples.ts`](../packages/config/adSamples.ts)；条目非空、不重复，最多 500 条 |

`whitelist.json` 与 `blocklist.json` 是全局安全边界，必须在联网和 Worker 启动前严格加载。其余四个 JSON 按功能惰性校验：一份写坏的贴纸配置不该让 copy、抽奖、入群验证和黑名单一起离线。`/ai_chat enable` 读前三份可选配置，`/ad_detect enable` 读 `ad_samples.json`，`/ja_copy enable` 读 `g-auth.json`；任一份读不动只拒绝对应开关。结论按进程缓存，修好文件要重启才生效。

### 从 2.1.0 升级

先停止旧进程并备份整个 `config/`；该目录从 3.0.0 起不再受 Git 追踪，直接更新工作树会移除旧版跟踪的四份文件。更新代码后，从备份恢复 `stickers.json`、`reactions.json`、`mood.json`、`ad_samples.json`，并从 `config_example/` 新增 `whitelist.json` 与 `blocklist.json`。

旧 `.env` 中每个 `PRIVILEGED_USERS_ID` 必须手工改成 `whitelist.json` 的键，然后删除该环境变量。只需要保留 copy 冷却豁免、验证代点和自动处置保护的身份可写成空对象 `{}`；要保持旧版 `/block` 与 `/unblock` 能力则显式写入 `"isCanBlock": true`、`"isCanUnBlock": true`。其它权限按需开启，完整键与说明可由超级管理员执行 `/permission help` 查看。`/white` 与 `/permission` 会原子改写该文件，因此运行用户必须对 `config/` 目录拥有写权限；其余配置仍可只读。

**例外：功能已经开着的时候仍然拒绝启动。**`state.json` 里那个 `true` 是管理员当初明确按下的，把它悄悄降级成「静默不干活」，群里看到的就是机器人从某次重启起再也不闲聊/不抓广告/不翻译。因此启动时会核对一次：凡是还有群开着的可选功能，凭据与配置必须齐备，缺了就带着群 id 和缺失项拒绝启动（见 [`packages/app/featurePreflight.ts`](../packages/app/featurePreflight.ts)）。出路是补回前提，或者先 `/ai_chat disable`、`/ad_detect disable`、`/ja_copy disable` 再撤掉它。

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
