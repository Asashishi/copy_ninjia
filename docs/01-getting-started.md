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
- **（可选）AI 闲聊供应商密钥**：只有 `/ai_chat` AI 闲聊需要，两家任选其一。默认走 Gemini，从 [Google AI Studio](https://aistudio.google.com/) 获取；缺 Gemini 那把时降级到 OpenAI，从 [OpenAI Platform](https://platform.openai.com/) 获取。
- **（可选）DeepSeek API Key**：从 [DeepSeek 开放平台](https://platform.deepseek.com/) 获取；只有 `/ad_detect` 广告检测需要。它与 AI 闲聊那两把职责不重叠、互不回退。
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

- **`TELEGRAM_BOT_TOKEN`**（必填）
  - BotFather 下发的 token。
- **`AI_CHAT_GEMINI_API_KEY`**（可空）
  - Gemini API 密钥，AI 闲聊 agent 的默认供应商：`/ai_chat` 的回复生成、图片理解、记忆压缩与生图。
- **`AI_CHAT_OPENAI_API_KEY`**（可空）
  - OpenAI API 密钥，AI 闲聊 agent 的降级供应商，能力与 Gemini 那份一一对应。
    `AI_CHAT_GEMINI_API_KEY` 留空时整条线降级到它。两把都配齐时默认仍走 Gemini，
    但超级管理员可以用 `/image_model gpt` 与 `/chat_model gpt` 把「生图」和「回复 +
    总结 + 看图」两半各自指过来（选择落进 `state.json` 的 `global.model`）。
    进程不做自动故障切换——换家只发生在这两条命令上。
    切换前需要知道三处不对等：OpenAI 侧没有可调的内容过滤档位（Gemini 侧四类全开
    `BLOCK_NONE`），生图只有三种画幅（十档宽高比按最近邻收敛），采样温度不可调
    （GPT-5 系推理模型只接受默认值，查证后降温与摘要低温两条策略不生效）。
  - 上面两把 AI 密钥是「或」的关系：**两把都留空**时 AI Worker 才不启动，
    `/ai_chat enable`、`/query_mood` 与 `/switch_mood` 被拒绝；磁盘上的 AI 记忆原样保留，
    其余功能照常运行。
- **`AD_DETECT_DEEPSEEK_API_KEY`**（可空）
  - DeepSeek API 密钥（OpenAI 兼容接口），供 `/ad_detect` 广告判定使用。留空时
    `/ad_detect enable` 被拒绝，其余功能照常运行。
- **`SUPER_ADMIN_USER_ID`**（必填）
  - 单个十进制超级管理员用户 ID。这个身份本身即持有 `whitelist.json` 能授予的
    **全部**逐项权限，**不需要**在 `whitelist.json` 里另配一条；它同时恒在白名单
    边界内，因此也享有 copy 冷却豁免、验证代点与自动处置保护，并且不可被 `/block`、
    `/mute` 或 `/batch_kick` 处置。
  - 另有五项只认身份、无法通过 `whitelist.json` 授予：`/init`、`/batch_kick`、
    `/permission` 的修改操作、`/white` 与 `/send`。
  - 白名单身份可用 `/permission query` 查询自身权限，并用 `/permission help` 查看说明；
    超级管理员的 `query` 返回那份逐项全开的视图。
- **`COPY_NINJIA_DATA_ROOT`**（可空）
  - 运行时数据根目录；留空时数据落在项目根。详见
    [07 运维与排障](07-operations.md#数据根)。

如需日语翻译，把服务账号密钥存为项目根目录的 `g-auth.json`。`.env` 与 `g-auth.json` 都已在 `.gitignore` 中。

## 项目侧配置文件

`config/` 是部署方自己的配置目录，已从 Git 追踪中排除；初次安装从 `config_example/` 复制，之后只改 `config/`，不要直接把示例目录当运行时配置。

- **[`prompt/persona.md`](../prompt/persona.md)**
  - **内容**：AI 闲聊的基础人设。
  - **校验**：纯文本，无 schema。
- **`config/whitelist.json`**（[示例](../config_example/whitelist.json)）
  - **内容**：用户/频道白名单及逐项权限；身份存在本身还代表 copy 冷却豁免、
    验证代点与自动处置保护。`SUPER_ADMIN_USER_ID` 不必也不应写进这里——它的
    全部权限由身份直接给出，写进来的条目永远不会被读到。
  - **校验**：[`packages/config/whitelist.ts`](../packages/config/whitelist.ts)；
    联网前严格加载，缺失或损坏会拒绝启动。
- **`config/blocklist.json`**（[示例](../config_example/blocklist.json)）
  - **内容**：部署方手工维护的静态用户/频道黑名单 ID 数组。
  - **校验**：[`packages/config/blocklist.ts`](../packages/config/blocklist.ts)；
    联网前严格加载，并与 `memory/` 动态层合并。
- **`config/stickers.json`**（[示例](../config_example/stickers.json)）
  - **内容**：AI 可用的贴纸包，最多 5 个。
  - **校验**：[`packages/config/stickers.ts`](../packages/config/stickers.ts)。
- **`config/reactions.json`**（[示例](../config_example/reactions.json)）
  - **内容**：AI 可用的 emoji 反应集合。
  - **校验**：[`packages/config/reactions.ts`](../packages/config/reactions.ts)。
- **`config/mood.json`**（[示例](../config_example/mood.json)）
  - **内容**：心情档位，包括文案、权重与天气/时段倍率。
  - **校验**：[`packages/config/mood.ts`](../packages/config/mood.ts)；权重必须是正整数，
    且总和恰好 100。
- **`config/ad_samples.json`**（[示例](../config_example/ad_samples.json)）
  - **内容**：广告检测的判定口径示例，顶层就是字符串数组。
  - **校验**：[`packages/config/adSamples.ts`](../packages/config/adSamples.ts)；条目非空、
    不重复，最多 500 条。

- **`config/gemini.json`**（[示例](../config_example/gemini.json)）
  - **内容**：Gemini 四条流水线各自的模型名（`reply`、`summary`、`media`、`image`），
    全部必填。没有 `base_url`——Gemini 走官方 SDK，端点不可配，多写这个键会报错。
  - **校验**：[`packages/config/gemini.ts`](../packages/config/gemini.ts)。
    **代码里不再保留任何模型默认值**：缺文件、缺字段一律拒绝，握着
    `AI_CHAT_GEMINI_API_KEY` 却没有这份文件时 `/ai_chat enable` 会拒绝，已经开着
    AI 闲聊的部署则拒绝启动。有默认值就意味着「配错了也能跑起来」，而两边产出都
    「看起来正常」，运维要到对账时才发现自己以为换掉的模型从没生效过。

- **`config/openai.json`**（[示例](../config_example/openai.json)）
  - **内容**：两条 OpenAI 兼容线各自的接口地址与模型名——`ad_detect` 给广告检测，
    `ai_agent` 给 AI 闲聊那条 agent 流水线的 OpenAI 侧。**两个对象与其中的模型名全部
    必填**——代码里不再保留任何模型默认值，缺文件、缺段、缺模型名一律拒绝。可省略的
    只有两处端点：`ad_detect.base_url` 缺省走官方地址，`ai_agent.base_url` 缺省走 SDK
    自带端点（端点有公认默认值，模型没有）。Gemini 的模型另见上面的 `gemini.json`。
  - **校验**：[`packages/config/openai.ts`](../packages/config/openai.ts)；端点必须是
    http(s) 绝对地址，模型名必须非空，未知键一律报错——拼错的键若被无声忽略，
    运维会以为换了模型、实际还在跑旧的。

`whitelist.json` 与 `blocklist.json` 是全局安全边界，必须在联网和 Worker 启动前严格加载。其余六个 JSON 按功能惰性校验：一份写坏的贴纸配置不该让 copy、抽奖、入群验证和黑名单一起离线。`/ai_chat enable` 读贴纸/反应/心情三份，外加按凭据条件读 `gemini.json` 与 `openai.json` 的 `ai_agent` 段；`/ad_detect enable` 读 `ad_samples.json` 与 `openai.json` 的 `ad_detect` 段，`/ja_copy enable` 读 `g-auth.json`；任一份读不动只拒绝对应开关。结论按进程缓存，修好文件要重启才生效。

### 从 2.1.0 升级

先停止旧进程并备份整个 `config/`；该目录从 3.0.0 起不再受 Git 追踪，直接更新工作树会移除旧版跟踪的四份文件。更新代码后，从备份恢复 `stickers.json`、`reactions.json`、`mood.json`、`ad_samples.json`，并从 `config_example/` 新增 `whitelist.json`、`blocklist.json`、`gemini.json` 与 `openai.json`。

后两份是新增的**必需**配置：模型名与 OpenAI 兼容线的接口地址已经全部移出代码，`packages/config/{gemini,openai}.ts` 里一个默认值都不留。因此已经开着 `/ad_detect` 的部署缺 `openai.json` 会直接拒绝启动（该功能读它的 `ad_detect` 段），已经开着 `/ai_chat` 的部署则按握着哪把 key 分别要求 `gemini.json` 与 `openai.json` 的 `ai_agent` 段。照抄 `config_example/` 之后，务必把里面的模型名换成本部署真正要跑的那几个——示例值只保证结构正确，不保证你的账号有权调用。

旧 `.env` 中每个 `PRIVILEGED_USERS_ID` 必须手工改成 `whitelist.json` 的键，然后删除该环境变量。只需要保留 copy 冷却豁免、验证代点和自动处置保护的身份可写成空对象 `{}`；要保持旧版 `/block` 与 `/unblock` 能力则显式写入 `"isCanBlock": true`、`"isCanUnBlock": true`。其它权限按需开启；`SUPER_ADMIN_USER_ID` 不必迁进来，它的全部权限由身份直接给出（旧版把它写进白名单的部署可以留着不管，那条条目已经读不到了，也可以用 `/white <超管id> disable` 清掉）。白名单身份可执行 `/permission help` 查看完整键与说明，并用 `/permission query` 查询解析默认值后的自身完整权限。`/white` 与 `/permission` 的修改操作会原子改写该文件，因此运行用户必须对 `config/` 目录拥有写权限；其余配置仍可只读。

**例外：功能已经开着的时候仍然拒绝启动。**`state.json` 里那个 `true` 是管理员当初明确按下的，把它悄悄降级成「静默不干活」，群里看到的就是机器人从某次重启起再也不闲聊/不抓广告/不翻译。因此启动时会核对一次：凡是还有群开着的可选功能，凭据与配置必须齐备，缺了就带着群 id 和缺失项拒绝启动（见 [`packages/app/featurePreflight.ts`](../packages/app/featurePreflight.ts)）。出路是补回前提，或者先 `/ai_chat disable`、`/ad_detect disable`、`/ja_copy disable` 再撤掉它。

同一道闸还核对 `state.json` 里 `global.model` 的两项模型选取：**显式选过**的那一家，它的 API key 必须在，否则同样拒绝启动并点名字段路径与 env 名。写下它的 `/image_model`、`/chat_model` 当时要求两把 key 都在，事后 key 被撤掉只有「撤错了」或「忘了先切回去」两种解释，两种都该当场说破而不是静默换一家。从没设过的那一项不设防——缺省本就跟随凭据默认（Gemini 优先、缺席时 OpenAI）。

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
