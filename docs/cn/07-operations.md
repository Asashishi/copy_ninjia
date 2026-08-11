# 07 运维与排障

<p align="center">
  <b>简体中文</b> · <a href="../en/07-operations.md">English</a> · <a href="../ja/07-operations.md">日本語</a>
</p>

<p align="center">
  <a href="conntent-table.md">📚 开发者文档首页</a> · <a href="06-modification-guide.md">← 上一页：06 修改配方</a> · <b>下一页：无 →</b>
</p>

---

## 部署形态

单实例长轮询进程，无 webhook、无外部数据库服务；身份策略使用本地 SQLite，其余持久化使用数据根内文件。单实例建议承载约 15 个活跃群以内（瓶颈是单 Bot API、AI 供应商配额与媒体速率，硬件参考见根 README「快速开始」）。

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

数据根目录先由部署工具预建：`sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia`。容器部署把同一目录作为持久卷挂载，owner 由宿主或 init container 设置；`memory/` 与 `database/` 都不要放容器临时层。

程序会以 `0750` 补建数据根、`logs/`、`memory/` 与初始 `database/`，四者都拒绝符号链接。数据根、`logs/` 与 `memory/` 必须属于运行 UID 且 mode 不宽于 `0750`。身份迁移会把 `database/` 设为 `02770`，主库及 WAL/SHM 为 `0660`；该目录可由运行 UID 所有，也可由部署账号所有但 group 必须是运行进程的有效组并具备完整 `rwx`。不要对整个数据根递归执行 `chmod 0750`，否则会拿掉 SQLite 创建 sidecar 所需的 group write。`config/` 是项目内的只读部署输入，身份策略不再从中加载或写回。

