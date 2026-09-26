# 07 运维与排障

<p align="center">
  <b>简体中文</b> · <a href="../en/07-operations.md">English</a> · <a href="../ja/07-operations.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="06-modification-guide.md">← 上一页：06 修改配方</a> · <a href="08-commands.md">下一页：08 命令与行为参考 →</a>
</p>

---

## 部署形态

单实例长轮询进程，无 webhook、无外部数据库服务；身份策略使用本地 SQLite，其余持久化使用数据根内文件。

### 硬件参考

<table width="100%">
<tr><th width="33%" align="left">部署规模</th><th width="26%" align="left">建议配置</th><th width="41%" align="left">说明</th></tr>
<tr><td>入门（低活跃、文本为主、仅少量群开启 AI）</td><td>2 vCPU / 2 GB RAM / 本地 SSD</td><td>可以运行，但媒体高峰时多个 Worker 可能争用 CPU；建议配备 2 GB Swap</td></tr>
<tr><td>轻量生产（文本为主、仅少量群开启 AI）</td><td>4 vCPU / 2 GB RAM / 本地 SSD</td><td>不建议用 2 GB 内存承载媒体处理高峰；建议配备 2 GB Swap</td></tr>
<tr><td>推荐生产（约 15 个单群日均 1,000～3,000 条消息的活跃群）</td><td>4 vCPU / 4 GB RAM / 本地 SSD</td><td>建议配备 2 GB Swap</td></tr>
<tr><td>全部群开启 AI 且图片、贴纸较多</td><td>4 vCPU / 8 GB RAM</td><td>给媒体下载、Base64 编码和图片转码预留峰值空间</td></tr>
</table>

单实例仍建议控制在约 15 个上述规模的活跃群以内；主要限制来自 Telegram Bot API、所配 AI provider 配额和实际消息/媒体速率，而不是群成员总数。

### systemd 示例

