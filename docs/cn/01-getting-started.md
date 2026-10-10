# 01 环境搭建与首次运行

<p align="center">
  <b>简体中文</b> · <a href="../en/01-getting-started.md">English</a> · <a href="../ja/01-getting-started.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <b>← 上一页：无</b> · <a href="02-architecture.md">下一页：02 架构总览 →</a>
</p>

---

本文将指导你以最快路径在全新环境中完成部署，使机器人可以在群组中正常工作。关于系统的分层架构与消息流转，请参考 [02 架构总览](02-architecture.md)。

## 前置条件

- **Linux 系统**（必须具备可读的 `/proc` 目录）：系统的单实例锁机制强依赖 `/proc/<pid>/stat` 与内核 boot ID，以此防止多进程并发冲突。不支持非 Linux 系统，启动时若检测到不支持的平台将直接退出以保障安全。
- **Bun 1.4.3**：源码安装与本地开发所需，可通过以下命令快速安装：
  ```bash
  curl -fsSL https://bun.sh/install | bash -s bun-v1.4.3
  ```
  > [!NOTE]
  > 二进制发行包已内置 Bun 运行时，无需宿主机预先安装 Bun。整个项目都不需要 Node.js。
- **Telegram Bot Token**：向官方 [@BotFather](https://t.me/BotFather) 发送 `/newbot` 创建机器人并取得 API Token。
- **AI 模型 API Key**：若需要使用 AI 闲聊、图像理解、AI 生图、语音合成（TTS）或联网检索功能，需准备对应提供商的 API 密钥（支持 [Google AI Studio](https://aistudio.google.com/)、[OpenAI Platform](https://platform.openai.com/) 或兼容服务）。在 `config/dynamic/agent.json` 中按需配置，各项能力独立生效，互不回退。
- **（可选）Google Cloud 服务账号凭据**：仅在启用 `/translate` 翻译功能时需要，保存为 `config/static/g-auth.json`（格式参考 [示例](../../config_example/static/g-auth.json)；示例中的占位私钥会被解析器直接拒绝）。
  - **凭据规格**：由 `packages/config/googleAuth.ts` 解析，必须包含 `client_email` 与用于 RS256 签名的非空 RSA PEM 私钥（不支持 EC、Ed25519 或 RSA-PSS 密钥）；`type` 只能为 `service_account`（可缺省）。
  - **默认行为**：若未配置该凭据，不会影响机器人启动，仅在群内使用 `/translate` 时提示缺少该文件；但若文件存在且格式错误，启动时的配置校验会直接报错退出。
  - **安全保障**：启动时一次性读入进程内存快照，运行期不再重复读取；错误日志只记录文件路径与格式要求，绝不泄露凭据内容。

---

## 安装

### 一键安装

全新服务器环境推荐使用 [`install.sh`](../../install.sh) 自动化安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

安装模式可通过参数或环境变量 `COPY_NINJIA_INSTALL_MODE`（`source` 或 `binary`）指定；若未指定，安装程序会在终端通过交互菜单询问（默认为源码模式）。`COPY_NINJIA_DIR` 用于指定安装目录名（默认为 `copy_ninjia`）。

```bash
# 二进制发行版安装（推荐快速部署，不依赖本地 git 或系统 Bun）
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --binary

# 源码安装（适合后续二次开发与贡献代码）
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --source
```

#### 安装方式对比与行为

<table width="100%">
<thead>
  <tr>
    <th width="20%" align="left">对比维度</th>
    <th width="40%" align="left">二进制发行版 (<code>--binary</code>)</th>
    <th width="40%" align="left">源码克隆方式 (<code>--source</code>)</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>📦 <b>发行渠道</b></nobr></td>
    <td>自动从 GitHub Latest Release 下载对应架构的预编译单二进制包</td>
    <td>通过 <code>git clone</code> 拉取对应 Release tag 的源码仓库</td>
  </tr>
  <tr>
    <td><nobr>⚙️ <b>系统依赖</b></nobr></td>
    <td>无需系统预装 Bun、git 或编译工具链；脚本会自动尝试补齐基础下载工具</td>
    <td>需要 git 与 Bun 1.4.3；安装脚本会尝试辅助安装缺失工具，若版本不符需手动调整</td>
  </tr>
  <tr>
    <td><nobr>🚀 <b>运行时封装</b></nobr></td>
    <td>独立单可执行文件，内嵌 Bun 运行时与各 Worker 运行逻辑</td>
    <td>执行 <code>bun install --frozen-lockfile</code> 安装完整依赖（遵循依赖安全冷却期）</td>
  </tr>
  <tr>
    <td><nobr>▶️ <b>启动命令</b></nobr></td>
    <td>直接运行目录下的 <code>./copy-ninjia</code></td>
    <td>运行 <code>bun run start</code> 或 <code>bun run index.ts</code></td>
  </tr>
</tbody>
</table>

> [!TIP]
> **安装流程概览**（与 `install.sh` 执行步骤保持一致；服务托管与备份边界见 [07 运维](07-operations.md#安装器的服务与备份边界)）：
> 1. **环境检查**：确认操作系统为 Linux、具备可读的 `/proc` 目录与可读写的控制终端（`/dev/tty`）。
> 2. **获取文件**：依次检查当前脚本所在目录、当前工作目录及目标克隆目录；若均无现存副本，则从 GitHub 拉取对应 Release 源码或下载预编译二进制包（自动识别 x64/arm64 与 glibc/musl）。之后转入目标目录自带的安装脚本继续执行。
> 3. **工具与环境**：源码模式按需安装指定版本的 Bun；二进制模式直接使用包内自带的可执行文件。
> 4. **安装依赖**：源码模式执行 `bun install --frozen-lockfile`；二进制模式直接跳过。
> 5. **准备配置目录**：检查配置目录结构；自动补充缺失的基础配置模板，但跳过可选的 `agent.json`、`g-auth.json` 与 `cron.json`，且绝不覆盖已有文件。
> 6. **交互式填写配置**：在终端引导填写 `config/static/bot.json`；若 `agent.json` 尚不存在，则逐项询问并配置 AI 能力。覆盖已有配置文件前会自动在临时目录外部备份，经严格格式校验通过后原子替换。
> 7. **初始化身份数据库**：检查 `database/storage.sqlite`。若数据库已存在，核对其记录的时区与 `bot.json` 的 `time_zone` 是否一致（不一致时拒绝注册服务）；若不存在，则以当前配置的时区初始化全新的空数据库。随后对所有已存在的配置文件执行全面校验。
> 8. **注册服务并观测**：注册或更新 systemd 服务 `copy-ninjia.service`（无可用 systemd 时提示在前台运行）。启动后持续观察服务状态，确认进程正常运行、无异常重启且日志无报错后，清理临时配置备份。

### 手工源码安装

```bash
# 1. 克隆代码仓库
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia

# 2. 按锁文件安装依赖
bun install --frozen-lockfile

# 3. 准备部署配置目录并复制模板文件
mkdir -p config/static config/dynamic
for example in config_example/static/*.json config_example/dynamic/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" "config/${example#config_example/}" ;;
  esac
done
```

> [!WARNING]
> `config_example/` 目录下的 `g-auth.json` 与 `cron.json` 示例仅作语法示意，切勿直接原样复制到生产环境。复制后的配置文件中如果带有 `replace-with-…` 占位字符串（如 `bot_token` 或各 AI 模型的 `api_key`），必须替换为真实凭据；保留占位符会导致程序在启动阶段报错退出。详细说明见 [`config_example/README/zh.md`](../../config_example/README/zh.md)。

---

## 配置 Telegram 身份

机器人的基础身份与全局超级管理员定义在 `config/static/bot.json` 中：

- **`bot_token`**（必填，字符串）
  - 从 BotFather 获取的 Telegram Bot API Token；示例中的占位字符会被校验直接拒绝。
- **`super_admin_user_id`**（必填，正整数）
  - 全局超级管理员的十进制 Telegram 用户 ID。
  - **特权边界**：超级管理员身份天生拥有白名单所能授予的**全部权限**，不需要（也不会）写入数据库白名单表中。
  - **豁免保护**：复读、生图等操作的调用冷却仅豁免超级管理员；超级管理员享有永久保护，不可被 `/block`、`/mute` 或 `/batch_kick` 处置。
  - **专属命令**：`/init`、`/batch_kick`、`/permission` 修改、`/white disable` 以及私聊 `/send` 仅允许超级管理员调用。
- **`atmosphere`**（可选，枚举：`"mesugaki"` | `"normal"`）
  - 系统通知与命令菜单的默认语气风格（`mesugaki` 雌小鬼版 / `normal` 普通版）。
  - 若显式配置则以此为准；未配置时，若存在 `prompt/persona.md` 则默认使用普通版，否则使用雌小鬼版。
- **`time_zone`**（可选，IANA 时区名，默认为 `Asia/Tokyo`）
  - 机器人的基准日历时区，供运势抽签、日志归档、广告统计、AI 时间感知、每日维护以及未指定时区的 cron 任务共同使用（不会直接继承宿主机操作系统时区）。
  - 配置时会自动去除首尾空白并规范化名称（例如 `asia/tokyo` 会标准化为 `Asia/Tokyo`）。
  - **时区绑定**：数据库初始化时会将此时区写入 `storage_metadata` 表中。此后机器人启动或安装脚本均会核对此时区；若中途修改 `time_zone` 将导致启动报错退出。已有数据不支持直接更换时区。

---

## 项目侧配置文件

## 项目配置文件说明

`config/` 目录用于存放本地部署私有配置，已被 `.gitignore` 排除。配置文件的目录结构必须严格按静态与动态划分：

```text
config/
├── static/                 # 静态配置（修改后需要重启机器人进程生效）
│   ├── bot.json            # 机器人核心身份与超级管理员配置
│   └── g-auth.json         # Google Cloud 服务账号凭据（可选，翻译功能使用）
└── dynamic/                # 动态配置（修改后支持自动防抖热重载）
    ├── agent.json          # AI 模型各项能力配置
    ├── assets.json         # 界面素材缩略图、默认头像与图库路径
    ├── stickers.json       # AI 贴纸包白名单
    ├── mood.json           # AI 心情挡位与权重配置
    ├── ad_samples.json     # 广告识别参考样本
    └── cron.json           # 定时任务配置（可选）
```

> [!IMPORTANT]
> - 配置文件必须严格放在对应的子目录下，禁止直接散落在 `config/` 根目录，否则启动校验将报错退出。
> - 机器人运行期间修改 `config/dynamic/` 下的文件会自动触发防抖热重载。如果新配置存在语法或格式错误，该次修改将被整体拒绝并记录错误日志，系统继续沿用上一份有效配置；但如果在重启时配置仍未修复，启动检查将报错退出。

### 核心配置文件详解

- **`prompt/persona.md`**（可选，项目根目录；参考 [示例](../../prompt_example/persona.md)）
  - **作用**：自定义 AI 闲聊的 System Prompt 人设。
  - **行为**：默认使用代码内置的人设；如果该文件存在，则读取其全部文本作为人设提示词。
  - **规范**：纯文本文件，编码必须为 UTF-8 且内容不能为空白。修改后需要重启生效。文件内容将原样提交给大模型，请勿在其中编写面向管理员的代码注释。

- **`prompt/voice_tool.md`**（可选，项目根目录；参考 [示例](../../prompt_example/voice_tool.md)）
  - **作用**：自定义 AI 调用语音合成工具（`send_voice`）时的提示词说明。
  - **行为**：默认根据 `agent.json` 中配置的语音语言（`en` / `zh` / `ja`）自动加载内置说明；如果该文件存在，则整份替换为该文件的内容。修改后需要重启生效。

- **`config/static/bot.json`**（参考 [示例](../../config_example/static/bot.json)）
  - 核心身份配置文件，字段见上文「配置 Telegram 身份」。启动时进行严格校验，不允许出现未知字段或非法数据类型。

- **`config/dynamic/stickers.json`**（参考 [示例](../../config_example/dynamic/stickers.json)）
  - 配置 AI 闲聊时允许发送的贴纸包 short name 列表（`packs` 数组）。各项必须为合法的 Telegram 贴纸包短名称且不得重复。

- **`config/dynamic/mood.json`**（参考 [示例](../../config_example/dynamic/mood.json)）
  - 配置 AI 心情轮换挡位（`moods` 数组）。每项包含 `name`（心情名称）、`weight`（抽取权重）与 `instruction`（注入模型的行为指示），可选配置天气与时段权重加成。

- **`config/dynamic/ad_samples.json`**（参考 [示例](../../config_example/dynamic/ad_samples.json)）
  - 提供给广告检测模型的少样本参考集，为纯文本字符串数组。

- **`config/dynamic/agent.json`**（参考 [示例](../../config_example/dynamic/agent.json)）
  - 配置 AI 系统的各项模型能力，顶层为 `agent` 对象。每项能力独立配置，各自声明 provider、api_key、model 及端点，能力之间不设自动回退：
    1. **AI 闲聊核心能力**（三项缺一则闲聊功能不可用）：
       - `text`：文本对话生成模型。
       - `summary`：群聊长上下文的滚动记忆压缩与摘要模型。
       - `media`：图像理解与语音识别转写模型。首次请求会自动探测端点对模态的支持度。
    2. **扩展生成工具**（未配置时自动卸载对应工具）：
       - `image`：AI 画图生成能力。使用 OpenAI 兼容协议时需声明 `image_protocol`（`openai` | `openai-standard` | `xai`）。
       - `tts`：语音合成能力。必须指定 `voice` 音色。可选配置 `bot_language`（台词语言）以及每日合成额度预算。
    3. **检索与风控能力**：
       - `web_search`：联网检索工具。未单独配置时，将回退使用 `text` 模型的服务商内建搜索能力。
       - `ad_detect`：进群消息的广告自动识别模型。未配置时广告检测不可用。
    4. **通用配置项**：
       - `provider`：模型供应商，支持 `google`、`openai`、`anthropic`（生图与语音仅支持前两者）。
       - `api_key`：访问密钥；占位字符串会被校验拦截。
       - `model`：具体的模型名称。
       - `base_url`：可选的自定义 API 端点（用于代理或内网网关）。
       - `headers`：仅 `google` 与 `anthropic` provider 可配置的附加请求头（1～`AGENT_HEADERS_MAX_ENTRIES` 个，用于 Cloudflare AI Gateway 等三方网关鉴权）。
       - `fallback_model`：仅 `anthropic` provider 可配置的回退模型（不能与 `model` 相同）。`model` 拒答时用它重发同一请求；回退模型也拒答或未配置时，该请求直接失败、不重试。

---

### 初始化身份数据库

为保证数据一致性，机器人运行时不会自动建表。在首次部署时，必须通过以下脚本初始化本地 SQLite 数据库：

```bash
mkdir -p database
bun -e '
  import { createStorageDatabase } from "./packages/database/interact/migration";
  import {
    closeStorageDatabase,
    enableStorageDatabaseWal,
    openStorageDatabase,
  } from "./packages/database/interact/connection";
  import { initializeStorageDatabase } from "./packages/database/interact/initialization";
  import { loadBotConfig } from "./packages/config/botInput";
  import { IDENTITY_DATABASE_PATH } from "./packages/consts/paths";

  const { timeZone } = await loadBotConfig();
  createStorageDatabase(IDENTITY_DATABASE_PATH);
  const database = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  try {
    initializeStorageDatabase(database, timeZone);
  } finally {
    closeStorageDatabase(database);
  }
  enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
'
chmod 2770 database
chmod 660 database/storage.sqlite
```

> [!IMPORTANT]
> 这一步至关重要：它会在数据库的 `storage_metadata` 表中写入当前结构版本号与配置的基准时区。请务必在完成 `bot.json` 配置后再执行初始化；若跳过此步，启动时将因找不到数据库元数据而直接报错退出。

---

### 自定义素材与图库路径

通过 `config/dynamic/assets.json`（支持动态热重载）可以自定义内联缩略图、机器人默认头像与专用图库目录：

```json
{
  "onlyPath": {
    "random_h_image_dir": "./h_image"
  },
  "pathOrUrl": {
    "bot_default_avatar": "https://example.com/avatar.png"
  },
  "onlyUrl": {
    "fortune_thumbnail_url": "https://example.com/fortune.png",
    "probability_thumbnail_url": "https://example.com/probability.png",
    "gag_thumbnail_url": "https://example.com/gag.png"
  }
}
```

各字段说明如下：
- **`onlyPath`**：仅支持本地文件路径（绝对路径或以 `./`、`../` 开头的相对数据根路径）。`random_h_image_dir` 指定随机图库目录，供 `/h_image` 命令与定时发图任务读取。
- **`pathOrUrl`**：支持本地路径或 HTTP(S) 直链。`bot_default_avatar` 为复原默认头像时所使用的素材：JPEG/PNG 图片（不超过 10 MiB）设为静态头像，MP4 视频（不超过 50 MiB，视频画面须为正方形且不超过 1080×1080）设为动态头像。直链单次下载超时为 90 秒。
- **`onlyUrl`**：必须为有效的 `https://` 图片绝对地址。分别用于运势抽签、概率计算与口球发言入口的卡片缩略图。

---

## Telegram 侧配置（BotFather 与群权限）

前往 Telegram 官方 [@BotFather](https://t.me/BotFather) 对机器人进行如下设置：

1. **关闭群隐私模式（Privacy Mode）**：
   - 执行 `/setprivacy` -> 选择你的 Bot -> 设置为 **Disable**。
   - *说明*：关闭后机器人才能接收到群内的普通文本消息；复读、AI 闲聊与群风控均依赖此项。
2. **授予群管理员权限**：
   - 将机器人拉入目标群组，并赋予群管理员身份（至少勾选“删除消息”与“限制成员/封禁”权限）。
3. **开启内联模式（Inline Mode）**：
   - 执行 `/setinline` -> 设置为 **Enable**。
   - *说明*：运势抽签（`@机器人 所求事项`）与口球（`/gag`）限制发言依赖内联模式。
4. **设置内联反馈率**：
   - 执行 `/setinlinefeedback` -> 设置为 **100%**。
   - *说明*：用于接收内联抽签结果的落盘回执。
5. **（可选）开启 Bot 间通信**：
   - 若需要在群里复读或翻译其他机器人的发言，在 BotFather 中开启 **Bot-to-Bot Communication Mode**。

---

## 首次启动与群组激活

```bash
# 1. 运行质量门禁确保环境完好无损
bun run check

# 2. 启动服务（长轮询模式）
bun run start
```

服务启动后，**超级管理员**进入目标群组，发送以下命令激活相关功能：

```text
/init enable      # 激活本群业务总开关（必须首先执行此项，否则机器人对本群消息保持静默）
/ai_chat enable   # （可选）开启本群 AI 闲聊
/ad_detect enable # （可选）开启本群广告自动检测（需管理员权限）
/antiraid enable  # （可选）开启本群入群验证与防冲群保护（需管理员权限）
```

### 验证运行状态

- 在群里发送 `/copy`（回复某条群消息）：机器人应成功复读该消息并同步更换为对方头像。
- 检查 `logs/` 目录：已正常生成当天的运行日志。
- 按 `Ctrl+C` 退出：控制台应显示入口关闸、Worker 队列排空与状态完整落盘的优雅退出日志。

---

<div align="center">

**← 上一页：无** · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#01-环境搭建与首次运行) · [下一页：02 架构总览 →](02-architecture.md)

</div>
