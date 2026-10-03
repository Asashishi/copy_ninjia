# 07 运维与排障

<p align="center">
  <b>简体中文</b> · <a href="../en/07-operations.md">English</a> · <a href="../ja/07-operations.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="06-modification-guide.md">← 上一页：06 修改配方</a> · <a href="08-images-and-cron.md">下一页：08 图库与定时任务 →</a>
</p>

---

## 部署形态

单实例长轮询进程，无 webhook、无外部数据库服务；身份策略使用本地 SQLite，其余持久化使用数据根内文件。

### 硬件参考

<table width="100%">
<thead>
  <tr>
    <th width="24%" align="left">部署规模</th>
    <th width="32%" align="left">建议配置</th>
    <th width="44%" align="left">说明与资源规划建议</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🌱 <b>入门规格</b></nobr><br><sub>（低活跃 / 纯文本）</sub></td>
    <td>2 vCPU / 2 GB RAM / 本地 SSD</td>
    <td>可以运行，但在媒体高峰时多个 Worker 可能争用 CPU；强烈建议配备 2 GB Swap。</td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>轻量生产</b></nobr><br><sub>（少量群开启 AI）</sub></td>
    <td>4 vCPU / 2 GB RAM / 本地 SSD</td>
    <td>文本处理平稳；不建议用 2 GB 内存承载高并发媒体，建议配备 2 GB Swap。</td>
  </tr>
  <tr>
    <td><nobr>🌟 <b>推荐生产</b></nobr><br><sub>（约 15 个活跃群）</sub></td>
    <td>4 vCPU / 4 GB RAM / 本地 SSD</td>
    <td>单群日均 1,000～3,000 条消息的标准规模，兼顾稳定性与成本（建议配备 2 GB Swap）。</td>
  </tr>
  <tr>
    <td><nobr>🔥 <b>高负载生产</b></nobr><br><sub>（全群 AI / 图片多）</sub></td>
    <td>4 vCPU / 8 GB RAM / 本地 SSD</td>
    <td>为媒体下载、Base64 编解码与图像转码预留充足的堆内存峰值缓冲区。</td>
  </tr>
</tbody>
</table>

> [!NOTE]
> 单实例建议控制在约 **15 个**上述规模的活跃群以内。主要资源瓶颈来自 Telegram Bot API 限流、所配 AI 供应商配额与实际消息/媒体吞吐速率，而不是群成员总数。

---

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

#### 目录权限与安全控制

- **预建数据根目录**：部署时建议先预建数据根目录：
  ```bash
  sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia
  ```
  容器部署将同一目录作为持久卷挂载，属主由宿主机或 init container 设置；`memory/` 与 `database/` 切勿放置在容器易失层。
- **自动补建与严格写保护**：程序启动时会补建数据根、`logs/`、`memory/` 与初始 `database/`（前三者按 `0755`，`database/` 按 `0770`，实际权限受 umask 收窄），四者均**拒绝符号链接**。数据根、`logs/` 与 `memory/` 必须属于运行 UID 且权限不宽于 `0755`：一旦检测到 group 或 other 具备写权限（`w` 位），将**直接拒绝启动**。读侧允许开放到 `0755`。

> [!WARNING]
> **多租户权限与数据安全**：
> `memory/` 下新文件默认权限是 `0644`。如果保持 `0755` 目录权限，同一机器上的其他本地账号皆可读取群聊记录。在多租户机器上，请务必将数据根与 `memory/` 收紧为 `0750`，已有文件收紧为 `0600`/`0640`（运行时会保留这些权限，不自动变更）。
> 可将 `database/` 设为 `02770`，主库及 WAL/SHM 首次创建权限为 `0660`。**切勿对整个数据根递归执行 `chmod 0750`**，否则会剥夺 SQLite 建立 sidecar 所需的 group write 权限。`config/` 是只读部署输入，保持只读即可。

