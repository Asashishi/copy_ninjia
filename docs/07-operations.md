# 07 运维与排障

<p align="center">
  <b>简体中文</b> · <a href="en/07-operations.md">English</a> · <a href="ja/07-operations.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 开发者文档首页</a> · <a href="06-modification-guide.md">← 上一页：06 修改配方</a> · <b>下一页：无 →</b>
</p>

---

## 部署形态

单实例长轮询进程，无 webhook、无外部数据库；持久化全部是本地文件。单实例建议承载约 15 个活跃群以内（瓶颈是单 Bot API、Gemini 配额与媒体速率，硬件参考见根 README「快速开始」）。

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

数据根目录先由部署工具预建：`sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia`。容器部署把同一目录作为持久卷挂载，owner 由宿主或 init container 设置；`memory/` 不要放容器临时层。

升级到带权限门禁的版本前先停掉所有实例，再检查并迁移已有目录：`sudo chown -R copy-ninjia:copy-ninjia /var/lib/copy-ninjia && sudo find /var/lib/copy-ninjia -type d -exec chmod 0750 {} +`。程序会以 `0750` 补建数据根及 `logs/`、`memory/`，并校验这些目录属于运行 UID；`config/` 是项目内只读部署配置，不属于独立运行时数据根。已有目录若比 `0750` 更宽会拒绝启动，不会擅自 chmod。若部署需要不同 owner/group，请替换命令中的账户，但仍须保证运行用户可写且 mode 不宽于 `0750`。