进程崩溃或非零退出交给 `Restart=on-failure` 拉起即可：待验证状态、锁定计时、身份写透、AI 记忆与未确认的 Telegram update 都会按 [04 运行时权威约束](04-invariants.md#持久化) 的恢复语义续接。

## 数据根

`COPY_NINJIA_DATA_ROOT` 派生所有运行时数据（留空则为项目根目录）：

- **`state.json` + `state.json.bak`**
  - **内容**：群开关（含 `isAntiRaidEnabled`：入群验证 + 防冲群私密模式的总开关，
    缺省关闭）、copy、锁定镜像等权威状态，以及 `global.assets` 的三条素材直链
    （两张运势缩略图 + 机器人默认头像）。模型选择不再属于运行时状态。
  - **备份**：主备一起备份。
  - **改素材直链只能停机改**：进程持有权威内存并会整份覆写这个文件，运行中编辑会被
    下次落盘抹掉。停服务 → 改 `global.assets` → 起服务；缺项会在启动成功后被自动
    补成当前生效值，写坏（漏 scheme、协议不对）则在解码期拒绝整份文件并点名字段路径。
    图床不限，只要能直出图片字节；两张缩略图必须是 `https`，只有 `botDefaultAvatarUrl`
    允许明文 `http`，且它**跟随重定向**——直链先 302 到实际存储域名（内置缺省那条 Drive
    链接即是）照样能用，不必自己解析出终点。
  - **升级前先看一眼这三项**：两张缩略图现在只认 `https`，从更早版本升上来时若有一项
    配成 `http://`，会在解码期拒绝启动并点名字段路径。
- **`memory/ai/<chatId>.json`**
  - **内容**：每群 AI 记忆的 version=1 原子快照，包括最近逐字消息、历史摘要、
    待合并摘要与保存时间。
  - **备份**：含群聊逐字内容，属于敏感数据；清空该群记忆时删除，启动按 chatId 恢复。
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
    最新 250,000 人。
- **`database/storage.sqlite`**（运行时可能同时存在 `-wal` / `-shm`）
  - **内容**：schema v3 身份数据库。`whitelist_entries` 与 `blocklist_entries` 是白名单、
    黑名单权威表，`pending_blocked_removals` 是未完成群级封禁任务 outbox，
    `storage_metadata` 记录唯一 schema version；Drizzle migration journal 必须匹配受支持谱系。
  - **备份**：必须备份，丢失黑名单等于解除全部永久封禁，丢失 outbox 则会漏掉未完成处置。
    停止 Bot 后，把主库及当时存在的 WAL/SHM 作为同一一致性集合复制到工作树外，并记录
    owner/mode 与 SHA-256；不得用文本编辑器或临时 SQL 手改业务行。schema migration 脚本会
    通过 SQLite 序列化快照建立并校验独立外部备份。
  - **恢复**：Disk I/O Worker 是唯一数据库 owner；启动先做 integrity、JSONB、schema、
    migration lineage、行 codec 与黑白名单互斥校验，再只把计数和 pending outbox 交回主线程。
    任一校验失败都拒绝启动，不会建空库、丢行或静默降级。
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
  - **备份**：不备份、不手工编辑。

`memory/` 顶层不直接放文件，上述六个领域各占一个子目录；身份策略另由 `database/` 承载。`ai/`、`stickers/`、`luck/` 与 `anti-raid/` 会在启动恢复时按需建目录；`ad-detected/` 只在第一次命中后建立，`joinlog/` 则只在首条入群事实或首次查询时建立，启动恢复不扫描它。`anti-raid/<day>.json` 的物理文件是增量日志而不是单纯 active 列表：新建和状态变化追加完整快照，结算追加同 key 的 `null` tombstone，恢复后才折叠成当前 active challenge。若停机跨过东京午夜，启动会严格读取最新旧日，再以当天记录为较新值合并；旧日损坏会拒绝恢复且不改写文件，只有当天原子快照落地成功才清理旧日。

`joinlog/` 的一次查询最多读取覆盖 `[since, now]` 的两个群日文件，并按用户取窗口内最后一次入群；第三个保留日只服务于 23:59 发起、跨午夜才进入 Worker 的在途查询。文件在 10,000 条冗余历史或新增 4 MiB 后评估压缩，预计至少回收 512 KiB 才原子重写。可解析但 schema 错误的文件会原样拒绝本次读写；仅末尾截断残片可由追加层修复。

### `memory/` 辅助文件与纯内存状态

- 原子覆盖会短暂创建 `.<目标文件名>.<pid>.<uuid>.tmp`，完成 `fsync + rename` 后消失；只有进程在两步之间被硬杀才可能留下。`ai/`、`stickers/`、`luck/` 在启动时清理 `*.tmp`，`ad-detected/` 在首次写样本前清理 `.sample.json.*.tmp`，`joinlog/` 在首次接管当日目录时清理 `*.tmp`。当前 `anti-raid/` 恢复只忽略这类文件而不主动清理；它们不参与恢复，确认 Bot 已停止且名称精确匹配上述原子写格式后才可作为孤儿删除。`storage.sqlite-wal` 与 `storage.sqlite-shm` 是 SQLite 正常 sidecar，不是孤儿临时文件，绝不能按本规则删除。
- `memory/ai/<chatId>.json.<时间戳>.<uuid>.corrupt` 与 `memory/stickers/<pack>.json.<时间戳>.<uuid>.corrupt` 是 JSON 无法解析时保留的唯一命名隔离件，不参与正常恢复也不自动删除；同一路径再次损坏会新增证据，不覆盖旧件。字段能解析但不符合当前 version=1 schema 时不会隔离，而是直接拒绝启动，要求按 [06](06-modification-guide.md#变更持久化-schema) 手工迁移。
- Challenge timer、广告检测待判队列/去重 Set、Telegram 成员/管理员短缓存都只存在于进程内，没有对应文件。

备份覆盖整个数据根，并在 Bot 停止或存储快照一致性边界内完成；SQLite 主库与存在的 sidecar 必须来自同一时点。`memory/` 与 `database/` 都视为敏感数据：前者文件 mode 为 `0644`，后者主库及 sidecar 为 `0660`（单租户部署基线见 [04](04-invariants.md#持久化)），访问控制靠顶层目录 owner/group/权限与主机账户隔离。

## 身份存储迁移

运行时不保留旧格式兼容或自动建库。任何迁移都先停 Bot 并确认 inactive；失败时保留外部备份与现场，不得启动新版本，也不得用 `config_example/` 覆盖真实输入。

### 旧 JSON → SQLite

仍使用 `config/whitelist.json`、`config/blocklist.json`，以及可选 `memory/blocklist/` 的部署按下列顺序迁移：

```bash
bun run migrate:identity-storage --check
bun run migrate:identity-storage --apply
```

`--check` 只严格读取并合并旧白名单、静态/动态黑名单与 v2 待踢 outbox，不改文件。`--apply` 取得 `bot.lock`，通过 Telegram 补齐身份 metadata，在工作树外创建带清单、owner/mode 与 SHA-256 的备份，再建立候选 SQLite、核对 integrity/JSONB/行数/主键/codec 后原子发布 `database/storage.sqlite`，最后删除三处旧结构。脚本会保留并打印外部备份目录；启动、权限命令与待踢重放全部验证正常前不得删除。

全新部署也必须显式走同一迁移边界：按 [01 环境搭建](01-getting-started.md#初始化身份数据库) 创建两份临时空旧输入后执行 `--apply`。启动不会凭缺失数据库猜测“空名单”，目标库已存在时迁移脚本也拒绝覆盖。

### SQLite schema v2 → v3

已在使用 JSONB schema v2 的部署，在 Bot 停止后执行：

```bash
bun run migrate:whitelist-permission -- --apply
```

脚本只接受精确的受支持 v2 migration lineage，先通过 SQLite serialization 在系统临时目录建立 `0600` 外部备份并核验哈希与完整性，再把白名单权限升级到 schema v3；未知谱系、非法行、黑白名单交叉或事务失败都原样拒绝。对已经是 v3 的库运行只做严格验证并报告无需迁移。Release 的 Compatibility / Migration Notes 必须写明实际执行的迁移、备份位置、恢复步骤和权限要求。

## 启动失败排查

程序的启动失败都是**有意的快速失败**，报错自带原因；对照处理，不要绕过：

- **数据根预检失败（带路径）**
  - **原因**：数据根/`memory`/`logs`/`database` 是符号链接，前三者 mode 宽于
    `0750`，`database/` 宽于 `0770` 或协作组不可写，目录不可写，或文件系统不支持
    fsync、hard link、原子 rename。
  - **处理**：停掉所有实例后逐目录修正 owner/group 与 mode；数据根、`memory/`、
    `logs/` 使用 `0750`，`database/` 按部署模型使用 `0750` 或 `02770`。若仍失败，
    改用满足能力要求的本地文件系统。
- **`bot.lock` 拒绝启动**
  - **原因与处理**：见下节。
- **config schema 校验失败**
  - **原因**：`config/*.json` 不合法。
  - **处理**：按报错字段修正；mood 权重和必须恰好 100、天气/时段倍率不得超过 100，
    贴纸最多 5 包。
- **身份数据库缺失或校验失败**
  - **原因**：尚未执行身份迁移，`storage.sqlite` 不可写，integrity/JSONB/schema/
    migration lineage 不合法，行 codec 失败，或同一身份同时存在于黑白名单。
  - **处理**：保持 Bot 停止，按[身份存储迁移](#身份存储迁移)完成或回滚；从同一一致性
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
- **出现 `*.corrupt` 文件**
  - **原因**：可能是单份 state 副本损坏被隔离，也可能是 AI/贴纸 JSON 解析失败后
    被移出恢复集合。
  - **处理**：先按原文件名定位 owner 并调查损坏原因。state 只有**备份副本**损坏时
    才自愈（隔离坏备份并从主文件重建，日志会记一行）；**主文件**解不开一律拒绝启动
    并原样保留现场，按报错里的字段路径改回来再起（见 [启动失败排查](#启动失败排查)）。
    AI/贴纸隔离件不会自动恢复或删除。

### `bot.lock` 拒绝启动

锁文件格式是严格的 `v2:pid:starttime:boot_id:sha256(token)`（`starttime` 取自 `/proc/<pid>/stat` 第 22 字段），实例锁显式依赖 Linux `/proc` 且 fail-closed：

- **另一个进程真的在跑**：PID、starttime、boot ID 全匹配才算活跃 owner——先停掉它。数据目录全局独占，同一数据根不允许两个实例。
- **stale v2 锁**（进程死了/机器重启过）：下一次启动或退出时自动清理，无需干预。
- **旧格式/损坏格式**：不兼容读取、不自动迁移、不按 PID 猜测清理。确认没有相关进程在跑之后，手工删除旧锁文件再启动。
- **退出时释放失败**：进程会保留非零退出状态并报告锁释放 owner 失败，不会把失败伪装成干净退出；先排查 `/proc`、目录权限与 guard 文件，再确认旧进程已结束后处理残留。
- `.candidate.*` 是 hard-link 锁协议的候选文件，`.tmp` 是 `state.json` / 锁注册表原子重写的临时文件；正常操作都会删除，当前格式的残留会在确认 owner 不活跃或取得实例锁后由启动清理回收。

token 指纹只用于识别锁 owner，不是数据隔离边界；多个 Bot 并行部署必须使用不同的数据根目录。

## 升级发布

1. `bun run release:check` 全绿（frozen lockfile + 全量检查 + 故障注入）；联网环境加
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

## 日常观察点

- `logs/`：错误由 Disk I/O Worker 批量追加，文案英文，可直接 grep。
- Worker 崩溃会节流自愈并从镜像/快照恢复；反复崩溃循环才需要介入（通常意味着持久化数据与代码版本不匹配）。
- 有限重试耗尽的持久化失败会让进程以非零状态退出——这是设计行为（durability 优先于可用性），由 systemd 拉起后从上一致状态续跑。

---

<div align="center">

[← 上一页：06 修改配方](06-modification-guide.md) · [📚 开发者文档首页](conntent-table.md) · [⬆️ 回到顶部](#07-运维与排障) · **下一页：无 →**

</div>