```ini
[Unit]
Description=Copy Ninjia Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=copy-ninjia
Group=copy-ninjia
WorkingDirectory=/opt/copy_ninjia
Environment=COPY_NINJIA_DATA_ROOT=/var/lib/copy-ninjia
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

数据根目录先由部署工具预建：`sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia`（`0755` 也接受，见下）。容器部署把同一目录作为持久卷挂载，owner 由宿主或 init container 设置；`memory/` 与 `database/` 都不要放容器临时层。

程序会补建数据根、`logs/`、`memory/` 与初始 `database/`（前三者按 `0755`，`database/` 按 `0770`，实际权限再受 umask 收窄），四者都拒绝符号链接。数据根、`logs/` 与 `memory/` 必须属于运行 UID 且 mode 不宽于 `0755`——这道闸拦的是**写**：group 或 other 拿到 `w` 位一律拒绝启动。读侧放开到 `0755`（默认 umask 建出的目录就是这个 mode）。

> **代价**：`memory/` 新文件默认是 `0644`，所以只采用默认值时，群聊逐字记录的访问控制主要依赖目录位。留在 `0755` 意味着同机器上任何本地账号都能读它们。多租户或存在非特权登录用户的机器，请自行把数据根与 `memory/` 收回 `0750`，并可把既有文件收紧为 `0600`/`0640`；运行时会保留这些 mode，不自动 chmod。部署方可将 `database/` 设为 `02770`，主库及 WAL/SHM 首次创建为 `0660`；该目录可由运行 UID 所有，也可由部署账号所有但 group 必须是运行进程的有效组并具备完整 `rwx`。不要对整个数据根递归执行 `chmod 0750`，否则会拿掉 SQLite 创建 sidecar 所需的 group write。`config/` 是项目内的只读部署输入，身份策略不再从中加载或写回。

进程崩溃或非零退出交给 `Restart=on-failure` 拉起即可：待验证状态、锁定计时、身份写透、AI 记忆与未确认的 Telegram update 都会按 [04 运行时权威约束](04-invariants.md#持久化) 的恢复语义续接。

### 二进制部署

二进制发行目录包含 `copy-ninjia`、`binary.json`、安装器、配置示例、`prompt/`、数据库 schema 文件与 `node_modules/` 中的原生图片依赖；部署时保留完整目录。在该目录执行 `bash install.sh` 完成配置和新库初始化，前台运行使用 `./copy-ninjia`。systemd 的 `WorkingDirectory` 指向该目录，`ExecStart` 使用该目录内可执行文件的绝对路径，不带 `start` 参数；无需系统 Bun。

安装器只为新目录下载 Latest 的对应平台包与 SHA-256，不覆盖或升级既有二进制部署。更新时按下述停机、外部备份、校验和手工迁移流程操作；先在独立暂存目录核验新包，再保留部署配置、凭据与数据并更新程序文件和随包依赖。需要冷迁移时先按本页迁移章节准备迁移工具；启动入口只接受当前格式。发行包构建、平台清单与上传校验见 [05 发布流程](05-dev-workflow.md#发布)。

## 数据根

`COPY_NINJIA_DATA_ROOT` 派生所有运行时数据（未设置时使用项目根目录；显式空白值拒绝启动）：

- **`memory/global/state.json`**
  - **内容**：`copy` 的全局复读状态，以及 `ttsUsage` 的语音合成每日计数（窗口起点 `windowStartedAt` 与次数 `count`，由机器人写入；要手工清零就停服务后删掉整块）。群开关、锁定记录、权限快照与翻译会话保存在 `database/storage.sqlite` 的 `chat_states`；素材目录与直链在 `config/dynamic/assets.json`。
  - **格式**：顶层只有必填的 `copy` 与可选的 `ttsUsage`。`copy.copyMode` 仅接受缺省、`reverse`、`nya`。文件缺失按从未使用处理；存在但非法、出现未知键均拒绝启动，不自动升级或丢弃条目。主线程独占写入（临时文件 + fsync + 原子 rename），Disk I/O Worker 不访问 `memory/global/`。
  - **手工修改状态**：停服务并确认 inactive，在工作树外用 `mktemp -d` 备份该文件及部署数据，记录权限、属主和 SHA-256，再编辑。保留未修改的字段，并用 `decodeGlobalStateFile` 严格解析、核对预期差异和权限后启动。版本升级按下方冷迁移流程执行，不用示例或 Git 内容覆盖部署状态。
  - **旧位置**：数据根下仍有 14.x 的 `state.json` 或 `state.json.bak` 时启动与安装器都拒绝，按[全局状态冷迁移](#全局状态冷迁移statejson-memoryglobalstatejson-configdynamicassetsjson)处理。
- **色图专用目录**（`config/dynamic/assets.json` 的 `random_h_image_dir`，缺省 `./h_image`，相对数据根解析）：
  `/h_image` 与未指定目录的 cron `rand_image` 从这里抽图。通过 `/h_image add` 收图；手工放置必须使用内容 SHA-256 的 64 位小写十六进制文件名，加 `jpg`/`jpeg`/`png`/`webp` 扩展名。禁止混放其他功能的图片。启动检查每个条目，非法名称、子目录、文件链接和残留 `.h_image-add-*` 临时文件均拒绝启动；停服备份后核对并整理残留。服务账号必须能读写和访问该目录；缺失时按 0755 创建。合规图片的增删无需重启；运行中改 `random_h_image_dir` 会先按同一口径准备并检查新目录，检查失败则拒绝这次改动。回滚须恢复与旧代码匹配的整套配置、状态和图库。
- **`memory/wed/<chatId>.json`**
  - **内容**：每群已发言成员 ID 的纯数字数组，例如 `[5974478892]`；主线程每群长期复用一个 `Set<number>`。最多 25 群，每群最多 150,000 个 ID，满额保留已有成员，退群后可继续新增。
  - **校验**：文件名必须是规范负安全整数群 ID，数组元素必须是唯一的正安全整数；非法 JSON、重复、类型或容量错误拒绝启动，不截断或修复原文件。目录和文件缺失允许启动，由程序按需创建。
  - **落盘与备份**：实际增删按累计 300 条或首条变更后 30 秒经 DiskIO 全量原子替换，无变化不写。没有按日过期，重启按文件恢复；`/init disable` 与机器人被移出群会连文件一起删掉（被撤管理员不删，权限加回来还要用）。纳入数据根的一致性备份，突然退出可能丢失尚未落盘的变更。
  - **离群清理**：退群服务消息、`chat_member` 更新与每日零点复核会把离群成员移出文件，后两者只在机器人是群管理员时生效。机器人不是管理员的群里只剩退群服务消息，而 Telegram 在较大的超级群或隐藏了成员列表时可能不发，文件里因此会留下已离群的 ID，`/wed` 也会照常抽到他们，这是预期行为，不是故障。要可靠清理，给机器人管理员权限；需要手工删 ID 时按运行时状态的规矩停服后再改文件。
- **`memory/stickers/<pack>.json`**
  - **内容**：每个白名单贴纸包的 version=1 描述目录，按 `file_unique_id` 保存
    emoji/描述及整包摘要。
  - **备份**：可由线上贴纸包重新对账；不再位于 `config/dynamic/stickers.json` 白名单中的包
    会在启动恢复时删除。
- **`memory/luck/<YYYY-MM-DD>.json`**
  - **内容**：东京当天运势结果，key 是用户 id，带所求事项时还含事项摘要。
  - **备份**：只保留当天；必须与下方回执密钥处于同一一致性备份中。
- **`memory/luck/receipt-secret.json`**
  - **内容**：当天运势回执的 version=1 HMAC 密钥（日期 + 32 字节 key）。
  - **备份**：不可单独删除、重建或从另一备份时点恢复，否则已有结果与回执会不一致。
- **`memory/anti-raid/<YYYY-MM-DD>.json`**
  - **内容**：Challenge 待验证状态的当日追加日志，包含 active 快照、重复 revision、
    终结 tombstone，以及已 write-ahead、尚未确认踢完的 `kickPending`。后者在重启
    恢复后继续成员探测与踢出，不另建踢人落盘文件。
  - **备份**：跨午夜启动先把最新旧日与当天合并（当天 active/tombstone 优先），
    原子发布成功后才删旧日；稳态只保留东京当天，达到 10,000 条历史或 4 MiB 时
    压缩成 active 快照。
- **`memory/joinlog/<chatId>.<YYYY-MM-DD>.json`**
  - **内容**：权威 `chat_member` 入群事实；`/batch_kick` 按滚动窗口读取。
  - **备份**：含用户 id 与时间戳，按敏感数据备份；保留最近三个东京自然日以覆盖
    跨午夜在途查询。精确重投不重复追加，历史按用户最新值压缩；单群单日最多保留
    最新 250,000 人。`/init disable` 与机器人被移出群会把该群保留窗口内外的全部
    日志一并删掉，不等自然过期（被撤管理员不删）。
- **`database/storage.sqlite`**（运行时可能同时存在 `-wal` / `-shm`）
  - **内容**：schema v11 共享存储数据库。`permission_list.policy` 是永久身份权限的严格 JSONB，`blocklist_entries` 保存黑名单（`data` 含 `blockedAt`、Telegram meta 与可选的 `participantInvalidCount`；不认识该字段的旧版本读到带该字段的行会拒绝启动，回滚到这类版本必须连同升级前同一时点的数据库备份一起恢复，不能只替换程序），`temporary_ad_bypass_entries` 保存临时广告免检累计；后者使用 `ad_bypass`、`ad_bypass_granted_at`、`qualified_days`、`send_count`、`counted_at` 与 `qualified_at`。`pending_blocked_removals` 保存未完成的群级封禁任务；`storage_metadata` 与 Drizzle journal 共同约束 schema 和精确谱系。
  - **群状态与人设**：`chat_states` 最多 25 行。`chat_id` 是群主键；`status` 是必填 JSONB 状态；`ai_persona` 是可空、非空白 TEXT，仅保存本群自定义提示词，缺省使用项目 `prompt/persona.md`。状态与人设在启动时读入现有主线程群缓存，`/bot_status` 直接查看是否已设置。`status.translate` 是本群翻译会话，缺省表示没有会话，存在时为 1–5 个会话的非空数组，例如 `"translate": [{"translatedUser": {"id": 123}, "language": "uk"}, {"translatedUser": {"id": 456}, "language": "ru"}]`；同群身份 ID 不得重复，方向仅允许 `ja`、`cn`、`en`、`uk`、`ru`，身份按 `CachedUser` 严格校验。`/init disable` 或 Bot 离群清除整行及人设；待恢复的 lockdown 状态按恢复协议保留。
  - **AI 上下文**：`ai_context` 是可空 JSONB version=1 快照，包含逐字消息、摘要、待合并摘要与保存时间，沿用 AI Worker 记忆缓存及主线程恢复镜像。只更新已有群行，不保留仅有上下文的行；清空记忆将该列置 NULL，不改人设。正文、名称与引用字段为单行，引用 text/quote 最多 500 个 UTF-16 码元，`at` 为有效东京本地时间 `YYYY/MM/DD HH:mm:ss`；机器人图片尚未识图时逐字消息带 `pendingImage`（`origin` 取 `command` / `generated` / `referenceGenerated`，`caption` 为单行），已识图或普通消息不含该键；摘要允许换行。非法字段拒绝恢复并指出嵌套路径，不修复原数据。
  - **备份与恢复**：数据库包含敏感群聊记忆与自定义提示词，必须备份。停 Bot 后，将主库及存在的 WAL/SHM 作为同一集合复制到工作树外，记录并核对 owner/mode 与 SHA-256。Disk I/O Worker 独占数据库，启动校验 integrity、JSONB、schema、谱系、严格行 codec、名单互斥与 outbox 引用；群状态和 AI 快照从同一连接恢复。身份热读使用 8,192 项 LRU，只按 update 所需身份冷读。任一校验失败都拒绝启动，不自动建库、迁移、丢行或降级。
- **`memory/ad-detected/sample.json`**
  - **内容**：广告判定命中的原始样本，包括时间、消息 id 与正文、判定理由、
    引用/回复上下文。
  - **备份**：**纯旁路，进程从不读它**。丢失不影响行为，只影响回头调整
    `config/dynamic/ad_samples.json` 的素材。达到 8 MiB 时自动轮转为
    `sample.<东京日期>[.<序号>].json`；归档按文件名日期自动保留今天在内最近
    15 个东京自然日。
- **`memory/ad-detected/sample.<YYYY-MM-DD>[.<序号>].json`**
  - **内容**：`sample.json` 的轮转归档；同日第二份从 `.2` 起递增。
  - **备份**：严格按文件名日期保留最近 15 个东京自然日；未知命名、目录与符号链接
    不进入自动删除路径。
- **`memory/ai-daily-usage/usage.json`**
  - **内容**：模型请求的 token 用量，只取供应商响应里的 usage，不含会话内容。一个
    JSON 对象：首位的 `summary` 是最近一个已结束东京日的汇总（请求数、输入/命中/输出
    token、命中率，以及按 `<能力>/<provider>/<模型>` 分组的同样合计）；其余键是尚未汇总的
    逐条记录，键为东京时间加 UUID，值为能力、provider、模型与三项 token 数。命中率等于
    命中 token 除以给出了缓存用量的请求的输入 token，保留 4 位小数；供应商没给缓存用量的
    请求 `cachedInputTokens` 为 `null`，只计入总量。
  - **落盘**：记录经诊断通道进入 Disk I/O Worker 的内存缓冲，满 300 条或首条后 30 秒
    追加到文件末尾，统一 flush 时也会刷出。东京零点维护与启动维护把今天之前的记录并入
    最近那一天的 `summary` 后删除，只保留一天的汇总。
  - **备份**：纯旁路，丢失不影响行为；写盘失败只丢那一批统计。文件被改成不合当前格式
    （撕裂的末尾除外）时启动拒绝并保留原字节，删除或修正后再启动。
  - **计量入口**：覆盖 `text`、`summary`、`media`、`image`、`tts`、`ad_detect`。Google generateContent 与 Interactions 分别映射字段，输出包括正文和思考；OpenAI Responses、广告检测 Chat Completions、图片生成/编辑及 token 型音频转写读取各自 usage。收到有效用量即记录，包括空正文、解码失败、应用层重试的每次响应，以及取消后 SDK 仍返回的响应；同一响应不重复计数。供应商未返回 token 或仅返回转写时长时不估算；TTS 每日次数配额独立保存于 `memory/global/state.json`。
  - **缺记录诊断**：`AI token usage unavailable` 只含 capability、provider 和 reason：`missing`（用量缺失）、`invalid`（用量非法）、`sink`（本线程无出口）、`duration`（只有时长）、`transport`（出口投递失败或主线程拒收）。同一出口生命周期内每种组合仅记录一次，不包含模型名、正文或凭据。诊断 FIFO 溢出另有有界丢弃汇总，写盘失败由 Disk I/O 记录错误；该文件是尽力统计，不是完整账单。

- **`logs/`**
  - **内容**：英文错误日志。
  - **备份**：按需。
- **`bot.lock`**（及 `.guard`/`.recovery`）
  - **内容**：单实例锁。
  - **备份**：随停机快照保留，不手工编辑或向运行中的进程回放锁。

`memory/` 顶层不直接放文件，上述八个领域各占一个子目录；身份策略另由 `database/` 承载。启动先只读扫描需要恢复的状态域（包括 `joinlog/` 的保留窗口）并严格解码，全部领域成功后才接管 owner；成功回执之后才按需建目录、清理临时/孤儿/过期文件、compact，并注册一个显式使用 `Asia/Tokyo` 的 Bun 原生零点维护 cron。该 cron 先通知主线程接纳 `/wed` 每日成员复核，再维护运势、日志、AI 缓存用量汇总、入群日志、广告样本归档、待验证日文件和临时广告免检累计，单领域失败不阻断其余任务；原有启动与业务事件路径继续兜底。临时广告免检维护会先提交共享 SQLite 的在途最终值；临时写仍未提交时拒绝删除。它保留当日行和刚结束日已经合格的行，删除刚结束日未合格及更早的整行，清理后迟到的失效旧日写会按原 revision 收敛为墓碑。`ad-detected/` 仍只在第一次命中后建立；若目录已经存在，启动成功后的 maintenance 只扫描目录项，不读取样本内容。`anti-raid/<day>.json` 的物理文件是增量日志而不是单纯 active 列表：新建和状态变化追加完整快照，结算追加同 key 的 `null` tombstone，恢复后才折叠成当前 active challenge。若停机跨过东京午夜，启动会严格读取最新旧日，再以当天记录为较新值合并；旧日损坏会拒绝恢复且不改写文件，只有成功回执后的 maintenance 才原子发布当天快照并清理旧日。运行期由统一 cron 触发相同轮换，失败时保留 active 镜像并以一秒 unref timer 重试。

`joinlog/` 的一次查询最多读取覆盖 `[since, now]` 的两个群日文件，并按用户取窗口内最后一次入群；第三个保留日只服务于 23:59 发起、跨午夜才进入 Worker 的在途查询。文件在 10,000 条冗余历史或新增 4 MiB 后评估压缩，预计至少回收 512 KiB 才原子重写。可解析但 schema 错误的文件会原样拒绝本次读写；仅末尾截断残片可由追加层修复。

### `memory/` 辅助文件与纯内存状态

- 原子覆盖会短暂创建 `.<目标文件名>.<pid>.<uuid>.tmp`，完成 `fsync + rename` 后消失；只有进程在两步之间被硬杀才可能留下。启动 inspect 只登记这些文件，不删除；所有领域校验与 adopt 成功并发出成功回执后，日志、`ai-daily-usage/`、`stickers/`、`luck/`、`joinlog/` 与 `wed/` 的 maintenance 才清理对应 `*.tmp`。已有的 `ad-detected/` 目录在启动成功后的 maintenance 清理 `.sample.json.*.tmp`，首次写样本仍执行同一兜底；`anti-raid/` 不把临时文件当恢复输入。`storage.sqlite-wal` 与 `storage.sqlite-shm` 是 SQLite 正常 sidecar，不是孤儿临时文件，绝不能按本规则删除。
- Challenge timer、广告检测待判队列/去重 Set、Telegram 成员/管理员短缓存都只存在于进程内，没有对应文件。

备份覆盖整个数据根，并在 Bot 停止或存储快照一致性边界内完成；SQLite 主库与存在的 sidecar 必须来自同一时点。`memory/` 与 `database/` 都视为敏感数据：新建 memory 文件默认 `0644`，数据库及 sidecar 首次创建默认 `0660`；已有文件的 mode 会在接管和原子替换后保留（见 [04](04-invariants.md#持久化)）。

## 身份存储迁移

运行时不保留旧格式兼容或自动建库。任何迁移都先停 Bot 并确认 inactive；失败时保留外部备份与现场，不得启动新版本，也不得用 `config_example/` 覆盖真实输入。

### 全新部署建空库

启动不会凭缺失数据库猜测「空名单」，所以全新部署必须显式建一次当前 schema 的空库。步骤见 [01 环境搭建](01-getting-started.md#初始化身份数据库)，`install.sh` 也已包含。目标库已存在时建库入口直接拒绝覆盖。

<a id="upgrade-15"></a>

### 从 14.0.0 升级到 15.0.0

> [!IMPORTANT]
> 15.0.0 把全局状态从数据根的 `state.json` 移到 `memory/global/state.json`，把随机图库目录与素材直链移到 `config/dynamic/assets.json`，不再维护 `state.json.bak`，并把 `config/` 按生效方式拆成 `static/` 与 `dynamic/` 两个子目录。先停服并备份，再更新程序与部署数据；配置和数据校验完成前不要启动。

| 检查项 | 操作 |
| :--- | :--- |
| 全局状态 | 按下节执行全局状态冷迁移；产物放到 `memory/global/state.json`，旧 `state.json` 与 `state.json.bak` 移出数据根。两者任一仍在数据根时，启动与安装器都拒绝 |
| 素材配置 | 迁移只把与内置缺省不同的素材项写进 `config/dynamic/assets.json`；没有产出该文件时不需要放置。字段见[配置说明](../../config_example/README/zh.md#assetsjson) |
| 配置目录布局 | 停机后把 `bot.json`、`g-auth.json` 移入 `config/static/`，其余六份（`agent.json`、`assets.json`、`ad_samples.json`、`mood.json`、`stickers.json`、`cron.json`）移入 `config/dynamic/`，保留原属主与 mode；`config/dynamic/` 即使为空也要建立。任一文件留在 `config/` 顶层或放错子目录、或 `config/dynamic/` 不存在时，启动拒绝；安装器同样拒绝放错位置的文件。`static/` 下的文件修改后须重启，`dynamic/` 下的文件热重载。字段与行为见[配置说明](../../config_example/README/zh.md) |
| 恢复与权限 | 保留外部备份及清单；服务账号须能写 `memory/global/`、数据库目录（含 WAL/SHM）、锁及其余记忆目录；`config/` 可只读 |

### 全局状态冷迁移（state.json → memory/global/state.json + config/dynamic/assets.json）

入口是 [`scripts/migrateGlobalState.ts`](../../scripts/migrateGlobalState.ts)，只接受 14.x 产出的格式：`state.json` 顶层只有 `global`，其中 `copy` 必填，`assets` 可缺省（与 14.0.0 的状态格式一致，14.0.0 之后才有的 `ttsUsage` 同样拒绝）；`state.json.bak` 存在时必须与 `state.json` 逐字节相同，否则拒绝并交由人工核对。未知谱系、已迁移的新格式或非法字段均拒绝。更早的部署先按[下一节](#从-1400-之前的版本升级)到达 14.x 格式。生产启动只校验当前格式，不执行迁移。

1. 停止服务并确认 inactive、没有残留进程。用 `mktemp -d` 在工作树外备份 `state.json`、`state.json.bak`、`config/`、整个 `database/`（SQLite 主库与已有 WAL/SHM 必须来自同一停机时点）与 `memory/`；记录文件清单、权限、属主与 SHA-256，并逐文件核对副本。
2. 指定源备份之外的新输出目录，父目录须存在。脚本不改源文件、不操作服务、不替换部署文件。

```bash
bun run migrate:global-state \
  --source-root /absolute/cold-backup \
  --output-root /absolute/new-staging-directory