进程崩溃或非零退出交给 `Restart=on-failure` 拉起即可：待验证状态、锁定计时、AI 记忆与未确认的 Telegram update 都会按 [04 运行时权威约束](04-invariants.md#持久化) 的恢复语义续接。

## 数据根

`COPY_NINJIA_DATA_ROOT` 派生所有运行时数据（留空则为项目根目录）：

| 路径 | 内容 | 备份要点 |
| :--- | :--- | :--- |
| `state.json` + `state.json.bak` | 群开关、copy、锁定镜像等权威状态 | 主备一起备份 |
| `memory/ai/<chatId>.json` | 每群 AI 记忆的 version=1 原子快照：最近逐字消息、历史摘要、待合并摘要与保存时间 | 含群聊逐字内容，敏感；清空该群记忆时删除，启动按 chatId 恢复 |
| `memory/stickers/<pack>.json` | 每个白名单贴纸包的 version=1 描述目录：按 `file_unique_id` 保存 emoji/描述及整包摘要 | 可由线上贴纸包重新对账；不再位于 `config/stickers.json` 白名单中的包会在启动恢复时删除 |
| `memory/luck/<YYYY-MM-DD>.json` | 东京当天运势结果，key 是用户 id，带所求事项时还含事项摘要 | 只保留当天；必须与下方回执密钥处于同一一致性备份中 |
| `memory/luck/receipt-secret.json` | 当天运势回执的 version=1 HMAC 密钥（日期 + 32 字节 key） | 不可单独删除、重建或从另一备份时点恢复，否则已有结果与回执会不一致 |
| `memory/anti-raid/<YYYY-MM-DD>.json` | Challenge 待验证状态的当日追加日志；包含 active 快照、重复 revision 与终结 tombstone | 逻辑上只恢复每个 `chatId:userId` 的最后状态；只保留东京当天，达到 10,000 条历史或 4 MiB 时压缩成 active 快照 |
| `memory/blocklist/blocklist.json` | `/block` 永久权威名单（用户 id + 拉黑时刻） | 必须备份：丢了等于全员解除拉黑。正常解除使用 `/unblock`；紧急手工编辑必须停机并保留合法 JSON。文件损坏会**拒绝启动**而不截断自愈；键必须是能原样还原的十进制 id |
| `memory/blocklist/removals.json` | 尚未完成的群级封禁任务 outbox | 不是名单副本；必须与 `blocklist.json`、`state.json` 处于同一备份一致点。启动时按权威名单与群管理状态过滤后重放，任务落定后删除 |
| `memory/ad-detected/sample.json` | 广告判定命中的原始样本（时间、消息 id 与正文、判定理由、引用/回复上下文） | **纯旁路，进程从不读它**：丢了不影响任何行为，只影响人回头调 `config/ad_samples.json` 的素材。达到 8 MiB 时自动轮转为 `sample.<东京日期>[.<序号>].json`；归档按文件名日期自动保留今天在内最近 15 个东京自然日 |
| `memory/ad-detected/sample.<YYYY-MM-DD>[.<序号>].json` | `sample.json` 的轮转归档；同日第二份从 `.2` 起递增 | 严格按文件名日期保留最近 15 个东京自然日；未知命名、目录与符号链接不进入自动删除路径 |
| `logs/` | 错误日志（英文文案） | 按需 |
| `bot.lock`（及 `.guard`/`.recovery`） | 单实例锁 | 不备份、不手工编辑 |

`memory/` 顶层不直接放文件，上述六个领域各占一个子目录。`ai/`、`stickers/`、`luck/`、`anti-raid/` 与 `blocklist/` 会在启动恢复时按需建目录；`ad-detected/` 只在第一次广告命中后建立。`anti-raid/<day>.json` 的物理文件是增量日志而不是单纯 active 列表：新建和状态变化追加完整快照，结算追加同 key 的 `null` tombstone，恢复后才折叠成当前 active challenge。

### `memory/` 辅助文件与纯内存状态

- 原子覆盖会短暂创建 `.<目标文件名>.<pid>.<uuid>.tmp`，完成 `fsync + rename` 后消失；只有进程在两步之间被硬杀才可能留下。`ai/`、`stickers/`、`luck/` 在启动时清理 `*.tmp`，`blocklist/` 的两个 owner 只按各自 `.blocklist.json.*.tmp` / `.removals.json.*.tmp` 前缀清理，`ad-detected/` 在首次写样本前清理 `.sample.json.*.tmp`。当前 `anti-raid/` 恢复只忽略这类文件而不主动清理；它们不参与恢复，确认 Bot 已停止且名称精确匹配上述原子写格式后才可作为孤儿删除。
- `memory/ai/<chatId>.json.corrupt` 与 `memory/stickers/<pack>.json.corrupt` 是 JSON 无法解析时保留的隔离件，不参与正常恢复也不自动删除。字段能解析但不符合当前 version=1 schema 时不会隔离，而是直接拒绝启动，要求按 [06](06-modification-guide.md#变更持久化-schema) 手工迁移。
- `/block` 的 `confirmedKickedUserIdsByChat`、Challenge timer、广告检测待判队列/去重 Set、Telegram 成员/管理员短缓存都只存在于进程内，没有对应文件。尤其“当日逐群确证踢出”缓存按东京日或进程重启清空，绝不从 `blocklist.json` 或 `removals.json` 推断恢复。

备份覆盖整个数据根，并在 Bot 停止或存储快照一致性边界内完成。`memory/` 视为敏感数据：文件 mode 是宽松的 `0644`（单租户部署基线，见 [04](04-invariants.md#持久化)），访问控制靠目录 owner/权限与主机账户隔离。

### `removals.json` v1 → v2

从 outbox v1 升级到 v2 前必须停 Bot 并手工迁移；新版严格拒绝 v1，不在运行时兼容或自动改写。文件不存在或已经是 v2 时跳过。以下命令以数据根为当前目录：

```bash
outbox=memory/blocklist/removals.json
backup=memory/blocklist/removals.json.v1.bak
candidate=memory/blocklist/removals.json.v2
cp -a "$outbox" "$backup"
jq -e '
  if .version != 1 or (.entries | type) != "array" then
    error("expected removals.json version=1")
  else
    .version = 2
    | .entries |= map(
        if .params.probeMembership == true then
          .params |= del(.userIds, .joinedAt, .announcementMessageId)
        else
          .
        end
      )
  end
' "$outbox" > "$candidate"
chmod --reference="$outbox" "$candidate"
chown --reference="$outbox" "$candidate"
test "$(jq '.entries | length' "$backup")" = "$(jq '.entries | length' "$candidate")"
diff -u \
  <(jq -S '[.entries[].params.removalId] | sort' "$backup") \
  <(jq -S '[.entries[].params.removalId] | sort' "$candidate")
jq -e '
  .version == 2
  and all(.entries[];
    if .params.probeMembership == true then
      (.params | has("userIds") or has("joinedAt") or has("announcementMessageId")) | not
    else
      (.params.userIds | type == "array" and length > 0)
    end
  )
' "$candidate" > /dev/null
```

迁移只改变补扫任务：`probeMembership: true` 表示“用当前黑名单扫这个群”，因此删除其中冻结的 `userIds`、`joinedAt`、`announcementMessageId`；`probeMembership: false` 的秒踢/广告处置必须原样保留非空 `userIds`。上述命令同时核对候选文件版本为 2、entry 数量与全部 `removalId` 和备份一致、补扫不再带上述三字段、非补扫仍带名单；任一步非零退出都不要替换。全部通过后执行 `mv "$candidate" "$outbox"`，再部署新版。启动恢复报错时停止服务并用 `$backup` 回滚；确认恢复和重放正常后才删除备份。Release 的 Compatibility / Migration Notes 必须重复说明这一步。

从仍使用 `config/blocklist.json` 的旧版本升级时，不保留运行时兼容分支：先停 Bot，备份旧文件与现有 `memory/blocklist/`，再把旧文件手工移动为 `memory/blocklist/blocklist.json`。不要与 `removals.json` 合并：前者回答“谁应永久封禁”，后者只回答“哪些群级处置还没完成”。确认目标 JSON 与备份一致后再启动新版本。

## 启动失败排查

程序的启动失败都是**有意的快速失败**，报错自带原因；对照处理，不要绕过：

| 症状 | 原因 | 处理 |
| :--- | :--- | :--- |
| 数据根预检失败（带路径） | 目录 mode 宽于 `0750`、不可写，或文件系统不支持 fsync / hard link / 原子 rename | 停掉所有实例后修正 owner/group 并 `chmod 0750 <数据根>`；若仍失败则改用满足能力要求的本地文件系统 |
| `bot.lock` 拒绝启动 | 见下节 | 见下节 |
| config schema 校验失败 | `config/*.json` 或 `.env` 不合法 | 按报错字段修正；mood 权重和必须恰好 100，贴纸最多 5 包 |
| 两份 state 副本均无效 | 部署了 schema 变更但没迁移数据 | 按 [06 变更持久化 schema](06-modification-guide.md#变更持久化-schema) 迁移后再启；程序不会改动原文件 |
| 运势结果与回执密钥不一致 | 当日结果和 `receipt-secret.json` 来自不同备份时点，或只恢复了其中一项 | 停止 Bot，恢复同一一致性时点的完整 `memory/luck/`；不要删除或重新生成单独的密钥 |
| 出现 `*.corrupt` 文件 | 可能是单份 state 副本损坏被隔离，也可能是 AI/贴纸 JSON 解析失败后被移出恢复集合 | 先按原文件名定位 owner 并调查损坏原因；state 有另一份副本时可自愈，AI/贴纸隔离件不会自动恢复或删除 |

### `bot.lock` 拒绝启动

锁文件格式是严格的 `v2:pid:starttime:boot_id:sha256(token)`（`starttime` 取自 `/proc/<pid>/stat` 第 22 字段），实例锁显式依赖 Linux `/proc` 且 fail-closed：

- **另一个进程真的在跑**：PID、starttime、boot ID 全匹配才算活跃 owner——先停掉它。数据目录全局独占，同一数据根不允许两个实例。
- **stale v2 锁**（进程死了/机器重启过）：下一次启动或退出时自动清理，无需干预。
- **旧格式/损坏格式**：不兼容读取、不自动迁移、不按 PID 猜测清理。确认没有相关进程在跑之后，手工删除旧锁文件再启动。
- **退出时释放失败**：进程会保留非零退出状态并报告锁释放 owner 失败，不会把失败伪装成干净退出；先排查 `/proc`、目录权限与 guard 文件，再确认旧进程已结束后处理残留。
- `.candidate.*` 是 hard-link 锁协议的候选文件，`.tmp` 是 `state.json` / 锁注册表原子重写的临时文件；正常操作都会删除，当前格式的残留会在确认 owner 不活跃或取得实例锁后由启动清理回收。

token 指纹只用于识别锁 owner，不是数据隔离边界；多个 Bot 并行部署必须使用不同的数据根目录。

## 升级发布

1. `bun run release:check` 全绿（frozen lockfile + 全量检查 + 故障注入）；联网环境加 `bun run audit:release`。
2. 版本包含持久化结构变更的，先按 [06 变更持久化 schema](06-modification-guide.md#变更持久化-schema) 停机迁移。
3. 重启服务（systemd 部署即 `systemctl restart <unit>`），观察启动日志与 `logs/`。

## 日常观察点

- `logs/`：错误由 Disk I/O Worker 批量追加，文案英文，可直接 grep。
- Worker 崩溃会节流自愈并从镜像/快照恢复；反复崩溃循环才需要介入（通常意味着持久化数据与代码版本不匹配）。
- 有限重试耗尽的持久化失败会让进程以非零状态退出——这是设计行为（durability 优先于可用性），由 systemd 拉起后从上一致状态续跑。

---

<div align="center">

[← 上一页：06 修改配方](06-modification-guide.md) · [📚 开发者文档首页](README.md) · [⬆️ 回到顶部](#07-运维与排障) · **下一页：无 →**

</div>
