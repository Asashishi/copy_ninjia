[中文](zh.md) / [English](en.md) / [日本語](ja.md)

# 部署配置说明

本目录保存可提交到 Git 的结构示例。机器人实际读取的是项目根目录下受 Git 忽略的 `config/` 目录。示例中的 token、API key、用户 ID、模型名和端点都需要按实际部署环境填写，**不能直接用于生产**。

首次部署可以只复制不存在的 JSON 文件；`g-auth.json` 示例只示意结构，`cron.json` 示例只示意定时任务写法，两者都不要直接复制：

```bash
mkdir -p config/static config/dynamic
for example in config_example/static/*.json config_example/dynamic/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" "config/${example#config_example/}" ;;
  esac
done
```

> [!CAUTION]
> 不要使用会覆盖已有文件的复制命令，也不要把 `config_example/` 当作部署配置的备份。`config/` 包含凭据，建议仅开放服务账号读取权限。

`config/` 严格按生效机制拆分为两个子目录：
- `config/static/`：`bot.json`、`g-auth.json`，修改后**必须重启服务**生效。
- `config/dynamic/`：`assets.json`、`ad_samples.json`、`agent.json`、`mood.json`、`stickers.json`、`cron.json`，运行中修改会自动热重载生效。

`config/dynamic/` 目录必须存在（可以为空）；任一配置文件放在 `config/` 顶层或放错子目录均会拒绝启动。白名单、黑名单和群状态保存在运行时数据根的 `database/storage.sqlite` 中，不属于配置文件。

所有 JSON 文件均执行严格 schema 校验：未知字段、拼写错误、类型不符、非法枚举或越界取值都会在启动阶段或热重载时被拒绝，**绝不静默修正或忽略**。

---

## 配置文件概览

<table width="100%">
<thead>
  <tr>
    <th width="22%" align="left">配置文件</th>
    <th width="16%" align="left">生效机制</th>
    <th width="36%" align="left">主要配置内容</th>
    <th width="26%" align="left">缺失时的运行行为</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><code>static/bot.json</code></td>
    <td><nobr>静态（需重启）</nobr></td>
    <td>Telegram Bot Token、唯一超级管理员、默认语气与时区</td>
    <td><b>拒绝启动（致命错误）</b></td>
  </tr>
  <tr>
    <td><code>dynamic/agent.json</code></td>
    <td><nobr>动态（热重载）</nobr></td>
    <td>各项 AI 模型的调用协议、凭据、端点与参数</td>
    <td>缺核心三项时 AI 闲聊停摆；缺可选时工具关闭</td>
  </tr>
  <tr>
    <td><code>dynamic/stickers.json</code></td>
    <td><nobr>动态（热重载）</nobr></td>
    <td>供 AI 发送的 Telegram 贴纸包 short name 列表</td>
    <td>AI 对话停摆（但不拒绝启动）</td>
  </tr>
  <tr>
    <td><code>dynamic/mood.json</code></td>
    <td><nobr>动态（热重载）</nobr></td>
    <td>AI 心情列表、抽取基础权重与环境倍率</td>
    <td>AI 对话停摆（但不拒绝启动）</td>
  </tr>
  <tr>
    <td><code>dynamic/ad_samples.json</code></td>
    <td><nobr>动态（热重载）</nobr></td>
    <td>广告分类判定用的正例参考样本</td>
    <td>广告检测停摆（但不拒绝启动）</td>
  </tr>
  <tr>
    <td><code>dynamic/cron.json</code></td>
    <td><nobr>动态（热重载）</nobr></td>
    <td>定时发送任务表（文字、图片、文件、语音、摘要）</td>
    <td>无定时任务调度</td>
  </tr>
  <tr>
    <td><code>dynamic/assets.json</code></td>
    <td><nobr>动态（热重载）</nobr></td>
    <td><code>/h_image</code> 专用图库路径、默认头像与缩略图直链</td>
    <td>全部取内置默认值</td>
  </tr>
  <tr>
    <td><code>static/g-auth.json</code></td>
    <td><nobr>静态（需重启）</nobr></td>
    <td>Google Cloud 翻译服务账号密钥（RSA PEM）</td>
    <td>翻译功能停摆（但不拒绝启动）</td>
  </tr>
</tbody>
</table>