```

二进制发行包携带全部当前有效冷迁移，不需要系统 Bun 或源码：`BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/migrateGlobalState.js --source-root <备份> --output-root <新目录>`。

3. `copy` 原样写进产物的 `memory/global/state.json`（顶层不再有 `global` 包装）。`assets` 的五项换成 `config/dynamic/assets.json` 的键（`random_h_image_dir`、`fortune_thumbnail_url`、`probability_thumbnail_url`、`gag_thumbnail_url`、`bot_default_avatar_url`），值去掉首尾空白、直链按 URL 归一化，只保留与内置缺省不同的项；全部相同时不生成该文件。数据库不参与本次迁移。
4. `ready.json` 是转换、严格校验及源复核完成的唯一标记。核对 `sourceFiles`、`outputFiles` 的哈希和元数据，以及 `assetKeys`。失败或中断时保留备份与不完整产物，从原备份向新目录重跑；不覆盖既有输出。
5. 在停机状态下把 `memory/global/state.json` 放到运行时数据根，存在时把产物里的 `config/dynamic/assets.json` 放到配置目录的 `dynamic/` 下，并把旧 `state.json` 与 `state.json.bak` 移出数据根（保留在外部备份中）。确保服务账号能写 `memory/global/`；`config/dynamic/assets.json` 与其余配置一样可只读。
6. 严格校验配置与全局状态后启动，观察至少两个 supervisor 重启间隔，确认 `active/running`、`NRestarts` 不增长且 journal 无新增非零退出，并确认启动日志里的复读目标与 `/h_image` 图库符合预期。全部核验完成前保留外部备份；回滚必须恢复对应代码与同一时点的数据集。

### 从 14.0.0 之前的版本升级

14.0.0 之前的部署先分阶段到达 14.x 格式：检出 `14.0.0` 标签的源码（或安装 14.0.0 发行包），按其文档在停机状态下执行 `migrate:translate-sessions`（13.0.x 之前的部署还要先按 `13.0.2` 的文档执行 `migrate:h-image-add-permission` 与 `migrate:bot-config`），部署其产物后，再用本版本执行上节的全局状态迁移，不需要启动中间版本。当前入口不直接接受这些更早格式；安装器发现 12.1.0 的 `telegram.json` 身份入口时同样拒绝，并提示先升级到 13.x。

### 随机图库文件名冷迁移

专用图库由 `config/dynamic/assets.json` 的 `random_h_image_dir` 指定，缺省为运行时数据根下的 `h_image/`。图库冷迁移只接受 `<uuidv7>[-<file_unique_id>]<扩展名>` 的直接前序命名，生成**内容 SHA-256** 加扩展名的图片。当前启动检查拒绝旧名称，不执行自动迁移。入口是
[`scripts/migrateRandomImageNames.ts`](../../scripts/migrateRandomImageNames.ts)。

1. 停止服务并确认 inactive、没有残留进程。用 `mktemp -d` 在工作树外完整备份图库目录，记录
   文件清单、权限、属主与 SHA-256，并逐文件核对副本。
2. 指定源目录之外的新输出目录，父目录须存在且输出目录本身不存在。脚本不改源目录、不操作服务、
   不替换部署文件。

```bash
bun run migrate:random-image-names \
  --source-directory /absolute/cold-backup/images \
  --output-directory /absolute/new-staging-directory