- **崩溃恢复保证**：进程崩溃或非零退出交由 `Restart=on-failure` 自动拉起即可：待验证状态、锁定计时、身份写透、AI 记忆与未确认的 Telegram update 均会按 [04 运行时权威约束](04-invariants.md#持久化) 语义自动续接。

---

### 二进制部署

二进制发行目录包含 `copy-ninjia`、`binary.json`、安装器、配置示例与数据库 schema 文件，不含 `node_modules/`（依赖已编译进可执行文件）；部署时保留完整目录。
- **首次配置**：在该目录执行 `bash install.sh` 完成配置和新库初始化，前台调试可直接执行 `./copy-ninjia`。
- **systemd 集成**：`WorkingDirectory` 指向发行目录，`ExecStart` 使用可执行文件的绝对路径（不带 `start` 参数）；目标机器无需安装系统 Bun。
- **更新流程**：安装器只为新目录下载 Latest 的平台包与 SHA-256，不覆盖或升级既有二进制部署。更新时按照下文的停机、外部备份、校验和手工迁移流程操作：先在独立暂存目录核验新包，再保留部署配置、凭据与数据并更新程序文件；发行包不含 `node_modules/`，部署目录中残留的该目录不会被读取，可在停机时删除。需要冷迁移时先准备迁移工具，启动入口只接受当前格式。构建与发布细节见 [05 发布流程](05-dev-workflow.md#发布)。

---

## 数据根

环境变量 `COPY_NINJIA_DATA_ROOT` 派生所有运行时数据路径（未设置时默认使用项目根目录；显式声明为空白值将拒绝启动）：

### 日历时区

`config/static/bot.json` 的 `time_zone` 在启动时生效，缺省 `Asia/Tokyo`；进程运行中不重新读取。cron 任务可用自己的 `time_zone` 覆盖默认时区。

数据根在建库时绑定当时的配置时区（`database/storage.sqlite` 中 `storage_metadata` 的 `time-zone` 标记），日文件名、运势回执密钥、临时广告累计与入群日志都按这一时区计算。此后修改 `time_zone` 会被启动拒绝，报错点名 `storage_metadata.time-zone` 及期望值；安装器在注册服务前做同一比对。把 `time_zone` 改回标记中的时区即可启动；已有数据根不支持更换时区。`database/` 与 `memory/` 必须来自同一时点，备份与恢复都按整体处理。

### 1. 全局状态：`memory/global/state.json`
- **功能职责**：保存 `copy` 的全局复读状态，以及 `ttsUsage` 语音合成每日计数（窗口起点 `windowStartedAt`、AI 计数 `agentCount`、预留计数 `reserveCount`）。
- **格式约束**：顶层仅允许必填的 `copy` 与可选的 `ttsUsage`。`copy.copyMode` 仅接受缺省、`reverse`、`nya`。文件缺失按从未使用处理；存在但非法、或出现未知键均**拒绝启动**。安装器在准备配置时按启动同一口径严格只读校验，不符合当前格式时在注册和启动服务前终止。
- **写入机制**：主线程独占写入（临时文件 + fsync + 原子 rename），Disk I/O Worker 不接触该目录。`copy` 变更立即写盘；`ttsUsage` 按 5 秒合并窗口在后台写盘。正常停机提交剩余变更，突发退出可能丢失窗口内未落盘次数。
- **手工修改**：停机并确认 inactive，在工作树外用 `mktemp -d` 完整备份文件及元数据后再行编辑。保留未修改字段，严格校验解析，核对无误后启动。
- **旧位置阻断**：数据根下若仍有 14.x 的 `state.json` 或 `state.json.bak`，启动与安装器均拒绝；先按[旧版本分阶段升级](#staged-upgrade)升级到 16.3.2 并完成其迁移。

### 2. 色图专用图库：`random_h_image_dir`
- **功能职责**：由 `config/dynamic/assets.json` 的 `onlyPath.random_h_image_dir` 指定（默认 `./h_image`，相对数据根解析）。`/h_image` 与未指定目录的 cron `rand_image` 从这里均匀抽图，通过 `/h_image add` 收录。
- **文件规范**：必须以**图片二进制内容 SHA-256**（64 位小写十六进制）命名，加 `jpg`/`jpeg`/`png`/`webp` 扩展名。严禁混入其他功能的图片。
- **启动检查**：逐项检查目录条目，非法文件名、子目录、符号链接和残留的 `.h_image-add-*` 临时文件均会**拒绝启动**。合规图片的增删无需重启；运行中修改配置路径会先按同等口径校验新目录，失败则拒绝变更。

### 3. 群友老婆候选库：`memory/wed/<chatId>.json`
- **功能职责**：每群已发言成员 ID 的纯数字数组（如 `[5974478892]`），主线程每群维护一个长期复用的 `Set<number>`。最多支持 25 群，单群上限 150,000 个 ID。
- **校验规则**：文件名必须是规范负安全整数群 ID，数组元素必须是唯一的正安全整数。格式错误、重复或超限均拒绝启动。
- **落盘机制**：实际增删累计 256 条变更或首条变更后 30 秒，经 DiskIO 执行全量原子替换。`/init disable` 或 Bot 离群时自动删除对应文件。
- **离群清理**：退群服务消息、`chat_member` 更新与每日零点复核负责清理离群成员（后两者需管理员权限）。若机器人不是管理员，在隐藏成员列表的大群可能收不到退群服务消息，文件会残留已离群成员并可能被抽中，此属预期行为。

### 4. 贴纸与运势：`memory/stickers/` 与 `memory/luck/`
- **`memory/stickers/<pack>.json`**：每个白名单贴纸包的 version=1 描述目录，按 `file_unique_id` 保存 emoji/描述及整包摘要。可由线上贴纸包重新对账；不再位于配置白名单中的包在启动恢复时删除。
- **`memory/luck/<YYYY-MM-DD>.json`**：配置时区当天运势结果，key 为用户 ID，带所求事项时包含事项摘要。只保留当天数据。
- **`memory/luck/receipt-secret.json`**：当天运势回执的 version=1 HMAC 密钥（日期 + 32 字节 key）。**必须与当日运势文件保持同一一致性备份**，切勿单独删除或重建。

### 5. 待验证与入群日志：`memory/anti-raid/` 与 `memory/joinlog/`
- **`memory/anti-raid/<YYYY-MM-DD>.json`**：Challenge 待验证状态的当日追加日志，包含 active 快照、修订 revision、终结 tombstone，以及已预写尚未确认踢完的 `kickPending`（重启后自动续跑踢出流程）。稳态只保留配置时区当天，达到 10,000 条历史或 4 MiB 时自动压缩。
- **`memory/joinlog/<chatId>.<YYYY-MM-DD>.json`**：权威 `chat_member` 入群事实记录，供 `/batch_kick` 按滚动窗口读取。
  - **写入机制**：先进入 Disk I/O Worker 内存批次，满 256 条或 30 秒追加落盘并 fsync。`/batch_kick` 查询前与停机时刷出剩余批次。
  - **生命周期**：至少保留最近三个配置时区自然日，并覆盖前一日命令的滚动 24 小时窗口；夏令时短日会扩展保留日期范围。单群单日最多保留最新 250,000 人。`/init disable` 或 Bot 离群时彻底删除。

### 6. 核心身份与群状态：`database/storage.sqlite`
运行时可能同时存在 `-wal` 与 `-shm` 文件：
- **存储内容**：schema v13 共享 SQLite 数据库。
  - `storage_metadata`：恰为 `schema-version` 与 `time-zone`（数据根绑定的配置时区）两行。
  - `permission_list.policy`：永久身份权限严格 JSONB。
  - `blocklist_entries`：权威永久黑名单。
  - `temporary_ad_bypass_entries`：临时广告免检累计记录。
  - `pending_blocked_removals`：未完成的群级封禁任务队列。
  - `chat_states`：最多 25 行群状态。包含必填群状态 JSONB、`translate` 会话数组（最多 5 人），以及可选的 `ai_context`（可空 JSONB 快照，包含逐字记忆、中期摘要等）。
- **独占与事务**：Disk I/O Worker 独占数据库连接。启动时严格校验 integrity、JSONB、schema、谱系、Codec 与互斥约束。群状态和 AI 快照从同一连接恢复。
- **备份规范**：包含敏感数据，备份时必须将主库与同一时点的 WAL/SHM 视为不可分割的整体一同备份与恢复。

### 7. 广告样本与 AI 用量：`memory/ad-detected/` 与 `memory/ai-daily-usage/`
- **`memory/ad-detected/sample.json`**：广告命中的原始样本记录（时间、消息正文、理由、上下文）。纯旁路数据，达到 8 MiB 时自动轮转归档为 `sample.<日期>[.<序号>].json`，保留最近 15 个自然日。
- **`memory/ai-daily-usage/usage.json`**：模型请求用量统计（不含会话内容）。
  - **数据结构**：首位 `summary` 为最近一个已结束的配置时区自然日的用量汇总（按能力/provider/模型分组），其余键为尚未汇总的逐条记录。
  - **覆盖能力**：`text`、`summary`、`media`、`image`、`tts`、`web_search`、`ad_detect`。
  - **停机清理工具**：使用 [`scripts/removeWebSearchUsage.ts`](../../scripts/removeWebSearchUsage.ts) 可剔除 `web_search` 用量并重算总计：
    ```bash
    bun run usage:remove-web-search --source-root <停机备份根> --output-root <不存在的独立产物目录>
    ```

### 8. 日志与实例锁：`logs/` 与 `bot.lock`
- **`logs/`**：英文结构化错误日志，由 Disk I/O Worker 批量追加。
- **`bot.lock`**（及 `.guard`/`.recovery`）：基于 Linux `/proc` 的单实例进程锁，严防双开。

---

### 数据根管理与维护调度

- **目录结构隔离**：`memory/` 顶层不直接存放文件，上述八个领域各占一个独立子目录；身份策略由 `database/` 承载。
- **启动预检流水线**：启动时先以只读模式扫描并严格解码全部恢复状态（包括 `joinlog/` 保留窗口），全部领域校验通过后才接管 owner。回执发布后按需补建目录、清理孤儿临时文件，并按 `bot.json` 的 `time_zone` 注册零点维护 cron。
- **配置时区零点维护 Cron**：依次调度 `/wed` 每日成员复核、运势归档、日志轮转、AI 缓存用量汇总、入群日志轮转、广告样本清理、Challenge 日志合并及临时广告免检衰减。单领域异常不影响其余任务。
- **辅助文件与纯内存状态**：
  - 原子写入产生的 `.<目标文件名>.<pid>.<uuid>.tmp` 临时文件在正常情况下自动清理，仅在异常强杀时可能残留。启动检查只登记不删除，待各领域成功接管后由维护任务安全清理。
  - `storage.sqlite-wal` 与 `storage.sqlite-shm` 是 SQLite 必需的运行文件，**严禁当成临时文件删除**。
  - Challenge 计时器、广告检测待判队列、Telegram 短期缓存均属纯内存状态，不落盘。

---

## 身份存储迁移

运行时不保留旧格式兼容逻辑，也不在启动时自动建库。所有迁移必须先停止 Bot 并确认进程退出；失败时保留外部备份与现场，不得启动新版本，亦不得拿 `config_example/` 覆盖真实配置。

以下每项停机迁移均须在工作树外用 `mktemp -d` 备份受影响数据，记录并核对文件清单、属主、权限和 SHA-256；脚本产物还须核对 `ready.json` 中的源文件与产物哈希。修改后的输入必须通过当前格式的严格校验，替换时恢复属主和权限。启动后至少观察两个 supervisor 重启间隔，确认 `active/running`、`NRestarts` 不增长且 journal 无新增非零退出；全部通过后才能删除外部备份。

### 全新部署建空库

启动不会凭缺失数据库猜测「空名单」。全新部署按 [01 环境搭建的初始化身份数据库步骤](01-getting-started.md#初始化身份数据库) 建立当前 schema 的空库；`install.sh` 也会在数据库缺失时执行该步骤。建库入口拒绝覆盖已存在的数据库。

<a id="upgrade-chat-persona"></a>

### 共享数据库冷迁移（删除群人设，schema v11 → v13）

入口是 [`scripts/migrateChatPersonaRemoval.ts`](../../scripts/migrateChatPersonaRemoval.ts)。用于移除群人设列及对应权限，并写入 `Asia/Tokyo` 时区标记（v11 的日历固定为东京），产物为 schema v13；此后 `bot.json` 的 `time_zone` 须保持 `Asia/Tokyo`。空状态群行仅在保有人设且没有 AI 上下文时删除；其他空状态行会使迁移失败。只接受 16.3.2 产出的 schema v11 源库（当前或历史 JSONB 基础谱系）；v11 以前、未知谱系以及已迁过的库一律拒绝。16.3.2 的其余持久化数据与配置格式不变，原样沿用。

1. **停机备份**：停止服务并确认 inactive，确保无进程持有数据库；按本节通用核验要求备份整个 `database/`（主库及 WAL/SHM）。
2. **执行迁移**：
   ```bash
   bun run migrate:chat-persona-removal \
     --source-root /absolute/cold-backup \
     --output-root /absolute/new-staging-directory
   ```
3. **核查产物**：按本节通用核验要求检查 `ready.json` 中的源文件、产物哈希及 `removedPersonas`、`removedEmptyChats`、`removedPermissions` 计数。
4. **替换数据库**：仅用产物替换 `database/storage.sqlite`，删除旧的 `-wal`/`-shm`，恢复权限。
5. **清理遗留菜单**：若此前曾为特定群配置过人设菜单，可通过 Telegram Bot API `deleteMyCommands` 传入特定 `chat_id` 作用域删除残留群菜单。
6. **启动验证**：按本节通用核验要求启动观察，全部通过后清理备份。

---

<a id="staged-upgrade"></a>

### 从旧版本分阶段升级流程

- **落后于 16.3.2 的部署**：本版只提供从 16.3.2 出发的冷迁移。先安装 16.3.2，按其文档完成全部迁移（包括全局状态、图库文件名与配置布局）并确认正常运行，再执行本版的[共享数据库冷迁移](#upgrade-chat-persona)。
- **11.0.9（Schema v8）跨大版本升级**：
  需在独立目录中通过 Git 标签分步执行冷迁移链路：
  1. `500e848fae` 提交：执行 `migrate:ai-context`（v8 → v9）
  2. `12.1.0` 标签：执行 `migrate:clear-context-permission`（v9 → v10）
  3. `13.0.2` 标签：执行 `migrate:h-image-add-permission`（v10 → v11）与 `migrate:bot-config`
  4. `14.0.0` 标签：执行 `migrate:translate-sessions`
  5. `16.3.2` 标签：按其文档执行 `migrate:global-state` 与 `migrate:random-image-names`
  6. 当前版本：执行 `migrate:chat-persona-removal`（v11 → v13）

  *注*：亦可使用打包好的中间源码归档 `copy-ninjia-schema-v9-source-500e848f.tar.gz`（SHA-256: `df6502625512d8fde136dc66d8470e1d4c977856e8a0bd3909b9b6c763c820f8`）。

---

## 启动失败排查

程序的启动失败均为**有意的快速失败（Fail-Fast）**，报错自带准确原因与字段路径。请对照排查，切勿盲目绕过：

### 1. 数据根预检失败
- **原因**：数据根、`memory/`、`logs/`、`database/` 存在符号链接；前三者权限宽于 `0755`（即 group/other 包含写权限）；`database/` 宽于 `0770` 或协作组不可写；底层文件系统不支持 fsync、hard link 或原子 rename。
- **处理**：停机后修正目录属主与权限。数据根、`memory/`、`logs/` 设为 `0750` 或 `0755`，`database/` 设为 `0750` 或 `02770`。确保在本地标准 POSIX 文件系统上运行。

### 2. `bot.lock` 拒绝启动
- **原因**：检测到已有相同 token 的进程正在运行，或存在旧版本残余锁文件。
- **处理**：详见下节 [`bot.lock` 拒绝启动](#botlock-拒绝启动)。

### 3. 配置目录布局不符
- **原因**：配置文件平铺在 `config/` 根目录下，或 `config/dynamic/` 缺失。
- **处理**：停机后将 `bot.json`、`g-auth.json` 移入 `config/static/`，其余业务配置文件移入 `config/dynamic/`。

### 4. Config Schema 校验失败
- **原因**：`config/{static,dynamic}/*.json` 内容不合法（如必填项缺失、类型错误、枚举越界）。
- **处理**：根据控制台报错指示的 JSON 路径直接修正。注意：`mood.json` 权重总和必须严格等于 100，贴纸最多 5 包。

### 5. 身份数据库校验失败
- **原因**：`storage.sqlite` 不可写；数据库损坏或未完成迁移（非 schema v13）；`time_zone` 与数据根绑定的时区不符（报错点名 `storage_metadata.time-zone`）；黑名单与免检名单出现交集冲突。
- **处理**：时区不符时把 `time_zone` 改回期望值；若为 16.3.2 的 v11 库，执行本版数据库冷迁移，更旧的库先升级到 16.3.2；若损坏，从同一时点的备份恢复主库与 sidecar（`-wal`/`-shm`）。禁止创建空库覆盖或手动删行。

### 6. 运势结果与回执密钥不一致
- **原因**：当日运势结果与 `receipt-secret.json` 来自不同的备份时点。
- **处理**：停止 Bot，从同一备份时点完整恢复 `memory/luck/` 目录，严禁单独重新生成密钥。

### 7. 全局状态文件非法或残留旧 state.json
- **原因**：`memory/global/state.json` 格式不符当前 schema，或数据根顶层残留旧版 `state.json`。
- **处理**：备份后修正错误字段；旧格式先升级到 16.3.2 完成其迁移，再移出数据根中的旧文件。

---

### `bot.lock` 拒绝启动

锁文件格式为严格的 `v2:pid:starttime:boot_id:sha256(token)`（其中 `starttime` 读取自 `/proc/<pid>/stat` 第 22 字段）。实例锁强依赖 Linux `/proc` 文件系统，具备严格的 Fail-Closed 机制：

- **活跃进程冲突**：当且仅当 PID、starttime、boot ID 全量匹配时判定为活跃进程。说明已有另一个实例正在运行，必须先停止旧实例。同一数据根严禁双开。
- **过期的陈旧锁（Stale Lock）**：进程被 SIGKILL 强杀或系统重启后留下的锁，下一次启动或退出时会自动识别并清理，无需人工干预。
- **损坏或旧格式锁**：程序拒绝猜测或自动升级。在人工确认**绝对没有相关进程在运行**后，可手动删除损坏的锁文件再启动。
- **退出时锁释放失败**：进程会保留非零退出码并报错。此时需排查 `/proc` 挂载状态、目录权限与 guard 文件。
- **临时残留文件**：`.candidate.*`（hard-link 锁候选文件）与 `.tmp` 临时文件在确认原 owner 不活跃后，由启动流程自动回收。

> [!CAUTION]
> token 指纹仅用于识别锁持有者身份，不做多租户数据隔离。并行部署多个 Bot 时**必须为每个实例指定独立的数据根目录**。

---

## 升级发布

1. **源码门禁检查**：在源码工作树上执行全量检查：
   ```bash
   bun run release:check -- --version <tag>
   # 联网环境补充安全审计
   bun run audit:release
   ```
2. **Git 状态核验**：在执行任何 Git 操作前，检查 `git status --short`、版本 diff 以及受保护文件 `git ls-files config .env g-auth.json`。严禁用仓库模板覆盖部署数据。
3. **独立工作目录作业**：若 systemd 的 `WorkingDirectory` 就是当前仓库，优先在独立 worktree 或克隆目录中完成测试与构建，仍遵守只使用 `dev` 和 `master` 的分支规则。若必须原地升级，**务必先停止服务并确认 inactive**，外部备份部署文件与数据库后，再做拉取和迁移。
4. **持久化变更**：若涉及数据结构变更，严格遵循冷迁移规范操作。
5. **上线观察期**：配置与状态严格校验通过后启动服务，至少观察两个实际 supervisor 重启间隔，确认 `ActiveState=active`、`SubState=running`、`NRestarts` 相对启动后基线不增长，且 journal 无新增非零退出；全部核验通过后才能清理外部备份。

### 安装器的服务与备份边界

`install.sh` 具备内置的守护保护机制：
- **服务状态检查**：安装器在首次原地写入前要求既有服务处于 `inactive/dead` 状态。若服务处于运行中或多条 `ExecStart` 冲突，当场拒绝继续。
- **备份与隔离**：替换配置文件与 unit 前，先在工作树外建立备份清单。任一步骤失败均保留现场，回滚时逐文件核验 SHA-256。
- **环境变量约束**：未设置 `COPY_NINJIA_DATA_ROOT` 时按项目根解析；显式设置时要求现有 unit 的 `Environment` 与安装环境解析为同一数据根。非空 `EnvironmentFiles` 及涉及该变量的 `PassEnvironment` / `UnsetEnvironment` 会被拒绝。
- **健康观察窗口**：启动后安装器观察两倍有效重启等待上限再加两秒；期间 `NRestarts` 相对基线变化、进程异常退出、journal 不可读或新增非零退出均使验证失败。

---

## 日常观察点

### 关键日志特征与排查

- **结构化日志**：位于 `logs/`，由 Disk I/O Worker 批量异步追加，纯英文日志，便于 grep 过滤分析。
- **Worker 崩溃自愈**：单个 Worker 崩溃会自动节流重启并从主线程恢复镜像或快照；若出现反复崩溃重启循环，通常指示持久化数据与当前代码版本不符。
- **持久化失败快速退出**：有限重试耗尽的落盘失败会触发主动非零退出（Durability 优先于可用性原则），等待 systemd 重启恢复。

#### 常见日志提示

- `Cron task "<name>" action #<n> (<type>) failed after <k> attempt(s)`：
  定时任务动作终态失败。可能原因：
  - `403`：Bot 已被移出目标群。
  - `400`：媒体 URL 无效或文件格式 Telegram 不支持。
  - `local file ... is missing`：本地素材文件丢失。
  - `speech synthesis failed: ...`：语音合成失败（`tts unconfigured` / `tts unsupported` 为配置不匹配；`worker unavailable` 为 AI Worker 未就绪；`synthesis failed` / `timed out` 为模型服务端问题；`daily limit reached` 为当日配额耗尽）。
- `/send TTS for chat <id> produced no voice: <原因>`：
  私聊中转中的语音合成失败，原因同上。超管私聊会同步收到失败说明，中转会话保持打开。
- `AI reply voice was not sent (chat <id>): <原因>`：
  AI 回复中 `send_voice` 工具未能成功输出语音（模型或网络故障、配额用尽）。此错误不阻断文本回复的正常发送。
- `Failed to probe chat membership ... PARTICIPANT_ID_INVALID`：
  黑名单成员补扫遇到 Telegram 销号账号。同一用户连续 5 次在群内探测返回该错误后，系统将自动从黑名单中注销该 ID。
- `Gemini context cache API ... create rejected (n/3): 400`：
  缓存创建请求被端点以 400 拒绝，可能是内容低于缓存 token 下限，也可能是参数非法。同一内容每隔 5 分钟重试，累计 3 次后不再尝试；期间请求仍可不带缓存发出。

---

<div align="center">

[← 上一页：06 修改配方](06-modification-guide.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#07-运维与排障) · [下一页：08 图库与定时任务 →](08-images-and-cron.md)

</div>
