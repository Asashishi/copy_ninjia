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
必须重启；`whitelist.json` 由 `/white` 和 `/permission` 命令原子改写，进程运行时不要
再从外部同时编辑它。

所有 JSON 都按严格 schema 解析：文件只要存在，未知字段、拼错的字段、错误类型、
非法枚举或越界值都会在连接 Telegram 和启动 Worker 前导致启动失败，不会静默修正、
回退或忽略。真正缺省的可选能力按下面的功能边界处理。

## 文件与启动边界

| 文件 | 配置内容 | 缺失时的行为 |
| --- | --- | --- |
| `telegram.json` | Telegram Bot token 与唯一超级管理员 | 始终拒绝启动 |
| `whitelist.json` | 白名单身份及逐项权限 | 始终拒绝启动 |
| `blocklist.json` | 启动时加载的静态黑名单 | 始终拒绝启动 |
| `agent.json` | 各项 AI 能力自己的 provider、凭据、端点和模型 | 由能力决定，见下文 |
| `stickers.json` | AI 可使用的贴纸包 | AI 对话不能启用；若已有群启用则拒绝启动 |
| `reactions.json` | AI 文本情绪到 Telegram reaction 的候选词 | AI 对话不能启用；若已有群启用则拒绝启动 |
| `mood.json` | AI 心情、基础概率和天气/时段倍率 | AI 对话不能启用；若已有群启用则拒绝启动 |
| `ad_samples.json` | 广告分类器的正例参考 | 广告检测不能启用；若已有群启用则拒绝启动 |

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
  该身份天然拥有全部可授予权限，不需要也不应再写入 `whitelist.json`。

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

## `whitelist.json`

顶层键是 Telegram 身份 ID 的十进制字符串：正数表示用户，负数表示频道身份；值是
该身份的权限覆盖对象。权限字段可以省略，省略时使用默认值。空对象 `{}` 仍表示身份
在白名单内，并默认绕过广告检测和防刷屏，但不获得管理命令权限。

| 权限键 | 为 `true` 时允许 |
| --- | --- |
| `isCanMute` | 使用 `/mute` |
| `isCanUnMute` | 使用 `/unmute` |
| `isCanBlock` | 使用 `/block` 写入永久黑名单并在托管群封禁 |
| `isCanUnBlock` | 使用 `/unblock` 移出永久黑名单并解除封禁 |
| `isCanSwitchMood` | 使用 `/switch_mood` 重抽 AI 心情 |
| `isCanBypassAdDetection` | 绕过广告检测和自动处置；默认 `true` |
| `isCanBypassFloodControl` | 绕过防刷屏计数和自动禁言；默认 `true` |
| `isCanControllAIPermission` | 使用 `/ai_chat enable\|disable` |
| `isCanControllAdDetectPermission` | 使用 `/ad_detect enable\|disable` |
| `isCanControllFloodControlPermission` | 使用 `/flood_control enable\|disable` |
| `isCanControllJATranslatePermission` | 使用 `/ja_copy enable\|disable` |
| `isCanControllAntiRaidPermission` | 使用 `/antiraid enable\|disable` |

字段名中的 `Controll` 是当前 schema 的固定拼写，不能自行改成 `Control`。除上面两个
bypass 字段默认 `true` 外，其余权限默认 `false`。超级管理员权限来自
`telegram.json`，不受这里的条目影响。

## `blocklist.json`

`blockedIds` 是静态封禁身份数组。正安全整数表示用户，负安全整数表示频道身份；零、
小数、重复值和超出安全整数范围的值均非法。静态黑名单不能包含超级管理员或任何
白名单身份，否则会因安全边界冲突拒绝启动。`/block` 维护的运行时永久黑名单另存于
`memory/blocklist/`，不要把两者当成同一份文件。

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
