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

程序会补建数据根、`logs/`、`memory/` 与初始 `database/`（前三者按 `0755`，`database/` 按 `0770`，实际权限再受 umask 收窄），四者都拒绝符号链接。数据根、`logs/` 与 `memory/` 必须属于运行 UID 且 mode 不宽于 `0755`——这道闸拦的是**写**：group 或 other 拿到 `w` 位一律拒绝启动。读侧放开到 `0755`，因为本项目按单租户处理、绝大多数部署是 root 直接跑，而默认 umask 建出来的目录就是 `0755`。

> **代价**：`memory/` 新文件默认是 `0644`，所以只采用默认值时，群聊逐字记录的访问控制主要依赖目录位。留在 `0755` 意味着同机器上任何本地账号都能读它们。多租户或存在非特权登录用户的机器，请自行把数据根与 `memory/` 收回 `0750`，并可把既有文件收紧为 `0600`/`0640`；运行时会保留这些 mode，不自动 chmod。部署方可将 `database/` 设为 `02770`，主库及 WAL/SHM 首次创建为 `0660`；该目录可由运行 UID 所有，也可由部署账号所有但 group 必须是运行进程的有效组并具备完整 `rwx`。不要对整个数据根递归执行 `chmod 0750`，否则会拿掉 SQLite 创建 sidecar 所需的 group write。`config/` 是项目内的只读部署输入，身份策略不再从中加载或写回。