```

3. 每张图按内容 SHA-256 重命名，扩展名按文件头重判（`.jpeg` 会落成 `.jpg`，名实不符的扩展名
   被纠正）。字节完全相同的多张图在产物里合并成一份，明细写进 `ready.json` 的 `duplicates`。
   源目录里只要混进一个不是图库候选的条目（隐藏文件、子目录、符号链接、别的扩展名），或者有
   文件的内容不是 jpeg、png、webp，整次迁移当场拒绝并点名——图库是部署方的数据，脚本不替它
   决定哪些东西可以不要。先自己清理干净再重跑。
4. `ready.json` 是复制、逐文件哈希复核与源目录复核完成的唯一标记。核对 `sourceFiles`、
   `outputFiles` 的哈希和元数据，以及 `renamed`、`alreadyNamed`、`deduplicated` 三个计数。
   失败或中断时保留备份与不完整产物，从原备份向新目录重跑；不覆盖既有输出。
5. 在停机状态下手工把图库目录换成验证后的产物，并按 `sourceFiles` 恢复属主与权限，确保服务
   账号能读该目录、能在其中写入（`/h_image add` 要往里写）。
6. 启动后观察至少两个 supervisor 重启间隔，确认 `active/running`、`NRestarts` 不增长且 journal
   无新增非零退出，并用一次 `/h_image` 抽图确认能正常发送。全部核验完成前保留外部备份。

### 从 11.0.9 分阶段升级

11.0.9 使用 schema v8，数据库需要三段：先在独立目录中用固定提交 `500e848faeda75dcae3c3329507f24d05137e3b9` 的 `migrate:ai-context` 产出 v9，再用 12.1.0 发布的 `migrate:clear-context-permission` 产出 v10，然后用 13.0.2 发布的 `migrate:h-image-add-permission` 产出 v11；Bot 配置同样用 13.0.2 的 `migrate:bot-config` 迁到 13.x 格式。之后用 14.0.0 发布的 `migrate:translate-sessions` 到达 14.x 格式，再由当前入口完成[全局状态迁移](#全局状态冷迁移statejson-memoryglobalstatejson-configdynamicassetsjson)。全过程保持服务停止，不需要启动中间版本。已在 12.x（schema v10）上的部署从 13.0.2 那一段开始。运行以下命令前，先完成外部一致性备份，包含 `memory/ai/` 与 SQLite WAL/SHM。Git 仓库须包含该固定提交与 12.1.0、13.0.2 标签，暂存输出目录须不存在。

中间源码是本流程的必需输入。仅有 11.0.9 标签或当前版本的源码压缩包时，须先取得上述固定提交的完整源码；发布前应独立保留并提供该源码，不能依赖 squash 后会被重置的 dev 历史。

也可使用独立中间源码归档 `copy-ninjia-schema-v9-source-500e848f.tar.gz`，其 SHA-256 为 `df6502625512d8fde136dc66d8470e1d4c977856e8a0bd3909b9b6c763c820f8`。核验后以 `tar -xzf /absolute/copy-ninjia-schema-v9-source-500e848f.tar.gz -C "$MIGRATION_CODE"` 代替下方的 `git archive` 步骤。

```bash
MIGRATION_CODE="$(mktemp -d)"
git archive 500e848faeda75dcae3c3329507f24d05137e3b9 | tar -x -C "$MIGRATION_CODE"
(
  cd "$MIGRATION_CODE"
  bun install --frozen-lockfile
  bun run migrate:ai-context \
    --source-root /absolute/11.0.9-cold-backup \
    --output-root /absolute/new-schema-v9-staging
)
RELEASE_CODE="$(mktemp -d)"
git archive 12.1.0 | tar -x -C "$RELEASE_CODE"
(
  cd "$RELEASE_CODE"
  bun install --frozen-lockfile
  bun run migrate:clear-context-permission \
    --source-root /absolute/new-schema-v9-staging \
    --output-root /absolute/new-schema-v10-staging
)
V13_CODE="$(mktemp -d)"
git archive 13.0.2 | tar -x -C "$V13_CODE"
(
  cd "$V13_CODE"
  bun install --frozen-lockfile
  bun run migrate:h-image-add-permission \
    --source-root /absolute/new-schema-v10-staging \
    --output-root /absolute/new-schema-v11-staging
)
```

第一阶段按原有全部 16 项权限授予 `isCanConfigAiPrompt`，第二阶段按完整 17 项权限授予 `isCanClearContext`，第三阶段按完整 18 项权限授予 `isCanAddHImage`。第一阶段仅导入 `chat_states` 已有群的记忆；无对应群行的记忆计入 `discardedContexts`，不创建群状态。逐阶段检查 `ready.json`、源/产物哈希和导入/丢弃计数，v11 主库与 13.x 格式的 state 再作为翻译会话迁移的输入；保留整份原始备份，手工移除部署根中已迁移的 `memory/ai/`，其余配置和状态按原路径保留。继续执行上节的权限恢复、严格校验和启动观察。当前运行时与迁移入口均不直接接受 v8 或 v9。

## 启动失败排查

程序的启动失败都是**有意的快速失败**，报错自带原因；对照处理，不要绕过：

- **数据根预检失败（带路径）**
  - **原因**：数据根/`memory`/`logs`/`database` 是符号链接，前三者 mode 宽于
    `0755`（即 group/other 拿到了写位），`database/` 宽于 `0770` 或协作组不可写，目录不可写，或文件系统不支持
    fsync、hard link、原子 rename。
  - **处理**：停掉所有实例后逐目录修正 owner/group 与 mode；数据根、`memory/`、
    `logs/` 使用 `0750` 或 `0755`，`database/` 按部署模型使用 `0750` 或 `02770`。若仍失败，
    改用满足能力要求的本地文件系统。
- **`bot.lock` 拒绝启动**
  - **原因与处理**：见下节。
- **配置目录布局不符**
  - **原因**：部署文件放在 `config/` 顶层或放错子目录（报错形如 `<路径>: $ must be absent; <文件> belongs in <子目录>/.`），或 `config/dynamic/` 不存在。
  - **处理**：停机后把 `bot.json`、`g-auth.json` 移入 `config/static/`，其余部署文件移入 `config/dynamic/`，保留原属主与 mode。
- **config schema 校验失败**
  - **原因**：`config/{static,dynamic}/*.json` 不合法。
  - **处理**：按报错字段修正；mood 权重和必须恰好 100、天气/时段倍率不得超过 100，
    贴纸最多 5 包。
- **身份数据库缺失或校验失败**
  - **原因**：尚未建立身份数据库，`storage.sqlite` 不可写，integrity/JSONB/schema/
    migration lineage 不合法，行 codec 失败，或黑名单与永久/临时广告免检相交。
  - **处理**：当前数据库格式为 schema v11；14.0.0 的合法数据库直接保留，旧谱系按上文分阶段升级。新安装或回滚按
    [身份存储迁移](#身份存储迁移)建库或回滚。从同一一致性
    备份恢复主库与 sidecar，修正目录协作组权限后再启动。不要创建空库或删除失败行。
- **运势结果与回执密钥不一致**
  - **原因**：当日结果和 `receipt-secret.json` 来自不同备份时点，或只恢复了其中一项。
  - **处理**：停止 Bot，恢复同一一致性时点的完整 `memory/luck/`；不要删除或重新生成
    单独的密钥。
- **全局状态文件非法或旧位置仍有 state.json**
  - **原因**：`memory/global/state.json` 无法解析或不符合当前 schema；或数据根下仍有 14.x 的
    `state.json` / `state.json.bak`。
  - **处理**：保持服务停止并备份原文件，按错误中的文件路径、字段路径和期望形态修正后重新
    校验；旧位置的文件按冷迁移流程处理后移出数据根。运行时保留非法文件原字节并拒绝启动，
    不生成 `*.corrupt` 隔离件。

### `bot.lock` 拒绝启动

锁文件格式是严格的 `v2:pid:starttime:boot_id:sha256(token)`（`starttime` 取自 `/proc/<pid>/stat` 第 22 字段），实例锁显式依赖 Linux `/proc` 且 fail-closed：

- **另一个进程真的在跑**：PID、starttime、boot ID 全匹配才算活跃 owner——先停掉它。数据目录全局独占，同一数据根不允许两个实例。
- **stale v2 锁**（进程死了/机器重启过）：下一次启动或退出时自动清理，无需干预。
- **旧格式/损坏格式**：不兼容读取、不自动迁移、不按 PID 猜测清理。确认没有相关进程在跑之后，手工删除旧锁文件再启动。
- **退出时释放失败**：进程会保留非零退出状态并报告锁释放 owner 失败，不会把失败伪装成干净退出；先排查 `/proc`、目录权限与 guard 文件，再确认旧进程已结束后处理残留。
- `.candidate.*` 是 hard-link 锁协议的候选文件，`.tmp` 是全局状态文件 / 锁注册表原子重写的临时文件；正常操作都会删除，当前格式的残留会在确认 owner 不活跃或取得实例锁后由启动清理回收。

token 指纹只用于识别锁 owner，不是数据隔离边界；多个 Bot 并行部署必须使用不同的数据根目录。

## 升级发布

1. 在源码工作树上通过 `bun run release:check -- --version <tag>`（frozen lockfile + 全量检查 + 覆盖率指标核对 + 故障注入 + 二进制构建验证）；联网环境加
   `bun run audit:release`。
2. 在任何会改写工作树的 Git 操作前，检查 `git status --short`、当前版本到目标版本的
   `git diff --name-status`，以及 `git ls-files config .env g-auth.json`。`config/`、
   `.env`、`g-auth.json` 与运行时状态都是部署数据，不能拿目标提交或
   `config_example/` 当备份。
3. 如果 systemd 的 `WorkingDirectory` 就是仓库目录，优先在独立 clone/worktree
   完成合并、测试、tag 与发布。确需原地更新时，先停止服务并确认 inactive；目标版本
   会删除、重命名或忽略部署路径时，先在工作树外备份文件清单、权限/属主与 SHA-256，
   更新后再逐文件恢复和迁移，不能用 `config_example/` 覆盖现有配置。
4. 版本包含持久化结构变更的，按
   [06 变更持久化 schema](06-modification-guide.md#变更持久化-schema)
   手工迁移，不在运行时代码里保留旧格式兼容。
5. 部署配置与运行时状态全部就位、严格解析与权限检查通过后再启动服务。systemd 部署
   至少确认 `ActiveState=active`、`SubState=running`，观察不少于两个
   `RestartSec` 间隔，并确认 `NRestarts` 不再增长、journal 没有新的非零退出。
   所有检查完成前保留外部备份。

### 安装器的服务与备份边界

`install.sh` 在首次原地写入前要求既有服务为 `inactive/dead`，并核对真实工作目录和唯一 Bun 或当前部署的二进制入口。状态查询失败、路径不符或多条 `ExecStart` 均拒绝继续；运行中的部署须先按上述运维流程停止。

覆盖现有 unit 与替换部署配置共用工作树外备份清单，记录原路径、权限、属主和 SHA-256。失败时保留原件与现场；恢复时按清单逐文件核对哈希并恢复权限和属主，完成全部验证后才能手工清理。

既有 unit 的数据根在任何配置、unit 或数据写入之前核对：`Environment` 中的 `COPY_NINJIA_DATA_ROOT` 必须可严格解析且与本次安装器的有效根一致。安装器拒绝非空 `EnvironmentFiles`，以及涉及该变量的 `PassEnvironment` / `UnsetEnvironment`。使用这些来源的部署须先按备份与停机流程手工整理为受支持的显式 `Environment` 配置；安装器不推断或迁移有效值。已有部署 JSON 重新填写后保留原 mode，新文件使用 `0600`。

启动观察窗口是两倍的有效重启等待上限加两秒：基础值来自 `RestartUSec`，生效的指数退避计入 `RestartMaxDelayUSec`，并加上 `RestartRandomizedDelayUSec`。`RestartMaxDelayUSec=infinity` 关闭退避；基础间隔为零时不启用退避。旧 systemd 不提供退避或随机延迟属性时不计该项，存在但非法的值拒绝确认。unit 启动后读取 `NRestarts` 基线，观察期间计数增长或回落均拒绝确认，观察后必须保持相同计数及 `active/running`。journal 使用启动前游标；没有游标时按本次开始时间查询。journal 不可读、异常退出或状态校验失败时非零退出，外部备份保持不动。

## 日常观察点

- `logs/`：错误由 Disk I/O Worker 批量追加，文案英文，可直接 grep。
- Worker 崩溃会节流自愈并从镜像/快照恢复；反复崩溃循环才需要介入（通常意味着持久化数据与代码版本不匹配）。
- 有限重试耗尽的持久化失败会让进程以非零状态退出——这是设计行为（durability 优先于可用性），由 systemd 拉起后从上一致状态续跑。
- `Cron task "<name>" action #<n> (<type>) failed after <k> attempt(s)`：定时任务的某个动作最终失败，本轮剩下的动作已跳过。末尾是 Telegram 的错误码与描述或本地原因：`403` 多为机器人已被移出目标群，`400` 多为地址不可用或文件类型不被 Telegram 接受，`local file ... is missing` 表示 `payload.path` 指向的本地文件已经不在了，`speech synthesis failed: <原因>` 是 `send_voice` 没合成出语音（`tts unconfigured` / `tts unsupported` 为配置问题，`worker unavailable` 表示 AI Worker 没在运行，`synthesis failed` / `timed out` 多为模型端问题，同时会有一行 `Gemini speech synthesis API` 的错误，`daily limit reached` 表示当日语音额度 `agent.tts.daily_limit` 已用尽、不重试）。改好 `cron.json` 或素材后会自动热重载，不用重启。
- `/send TTS for chat <id> produced no voice: <原因>`：`/send` 中转里的语音请求没合成出语音，原因的读法同上；超管私聊同时收到一句失败提示，中转会话保持开启。
- `Cron task "<name>" action #<n> (<type>) failed in chat <id> after <k> attempt(s)`：投递多个会话的任务（`["all"]`、`["except", ...]` 或逐个列出多个会话）在某个会话最终失败，只跳过这个会话剩下的动作，其余会话照常发送；原因的读法同上。`Cron task "<name>" skipped <n> chat(s) without send permission.` 是普通日志，表示本轮有群因机器人缺发送权限或查询失败被跳过。
- `Failed to probe chat membership` / `Failed to ban chat member` 以 `PARTICIPANT_ID_INVALID` 结尾时，通常是黑名单里有已销号账号。补扫照常按退避重试；同一用户在一个群的一次补扫里全部请求都返回这一句记 1 次，任一群查到或封到 TA 即清零，累计 5 次后自动移出黑名单与待踢批次，并记 `Removed blocklisted user <id> after 5 consecutive PARTICIPANT_ID_INVALID sweep results`。`/wed` 每日复核遇到同一错误直接把该 ID 移出候选集合，不记错误日志。

---

<div align="center">

[← 上一页：06 修改配方](06-modification-guide.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#07-运维与排障) · [下一页：08 命令与行为参考 →](08-commands.md)

</div>
