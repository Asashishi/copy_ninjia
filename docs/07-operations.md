# 07 运维与排障

[← 06 常见修改配方](06-modification-guide.md) · [返回目录](README.md)

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

进程崩溃或非零退出交给 `Restart=on-failure` 拉起即可：待验证状态、锁定计时、AI 记忆与未确认的 Telegram update 都会按 [04 运行时权威约束](04-invariants.md#持久化) 的恢复语义续接。

## 数据根

`COPY_NINJIA_DATA_ROOT` 派生所有运行时数据（留空则为项目根目录）：

| 路径 | 内容 | 备份要点 |
| :--- | :--- | :--- |
| `state.json` + `state.json.bak` | 群开关、copy、锁定镜像等权威状态 | 主备一起备份 |
| `memory/ai/` | 每群 AI 记忆快照 | 含群聊逐字内容，敏感 |
| `memory/stickers/` | 贴纸描述目录 | 可由线上对账重建 |
| `memory/luck/` | 运势结果 + `receipt-secret.json` | 密钥与当天结果必须在同一一致性备份中 |
| `memory/anti-raid/` | 待验证状态按日文件 | 只保留东京当天 |
| `logs/` | 错误日志（英文文案） | 按需 |
| `bot.lock`（及 `.guard`/`.recovery`） | 单实例锁 | 不备份、不手工编辑 |

备份覆盖整个数据根，并在 Bot 停止或存储快照一致性边界内完成。`memory/` 视为敏感数据：文件 mode 是宽松的 `0644`（单租户部署基线，见 [04](04-invariants.md#持久化)），访问控制靠目录 owner/权限与主机账户隔离。

## 启动失败排查

程序的启动失败都是**有意的快速失败**，报错自带原因；对照处理，不要绕过：

| 症状 | 原因 | 处理 |
| :--- | :--- | :--- |
| 数据根预检失败（带路径） | 目录不可写，或文件系统不支持 fsync / hard link / 原子 rename | 换本地文件系统路径；网络盘与部分容器层不满足能力要求 |
| `bot.lock` 拒绝启动 | 见下节 | 见下节 |
| config schema 校验失败 | `config/*.json` 或 `.env` 不合法 | 按报错字段修正；mood 权重和必须恰好 100，贴纸最多 5 包 |
| 两份 state 副本均无效 | 部署了 schema 变更但没迁移数据 | 按 [06 变更持久化 schema](06-modification-guide.md#变更持久化-schema) 迁移后再启；程序不会改动原文件 |
| 出现 `*.corrupt` 文件 | 单份 state 副本损坏被隔离，另一份已接管 | 正常自愈路径；排查完原因后可删除隔离件 |

### `bot.lock` 拒绝启动

锁文件格式是严格的 `v2:pid:starttime:boot_id:sha256(token)`（`starttime` 取自 `/proc/<pid>/stat` 第 22 字段），实例锁显式依赖 Linux `/proc` 且 fail-closed：

- **另一个进程真的在跑**：PID、starttime、boot ID 全匹配才算活跃 owner——先停掉它。数据目录全局独占，同一数据根不允许两个实例。
- **stale v2 锁**（进程死了/机器重启过）：下一次启动或退出时自动清理，无需干预。
- **旧格式/损坏格式**：不兼容读取、不自动迁移、不按 PID 猜测清理。确认没有相关进程在跑之后，手工删除旧锁文件再启动。
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

[← 06 常见修改配方](06-modification-guide.md) · [返回目录](README.md)
