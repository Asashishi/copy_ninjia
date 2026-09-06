# 01 环境搭建与首次运行

<p align="center">
  <b>简体中文</b> · <a href="../en/01-getting-started.md">English</a> · <a href="../ja/01-getting-started.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <b>← 上一页：无</b> · <a href="02-architecture.md">下一页：02 架构总览 →</a>
</p>

---

本页把一个全新环境带到「机器人在群里正常工作」。只求最短路径；每一步背后的设计原因见 [02 架构总览](02-architecture.md)。

## 前置条件

- **Linux（带可读的 `/proc`）**：实例锁依赖 `/proc/<pid>/stat` 与 boot ID；其它平台会 fail-closed 拒绝启动。
- **Bun 1.4.2**：`curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2`。项目所有脚本、测试与运行时都走 Bun，不需要 Node.js。
- **Telegram Bot Token**：找 [@BotFather](https://t.me/BotFather) `/newbot` 创建。
- **所配 AI 能力的 API Key**：`config/agent.json` 的每项能力各自持有 key、provider、端点与模型；可从 [Google AI Studio](https://aistudio.google.com/)、[OpenAI Platform](https://platform.openai.com/) 或所配兼容服务取得。能力之间不回退。
- **（可选）Google Cloud 服务账号 JSON**：只有 `/ja_copy` 日语翻译需要，存为项目根的 `g-auth.json`。缺失时 `/ja_copy` 直接拒绝并点名这个文件，自动复读的 ja 变换退化成普通复制，但不阻止进程启动；文件存在却写坏时，启动总闸会在解析阶段拒绝启动。

`g-auth.json` 由 `packages/config/googleAuth.ts` 严格解析：`client_email` 为非空字符串，`private_key` 为可解析的非空 PEM 私钥；`type` 可省略，存在时只能为 `service_account`。SDK 消费的 `private_key_id`、`project_id`、`quota_project_id`、`universe_domain` 可省略，存在时必须为非空字符串。其余元数据原样保留。校验发生在创建 Worker 和连接 Telegram 之前，错误仅包含文件路径、字段路径与期望，不输出凭据值。

## 安装

### 一键安装

假设机器上什么都没装的话，[`install.sh`](../../install.sh) 把本页剩下的步骤连成一条：

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

下载入口找到工作树后，使用该树自己的 `install.sh` 完成后续步骤。`COPY_NINJIA_DIR` 支持相对路径和绝对路径。当前代码要求 Bun **1.4.2**；已有 Bun 版本不匹配时，安装器在安装依赖和写配置前退出并提示手工安装，不自动覆盖已有 Bun。

不用先 clone：脚本自己会把 **GitHub 上的 Latest Release** clone 到当前目录下的 `copy_ninjia/`（想换目录设 `COPY_NINJIA_DIR`），落在该 tag 上（detached HEAD）。装的是已发布版本而不是 `master` HEAD——tag 由 `releases/latest` 接口现问，问不到就当场失败，不会退回 `master`：那等于把一台生产机装成还没公告过的代码。

已经有工作树时，在仓库根跑 `bash install.sh` 等价，会跳过 clone，并且**不改动那棵树的 checkout**（它可能有本地改动或有意停在某个版本），只报一句当前版本。

源码若是解压发布包（或整目录拷贝）得到的——有源码、没有 `.git`——脚本会就地补出 git 仓库，好让此后能用 git 更新：`git init`、把 `origin` 指向本仓库、拉全部 tag，再**逐个 tag 比对内容**认出与现有文件一致的那个，把 `HEAD` 指过去（detached，与 clone 出来的形态相同），于是 `git status` 是干净的，更新就是一次 `git fetch --tags` 加 `git checkout <新 tag>`。

补仓库这一步**不写工作树里的任何文件**，也不会把 `config/`、`state.json`、`g-auth.json` 这类部署数据收进对象库——它只用 `read-tree`/`diff-index` 比对 tag 自带的对象，未跟踪文件完全不参与，因此不依赖 `.gitignore` 是否完整。对不上任何已发布 tag 时（改过，或根本不是发布包）**不猜版本**：仓库、`origin` 和 tag 都给到位，但 `HEAD` 不指向任何版本，由你核对后自行 `git checkout <tag>`。装不上 `git`、拉不到 tag 也只是跳过这一步并提示，不会中断安装。

安装器在依赖安装、配置或数据库写入前核对既有服务：必须为 `inactive/dead`，`WorkingDirectory` 必须指向目标工作树，`ExecStart` 必须是唯一一条 Bun 项目入口。运行中、状态未知或归属不符时拒绝修改；请先按 [07 运维](07-operations.md) 的流程停机并确认。安装器不会自动停掉既有服务。

配置校验完成后注册或复用 `copy-ninjia.service`，覆盖既有 unit 前先备份。启动后按实际重启等待上限（包括生效的退避与随机延迟）观察两倍时长，再加两秒；要求 `active/running`、重启计数不变且 journal 无新增非零退出。查询失败或 journal 不可读时非零退出并保留备份。没有 systemd 且没有既有 unit 时进入前台运行，备份留待人工核验。

管道运行下 fd 0 是脚本正文本身，所以所有问答都从 `/dev/tty` 读——拿不到控制终端时脚本直接退出，不会读到半截脚本当答案。

安装流程包括以下步骤：

1. **环境与代码**：检查 Linux、可读 `/proc` 和控制终端；按需补齐基础工具、取得 Latest Release 或复用既有工作树。缺少 Bun 时安装目标代码指定的精确版本，核对 `packageManager` 后执行 `bun install --frozen-lockfile`，沿用七天依赖冷却期。
2. **部署配置**：只补缺少的示例文件，跳过 `agent.json` 示例。Telegram 身份可交互重填；既有文件先在工作树外备份，再校验候选文件并原子替换。未配置 AI 能力时不创建 `agent.json`，既有 AI 配置保持原样。生成的身份与 AI 配置权限为 `600`。
3. **身份数据库与校验**：按生产路径解析结果检查 `database/storage.sqlite`，只在不存在时创建当前 schema 的空库，再校验部署输入。
4. **服务与观察**：在已确认停止的部署上注册或复用 unit，启动并完成状态、动态观察时长、重启计数与 journal 核验。仅全部通过才清理配置和 unit 备份；验证失败非零退出，前台运行保留备份。

脚本重跑时保留既有数据库，配置仅在明确重填时替换。`g-auth.json` 由部署方带外提供；缺少它时日语翻译不可用，已有但非法时拒绝启动。

### 手工安装

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
  - 单个十进制超级管理员用户 ID。这个身份本身即持有白名单能授予的
    **全部**逐项权限，**不需要**写入 SQLite 白名单表；copy、生图、生歌的冷却
    豁免只归这个身份。它同时恒在白名单边界内，因此享有自动处置保护，并且
    不可被 `/block`、`/mute` 或 `/batch_kick` 处置。入群验证的「通过」按钮
    只认本群非匿名管理员，与白名单和超级管理员身份无关。
  - `/init`、`/batch_kick`、`/permission` 的修改操作、`/white disable` 与 `/send`
    只认这个身份；`isCanWhiteOther` 只能把其它身份以默认权限加入白名单，不能删除成员。
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
  - **校验**：[`packages/config/telegramInput.ts`](../../packages/config/telegramInput.ts)；联网前严格
    加载，缺失、未知字段、空 token 或非法 ID 均拒绝启动。
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

永久白名单、黑名单、临时白名单累计与待完成处置不是部署 JSON；它们统一放在运行时数据根的 `database/storage.sqlite`，由 Disk I/O Worker 在启动时完成 SQLite 完整性、migration 谱系、schema 版本、JSONB/关系列结构和名单互斥校验。其余配置按功能惰性校验：`/ai_chat enable` 读取贴纸、反应、心情、人设和 `agent.json` 的对话能力；`/ad_detect enable` 读取相应分类前提；`/ja_copy enable` 读取 `g-auth.json`。任一份读不动只拒绝对应开关与该功能的运行路径，不阻止进程启动；但**文件只要存在就必须能严格解析**，非法内容即使对应功能当前关着也会在启动总闸拒绝启动（见 [`packages/config/readiness.ts`](../../packages/config/readiness.ts) 的 `validateExistingDeploymentInputs`）。结论按进程缓存，修好文件后必须重启。

### 初始化身份数据库

运行时不会猜测缺失数据库并自动建空表，全新部署必须显式建一次空库。[`install.sh`](../../install.sh) 已经包含这一步；手工安装时执行：

```bash
mkdir -p database
bun -e '
  import { createStorageDatabase } from "./packages/database/interact/migration";
  import {
    closeStorageDatabase,
    enableStorageDatabaseWal,
    openStorageDatabase,
  } from "./packages/database/interact/connection";
  import { initializeStorageDatabase } from
    "./packages/database/interact/initialization";
  import { IDENTITY_DATABASE_PATH } from "./packages/consts/paths";
  createStorageDatabase(IDENTITY_DATABASE_PATH);
  const database = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  try {
    initializeStorageDatabase(database);
  } finally {
    closeStorageDatabase(database);
  }
  enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
'
chmod 2770 database
chmod 660 database/storage.sqlite
```

`initializeStorageDatabase` 那一笔不能省：`createStorageDatabase` 只建表，`storage_metadata` 的 schema-version 行不在 migration 里。漏掉它库看着是好的，但启动 hydrate 会以「storage_metadata must contain exactly one schema-version row」拒绝。

建出来的是当前 schema 的空库，黑白名单和待踢 outbox 都为空；目标库已存在时 `createStorageDatabase` 直接拒绝覆盖，不会动现场。两个 `chmod` 与
[`packages/consts/identityStorage.ts`](../../packages/consts/identityStorage.ts) 的 `IDENTITY_DATABASE_DIRECTORY_MODE`、`IDENTITY_DATABASE_FILE_MODE` 一致，setgid 让 WAL/SHM 旁路文件继承同一个协作组。

仍在用 `config/whitelist.json`、`config/blocklist.json` 的旧部署**不适用**这条路径：那份冷迁移脚本最后一次随 9.1.5 发布，见 [07 运维与排障](07-operations.md#身份存储迁移)。

### 从 2.1.0 升级

升级时先停止旧进程并备份整个 `config/`。将原 `gemini.json`、`openai.json` 的模型、
端点与 API key 手工迁入统一的 `agent.json`，不要用示例目录覆盖部署配置。旧的 AI 环境
变量和 `state.json.global.model` 运行时选择不再读取；模型切换改为停机修改对应能力配置后
重启。示例值只保证结构正确，不保证账号具有调用权限。

旧 `.env` 中每个 `PRIVILEGED_USERS_ID` 必须先迁入旧格式白名单输入，再删除该环境变量并**在 9.1.5 上**运行身份存储迁移（该脚本已在 9.2.0 删除，见 [07 运维与排障](07-operations.md#身份存储迁移)）；不要在 SQLite 迁移完成后手改数据库。只需要保留自动处置保护的身份可写成空对象 `{}`；其它权限按需开启。超级管理员不迁入白名单表，它的全部权限由 `config/telegram.json` 中的身份直接给出。迁移完成后，白名单身份可执行 `/permission help` 查看完整键与说明，并用 `/permission query` 查询自身完整权限；`/white` 与 `/permission` 通过数据库事务持久化，`config/` 可保持只读。

**注意：撤掉凭据不会拒绝启动，但那个群会静默停摆。**启动总闸只校验**已经存在**的部署输入（见 [`packages/app/featurePreflight.ts`](../../packages/app/featurePreflight.ts)，它现在只是 `packages/config/readiness.ts` 的 `validateExistingDeploymentInputs` 出口）：文件在就必须严格解析通过，文件真的不在则不阻止启动。`chat_states` 里那个 `true` 会照常恢复，但对应功能在唯一判定入口上被判为不可用——AI 闲聊的 Worker 根本不启动、记忆不 hydrate（`memory/` 里那份原样留着等前提补齐），`/ja_copy` 退化成普通复制，广告检测不再送检。群里看到的就是机器人从某次重启起再也不闲聊/不抓广告/不翻译，而痕迹只有 `logs/` 里的一行。因此撤凭据前先 `/ai_chat disable`、`/ad_detect disable`、`/ja_copy disable`，或者干脆把前提补回去。

### 换掉内联缩略图与机器人默认头像

三张内联结果缩略图（`/luck_challenge` 的「未卜先知」「概率论」，以及 gag 发言入口）和 `/reset_icon`、`/stop_copy` 复原用的默认头像，直链都放在 `state.json` 的 `global.assets`：

```json
"global": {
  "assets": {
    "fortuneThumbnailUrl": "https://…",
    "probabilityThumbnailUrl": "https://…",
    "gagThumbnailUrl": "https://…",
    "botDefaultAvatarUrl": "https://…"
  }
}
```

四个键依次是「未卜先知」的缩略图、「概率论」的缩略图、gag 发言 inline 结果的缩略图、复原头像时抓的那张图。`state.json` 走严格 `JSON.parse`，块里不能带 `//` 注释。

四项在启动成功时被自动补成代码里的内置缺省值（见 [`packages/consts/ui/assets.ts`](../../packages/consts/ui/assets.ts)），所以打开文件就能看到当前生效的地址，直接改即可。要求是**能直出图片字节的绝对地址**，图床不限（内置缺省恰好用了 Google Drive 直链，不代表只能用它；用 Drive 时注意分享页 `/file/d/<id>/view` 返回的是网页而不是图片字节）。三张缩略图由 Telegram 客户端去取，只接受 `https://`；只有 `botDefaultAvatarUrl` 允许明文 `http://`，那张图由 Bot 自己抓，走不走 TLS 由你决定。抓头像那条请求**跟随重定向**，所以「直链先 302 到实际存储域名」这种常见形态（内置缺省那条 Drive 链接就是）直接填上即可，不必自己解析出终点。写坏——比如漏掉 `https://`——会在启动解码时拒绝整份 `state.json` 并点名字段路径，不会静默退回默认图。

> 从 `state.global.assets` 早于本节的版本升级上来时，**先看一眼这五项再启动**：四张缩略图现在只认 `https`，此前配成 `http://` 的会在解码期拒绝启动并点名字段路径。

**改法是停机改**：运行中的进程持有权威内存，会整份覆写这个文件，改完必须 `systemctl stop` → 编辑 → `systemctl start`（同 [07 运维与排障](07-operations.md)）。

## Telegram 侧配置（BotFather 与群内）

1. `/setprivacy` 关闭 Privacy Mode——否则机器人看不到普通群消息，复读与 AI 记忆都不工作。
2. 把机器人拉进群并授予管理员权限（删消息、封禁成员、管理群）——入群验证与 Anti-Raid 只在有权限时启用，还要在群里 `/antiraid enable` 打开（缺省关闭）。
3. `/setinline` 开启 Inline Mode——运势抽签 `@机器人 所求事项` 依赖它。
4. `/setinlinefeedback` 设为 100%——`chosen_inline_result` 是抽签结果确认与落盘的主路径；消息内的签名回执是补充确认路径。

## 首次启动

```bash
bun run check     # 约定检查 + ESLint + tsc + 全源码覆盖率测试 + 热路径门禁，首次跑一遍确认环境完好
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

**← 上一页：无** · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#01-环境搭建与首次运行) · [下一页：02 架构总览 →](02-architecture.md)

</div>