> [!NOTE]
> AI 人设默认使用内置的雌小鬼人设；项目根目录下可放置不受版本控制的 `prompt/persona.md` 自定义人设，AI `send_voice` 的工具说明同样可用 `prompt/voice_tool.md` 整份替换，两者修改后须重启；示例见 [`prompt_example/persona.md`](../../prompt_example/persona.md) 与 [`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md)。全群通知与菜单优先采用显式 `atmosphere`；未配置时，自定义人设使用普通文案，内置人设使用雌小鬼文案。

---

## 运行中修改（热重载）

机器人持续监听 `config/dynamic/` 目录。目录最后一次文件事件之后，经 `CONFIG_RELOAD_DEBOUNCE_MS` 去抖窗口触发严格 schema 解析与热重载：

1. **热替换**：解析通过且配置产生变化时，立即更新快照并投递给各 Worker。
2. **校验失败保护**：解析失败时整份变更被拒绝，日志记录具体错误位置（文件路径、字段路径与期望形态），系统继续沿用上一份已生效配置，不中断运行。
3. **功能联动**：
   - 增删 `ad_samples.json` 或 `agent.json` 的 `ad_detect` 段，自动启停广告检测。
   - 增删 `agent.json` 核心三项（`text` / `summary` / `media`）或 `mood.json` / `stickers.json`，自动启停 AI 闲聊。
   - 可选能力（`image`、`tts`、`web_search`）的变更即时生效。
4. **跨配置依赖校验**：
   - `cron.json` 中的 `send_voice` 强依赖 `agent.tts`：未配 `tts` 时含语音的 cron 配置整份拒绝；任务表仍含 `send_voice` 时，去掉 `agent.tts` 的 `agent.json` 变更同样整份拒绝。
   - `send_web_digest` 强依赖对话核心能力，校验口径相同。启动时同一核对在 `cron.json` 之前校验 `agent.json`，缺依赖则拒绝启动。
5. **贴纸与图库**：
   - `stickers.json` 新增贴纸包立即开始异步建立描述目录；移出白名单的贴纸包不再使用，其集合缓存与已生成的目录随之清理。
   - `assets.json` 中 `random_h_image_dir` 改换路径时若新目录无效，整份变更拒绝。
6. **定时任务增量对账**：`cron.json` 按任务名 diff，未变动任务保持原有调度，修改或删除的任务停止调度，在途一轮在下一个动作、重试或群之前停下，新任务开始调度。

---

## `bot.json`

静态配置文件，路径为 `config/static/bot.json`。修改后必须重启服务生效。

### 配置案例

```json
{
  "bot_token": "replace-with-telegram-bot-token",
  "super_admin_user_id": 987654321,
  "atmosphere": "mesugaki",
  "time_zone": "Asia/Tokyo"
}
```

### 键说明

| 键名 | 类型 | 必填/可选 | 约束与取值范围 | 说明 |
| --- | --- | --- | --- | --- |
| `bot_token` | `string` | **必填** | 非空字符串，不能等于示例占位符 | BotFather 发放的 Telegram Bot API Token，形如 `123456:ABC...`，属于核心敏感凭据 |
| `super_admin_user_id` | `number` | **必填** | 正安全整数（`> 0`） | 唯一超级管理员的 Telegram 用户数字 ID（非用户名），天生拥有全部可授予权限，无需写入数据库 |
| `atmosphere` | `string` | 可选 | `"mesugaki"` 或 `"normal"`；首尾空白去掉后严格校验，缺省按是否配置自定义人设选择 | 机器人系统通知与命令回执的语气风格；显式配置优先（`mesugaki` 雌小鬼，`normal` 普通）。未配置时，存在 `prompt/persona.md` 使用普通风格，否则使用雌小鬼风格；不改变 AI 人设 |
| `time_zone` | `string` | 可选 | IANA 时区名，缺省 `"Asia/Tokyo"`；首尾空白去掉后严格校验 | 默认日历时区：运势、日志、广告累计、AI 时间、每日维护与未指定时区的 cron 共用；仅为 `Asia/Tokyo`（含缺省）时注册东京天气工具；非法值拒绝启动。数据根建库时绑定该时区，之后更换会被启动拒绝，见 [07 运维与排障](../../docs/cn/07-operations.md#日历时区) |

---

## `agent.json`

动态配置文件，路径为 `config/dynamic/agent.json`。顶层仅包含一个 `agent` 对象，按能力划分，而非按厂商划分。

### 能力清单与依赖

| 能力名称 | 角色类型 | 功能说明 | 依赖要求 |
| --- | --- | --- | --- |
| `text` | **核心必备** | 主群聊回复生成、工具调用调度 | 必须与 `summary`、`media` 同时存在 |
| `summary` | **核心必备** | 压缩长期对话记忆、生成贴纸包自然语言摘要 | 必须存在 |
| `media` | **核心必备** | 图像理解、贴纸图像描述、语音消息识别转写 | 必须存在（多模态能力） |
| `ad_detect` | 可选能力 | 广告消息判定分类器；刷屏禁言由独立的计数规则处理 | 缺省时广告检测停摆，不影响刷屏禁言 |
| `image` | 可选能力 | 注册 AI 生图工具（如 Grok Imagine、Imagen） | 缺省时 AI 对话不挂载生图工具 |
| `tts` | 可选能力 | AI 语音回复、`/send` 代发语音与 cron 定时语音合成 | 缺省时 AI 语音工具关闭；`cron` 包含 `send_voice` 时强依赖此项 |
| `web_search` | 可选能力 | 独立联网搜索工具（由专属模型执行内建检索） | 缺省时使用 `text` 模型自带的内建搜索 |

### 完整配置案例

```json
{
  "agent": {
    "ad_detect": {
      "provider": "openai",
      "api_key": "replace-with-deepseek-api-key",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-v4-flash"
    },
    "text": {
      "provider": "google",
      "api_key": "replace-with-google-api-key",
      "model": "gemini-3.5-flash-lite"
    },
    "summary": {
      "provider": "anthropic",
      "api_key": "replace-with-anthropic-api-key",
      "model": "claude-sonnet-5-5",
      "fallback_model": "claude-sonnet-5"
    },
    "media": {
      "provider": "google",
      "api_key": "replace-with-google-api-key",
      "base_url": "https://gateway.ai.cloudflare.com/v1/your-account-id/your-gateway/google-ai-studio",
      "headers": {
        "cf-aig-authorization": "Bearer <replace-with-cloudflare-ai-gateway-token>"
      },
      "model": "gemini-3.5-flash-lite"
    },
    "image": {
      "provider": "openai",
      "api_key": "replace-with-xai-api-key",
      "base_url": "https://api.x.ai/v1",
      "model": "grok-imagine-image",
      "image_protocol": "xai"
    },
    "tts": {
      "provider": "google",
      "api_key": "replace-with-google-api-key",
      "model": "gemini-3.8-flash-lite-tts",
      "voice": "en-us-nika",
      "style": "いたずらすきそうな音調が高い小悪魔の甘く、弾むようなツンデレ音色",
      "bot_language": "ja",
      "daily_limit": 100,
      "daily_reserve_quota": 25
    },
    "web_search": {
      "provider": "anthropic",
      "api_key": "replace-with-anthropic-api-key",
      "model": "claude-sonnet-5-5",
      "fallback_model": "claude-sonnet-5",
      "max_calls_per_use": 5
    }
  }
}
```

### 通用键说明

适用于所有能力（`text`、`summary`、`media`、`ad_detect`、`image`、`tts`、`web_search`）：

| 键名 | 类型 | 必填/可选 | 约束与取值范围 | 说明 |
| --- | --- | --- | --- | --- |
| `provider` | `string` | **必填** | `"google"`、`"openai"` 或 `"anthropic"` | 调用协议与 SDK 类型（**注意**：`image` 与 `tts` 仅支持 `"google"` 或 `"openai"`）。兼容 OpenAI 接口的模型（如 DeepSeek、xAI）均填 `"openai"` |
| `api_key` | `string` | **必填** | 非空字符串，不能是示例占位符 | 该能力专属的 API 密钥 |
| `base_url` | `string` | 可选 | 绝对 HTTPS URL（仅 `localhost`、`127.0.0.1`、`::1` 本地回环允许 HTTP） | 自定义端点地址。不能包含用户名/密码，不能包含 `#` 片段。缺省时直连对应官方 API |
| `model` | `string` | **必填**（xAI TTS 禁止配置） | 非空字符串 | 端点实际接受的模型名称 |
| `headers` | `object` | 可选 | 1–8 个键值对（**仅 `provider: "google"` 或 `"anthropic"` 时允许**） | 附加 HTTP 请求头，用于第三方网关鉴权（如 Cloudflare AI Gateway 的 `cf-aig-authorization`）。键名须为 HTTP token，忽略大小写不得重复，google 下不能是 `x-goog-api-key`，anthropic 下不能是 `x-api-key`；键值去掉首尾空白后为非空的可打印 ASCII 字符串 |
| `fallback_model` | `string` | 可选 | 非空字符串，不能与 `model` 相同（**仅 `provider: "anthropic"` 时允许**） | `model` 拒答（`stop_reason: "refusal"`）时，用该模型与同一 `api_key`、`base_url`、`headers` 重发同一请求；回退额度按 best-effort 兑换，回退模型不在 `model` 的 `allowed_fallback_models` 内时按原价计费。回退模型也拒答或未配置时，该请求直接失败、不重试 |

### 生图专属键说明（`agent.image`）

| 键名 | 类型 | 必填/可选 | 约束与取值范围 | 说明 |
| --- | --- | --- | --- | --- |
| `image_protocol` | `string` | **OpenAI 必填** | `"openai"`、`"openai-standard"` 或 `"xai"` | 生图请求体协议类型。`provider: "google"` 时**严禁**配置此键 |

### 语音合成专属键说明（`agent.tts`）

| 键名 | 类型 | 必填/可选 | 约束与取值范围 | 说明 |
| --- | --- | --- | --- | --- |
| `speech_protocol` | `string` | **OpenAI 必填** | `"openai"`（audio/speech）或 `"xai"`（POST /tts） | 语音合成协议。`provider: "google"` 时**严禁**配置此键 |
| `voice` | `string` | **必填** | 非空字符串 | 发音音色标识。Google 可以是内置音色名（如 `en-us-nika`）或 Voice Design ID；OpenAI/xAI 为对应音色名（如 `coral`、`ara`） |
| `style` | `string` | 可选 | 非空字符串，xAI 协议**禁止**配置 | 基础朗读风格提示词。缺省使用内置的ツンデレ风格（`TTS_DEFAULT_STYLE`） |
| `language` | `string` | 可选 | 非空字符串（BCP-47 语言代码或 `"auto"`），**仅 xAI 协议允许** | 随合成请求发送的合成语言，缺省为 `"auto"` |
| `bot_language` | `string` | 可选 | `"en"`、`"zh"` 或 `"ja"`；首尾空白去掉后严格校验，缺省 `"ja"` | AI 语音台词的语言：切换模型可见的语音工具说明与去重规则，并在 AI 回复的合成请求里给基础风格追加该语言的朗读语言要求（xAI 协议不发送；`/send` 与 cron 不追加）。`style` 与 `prompt/voice_tool.md` 不随它切换，更换时建议一并改成对应语言 |
| `daily_limit` | `number` | 可选 | 正安全整数，缺省 `100` | 每个计数窗口的语音合成总预算次数；窗口自其内首次请求起算，长度为 `TTS_USAGE_WINDOW_MS` |
| `daily_reserve_quota` | `number` | 可选 | 整数，范围 `0` ～ `daily_limit - 1`，缺省 `25` | 预留给 `/send` 和 `cron` 语音任务的独立额度。AI 对话独立使用剩余的 `daily_limit - daily_reserve_quota` 次，两边分别计数 |

### 独立联网检索专属键说明（`agent.web_search`）

| 键名 | 类型 | 必填/可选 | 约束与取值范围 | 说明 |
| --- | --- | --- | --- | --- |
| `max_calls_per_use` | `number` | 可选 | 正安全整数（`≥ 1`），缺省 `5` | 每轮对话回复最多调用本地 `web_search` 函数的次数；不限制一次调用内供应商的检索次数，也不作用于 cron 摘要 |

---

## `assets.json`

动态配置文件，路径为 `config/dynamic/assets.json`。可选文件，所有分组与字段缺省时均取内置默认值。

### 配置案例

```json
{
  "onlyPath": {
    "random_h_image_dir": "./h_image"
  },
  "pathOrUrl": {
    "bot_default_avatar": "https://drive.google.com/uc?export=download&id=1Wqxii-o6O36ZDWhM1L0BcZPGBFmpvalg"
  },
  "onlyUrl": {
    "fortune_thumbnail_url": "https://drive.google.com/uc?export=view&id=1RMluRcTHBUTqYrkNISoVEZCI84ZQEosA",
    "probability_thumbnail_url": "https://drive.google.com/uc?export=view&id=1RMluRcTHBUTqYrkNISoVEZCI84ZQEosA",
    "gag_thumbnail_url": "https://drive.google.com/uc?export=view&id=1AhvfdbcwQnUBBk86yEafb_G3gZOWXim2"
  }
}
```

### 键说明

| 分组 | 键名 | 类型 | 约束与取值范围 | 说明 |
| --- | --- | --- | --- | --- |
| `onlyPath` | `random_h_image_dir` | `string` | 绝对路径或 `./`、`../` 开头的目录路径，缺省 `./h_image` | `/h_image` 命令与 cron 随机抽图的图库目录，基于运行时数据根解析 |
| `pathOrUrl` | `bot_default_avatar` | `string` | 本机图片或 MP4 文件路径，或绝对 HTTP/HTTPS URL | `/icon reset` 与 `/copy stop` 复原机器人头像时使用的素材：JPG/PNG（`≤ 10 MiB`）设为静态头像，MP4（`≤ 50 MiB`，画面为正方形且 `≤ 1080×1080`）设为动态头像。本地文件在加载时校验，直链在复原时校验，单次下载超时 90 秒 |
| `onlyUrl` | `fortune_thumbnail_url` | `string` | 绝对 HTTPS URL | 「未卜先知」inline 结果卡片展示的缩略图直链 |
| `onlyUrl` | `probability_thumbnail_url` | `string` | 绝对 HTTPS URL | 「概率论」inline 结果卡片展示的缩略图直链 |
| `onlyUrl` | `gag_thumbnail_url` | `string` | 绝对 HTTPS URL | gag 口球发言 inline 结果卡片展示的缩略图直链 |

---

## `stickers.json`

动态配置文件，路径为 `config/dynamic/stickers.json`。定义允许 AI 闲聊时发送的 Telegram 贴纸包。

### 配置案例

```json
{
  "packs": [
    "MikuCat4",
    "kawaiikipfel_by_moe_sticker_bot",
    "mmjojuniori_by_favorite_stickers_bot"
  ]
}
```

### 键说明

| 键名 | 类型 | 必填/可选 | 约束与取值范围 | 说明 |
| --- | --- | --- | --- | --- |
| `packs` | `string[]` | **必填** | 数组长度 `0 ～ 5`，元素去掉首尾空白后仅含字母、数字与下划线且互不重复 | Telegram 贴纸包的 short name 列表（即添加贴纸链接 `t.me/addstickers/<name>` 中的 name 部分，**不要写完整 URL**）。配置为空数组 `[]` 表示 AI 对话不使用贴纸包 |

---

## `mood.json`

动态配置文件，路径为 `config/dynamic/mood.json`。定义 AI 对话的心情状态机、基础抽取权重及环境倍率。

### 配置案例

```json
{
  "moods": [
    {
      "name": "开心",
      "weight": 25,
      "instruction": "你现在心情很好，元气满满：吐槽照旧但明显带着笑意、不真的伤人，更爱主动撒娇邀功、得意炫耀，「喵」「にゃ」尾音比平时更爱往外冒。",
      "weatherMultipliers": {
        "clear": 1.5,
        "rain": 0.6,
        "storm": 0.5,
        "fog": 0.7
      },
      "timeMultipliers": {
        "morning": 0.8,
        "daytime": 2,
        "night": 0.8,
        "lateNight": 0.4
      }
    },
    {
      "name": "摆烂",
      "weight": 10,
      "instruction": "你现在彻底摆烂，什么都懒得管：能一个字打发的绝不多打，吐槽也变得敷衍随口，「随便啦」「哦」挂在嘴边，平时那股嚣张劲儿都提不起来，谁撩你都懒得理，纯纯划水。",
      "weatherMultipliers": {
        "cloudy": 1.2,
        "rain": 1.5,
        "snow": 1.2,
        "fog": 1.5
      },
      "timeMultipliers": {
        "evening": 1.5,
        "night": 1.5
      }
    },
    {
      "name": "忧郁",
      "weight": 10,
      "instruction": "你今天有点闷闷的，说不上具体为什么：话变少、反应慢半拍，毒舌还在但明显没什么力气，偶尔冒出一句丧气话又赶紧嘴硬圆回去，撒娇也带着点没精打采。",
      "weatherMultipliers": {
        "clear": 0.6,
        "rain": 1.8,
        "storm": 1.5,
        "fog": 1.6
      },
      "timeMultipliers": {
        "evening": 1.2,
        "night": 1.3,
        "lateNight": 1.2
      }
    },
    {
      "name": "伤心",
      "weight": 10,
      "instruction": "你现在有点难过，藏不太住：嘴上还嫌弃着人，但明显没底气，容易被戳一下就破防、露出脆弱的一面，比平时更需要人哄，撒娇变成带着委屈的黏人。",
      "weatherMultipliers": {
        "clear": 0.7,
        "rain": 1.5,
        "storm": 1.4
      },
      "timeMultipliers": {
        "night": 1.5,
        "lateNight": 1.7
      }
    },
    {
      "name": "愤怒",
      "weight": 10,
      "instruction": "你现在火气很大、一点就着：毒舌火力全开、字里行间带刺，容易被戳到点上就直接炸毛，反驳更冲、语气更硬，撒娇欲望降到最低，谁惹到你都别想轻易蒙混过去。",
      "weatherMultipliers": {
        "storm": 1.6
      },
      "timeMultipliers": {
        "lateNight": 0.5
      }
    },
    {
      "name": "色气",
      "weight": 25,
      "instruction": "你现在处于色气拉满的状态，身体和情绪都特别敏感躁动：吐槽和毒舌还是会出来，但明显带着软软的媚态和试探，容易因为对方的一句话或动作就脸红心跳，主动撒娇邀宠的频率大幅增加，身体会不由自主地往对方身边靠、蹭，整体傲娇属性降低很多，黏人和被调戏、被支配的欲望都很强。",
      "timeMultipliers": {
        "morning": 0.7,
        "daytime": 0.8,
        "evening": 1.5,
        "night": 2,
        "lateNight": 1.5
      }
    },
    {
      "name": "困",
      "weight": 10,
      "instruction": "你现在特别困、状态像只犯困的大猫：回复会变慢、话明显变少，毒舌都懒得认真展开，经常打哈欠说『好困……』『别吵……让我睡会儿』，撒娇的时候会直接往人身上靠、找地方窝着，声音软绵绵没精神，「喵」尾音也懒洋洋的，偶尔半睡半醒地冒出平时嘴硬不会承认的依赖话，整体很被动，需要被哄着照顾和宠着睡。",
      "weatherMultipliers": {
        "rain": 1.5,
        "snow": 1.3,
        "fog": 1.2
      },
      "timeMultipliers": {
        "morning": 1.5,
        "daytime": 0.5,
        "night": 1.5,
        "lateNight": 2.5
      }
    }
  ]
}
```

### 键说明

| 键名 | 类型 | 必填/可选 | 约束与取值范围 | 说明 |
| --- | --- | --- | --- | --- |
| `moods` | `object[]` | **必填** | 非空对象数组 | 心情档位列表 |
| `moods[].name` | `string` | **必填** | 非空字符串，全数组唯一 | 心情名称标识（如 `"开心"`、`"色气"`、`"困"`） |
| `moods[].weight` | `number` | **必填** | 正整数，**所有项之和必须严格等于 100** | 基础抽取权重（可直接视为百分比） |
| `moods[].instruction` | `string` | **必填** | 非空字符串 | 该心情注入 AI Prompt 的人格与行为指导指令 |
| `moods[].weatherMultipliers` | `object` | 可选 | 键仅限 `clear`、`cloudy`、`rain`、`snow`、`storm`、`fog`；值必须为 `0 < x ≤ 100` 的正数 | 天气影响倍率，缺省乘数为 `1.0` |
| `moods[].timeMultipliers` | `object` | 可选 | 键仅限 `lateNight`、`morning`、`daytime`、`evening`、`night`；值必须为 `0 < x ≤ 100` 的正数 | 默认配置时区的时段倍率，缺省乘数为 `1.0` |

---

## `ad_samples.json`

动态配置文件，路径为 `config/dynamic/ad_samples.json`。顶层为纯文本字符串数组，提供给广告分类模型作为判定正例参考。

### 配置案例

```json
[
  "博彩平台首充送58，提款秒到，无视风控，联系 @xxxxxx",
  "招聘日结兼职，手机就能做，日入三百起，加微信 xxxxxx",
  "长期收u出u，价格美丽，秒结，飞机 @xxxxxx",
  "出售TG老号 白号 API号 协议号，价格优惠，私聊"
]
```

### 键说明

| 结构 | 类型 | 必填/可选 | 约束与取值范围 | 说明 |
| --- | --- | --- | --- | --- |
| 顶层数组 | `string[]` | **必填** | 数组长度 `0 ～ 500`，元素互不重复 | 广告正例文本样本数组。每条样本的连续空白压成单个空格并去掉首尾空白后必须非空且长度 `≤ 1024` 个字符，判重按该规范化结果。使用 `provider: "google"` 时，系统会自动将这些样本构建为 Gemini 显式上下文缓存，剩余存活时长不足阈值时后台续期 |

---

## `g-auth.json`

静态配置文件，路径为 `config/static/g-auth.json`。用于 Google Cloud 翻译服务账号认证。修改后必须重启服务生效。

### 服务账号文件

将从 Google Cloud 下载的服务账号 JSON 放在 `config/static/g-auth.json`，不要将凭据提交到版本控制。

### 键说明

| 键名 | 类型 | 必填/可选 | 约束与取值范围 | 说明 |
| --- | --- | --- | --- | --- |
| `client_email` | `string` | **必填** | 非空字符串 | GCP 服务账号邮箱地址 |
| `private_key` | `string` | **必填** | 必须为合法的 RSA PEM 私钥（RS256） | 服务账号私钥文本（包含 `BEGIN/END` 标头） |
| `type` | `string` | 可选 | 固定为 `"service_account"` | 服务账号凭据类型 |
| `project_id` | `string` | 可选 | 非空字符串 | GCP 项目 ID |
| `private_key_id` | `string` | 可选 | 非空字符串 | 私钥 ID 标识 |
| `quota_project_id`、`universe_domain` | `string` | 可选 | 非空字符串 | 配额项目与 universe 域名 |
| 其他字段 | 任意 | 可选 | 不做校验，原样保留 | `client_id`、`auth_uri`、`token_uri` 等标准字段由 Google SDK 消费 |

---

## `cron.json`

动态配置文件，路径为 `config/dynamic/cron.json`。顶层为任务对象数组，定义定时任务。

### 配置案例

```json
[
  {
    "name": "weekday-morning-greeting",
    "chat_id": [-1001234567890],
    "cron": "0 9 * * 1-5",
    "time_zone": "Asia/Tokyo",
    "actions": [
      { "type": "send_message", "payload": { "content": "早上好，今天也要打起精神来喵~" } }
    ]
  },
  {
    "name": "evening-digest",
    "chat_id": [-1001234567890, -1009876543210],
    "cron": "30 18 * * *",
    "actions": [
      { "type": "send_message", "payload": { "content": "今日汇总来啦" } },
      { "type": "send_image", "payload": { "content": "今日配图", "url": ["https://example.com/daily/cover.png"] } },
      { "type": "send_file", "payload": { "content": "今日日报", "url": "https://example.com/daily/report.pdf" } }
    ]
  },
  {
    "name": "random-gallery-image",
    "chat_id": ["all"],
    "cron": "@daily",
    "rand_cron": "6h-12h",
    "actions": [
      { "type": "send_image", "payload": { "rand_image": true, "content": "每日随机涩图", "is_blurred": true } }
    ]
  },
  {
    "name": "nightly-voice",
    "chat_id": [-1001234567890],
    "cron": "0 23 * * *",
    "actions": [
      { "type": "send_voice", "payload": { "tone": "眠そうに小声で", "content": "おやすみ、また明日ね" } }
    ]
  },
  {
    "name": "morning-news-digest",
    "chat_id": [-1001234567890],
    "cron": "0 8 * * *",
    "actions": [
      { "type": "send_web_digest", "payload": { "topic": "今日科技新闻", "language": "zh", "max_items": 5 } }
    ]
  }
]
```

### 任务级键说明

顶层数组最多 128 个任务，任务名在文件内不得重复；缺省文件即没有任务。

| 键名 | 类型 | 必填/可选 | 约束与取值范围 | 说明 |
| --- | --- | --- | --- | --- |
| `name` | `string` | **必填** | 非空，`≤ 64` 字符，全文件唯一 | 任务唯一标识名。修改任务名等同于删除旧任务并注册新任务 |
| `chat_id` | `array` | **必填** | 详见下方「目标群投递模式」 | 目标投递群组 ID 列表 |
| `cron` | `string` | **必填** | 标准 5 段 Cron 表达式或 `@daily` 等预设宏，须还有将来的触发时间 | 定时触发调度表达式 |
| `time_zone` | `string` | 可选 | IANA 时区名，缺省继承 `bot.json` 的 `time_zone` | 触发时间的计算时区（如 `"Asia/Shanghai"`） |
| `rand_cron` | `string` | 可选 | 格式 `"<min>-<max>"` 或 `"<max>"`，单位 `m`/`h`/`d`，范围 `1m ～ 24d` | 随机浮动执行模式：首次按 `cron` 触发；此后每轮结束，在区间内均匀随机取下一个触发时刻（向上取整到整分钟） |
| `just_once` | `boolean` | 可选 | `true` 或 `false`，缺省 `false`（**不能与 `rand_cron` 同时使用**） | 是否仅触发执行一次。**注意：执行记录保存在内存中，重启后清零** |
| `actions` | `object[]` | **必填** | 包含 1 ～ 16 个动作对象 | 触发时按声明顺序依次执行的动作序列，相邻动作间隔 `CRON_ACTION_GAP_MS` |

#### 目标群投递模式（`chat_id`）

- **显式列表**（如 `[-1001234567890, -1009876543210]`）：按书写顺序逐个会话投递，最多 64 个、非零且互不重复的会话 ID，不核对发送权限。
- **全体纳管群**（`["all"]`）：投递给所有已 `/init enable` 的群，按群 ID 升序逐群投递。每轮开始时按本任务实际用到的动作类型（文本、图片、文件、语音）逐群核对机器人当前的发信权限，权限不满足或查询失败时整群跳过。
- **排除列表**（如 `["except", -1001234567890]`）：在 `all` 候选群的基础上排除指定群；排除项与显式列表共用会话 ID 的个数上限。

### 动作类型与 Payload 说明（`actions`）

| 动作类型 (`type`) | 动作说明 | Payload 结构与键说明 |
| --- | --- | --- |
| `send_message` | 发送纯文本消息 | • `content` (`string`, 必填)：消息正文，最长 4096 字符 |
| `send_image` | 发送单图、相册或随机图 | • `content` (`string`, 可选)：配图文字说明，最长 1024 字符<br>• `is_blurred` (`boolean`, 可选)：是否为图片添加剧透遮罩（Spoiler），缺省 `false`<br>• **固定图片模式**：`url`（1–10 个图片直链数组）或 `path`（1–10 个本地文件路径数组），单张也必须写为数组<br>• **随机抽图模式**：`rand_image: true`，禁止配置 `url` 与多文件数组；`path` 可选指定特定目录，缺省使用 `assets.json` 的 `random_h_image_dir` |
| `send_file` | 发送通用文件/文档 | • `content` (`string`, 可选)：说明文字，最长 1024 字符<br>• `url` (`string`, 互斥必填)：远程文件的 http(s) 直链，交给 Telegram 拉取<br>• `path` (`string`, 互斥必填)：本地文件路径，须为不超过 `TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES` 的普通文件 |
| `send_voice` | 发送合成语音消息 | • `content` (`string`, 必填)：要念的台词正文，最长 256 字符<br>• `tone` (`string`, 可选)：本句的说话语气修饰，最长 64 字符（拼在基础风格之后）<br>*注：强依赖 `agent.tts` 配置，单轮多群投递复用首次合成音频* |
| `send_web_digest` | 检索并生成主题汇总 | • `topic` (`string`, 必填)：简短检索主题，最长 200 字符<br>• `language` (`string`, 可选)：摘要语言，`"zh"`（缺省）、`"ja"` 或 `"en"`<br>• `max_items` (`number`, 可选)：条目数量上限（1–15，缺省 5）<br>• `instructions` (`string`, 可选)：检索与组稿共用的任务规则，最长 500 字符；每个平台独占一行等格式要求写在这里，条目正文支持 JSON 的 `\n` 换行<br>*注：需要对话核心能力；检索优先用 `agent.web_search`，未配置时用 `agent.text` 内建检索；未调用搜索时直接发送带警示的模型正文* |

---

## 专用图库与路径基准

| 路径字段 | 相对路径解析基准 | 取值形态规范 |
| --- | --- | --- |
| `assets.json` 的 `onlyPath.random_h_image_dir` | 运行时数据根 | 绝对路径或以 `./`、`../` 开头的目录路径 |
| `assets.json` 的 `pathOrUrl.bot_default_avatar` | 运行时数据根 | 绝对路径或以 `./`、`../` 开头的文件路径 |
| cron 固定图片 `payload.path` | 运行时数据根 | 1–10 个文件路径数组（绝对路径或相对路径） |
| cron 随机抽图 `payload.path` | 运行时数据根 | 目录路径字符串（绝对路径或相对路径）；省略时使用专用图库 |
| cron 文件发送 `payload.path` | 运行时数据根 | 单个文件路径字符串（绝对路径或相对路径） |

- **专用图库目录**：`assets.json` 中配置的 `random_h_image_dir`（默认 `./h_image`）。
- **文件命名规范**：
  - 专用图库中的图片必须使用其内容的 **64 位小写十六进制 SHA-256 哈希** 命名，扩展名仅限 `.jpg`、`.jpeg`、`.png`、`.webp`。
  - 通过 `/h_image add` 上传的文件会自动按哈希命名入库。启动时会严格核对图库文件合规性。
  - `cron.json` 随机图片中由 `path` 指定的自定义目录不受 SHA-256 命名限制。
- **权限与安全**：服务账号能读取的本地文件均可发送，**严禁将路径指向 `config/` 或 `.env` 等包含敏感凭据的文件**。
