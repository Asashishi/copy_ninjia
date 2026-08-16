[中文](zh.md) / [English](en.md) / [日本語](ja.md)

# 部署配置说明

本目录只保存可提交到 Git 的结构示例。机器人实际读取的是项目根目录下 Git 忽略的
`config/`；示例中的 token、API key、用户 ID、模型名和端点都需要按部署环境确认，
不能直接用于生产。

首次部署可以只补齐不存在的 JSON 文件：

```bash
mkdir -p config
cp -n config_example/*.json config/
```

不要使用会覆盖已有文件的复制命令，也不要把 `config_example/` 当作部署配置的备份。
`config/` 中包含凭据，建议只允许服务账号读取。配置在进程内不会热重载，手工修改后
必须重启。白名单、黑名单和待完成处置不属于部署配置，统一保存在运行时数据根的
`database/storage.sqlite`，只通过命令和显式迁移脚本修改。

所有 JSON 都按严格 schema 解析：文件只要存在，未知字段、拼错的字段、错误类型、
非法枚举或越界值都会在连接 Telegram 和启动 Worker 前导致启动失败，不会静默修正、
回退或忽略。真正缺省的可选能力按下面的功能边界处理。

## 文件与启动边界

| 文件 | 配置内容 | 缺失时的行为 |
| --- | --- | --- |
| `telegram.json` | Telegram Bot token 与唯一超级管理员 | 始终拒绝启动 |
| `agent.json` | 各项 AI 能力自己的 provider、凭据、端点和模型 | 由能力决定，见下文 |
| `stickers.json` | AI 可使用的贴纸包 | AI 对话不能启用；已启用的群静默停摆，但不拒绝启动 |
| `reactions.json` | AI 文本情绪到 Telegram reaction 的候选词 | AI 对话不能启用；已启用的群静默停摆，但不拒绝启动 |
| `mood.json` | AI 心情、基础概率和天气/时段倍率 | AI 对话不能启用；已启用的群静默停摆，但不拒绝启动 |
| `ad_samples.json` | 广告分类器的正例参考 | 广告检测不能启用；已启用的群静默停摆，但不拒绝启动 |

AI 对话还依赖 `prompt/persona.md`，日语翻译依赖项目根目录下的 `g-auth.json`；两者不在
本目录。任一可选配置文件已经存在但内容非法时，即使对应功能当前关闭也会拒绝启动。

## `telegram.json`

```json
{
  "bot_token": "replace-with-telegram-bot-token",
  "super_admin_user_id": 123456789
}
```

- `bot_token`：BotFather 发放的非空 Bot API token，属于敏感凭据。
- `super_admin_user_id`：唯一超级管理员的正安全整数 Telegram 用户 ID，不是用户名。
  该身份天然拥有全部可授予权限，不需要也不应再写入 SQLite 白名单表。

## `agent.json`

顶层只能有一个 `agent` 对象。每项能力独立选择协议、API key、端点和模型；不同能力
可以使用不同供应商，也可以重复填写同一把 key，但不存在跨能力继承或故障回退。

| 能力 | 实际用途 | 配置要求 |
| --- | --- | --- |
| `ad_detect` | 对消息束做广告判定 | 可选；缺失只阻止广告检测 |
| `text` | 生成群聊正文并执行工具调用 | AI 对话核心，必须与 `summary`、`media` 同时存在 |
| `summary` | 压缩长期对话记忆、生成贴纸包简介 | AI 对话核心，必须存在 |
| `media` | 识图、描述贴纸和转写语音 | AI 对话核心，必须存在 |
| `image` | 为 AI 注册生图工具 | 可选；缺失只移除生图工具 |
| `song` | 为 AI 注册生歌工具 | 可选；缺失或实现不支持只移除生歌工具 |

普通能力使用下面四个字段：

| 字段 | 含义 |
| --- | --- |
| `provider` | 调用协议，只能是 `google` 或 `openai`；它不是模型品牌名 |
| `api_key` | 这一项能力自己的非空 API key |
| `base_url` | 可选的绝对 `https` 端点；省略时使用对应 SDK 的官方端点。明文 `http` 只允许 `localhost`、`127.0.0.1`、`::1`（本机代理），其余一律拒绝启动——这个字段旁边就是同一项能力的 `api_key`。URL 里不得带用户名/密码，也不得带 `#` 片段 |
| `model` | 端点实际接受的非空模型标识，不由程序猜测或改写 |

