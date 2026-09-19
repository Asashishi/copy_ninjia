[中文](zh.md) / [English](en.md) / [日本語](ja.md)

# 部署配置说明

本目录只保存可提交到 Git 的结构示例。机器人实际读取的是项目根目录下 Git 忽略的
`config/`；示例中的 token、API key、用户 ID、模型名和端点都需要按部署环境确认，
不能直接用于生产。

首次部署可以只补齐不存在的 JSON 文件；`g-auth.json` 示例只示意结构，`cron.json` 示例只示意
定时任务的写法，两者都不要复制：

```bash
mkdir -p config
for example in config_example/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" config/ ;;
  esac
done
```

不要使用会覆盖已有文件的复制命令，也不要把 `config_example/` 当作部署配置的备份。
`config/` 中包含凭据，建议只允许服务账号读取。运行中修改 `ad_samples.json`、
`agent.json`、`mood.json`、`stickers.json`、`cron.json` 会热重载，其余文件修改后必须重启，详见下文
「运行中修改」。白名单、黑名单和待完成处置不属于部署配置，统一保存在运行时数据根的
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
| `mood.json` | AI 心情、基础概率和天气/时段倍率 | AI 对话不能启用；已启用的群静默停摆，但不拒绝启动 |
| `ad_samples.json` | 广告分类器的正例参考 | 广告检测不能启用；已启用的群静默停摆，但不拒绝启动 |
| `cron.json` | 定时发送任务（文字、图片、文件） | 没有定时任务 |
| `g-auth.json` | `/translate` 使用的 Google Cloud 服务账号密钥；示例只有占位值，真实密钥由部署方带外放入 `config/` | 翻译不能开启；已开启的翻译会话不处理消息，但不拒绝启动 |

AI 对话还依赖不在本目录的 `prompt/persona.md`。任一可选配置文件已经存在但内容非法时，
即使对应功能当前关闭也会拒绝启动。

## 运行中修改

机器人监听 `config/`。`ad_samples.json`、`agent.json`、`mood.json`、`stickers.json`、
`cron.json` 最后一次保存约 0.5 秒后，按启动时同一套严格 schema 重新解析：

- 解析通过且内容有变化：替换快照并投给相关 Worker，日志记一行
  `Reloaded deployment config <路径>.`；在途的模型请求按旧配置完成。
- 解析失败：整份改动被拒绝，日志记一条带文件路径、字段路径与期望形态的错误，机器人
  继续使用上一份已生效配置。文件若一直不修，下次重启时启动总闸会拒绝启动。
- 新增或删除这四份文件、在 `agent.json` 里整段增删 `ad_detect`，或增删 `text`、
  `summary`、`media` 中任一项，直接改变对应功能的可用性：缺了前提的 AI 闲聊或广告检测
  立即停用并在日志记一行原因，群开关保持原值；补齐后自动恢复，无需重启。删除文件时日志
  记 `Deployment config <路径> was removed.`。`image`、`song` 的增删直接生效。
- `stickers.json` 新加入的贴纸包立即开始生成目录；移出的包不再供 AI 使用，其目录在
  下次重启时按白名单清理。
- `mood.json` 中仍然存在的心情对各群立即生效；当前心情已被删除的群在下次用到时重抽。
- `cron.json` 按任务名对账：内容没变的任务保留原有计时；改动或删除的任务停止调度，正在
  执行的那一轮在下一个动作前停下；新增的任务开始调度。删除文件等于清空全部任务。

`telegram.json`、`prompt/persona.md` 与 `g-auth.json` 不热重载，修改后须重启。

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
后续媒体仍可再探测。普通 Google/OpenAI HTTP 请求最多在首次失败后重试五次；`media`
被热重载替换或 Worker/进程重建后会重新探测。

## 撤掉凭据之前先关掉功能

某项能力在群里还开着，却把它的 API key 或配置撤掉了——进程**照常启动**，那个 `true` 也照常恢复，
但该功能在唯一判定入口上被判为不可用：启动时就缺前提则 AI 闲聊的 Worker 根本不启动（磁盘快照
原样留着），运行中撤掉则热重载后 Worker 闲置；`/translate` 会话停止处理消息，广告检测不再送检。
群里看到的就是机器人从那一刻（或那次重启）起再也不干活，痕迹只有 `logs/` 里的一行。正确顺序是
先在群里 `/ai_chat disable`、`/ad_detect disable` 或 `/translate disable`，再撤掉配置；或者把前提
补回去——AI 闲聊与广告检测会经热重载自动恢复，`g-auth.json` 补回后要重启。

**注意方向**：这只适用于文件**真的不存在**。文件还在但内容非法时，启动总闸照旧拒绝启动——
哪怕对应功能当前是关的。

## 身份策略与群状态不在 `config/`

白名单、黑名单、待完成处置和**每群状态**（功能开关、静默、锁定记录、机器人权限快照、
群名、中转标记）的权威源都是运行时数据根下的 `database/storage.sqlite`。群状态存放在
`chat_states` 表，最多 25 个群，超出时 `/init enable` 会以一句回执拒绝。`/white`、`/permission`、`/block … enable` 与 `/block … disable` 通过
Disk I/O Worker 事务写入；普通部署不应直接编辑数据库。权限键与默认值以
`/permission help` 为准，数据库 schema 非法、版本不匹配或两张名单存在交集都会在
联网前拒绝启动。旧 JSON 部署按 [运维文档](../../docs/cn/07-operations.md) 的一次性
迁移流程处理，不要把旧文件复制回 `config/`。

## `stickers.json`

`packs` 是允许 AI 使用的 Telegram 贴纸包 short name 数组，不是 `t.me` 链接。最多
配置 5 个，不能重复；空数组表示 AI 不使用配置贴纸包。Bot 必须能读取这些贴纸包。

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