进程崩溃或非零退出交给 `Restart=on-failure` 拉起即可：待验证状态、锁定计时、身份写透、AI 记忆与未确认的 Telegram update 都会按 [04 运行时权威约束](04-invariants.md#持久化) 的恢复语义续接。

### 二进制部署

二进制发行目录包含 `copy-ninjia`、`binary.json`、安装器、配置示例、`prompt/`、数据库 schema 文件与 `node_modules/` 中的原生图片依赖；部署时保留完整目录。在该目录执行 `bash install.sh` 完成配置和新库初始化，前台运行使用 `./copy-ninjia`。systemd 的 `WorkingDirectory` 指向该目录，`ExecStart` 使用该目录内可执行文件的绝对路径，不带 `start` 参数；无需系统 Bun。

安装器只为新目录下载 Latest 的对应平台包与 SHA-256，不覆盖或升级既有二进制部署。更新时按下述停机、外部备份、校验和手工迁移流程操作；先在独立暂存目录核验新包，再保留部署配置、凭据与数据并更新程序文件和随包依赖。需要冷迁移时先按本页迁移章节准备迁移工具；启动入口只接受当前格式。发行包构建、平台清单与上传校验见 [05 发布流程](05-dev-workflow.md#发布)。

## 数据根

`COPY_NINJIA_DATA_ROOT` 派生所有运行时数据（未设置时使用项目根目录；显式空白值拒绝启动）：

- **`state.json` + `state.json.bak`**
  - **内容**：`global.copy` 的全局复读状态、`global.assets` 的四条素材直链，以及 `translate` 的按群翻译会话。群开关、锁定记录和权限快照保存在 `database/storage.sqlite` 的 `chat_states`。
  - **翻译格式**：顶层可选 `translate` 缺省为 `{}`；键必须是规范负整数群 ID，值为 1–5 个会话的非空数组。例如 `"translate": {"-1001": [{"translatedUser": {"id": 123}, "language": "uk"}, {"translatedUser": {"id": 456}, "language": "ru"}]}`。最多 25 群，同群身份 ID 不得重复，方向仅允许 `ja`、`cn`、`en`、`uk`、`ru`，身份按 `CachedUser` 严格校验。`global.copy.copyMode` 仅接受缺省、`reverse`、`nya`。非法主文件或 LKG、单会话对象等旧形态均拒绝启动，不自动升级或丢弃条目。
  - **手工修改状态**：停服务并确认 inactive，在工作树外用 `mktemp -d` 备份主备及部署数据，记录权限、属主和 SHA-256，再编辑两份状态。保留未修改的 `global` 字段，并用 `decodeStateFile` 严格解析主备、核对预期差异和权限后启动。版本升级按下方冷迁移流程执行，不用示例或 Git 内容覆盖部署状态。
  - **备份**：主备一起备份。
  - **改素材直链只能停机改**：进程持有权威内存并会整份覆写这个文件，运行中编辑会被
    下次落盘抹掉。停服务 → 改 `global.assets` → 起服务；缺项会在启动成功后被自动
    补成当前生效值，写坏（漏 scheme、协议不对）则在解码期拒绝整份文件并点名字段路径。
    图床不限，只要能直出图片字节；三张缩略图必须是 `https`，只有 `botDefaultAvatarUrl`
    允许明文 `http`，且它**跟随重定向**——直链先 302 到实际存储域名（内置缺省那条 Drive
    链接即是）照样能用，不必自己解析出终点。
  - **升级前先看一眼这四项**：三张缩略图现在只认 `https`，从更早版本升上来时若有一项
    配成 `http://`，会在解码期拒绝启动并点名字段路径。
- **`memory/wed/<chatId>.json`**
  - **内容**：每群已发言成员 ID 的纯数字数组，例如 `[5974478892]`；主线程每群长期复用一个 `Set<number>`。最多 25 群，每群最多 150,000 个 ID，满额保留已有成员，退群后可继续新增。
  - **校验**：文件名必须是规范负安全整数群 ID，数组元素必须是唯一的正安全整数；非法 JSON、重复、类型或容量错误拒绝启动，不截断或修复原文件。目录和文件缺失允许启动，由程序按需创建。
  - **落盘与备份**：实际增删按累计 300 条或首条变更后 30 秒经 DiskIO 全量原子替换，无变化不写。没有按日过期，重启按文件恢复；`/init disable` 与机器人被移出群会连文件一起删掉（被撤管理员不删，权限加回来还要用）。纳入数据根的一致性备份，突然退出可能丢失尚未落盘的变更。
- **`memory/stickers/<pack>.json`**
  - **内容**：每个白名单贴纸包的 version=1 描述目录，按 `file_unique_id` 保存
    emoji/描述及整包摘要。
  - **备份**：可由线上贴纸包重新对账；不再位于 `config/stickers.json` 白名单中的包
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
  - **内容**：schema v10 共享存储数据库。`permission_list.policy` 是永久身份权限的严格 JSONB，`blocklist_entries` 保存黑名单（`data` 含 `blockedAt`、Telegram meta 与可选的 `participantInvalidCount`；不认识该字段的旧版本读到带该字段的行会拒绝启动，回滚到这类版本必须连同升级前同一时点的数据库备份一起恢复，不能只替换程序），`temporary_ad_bypass_entries` 保存临时广告免检累计；后者使用 `ad_bypass`、`ad_bypass_granted_at`、`qualified_days`、`send_count`、`counted_at` 与 `qualified_at`。`pending_blocked_removals` 保存未完成的群级封禁任务；`storage_metadata` 与 Drizzle journal 共同约束 schema 和精确谱系。
  - **群状态与人设**：`chat_states` 最多 25 行。`chat_id` 是群主键；`status` 是必填 JSONB 状态；`ai_persona` 是可空、非空白 TEXT，仅保存本群自定义提示词，缺省使用项目 `prompt/persona.md`。状态与人设在启动时读入现有主线程群缓存，`/bot_status` 直接查看是否已设置。`/init disable` 或 Bot 离群清除整行及人设；待恢复的 lockdown 状态按恢复协议保留。
  - **AI 上下文**：`ai_context` 是可空 JSONB version=1 快照，包含逐字消息、摘要、待合并摘要与保存时间，沿用 AI Worker 记忆缓存及主线程恢复镜像。只更新已有群行，不保留仅有上下文的行；清空记忆将该列置 NULL，不改人设。正文、名称与引用字段为单行，引用 text/quote 最多 500 个 UTF-16 码元，`at` 为有效东京本地时间 `YYYY/MM/DD HH:mm:ss`；摘要允许换行。非法字段拒绝恢复并指出嵌套路径，不修复原数据。
  - **备份与恢复**：数据库包含敏感群聊记忆与自定义提示词，必须备份。停 Bot 后，将主库及存在的 WAL/SHM 作为同一集合复制到工作树外，记录并核对 owner/mode 与 SHA-256。Disk I/O Worker 独占数据库，启动校验 integrity、JSONB、schema、谱系、严格行 codec、名单互斥与 outbox 引用；群状态和 AI 快照从同一连接恢复。身份热读使用 8,192 项 LRU，只按 update 所需身份冷读。任一校验失败都拒绝启动，不自动建库、迁移、丢行或降级。
- **`memory/ad-detected/sample.json`**
  - **内容**：广告判定命中的原始样本，包括时间、消息 id 与正文、判定理由、
    引用/回复上下文。
  - **备份**：**纯旁路，进程从不读它**。丢失不影响行为，只影响回头调整
    `config/ad_samples.json` 的素材。达到 8 MiB 时自动轮转为
    `sample.<东京日期>[.<序号>].json`；归档按文件名日期自动保留今天在内最近
    15 个东京自然日。
- **`memory/ad-detected/sample.<YYYY-MM-DD>[.<序号>].json`**
  - **内容**：`sample.json` 的轮转归档；同日第二份从 `.2` 起递增。
  - **备份**：严格按文件名日期保留最近 15 个东京自然日；未知命名、目录与符号链接
    不进入自动删除路径。
- **`logs/`**
  - **内容**：英文错误日志。
  - **备份**：按需。
- **`bot.lock`**（及 `.guard`/`.recovery`）
  - **内容**：单实例锁。
  - **备份**：随停机快照保留，不手工编辑或向运行中的进程回放锁。

`memory/` 顶层不直接放文件，上述六个领域各占一个子目录；身份策略另由 `database/` 承载。启动先只读扫描需要恢复的状态域（包括 `joinlog/` 的保留窗口）并严格解码，全部领域成功后才接管 owner；成功回执之后才按需建目录、清理临时/孤儿/过期文件、compact，并注册一个显式使用 `Asia/Tokyo` 的 Bun 原生零点维护 cron。该 cron 先通知主线程接纳 `/wed` 每日成员复核，再维护运势、日志、入群日志、广告样本归档、待验证日文件和临时广告免检累计，单领域失败不阻断其余任务；原有启动与业务事件路径继续兜底。临时广告免检维护会先提交共享 SQLite 的在途最终值；临时写仍未提交时拒绝删除。它保留当日行和刚结束日已经合格的行，删除刚结束日未合格及更早的整行，清理后迟到的失效旧日写会按原 revision 收敛为墓碑。`ad-detected/` 仍只在第一次命中后建立；若目录已经存在，启动成功后的 maintenance 只扫描目录项，不读取样本内容。`anti-raid/<day>.json` 的物理文件是增量日志而不是单纯 active 列表：新建和状态变化追加完整快照，结算追加同 key 的 `null` tombstone，恢复后才折叠成当前 active challenge。若停机跨过东京午夜，启动会严格读取最新旧日，再以当天记录为较新值合并；旧日损坏会拒绝恢复且不改写文件，只有成功回执后的 maintenance 才原子发布当天快照并清理旧日。运行期由统一 cron 触发相同轮换，失败时保留 active 镜像并以一秒 unref timer 重试。

`joinlog/` 的一次查询最多读取覆盖 `[since, now]` 的两个群日文件，并按用户取窗口内最后一次入群；第三个保留日只服务于 23:59 发起、跨午夜才进入 Worker 的在途查询。文件在 10,000 条冗余历史或新增 4 MiB 后评估压缩，预计至少回收 512 KiB 才原子重写。可解析但 schema 错误的文件会原样拒绝本次读写；仅末尾截断残片可由追加层修复。

### `memory/` 辅助文件与纯内存状态

- 原子覆盖会短暂创建 `.<目标文件名>.<pid>.<uuid>.tmp`，完成 `fsync + rename` 后消失；只有进程在两步之间被硬杀才可能留下。启动 inspect 只登记这些文件，不删除；所有领域校验与 adopt 成功并发出成功回执后，日志、`stickers/`、`luck/`、`joinlog/` 与 `wed/` 的 maintenance 才清理对应 `*.tmp`。已有的 `ad-detected/` 目录在启动成功后的 maintenance 清理 `.sample.json.*.tmp`，首次写样本仍执行同一兜底；`anti-raid/` 不把临时文件当恢复输入。`storage.sqlite-wal` 与 `storage.sqlite-shm` 是 SQLite 正常 sidecar，不是孤儿临时文件，绝不能按本规则删除。
- Challenge timer、广告检测待判队列/去重 Set、Telegram 成员/管理员短缓存都只存在于进程内，没有对应文件。

备份覆盖整个数据根，并在 Bot 停止或存储快照一致性边界内完成；SQLite 主库与存在的 sidecar 必须来自同一时点。`memory/` 与 `database/` 都视为敏感数据：新建 memory 文件默认 `0644`，数据库及 sidecar 首次创建默认 `0660`；已有文件的 mode 会在接管和原子替换后保留（见 [04](04-invariants.md#持久化)）。

## 身份存储迁移

运行时不保留旧格式兼容或自动建库。任何迁移都先停 Bot 并确认 inactive；失败时保留外部备份与现场，不得启动新版本，也不得用 `config_example/` 覆盖真实输入。

### 全新部署建空库

启动不会凭缺失数据库猜测「空名单」，所以全新部署必须显式建一次当前 schema 的空库。步骤见 [01 环境搭建](01-getting-started.md#初始化身份数据库)，`install.sh` 也已包含。目标库已存在时建库入口直接拒绝覆盖。

### 从 schema v9 冷迁移

当前唯一冷迁移入口是 [`scripts/migrateClearContextPermission.ts`](../../scripts/migrateClearContextPermission.ts)，只接受上一次迁移产出的 schema v9 精确谱系，输出 schema v10。更旧部署须先按对应版本文档分阶段升级到 schema v9；未知谱系与已迁移的 v10 均拒绝。生产启动只校验当前格式，不执行迁移。

1. 停止服务并确认 inactive、没有残留进程。用 `mktemp -d` 在工作树外备份真实配置、凭据和运行时数据；SQLite 主库与已有 WAL/SHM 必须来自同一停机时点。记录文件清单、权限、属主与 SHA-256，并逐文件核对副本。
2. 指定源备份之外的新输出目录，父目录须存在。脚本不改源文件、不操作服务、不替换部署文件。

```bash
bun run migrate:clear-context-permission \
  --source-root /absolute/cold-backup \
  --output-root /absolute/new-staging-directory
```

3. 迁移为每条 `permission_list.policy` 增加布尔权限 `isCanClearContext`。原有全部权限均为 true 的成员设为 true，其余设为 false；原权限、身份元数据、群状态、上下文、人设及其他领域数据保持不变。超级管理员不依赖此表，运行时始终直授 true。新成员默认 false，后续可以通过 `/permission` 单独授予或撤销。
4. `ready.json` 是转换、严格校验、SQLite checkpoint、连接关闭及源复核完成的唯一标记。核对 `sourceFiles`、`outputFiles` 的哈希和元数据，以及 `enabledPermissions`、`disabledPermissions` 计数。失败或中断时保留备份与不完整产物，从原备份向新目录重跑；不覆盖既有输出。
5. 在停机状态下手工替换验证后的 SQLite 主库。旧 WAL/SHM 只在已有一致备份且确认无数据库句柄时移除，不得与新主库混用。按清单恢复原属主与权限，确保服务账号能写 SQLite 和父目录；`config/` 可只读。
6. 打开数据库前核对安装后哈希，再严格校验配置、主备状态和当前数据库。全部就位后启动，观察至少两个 supervisor 重启间隔，确认 `active/running`、`NRestarts` 不增长且 journal 无新增非零退出。全部核验完成前保留外部备份；回滚必须恢复对应代码与同一时点的数据集。

只读 SQLite 连接也可能重建 SHM 索引；先记录文件哈希，再做数据库校验，旁路索引变化须单独记录，不能覆盖原始备份清单。

### 从 11.0.9 分阶段升级

11.0.9 使用 schema v8。先在独立目录中使用固定提交 `500e848faeda75dcae3c3329507f24d05137e3b9` 的 `migrate:ai-context` 产出 v9，再由当前入口产出 v10；全过程保持服务停止，不需要启动中间版本。运行以下命令前，先按上节完成外部一致性备份，包含 `memory/ai/` 与 SQLite WAL/SHM。Git 仓库须包含该固定提交，两个暂存输出目录须不存在。

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
bun run migrate:clear-context-permission \
  --source-root /absolute/new-schema-v9-staging \
  --output-root /absolute/new-schema-v10-staging
```

第一阶段按原有全部 16 项权限授予 `isCanConfigAiPrompt`，第二阶段按完整 17 项权限授予 `isCanClearContext`。第一阶段仅导入 `chat_states` 已有群的记忆；无对应群行的记忆计入 `discardedContexts`，不创建群状态。逐阶段检查 `ready.json`、源/产物哈希和导入/丢弃计数，最终只安装 v10 主库；保留整份原始备份，手工移除部署根中已迁移的 `memory/ai/`，其余配置和状态按原路径保留。继续执行上节的权限恢复、严格校验和启动观察。当前运行时与迁移入口均不直接接受 v8。

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
- **config schema 校验失败**
  - **原因**：`config/*.json` 不合法。
  - **处理**：按报错字段修正；mood 权重和必须恰好 100、天气/时段倍率不得超过 100，
    贴纸最多 5 包。
- **身份数据库缺失或校验失败**
  - **原因**：尚未建立身份数据库，`storage.sqlite` 不可写，integrity/JSONB/schema/
    migration lineage 不合法，行 codec 失败，或黑名单与永久/临时广告免检相交。
  - **处理**：若为已确认的 10.5.4 schema v7，保持停机并执行上述冷迁移；更旧版本先分阶段升级到 10.5.4。其余情况按
    [身份存储迁移](#身份存储迁移)建库或回滚。从同一一致性
    备份恢复主库与 sidecar，修正目录协作组权限后再启动。不要创建空库或删除失败行。
- **两份 state 副本均无效**
  - **原因**：部署了 schema 变更但没迁移数据。
  - **处理**：按
    [06 变更持久化 schema](06-modification-guide.md#变更持久化-schema)
    迁移后再启动；程序不会改动原文件。
- **运势结果与回执密钥不一致**
  - **原因**：当日结果和 `receipt-secret.json` 来自不同备份时点，或只恢复了其中一项。
  - **处理**：停止 Bot，恢复同一一致性时点的完整 `memory/luck/`；不要删除或重新生成
    单独的密钥。
- **state 主文件或备份副本非法**
  - **原因**：`state.json` 或 `state.json.bak` 无法解析或不符合当前 schema。
  - **处理**：保持服务停止并备份两份原文件，按错误中的文件路径、字段路径和期望形态
    修正后重新校验。运行时保留非法文件原字节并拒绝启动，不生成 `*.corrupt` 隔离件。

### `bot.lock` 拒绝启动

锁文件格式是严格的 `v2:pid:starttime:boot_id:sha256(token)`（`starttime` 取自 `/proc/<pid>/stat` 第 22 字段），实例锁显式依赖 Linux `/proc` 且 fail-closed：

- **另一个进程真的在跑**：PID、starttime、boot ID 全匹配才算活跃 owner——先停掉它。数据目录全局独占，同一数据根不允许两个实例。
- **stale v2 锁**（进程死了/机器重启过）：下一次启动或退出时自动清理，无需干预。
- **旧格式/损坏格式**：不兼容读取、不自动迁移、不按 PID 猜测清理。确认没有相关进程在跑之后，手工删除旧锁文件再启动。
- **退出时释放失败**：进程会保留非零退出状态并报告锁释放 owner 失败，不会把失败伪装成干净退出；先排查 `/proc`、目录权限与 guard 文件，再确认旧进程已结束后处理残留。
- `.candidate.*` 是 hard-link 锁协议的候选文件，`.tmp` 是 `state.json` / 锁注册表原子重写的临时文件；正常操作都会删除，当前格式的残留会在确认 owner 不活跃或取得实例锁后由启动清理回收。

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
- `Failed to probe chat membership` / `Failed to ban chat member` 以 `PARTICIPANT_ID_INVALID` 结尾时，通常是黑名单里有已销号账号。补扫照常按退避重试；同一用户在一个群的一次补扫里全部请求都返回这一句记 1 次，任一群查到或封到 TA 即清零，累计 5 次后自动移出黑名单与待踢批次，并记 `Removed blocklisted user <id> after 5 consecutive PARTICIPANT_ID_INVALID sweep results`。`/wed` 每日复核遇到同一错误直接把该 ID 移出候选集合，不记错误日志。

---

<div align="center">

[← 上一页：06 修改配方](06-modification-guide.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#07-运维与排障) · **下一页：无 →**

</div>
