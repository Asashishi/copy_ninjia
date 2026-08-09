# 01 环境搭建与首次运行

<p align="center">
  <b>简体中文</b> · <a href="../en/01-getting-started.md">English</a> · <a href="../ja/01-getting-started.md">日本語</a>
</p>

<p align="center">
  <a href="conntent-table.md">📚 开发者文档首页</a> · <b>← 上一页：无</b> · <a href="02-architecture.md">下一页：02 架构总览 →</a>
</p>

---

本页把一个全新环境带到「机器人在群里正常工作」。只求最短路径；每一步背后的设计原因见 [02 架构总览](02-architecture.md)。

## 前置条件

- **Linux（带可读的 `/proc`）**：实例锁依赖 `/proc/<pid>/stat` 与 boot ID；其它平台会 fail-closed 拒绝启动。
- **Bun 1.3+**：`curl -fsSL https://bun.sh/install | bash`。项目所有脚本、测试与运行时都走 Bun，不需要 Node.js。
- **Telegram Bot Token**：找 [@BotFather](https://t.me/BotFather) `/newbot` 创建。
- **所配 AI 能力的 API Key**：`config/agent.json` 的每项能力各自持有 key、provider、端点与模型；可从 [Google AI Studio](https://aistudio.google.com/)、[OpenAI Platform](https://platform.openai.com/) 或所配兼容服务取得。能力之间不回退。
- **（可选）Google Cloud 服务账号 JSON**：只有 `/ja_copy` 日语翻译需要，存为项目根的 `g-auth.json`。缺失或写坏时 `/ja_copy` 直接拒绝并点名这个文件，自动复读的 ja 变换退化成普通复制；若已有群开着 `/ja_copy enable`，则拒绝启动。

## 安装

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
mkdir -p config
cp -n config_example/*.json config/
```

## 配置 Telegram 身份

完整字段与能力说明见 [`config_example/README/zh.md`](../../config_example/README/zh.md)。
Bot 身份和超级管理员写入 `config/telegram.json`：

- **`bot_token`**（必填）
  - BotFather 下发的 token。
- **`super_admin_user_id`**（必填）
  - 单个十进制超级管理员用户 ID。这个身份本身即持有 `whitelist.json` 能授予的
    **全部**逐项权限，**不需要**在 `whitelist.json` 里另配一条；它同时恒在白名单
    边界内，因此也享有 copy 冷却豁免、验证代点与自动处置保护，并且不可被 `/block`、
    `/mute` 或 `/batch_kick` 处置。
  - 另有五项只认身份、无法通过 `whitelist.json` 授予：`/init`、`/batch_kick`、
    `/permission` 的修改操作、`/white` 与 `/send`。
  - 白名单身份可用 `/permission query` 查询自身权限，并用 `/permission help` 查看说明；
    超级管理员的 `query` 返回那份逐项全开的视图。
AI 的 provider、API key、端点与模型按能力写入 `config/agent.json`。如需改变运行时
数据目录，可在进程环境中设置 `COPY_NINJIA_DATA_ROOT`；缺省时数据落在项目根，详见
[07 运维与排障](07-operations.md#数据根)。如需日语翻译，把服务账号密钥存为项目根目录
的 `g-auth.json`；该文件已加入 `.gitignore`。

## 项目侧配置文件

`config/` 是部署方自己的配置目录，已从 Git 追踪中排除；初次安装从 `config_example/` 复制，之后只改 `config/`，不要直接把示例目录当运行时配置。

- **[`prompt/persona.md`](../../prompt/persona.md)**
  - **内容**：AI 闲聊的基础人设。
  - **校验**：纯文本，无 schema。
- **`config/telegram.json`**（[示例](../../config_example/telegram.json)）
  - **内容**：Bot API token 与唯一超级管理员用户 ID。
  - **校验**：[`packages/config/telegram.ts`](../../packages/config/telegram.ts)；联网前严格
    加载，缺失、未知字段、空 token 或非法 ID 均拒绝启动。
- **`config/whitelist.json`**（[示例](../../config_example/whitelist.json)）
  - **内容**：用户/频道白名单及逐项权限；身份存在本身还代表 copy 冷却豁免、
    验证代点与自动处置保护。超级管理员不必也不应写进这里——它的
    全部权限由身份直接给出，写进来的条目永远不会被读到。
  - **校验**：[`packages/config/whitelist.ts`](../../packages/config/whitelist.ts)；
    联网前严格加载，缺失或损坏会拒绝启动。
- **`config/blocklist.json`**（[示例](../../config_example/blocklist.json)）
  - **内容**：部署方手工维护的静态用户/频道黑名单 ID 数组。
  - **校验**：[`packages/config/blocklist.ts`](../../packages/config/blocklist.ts)；
    联网前严格加载，并与 `memory/` 动态层合并。
- **`config/stickers.json`**（[示例](../../config_example/stickers.json)）
  - **内容**：AI 可用的贴纸包，最多 5 个。
  - **校验**：[`packages/config/stickers.ts`](../../packages/config/stickers.ts)。
- **`config/reactions.json`**（[示例](../../config_example/reactions.json)）
  - **内容**：AI 可用的 emoji 反应集合。
  - **校验**：[`packages/config/reactions.ts`](../../packages/config/reactions.ts)。
- **`config/mood.json`**（[示例](../../config_example/mood.json)）
  - **内容**：心情档位，包括文案、权重与天气/时段倍率。
  - **校验**：[`packages/config/mood.ts`](../../packages/config/mood.ts)；权重必须是正整数，
    且总和恰好 100。
- **`config/ad_samples.json`**（[示例](../../config_example/ad_samples.json)）
  - **内容**：广告检测的判定口径示例，顶层就是字符串数组。
  - **校验**：[`packages/config/adSamples.ts`](../../packages/config/adSamples.ts)；条目非空、
    不重复，最多 500 条。

- **`config/agent.json`**（[示例](../../config_example/agent.json)）
  - **内容**：`agent.ad_detect`、`text`、`summary`、`media`、`image`、`song` 六项能力。
    每项独立声明 `provider`、`api_key`、可选 `base_url` 与 `model`；provider 当前只接受
    `google`、`openai`。`text`、`summary`、`media` 是 AI 对话必备项；`image`、`song`
    缺省时只摘掉对应工具；`ad_detect` 缺省时只阻止广告检测。OpenAI 生图还必须显式
    声明 `image_protocol`（`openai`、`openai-standard` 或 `xai`）。`base_url` 只接受
    `https`，明文 `http` 仅限 `localhost`、`127.0.0.1`、`::1`；URL 不得带用户名/密码
    或 `#` 片段。
  - **校验**：[`packages/config/agent.ts`](../../packages/config/agent.ts)。文件与字段严格
    校验，未知键、空 key/model、非法 provider/URL/协议都会拒绝对应功能。**整份配置只由
    主线程在启动时解析一次**，再随各 Worker 的初始化消息投递过去；Worker 侧只读这份
    快照、从不读盘，崩溃重建也重放同一份，因此同一进程内不会出现两代配置——修改后
    必须整进程重启。媒体的视觉和语音输入分别在首次真实请求时探测：明确不支持、或端点
    以 404/405 表明模型/路径不存在时都停止下载该类媒体（后者另记一行指向
    `$.agent.media` 的诊断），瞬时故障只按次数退避、不会永久关闭能力。

`whitelist.json` 与 `blocklist.json` 是全局安全边界，必须在联网和 Worker 启动前严格加载。其余配置按功能惰性校验：`/ai_chat enable` 读取贴纸、反应、心情、人设和 `agent.json` 的对话能力；`/ad_detect enable` 读取广告样本与 `agent.ad_detect`；`/ja_copy enable` 读取 `g-auth.json`。任一份读不动只拒绝对应开关；若该功能已在状态中开启，则启动总闸拒绝进程启动。结论按进程缓存，修好文件后必须重启。

### 从 2.1.0 升级

升级时先停止旧进程并备份整个 `config/`。将原 `gemini.json`、`openai.json` 的模型、
端点与 API key 手工迁入统一的 `agent.json`，不要用示例目录覆盖部署配置。旧的 AI 环境
变量和 `state.json.global.model` 运行时选择不再读取；模型切换改为停机修改对应能力配置后
重启。示例值只保证结构正确，不保证账号具有调用权限。

旧 `.env` 中每个 `PRIVILEGED_USERS_ID` 必须手工改成 `whitelist.json` 的键，然后删除该环境变量。只需要保留 copy 冷却豁免、验证代点和自动处置保护的身份可写成空对象 `{}`；要保持旧版 `/block` 与 `/unblock` 能力则显式写入 `"isCanBlock": true`、`"isCanUnBlock": true`。其它权限按需开启；超级管理员不必迁进来，它的全部权限由 `config/telegram.json` 中的身份直接给出（旧版把它写进白名单的部署可以留着不管，那条条目已经读不到了，也可以用 `/white <超管id> disable` 清掉）。白名单身份可执行 `/permission help` 查看完整键与说明，并用 `/permission query` 查询解析默认值后的自身完整权限。`/white` 与 `/permission` 的修改操作会原子改写该文件，因此运行用户必须对 `config/` 目录拥有写权限；其余配置仍可只读。

**例外：功能已经开着的时候仍然拒绝启动。**`state.json` 里那个 `true` 是管理员当初明确按下的，把它悄悄降级成「静默不干活」，群里看到的就是机器人从某次重启起再也不闲聊/不抓广告/不翻译。因此启动时会核对一次：凡是还有群开着的可选功能，凭据与配置必须齐备，缺了就带着群 id 和缺失项拒绝启动（见 [`packages/app/featurePreflight.ts`](../../packages/app/featurePreflight.ts)）。出路是补回前提，或者先 `/ai_chat disable`、`/ad_detect disable`、`/ja_copy disable` 再撤掉它。

### 换掉运势缩略图与机器人默认头像

两张内联抽签缩略图（`/luck_challenge` 的「未卜先知」「概率论」）和 `/reset_icon`、`/stop_copy` 复原用的默认头像，直链都放在 `state.json` 的 `global.assets`：

```json
"global": {
  "assets": {
    "fortuneThumbnailUrl": "https://…",
    "probabilityThumbnailUrl": "https://…",
    "botDefaultAvatarUrl": "https://…"
  }
}
```

三个键依次是「未卜先知」的缩略图、「概率论」的缩略图、复原头像时抓的那张图。`state.json` 走严格 `JSON.parse`，块里不能带 `//` 注释。

三项在启动成功时被自动补成代码里的内置缺省值，所以打开文件就能看到当前生效的地址，直接改即可。要求是**能直出图片字节的绝对地址**，图床不限（内置缺省恰好用了 Google Drive 直链，不代表只能用它；用 Drive 时注意分享页 `/file/d/<id>/view` 返回的是网页而不是图片字节）。两张缩略图由 Telegram 客户端去取，只接受 `https://`；只有 `botDefaultAvatarUrl` 允许明文 `http://`，那张图由 Bot 自己抓，走不走 TLS 由你决定。抓头像那条请求**跟随重定向**，所以「直链先 302 到实际存储域名」这种常见形态（内置缺省那条 Drive 链接就是）直接填上即可，不必自己解析出终点。写坏——比如漏掉 `https://`——会在启动解码时拒绝整份 `state.json` 并点名字段路径，不会静默退回默认图。

> 从 `state.global.assets` 早于本节的版本升级上来时，**先看一眼这三项再启动**：两张缩略图现在只认 `https`，此前配成 `http://` 的会在解码期拒绝启动并点名字段路径。

**改法是停机改**：运行中的进程持有权威内存，会整份覆写这个文件，改完必须 `systemctl stop` → 编辑 → `systemctl start`（同 [07 运维与排障](07-operations.md)）。

## Telegram 侧配置（BotFather 与群内）

1. `/setprivacy` 关闭 Privacy Mode——否则机器人看不到普通群消息，复读与 AI 记忆都不工作。
2. 把机器人拉进群并授予管理员权限（删消息、封禁成员、管理群）——入群验证与 Anti-Raid 只在有权限时启用，还要在群里 `/antiraid enable` 打开（缺省关闭）。
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
/antiraid enable  # （可选）打开本群入群验证与防冲群私密模式；同样需要管理员权限
```

`/antiraid` 一条开关同时管两件事：新成员的按钮验证（超时踢出）和短时间大量入群时自动关闭邀请权限的私密模式。缺省关闭，关掉后这两条链路一个事件都不触发；广告检测、防刷屏禁言和永久黑名单各有各的开关，不受它影响。授权键是 `isCanControllAntiRaidPermission`（超级管理员恒持有）。

## 验证跑通了

- 群里发 `/copy`（回复某人的消息）——机器人开始复读并同步头像。
- `logs/` 目录出现错误日志文件（无错误时可能为空）；`state.json` 在首次成功启动时生成——启动闸通过后会把 `global.assets` 的素材直链补成当前生效值并落盘（见下节）。
- 停止用 `Ctrl+C`：进程会 quiesce 入口、drain 各队列、flush 状态后退出，属正常停机路径。

启动失败时（数据根预检、`bot.lock`、state 校验的报错都设计为快速失败），对照 [07 运维与排障](07-operations.md#启动失败排查) 处理。

---

<div align="center">

**← 上一页：无** · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#01-环境搭建与首次运行) · [下一页：02 架构总览 →](02-architecture.md)

</div>