OpenAI 兼容服务（例如使用 xAI 或其他兼容网关）仍填写 `provider: "openai"`，并在该
能力自己的 `base_url` 和 `model` 中写明端点与模型。`provider` 只决定请求协议和 SDK，
不会根据模型名或 URL 自动切换。

`image` 在 `provider: "openai"` 时还必须配置 `image_protocol`，明确生图请求体：

- `openai`：OpenAI `gpt-image-2` 任意尺寸协议。
- `openai-standard`：GPT Image 系列共同支持的标准尺寸协议。
- `xai`：xAI 的 JSON 与画幅协议。

`image.provider` 为 `google` 时禁止填写 `image_protocol`。当前只有 Google 实现了生歌，
所以 `song.provider` 选择 `openai` 虽能通过通用配置校验，但不会注册生歌工具。

`media` 的视觉与语音输入支持度分别在第一次真实请求时探测和缓存。明确不支持后，
当前 Worker 生命周期内不再下载该类媒体；成功后记为支持；网络等瞬时错误保持未知，
后续媒体仍可再探测。普通 Google/OpenAI HTTP 请求最多在首次失败后重试五次，配置
修改或 Worker/进程重建后会重新探测。

## 撤掉凭据之前先关掉功能

某项能力在群里还开着，却把它的 API key 或配置撤掉了——进程**照常启动**，那个 `true` 也照常恢复，
但该功能在唯一判定入口上被判为不可用：AI 闲聊的 Worker 根本不启动、记忆不 hydrate（磁盘快照
原样留着），`/ja_copy` 退化成普通复制，广告检测不再送检。群里看到的就是机器人从某次重启起
再也不干活，痕迹只有 `logs/` 里的一行。正确顺序是先在群里 `/ai_chat disable`、
`/ad_detect disable` 或 `/ja_copy disable`，再撤掉配置；或者把前提补回去。

**注意方向**：这只适用于文件**真的不存在**。文件还在但内容非法时，启动总闸照旧拒绝启动——
哪怕对应功能当前是关的。

## 身份策略与群状态不在 `config/`

白名单、黑名单、待完成处置和**每群状态**（功能开关、静默、锁定记录、机器人权限快照、
群名、中转标记）的权威源都是运行时数据根下的 `database/storage.sqlite`。群状态存放在
`chat_states` 表，最多 25 个群，超出时 `/init enable` 会以一句回执拒绝。`/white`、`/permission`、`/block` 与 `/unblock` 通过
Disk I/O Worker 事务写入；普通部署不应直接编辑数据库。权限键与默认值以
`/permission help` 为准，数据库 schema 非法、版本不匹配或两张名单存在交集都会在
联网前拒绝启动。旧 JSON 部署按 [运维文档](../../docs/cn/07-operations.md) 的一次性
迁移流程处理，不要把旧文件复制回 `config/`。

## `stickers.json`

`packs` 是允许 AI 使用的 Telegram 贴纸包 short name 数组，不是 `t.me` 链接。最多
配置 5 个，不能重复；空数组表示 AI 不使用配置贴纸包。Bot 必须能读取这些贴纸包。

## `reactions.json`

`emotionKeywords` 把 Telegram 支持的标准 reaction emoji 映射到非空关键词数组。
模型输出命中关键词时会选择对应 reaction；自定义 emoji、空关键词和非字符串条目
都会被拒绝。

## `mood.json`

`moods` 必须是非空数组，每项含：

- `name`：唯一的非空心情名。
- `weight`：正整数基础权重；所有心情的 `weight` 总和必须恰好为 100，可直接按百分比理解。
- `instruction`：该心情注入 AI 的非空行为说明。
- `weatherMultipliers`：可选天气倍率；键只允许 `clear`、`cloudy`、`rain`、`snow`、
  `storm`、`fog`。
- `timeMultipliers`：可选东京时段倍率；键只允许 `lateNight`、`morning`、`daytime`、
  `evening`、`night`。

倍率省略时按 `1` 计算，存在时必须是大于 0 且不超过 100 的有限数。倍率只调整当次
抽取概率，不改变基础权重总和必须为 100 的约束。

## `ad_samples.json`

顶层直接是字符串数组，每条是“应当被判为广告”的正例原文，用来给 `ad_detect` 模型
定义部署方的广告口径，不是命中词黑名单。最多 500 条；每条去除并合并空白后必须
非空、不重复且不超过 1,024 个字符。应使用去标识化样本，不要放入无关个人信息或
真实凭据。