## `g-auth.json`

示例与 GCP 控制台下载的服务账号密钥文件同形，只用于对照结构；占位私钥无法解析，
原样放进 `config/` 会拒绝启动。需要翻译时把真实密钥文件存为 `config/g-auth.json`；
不需要翻译就不要放这个文件。`client_email` 必须非空，`private_key` 必须是可解析的
RSA PEM 私钥；`type` 存在时只能是 `service_account`；`private_key_id`、`project_id`、
`quota_project_id`、`universe_domain` 存在时必须是非空字符串；其余官方字段原样交给
SDK。安装器不会从示例生成这个文件。

## `cron.json`

顶层是任务数组，缺省或 `[]` 表示没有定时任务。严格 JSON，不能写注释。

[`config_example/cron.json`](../cron.json) 收录了覆盖全部写法的示例任务：工作日发纯文字；显式写出
时区，依次发文字、网址图片和网址文件；按相对项目根的路径发送本地图片、按绝对路径发送本地文件；
`rand_cron` 区间从默认图库抽图；`@daily` 加单值 `rand_cron` 从指定目录抽图；以及 `just_once`。示例里的会话 id、地址和
本地路径都是假的，原样放进 `config/` 会因本地文件不存在而拒绝启动；按需挑任务、改成真实的会话 id
与路径后写进 `config/cron.json`。安装器不会从示例生成这个文件。

```json
[
  {
    "name": "daily-greeting",
    "chat_id": -1001234567890,
    "cron": "0 9 * * *",
    "time_zone": "Asia/Tokyo",
    "rand_cron": "6h-24h",
    "actions": [
      { "type": "send_message", "payload": { "content": "早上好" } },
      { "type": "send_image", "payload": { "content": "今日图", "rand_image": true } },
      { "type": "send_image", "payload": { "url": "https://example.com/a.png" } },
      { "type": "send_file", "payload": { "content": "周报", "path": "/srv/copy-ninjia/reports/weekly.pdf" } }
    ]
  }
]
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `name` | 是 | 非空、不超过 64 字符、全文件唯一；是任务身份，改名等于新任务 |
| `chat_id` | 是 | 目标会话 id（非零整数），或 `"all"`：所有能发送的已启用群，见下文 |
| `cron` | 是 | 5 段表达式或 `@daily` 这类写法；必须还有将来的触发时间 |
| `time_zone` | 否 | IANA 时区名（如 `Asia/Shanghai`），缺省 `Asia/Tokyo` |
| `rand_cron` | 否 | `"<最短>-<最长>"` 或单值（等于 `1m-<值>`），单位 m/h/d，范围 1m–24d；首次按 `cron` 触发，之后每轮结束再在区间内随机等待 |
| `just_once` | 否 | `true` 时只执行一次，重启后才会再次登记；不能与 `rand_cron` 同时使用 |
| `actions` | 是 | 1–16 个动作，按顺序执行，相邻两个间隔 1 秒 |

动作的 `type` 与 `payload`：

- `send_message`：`content` 必填，最长 4096 字符。
- `send_image`：`content` 可选（最长 1024 字符）。来源恰好一个：`url`，或 `path`（文件）；
  `rand_image: true` 时改为从目录随机抽一张，`path` 写目录，省略则用 `state.json` 的
  `global.assets.randomImageDir`（与 `/h_image` 同源），这时不能写 `url`。
- `send_file`：`content` 可选（最长 1024 字符），来源恰好一个 `url` 或 `path`。

`path` 写绝对路径，或相对项目根目录的路径（源码运行时项目根是仓库根，二进制运行时是服务的工作
目录），可以指向本机任何位置的文件或目录（符号链接按指向的对象判定）；加载时就
检查它是否存在、类型是否相符。服务账号能读到的文件都能被发进群里，不要指向 `config/`、`.env`
这类含凭据的文件。`url` 原样交给 Telegram 去拉取，本机
不下载：按地址发送时 Telegram 限制图片 5 MB、其它文件 20 MB，发送文件时只保证 PDF、ZIP、
GIF 可用，其余类型发不出去属于配置问题。本地上传的上限是图片 10 MB、文件 50 MB。

执行语义：

- 同一任务的两轮不会重叠；停机期间错过的触发不补发。`just_once` 的执行记录与 `rand_cron`
  的随机等待都只在内存里，重启后重新开始。
- 某个动作因网络、Telegram 5xx 或出站队列满失败时，按 2、4、8 秒退避最多重试 3 次；
  其余失败（如 Telegram 4xx、机器人被移出群、本地文件被删）不重试。最终失败时日志记一条
  `Cron task "<name>" action #<n> ...`，并跳过本轮剩下的动作。超时但 Telegram 实际已收到时，
  重试会重复发送一条。
- 定时消息长期保留，不做 30 秒删除；不带论坛话题，开了话题的群里发到 General。全部请求照常经过
  机器人的发送限速与 429 退避。
- 不要求目标群已 `/init`；机器人被移出目标群后，每次触发都会记一条错误日志。
- `chat_id: "all"`：每一轮开始时，对所有已 `/init enable` 的群逐个现查机器人此刻的发送权限
  （群主、管理员直接可发；被限制时看它自己的发送权限；普通成员看群的默认成员权限）。文字要能
  发消息、图片要能发图片、文件要能发文件，本任务用到的缺任何一项，整群跳过，不会只收到半套。
  可发送的群按 chat id 从小到大逐个执行整套动作，群与群之间同样间隔 1 秒；某个群最终失败只跳过
  该群剩下的动作，日志写明群 id，然后继续下一个群。有群被跳过时，本轮结束记一行
  `Cron task "<name>" skipped <n> chat(s) without send permission.`。随机图每个群各抽一张。

