# 01 环境搭建与首次运行

<p align="center">
  <b>简体中文</b> · <a href="../en/01-getting-started.md">English</a> · <a href="../ja/01-getting-started.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <b>← 上一页：无</b> · <a href="02-architecture.md">下一页：02 架构总览 →</a>
</p>

---

本页把一个全新环境带到「机器人在群里正常工作」，只求最短路径。系统架构与消息流见 [02 架构总览](02-architecture.md)。

## 前置条件

- **Linux 系统**（必须具备可读的 `/proc`）：实例锁强依赖 `/proc/<pid>/stat` 与系统 boot ID；其它操作系统均会 fail-closed 拒绝启动。
- **Bun 1.4.2**：源码安装与本地开发需要，可通过以下命令安装：
  ```bash
  curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2
  ```
  > [!NOTE]
  > 二进制发行包已自带内置 Bun 运行时，无需宿主机预先安装 Bun。项目全链路不需要 Node.js。
- **Telegram Bot Token**：向 [@BotFather](https://t.me/BotFather) 发送 `/newbot` 创建机器人并取得 Token。
- **所配 AI 能力的 API Key**：`config/dynamic/agent.json` 中配置的各项能力（对话、媒体描述、生图、TTS、联网检索等）各自持有 key、provider、端点与模型；可从 [Google AI Studio](https://aistudio.google.com/)、[OpenAI Platform](https://platform.openai.com/) 或兼容服务取得。能力之间不设自动回退。
- **（可选）Google Cloud 服务账号 JSON**：仅 `/translate` 翻译功能需要，保存为 `config/static/g-auth.json`（结构参考 [示例](../../config_example/static/g-auth.json)；示例中的占位私钥会被解析器拒绝）。
  - **凭据规格**：由 `packages/config/googleAuth.ts` 严格解析，必须包含 `client_email` 与用于 RS256 签名的非空 RSA PEM 私钥（不接受 EC、Ed25519 或 RSA-PSS 密钥）；`type` 省略或只能为 `service_account`。
  - **优雅降级**：凭据缺失时不阻止进程启动，仅在执行 `/translate` 时直接拒绝并明确点名该文件；文件若存在但格式非法，启动总闸会在解析阶段立刻退出。
  - **凭据安全**：凭据在启动阶段生成进程级只读快照，运行时不再反复读盘；错误信息仅输出文件路径与字段期望，严禁回显凭据明文。

---

## 安装

### 一键安装

全新服务器环境推荐使用 [`install.sh`](../../install.sh) 自动化脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

可通过参数或环境变量指定安装模式（两者仅选其一）：

```bash
# 二进制发行版安装（推荐快速部署，不依赖 git 或系统 Bun）
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --binary

# 源码安装（适合后续二次开发）
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
    <td>自动从 GitHub Latest Release 下载对应架构预编译包</td>
    <td><code>git clone</code> 对应 Release tag（处于 detached HEAD）</td>
  </tr>
  <tr>
    <td><nobr>⚙️ <b>系统依赖</b></nobr></td>
    <td>无需系统 Bun、git 或本地编译；安装器会尝试补齐缺少的下载工具</td>
    <td>需要 git 与 Bun 1.4.2；安装器会尝试补装缺少的工具，已安装的 Bun 版本不符时需手工调整</td>
  </tr>
  <tr>
    <td><nobr>🚀 <b>运行时封装</b></nobr></td>
    <td>独立单可执行文件，内置 Bun 运行时与 Worker 逻辑</td>
    <td>执行 <code>bun install --frozen-lockfile</code>（7 天依赖安全冷却期）</td>
  </tr>
  <tr>
    <td><nobr>▶️ <b>启动命令</b></nobr></td>
    <td>直接运行目录下的 <code>./copy-ninjia</code></td>
    <td>运行 <code>bun run start</code> 或 <code>bun run index.ts</code></td>
  </tr>
</tbody>
</table>

> [!TIP]
> **安装流程概览**：
> 1. **环境与架构校验**：核对 Linux 与 `/proc` 可用性；自动识别 Linux x64/arm64 与 glibc/musl。
> 2. **部署配置准备**：仅补充缺少的配置模板，跳过 `agent.json`、`g-auth.json` 与 `cron.json`。已有文件先在工作树外备份，校验通过后原子替换；生成的文件权限严格设为 `600`。
> 3. **身份数据库初始化**：按生产路径校验 `database/storage.sqlite`。已存在时只读核对它绑定的时区与 `bot.json` 的 `time_zone` 一致，不符即在注册服务前退出；不存在则以 `bot.json` 的时区初始化当前 schema 的全新空库。
> 4. **服务注册与观测**：自动注册或复用 `copy-ninjia.service`，启动后动态观察服务状态，确认 `active/running`、重启计数稳定且 journal 无异常后清理备份。

### 手工源码安装

```bash
# 1. 克隆代码仓库
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia

# 2. 锁定安装依赖
bun install

# 3. 准备部署配置目录
mkdir -p config/static config/dynamic
for example in config_example/static/*.json config_example/dynamic/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" "config/${example#config_example/}" ;;
  esac
done
```

> [!WARNING]
> `g-auth.json` 与 `cron.json` 的示例仅示意语法，不要盲目复制到生产环境。详细说明见 [`config_example/README/zh.md`](../../config_example/README/zh.md)。

---

## 配置 Telegram 身份

Bot 基础身份与全局超级管理员定义在 `config/static/bot.json`：

- **`bot_token`**（必填，字符串）
  - 从 BotFather 取得的 Telegram Bot API Token。
- **`super_admin_user_id`**（必填，正整数）
  - 单个十进制超级管理员用户 ID。
  - **特权边界**：该身份本身天然持有白名单能授予的**全部权限**，不需要写入 SQLite 白名单表。
  - **豁免保护**：复读、生图等操作的冷却豁免仅属于该身份；恒在白名单边界内，享有自动处置保护，不可被 `/block`、`/mute` 或 `/batch_kick` 处置。
  - **专属命令**：`/init`、`/batch_kick`、`/permission` 的修改操作、`/white disable` 与 `/send` 仅允许超级管理员调用。
- **`atmosphere`**（可选，枚举：`"mesugaki"` | `"normal"`）
  - 通知与菜单的默认语气风格（雌小鬼 / 普通版）。
  - 显式配置优先；未配置时，存在 `prompt/persona.md` 使用普通文案，否则使用雌小鬼文案。字符串先去掉首尾空白，非法值拒绝启动。
- **`time_zone`**（可选，IANA 时区名，缺省 `"Asia/Tokyo"`）
  - 默认日历时区，供运势、日志、广告累计、AI 时间、每日维护及未指定时区的 cron 共用。
  - 去掉首尾空白后校验，并按 Temporal 规范化大小写（如 `asia/tokyo` 记为 `Asia/Tokyo`；`Japan` 等别名原样保留）；空字符串、非法类型或不支持的时区会拒绝启动。
  - 建库时写入数据库 `storage_metadata` 的 `time-zone` 标记，数据根从此绑定该时区：启动与安装器都按它比对，修改 `time_zone` 会被拒绝启动（报错点名 `storage_metadata.time-zone`），已有数据根不支持更换时区。

---

## 项目侧配置文件

`config/` 目录属于部署方私有数据，已在 `.gitignore` 中完全排除。文件布局必须严格遵守子目录分类：

```text
config/
├── static/                 # 静态配置（修改后须重启进程）
│   ├── bot.json            # 机器人身份与超管配置
│   └── g-auth.json         # Google Cloud 服务账号凭据（可选）
└── dynamic/                # 动态配置（修改后约 0.5s 自动热重载）
    ├── agent.json          # AI 模型各项能力配置
    ├── assets.json         # 缩略图、默认头像与图库路径
    ├── stickers.json       # 贴纸包白名单
    ├── mood.json           # 心情挡位与权重
    ├── ad_samples.json     # 广告样本参考集
    └── cron.json           # 定时任务配置（可选）
```

> [!IMPORTANT]
> - 任何配置文件若出现在 `config/` 顶层或放错子目录，系统将在启动阶段直接 fail-closed 退出。
> - 运行中修改 `config/dynamic/` 下的文件会自动触发防抖热重载。若改动出现语法或 schema 错误，该次改动整份拒绝并记日志，继续沿用上一份有效快照；下次重启时若仍未修复则拒绝启动。

### 核心配置文件详解

- **`prompt/persona.md`**（可选，项目根目录）
  - **内容**：自定义 AI 闲聊人设。
  - **行为**：缺省使用代码内置人设（[`persona.ts`](../../packages/consts/aiChat/prompts/persona.ts)）；存在时以文件正文替换人设；通知优先采用显式 `atmosphere`，风格未配置时使用普通文案。
  - **校验**：纯文本格式；若存在但为空白或非合法 UTF-8 则拒绝启动。修改后须重启。

- **`config/static/bot.json`**（[示例](../../config_example/static/bot.json)）
  - 声明 `bot_token`、`super_admin_user_id` 与可选的 `atmosphere`、`time_zone`。启动前严格校验，未知键或非法类型均拒绝启动。

- **`config/dynamic/stickers.json`**（[示例](../../config_example/dynamic/stickers.json)）
  - 声明 AI 可选用的贴纸包名称数组，最多 5 个。

- **`config/dynamic/mood.json`**（[示例](../../config_example/dynamic/mood.json)）
  - 声明 AI 心情挡位（名称、描述、权重、天气与时段倍率）。权重必须为正整数且总和严格等于 100。

- **`config/dynamic/ad_samples.json`**（[示例](../../config_example/dynamic/ad_samples.json)）
  - 声明广告检测模型的参考判定样本，纯字符串数组，非空且不重复，最多 500 条。

- **`config/dynamic/agent.json`**（[示例](../../config_example/dynamic/agent.json)）
  - 声明 AI 系统的 7 大能力。每项能力独立配置，能力之间绝不跨项回退：
    1. **对话核心必备能力**（三项缺一则 AI 闲聊不可用）：
       - `text`：文本生成模型。
       - `summary`：记忆压缩摘要模型。
       - `media`：视觉与语音转写模型。支持多模态首次请求探测与端点退避。
    2. **扩展生成能力**（缺省时仅摘除对应工具）：
       - `image`：生图能力。OpenAI 兼容协议必须显式声明 `image_protocol`（`openai` | `openai-standard` | `xai`）。
       - `tts`：语音合成能力。必须指定 `voice` 音色；OpenAI 需声明 `speech_protocol`（`openai` | `xai`）。可选 `daily_limit`（默认 100）与 `daily_reserve_quota`（默认 25，分配给 `/send` 与 cron）。
    3. **检索与风控能力**：
       - `web_search`：本地联网检索工具能力。支持 `max_calls_per_use`（默认 5）限制单轮调用次数。未配置时回退使用 `text` 模型的服务端内建检索。
       - `ad_detect`：进群消息广告识别能力。未配置时阻止广告检测。
    4. **单项能力通用字段**：
       - `provider`：`google` | `openai` | `anthropic`（`image` 与 `tts` 仅支持前两者）。
       - `api_key`：访问密钥。
       - `model`：模型标识字符串。
       - `base_url`：可选自定义端点（仅限 `https`，明文 `http` 仅允许 localhost/127.0.0.1/::1）。
       - `headers`：仅 `google` provider 允许配置附加 HTTP 请求头（1～8 个，用于 Cloudflare AI Gateway 等三方网关鉴权）。

---

### 初始化身份数据库

运行时不执行自动建表，首次部署必须手工或通过脚本初始化 SQLite 数据库：

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
> `initializeStorageDatabase` 必不可少：它在 `storage_metadata` 写入 schema 版本号与 `bot.json` 的 `time_zone`（数据根绑定的时区标记），因此须在配置 Telegram 身份之后执行。若跳过该步，启动 hydrate 会因找不到元数据而直接退出。

---

### 换掉内联缩略图与机器人默认头像

通过 `config/dynamic/assets.json`（支持热重载）自定义界面素材与图库目录：

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

- **`onlyPath`**：只收本机绝对路径或 `./` / `../` 相对路径（相对数据根解析）。`random_h_image_dir` 为 `/h_image` 专用图库。
- **`pathOrUrl`**：本机路径或 HTTPS/HTTP 直链。`bot_default_avatar` 为复原默认头像所用图片。
- **`onlyUrl`**：必须为可直出图片字节的 `https://` 绝对地址。分别为运势、概率论与 gag 发言入口的缩略图。

---

## Telegram 侧配置（BotFather 与群内）

前往 [@BotFather](https://t.me/BotFather) 完成以下配置：

1. **关闭 Privacy Mode**：执行 `/setprivacy` -> 选择你的 Bot -> 设为 **Disable**。
   - *原因*：若不关闭，机器人无法收到群内普通消息，复读、AI 闲聊与自动风控均无法触发。
2. **授予管理员权限**：将机器人拉入目标群，并授予群管理员权限（删除消息、封禁成员、管理群聊等）。
3. **开启 Inline Mode**：执行 `/setinline` -> 设为 **Enable**。
   - *原因*：运势抽签（`@机器人 所求事项`）与 gag 限制发言均依赖内联模式。
4. **设置 Inline 反馈率**：执行 `/setinlinefeedback` -> 设为 **100%**。
   - *原因*：`chosen_inline_result` 是抽签结果落地确认与落盘的核心链路。
5. **（可选）开启 Bot-to-Bot 通信**：如需复读或翻译其他机器人的普通发言，在 BotFather 中开启该模式。收到的其他 Bot 消息会经过[主线程入口限流](04-invariants.md)。

---

## 首次启动

```bash
# 1. 运行质量门禁确认环境完好
bun run check

# 2. 启动长轮询服务
bun run start
```

服务启动后，**超级管理员**在目标群组中发送命令完成握手：

```text
/init enable      # 激活本群业务入口（必须先执行此项，否则其余消息均被静默丢弃）
/ai_chat enable   # （可选）开启本群 AI 闲聊
/ad_detect enable # （可选）开启本群广告检测（需管理员权限）
/antiraid enable  # （可选）开启本群入群验证与防冲群私密模式（需管理员权限）
```

### 验证跑通了

- 在群里发送 `/copy`（回复某条消息）：机器人应成功复读并同步该用户头像。
- 检查 `logs/` 目录：已正常生成运行日志文件。
- 按 `Ctrl+C` 退出：观察控制台完成入口关闸、Worker 队列排空与状态落盘，确认优雅退出流程顺畅。

---

<div align="center">

**← 上一页：无** · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#01-环境搭建与首次运行) · [下一页：02 架构总览 →](02-architecture.md)

</div>
