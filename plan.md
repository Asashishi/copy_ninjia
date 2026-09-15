# 全仓专项审查与实施

基线：`500e848faeda`（dev）；Bun 1.4.2 / `744846f844374847c902b5e7fd59b4342a51ef99`。保留功能表现，新增行为仅限用户授权的机器人自称与清理权限。

## 审查与修复

| 专项 | 核对结果与证据 |
| --- | --- |
| 脚本与代码同步 | [install.sh](install.sh) 按目标版本加载六个 `scripts/install/` 模块；语法和隔离夹具共用 [模块清单](scripts/installSources.ts)。33 个原 shell 函数体保持一致。 |
| states / 生命周期 | 维持纯状态转移与 owner 分离；[天气刷新](packages/aiChat/ai/weather.ts) 停止时取消请求，迟到结果检查 owner。 |
| Bun API | 原生 API 适用性按当前 Bun、已安装类型和官方文档核对；冷迁移使用 `Bun.file().stream()` 增量哈希，取消使用 `AbortSignal.any`。同步 I/O、rename、目录操作等保留必要 `node:` API。 |
| 功能与抽象 | 移除身份、群状态、问答存储中仅服务不完整 mock 的可选接口适配；20 处测试使用 [完整 Disk I/O 替身](test/helpers/diskIOMock.ts)，真实拒收、ACK、恢复语义保留。 |
| 性能 / 内存 / JIT / GC | 流式哈希有固定输入对照；热路径执行现有 GC/RSS/JIT 门禁。未引入对象池、共享可变内存或每消息跨线程往返。 |
| 测试 | 覆盖天气取消/乱序、权限默认/授予/撤销/频道身份、自己身份渲染、迁移谱系/严格字段/故障/容量、安装模块缺失/语法错误。 |
| 分包 / 风格 / 死代码 | 安装入口 197 行，六个模块最长 235 行；新增手写 TS/JS/sh 的 1,000 行硬门禁。旧冷迁移入口及测试按最近迁移边规则删除。 |

审查按文件与依赖清单、状态与生命周期、调用方/脚本/测试交叉核对、mock 与门禁分四遍执行。基线清单覆盖 1,300 个受跟踪文件；深查集中在边界与热点，不等同逐行证明无缺陷。原始清单与复现：`/tmp/copy-ninjia-audit-E4wR2G/`。

## 授权功能

- [x] 自称严格保留 `SELF_SPEAKER_NAME = "自己（也就是你）"`；自身记录、转录、引用、名册和摘要输入按 bot ID 隐去其 Telegram 姓名/用户名。保留其他成员身份、ID 和正文，不改写历史自由文本摘要。见 [自身身份测试](test/aiChat/ai/selfIdentity.test.ts)。
- [x] 新权限 `isCanClearContext` 默认 false；超管由身份始终直授 true。`/clear_context` 仅清当前群记忆，保留人设，授权与撤销由 `/permission` 独立控制。
- [x] 当前冷迁移仅接受 v9 → v10，原 17 项权限全部为 true 才授予新权限；当前运行时严格拒绝旧格式和非法字段。见 [迁移测试](test/scripts/migrateClearContextPermission.test.ts)。
- [x] 复核补强：`ready.json` 写入成功后才清理 `incomplete.json`；outbox 恰好达到 4,096 项允许，超过则拒绝，和生产启动一致。均有回归测试。

## 性能实测

64 MiB 确定性输入、固定 Bun 构建，每种实现三个独立进程交替执行，每进程预热三次、计时七次；最终复测直接提取当前哈希函数。内存另开采样循环，计时窗口不强制 GC。

| 指标 | 整文件读取 | 流式读取 |
| --- | ---: | ---: |
| 三轮均值（ms） | 203.65 / 205.33 / 196.28 | 194.67 / 189.51 / 192.82 |
| 总平均 / 轮间变异系数 | 201.75 ms / 1.95% | 192.33 ms / 1.11% |
| 吞吐 | 317.22 MiB/s | 332.75 MiB/s |
| 采样峰值 RSS | 213.59 MiB | 52.18 MiB |
| heapUsed / external 峰值 | 0.25 / 192.04 MiB | 13.79 / 13.56 MiB |
| 每轮 GC 次数 / 暂停占比 | 4 / 0.17–0.19% | 61 / 2.03–2.09% |
| full-GC 后留存增量（仅诊断） | 45,974–45,977 B | 54,111 B |

耗时降低 4.67%、RSS 降低 75.57%，三轮方向一致且 SHA-256 相同；实施前 mock 耗时降低 5.33%。流式读取增加小块分配与 GC，收益仅针对冷迁移耗时和峰值内存，不外推热路径。首次复测流式 CV 8.74%，已保留噪声结果并单独复测。证据：`/tmp/copy-ninjia-implemented-hash/{hash-bench.ts,actualHasher.ts,hash-results.json,hash-results-initial.json}`，大文件夹具已删除。

新增自身身份功能另经既有 `transcript-render` 三轮 profile / retained 压力验证：150 条消息渲染中位耗时 36.52 / 37.32 / 37.84 µs，留存增量最高 24,769 B；不作前后性能收益声明。未运行 `perf:full`，未修改基准规模或性能指标文件。

## 11.0.9 与安装验证

- [x] 从 11.0.9 实际提交 `95e37ab4ffd8938fd80e33e7e66c534346fd7975` 的 schema、权限和建库代码构造空库、业务库、历史 JSONB 谱系三组夹具。
- [x] 用固定中间提交 `500e848faeda75dcae3c3329507f24d05137e3b9` 的原始迁移生成 v9，再用当前入口生成 v10；每组均验证源哈希、权限、元数据、问答、黑名单、临时免检及 AI 上下文。两组业务库各 18 成员：新权限 1 true / 17 false；已有群记忆导入，无主记忆按中间版本规则计入丢弃数。
- [x] 三组 v10 均交给当前 `install.sh`，使用独立数据根运行真实应用和 Worker；仅替换系统管理、依赖安装及网络出站，均启动、轮询、SIGTERM 排空成功，退出码 0，锁文件清除。
- [x] 现有安装测试同时覆盖新装、AI 开/关、带已有群状态再次启动及非法配置拒绝；没有操作当前服务。三语 [迁移指南](docs/cn/07-operations.md) 已包含分阶段命令与手工替换步骤。

每个测试 Worker 经 Bun preload 安装网络替身，天气返回罐头；主线程提供群菜单、群标题和贴纸目录应答，未声明请求使测试失败。固定中间版本完整源码已另存 `/tmp/copy-ninjia-schema-v9-source-500e848f.tar.gz`（4,519,520 B），SHA-256 为 `df6502625512d8fde136dc66d8470e1d4c977856e8a0bd3909b9b6c763c820f8`。后续 squash 发布须保留并提供此中间源码，不能仅依赖将重置的 dev 历史。

一次性跨版本验证不在当前代码树保留旧迁移边或旧边测试。复现脚本：`/tmp/copy-ninjia-verify-11.0.9.ts`；结构化结果：`/tmp/copy-ninjia-release-migration-report.json`；临时源码、数据库和安装目录已清理。

## 最终门禁与交付

- [x] 完整 `bun run check` 通过：安装语法、安装隔离、约定、lint、typecheck、coverage、热路径门禁全部成功。
- [x] 全量测试 **4,281 pass / 0 fail**，378 文件，157,651 次断言；函数覆盖率 **97.16%**、行覆盖率 **97.93%**。三语 README、开发文档、图注和两张 SVG 已同步并与同次输出逐项核对。
- [x] 故障注入 **1,351 pass / 0 fail**，94 文件，9,797 次断言。
- [x] 热路径 **10 场景 × 3 轮** profile / retained 通过：最高 GC **23.35%**，采样 RSS **145.17 MiB**，留存堆增量 **26,490 B**；生产探针均达到 DFG，无延迟软告警。`performance/` 无残留目录。
- [x] 文档已同步当前权限、严格输入、天气 owner、自身身份、安装模块和隔离边界，以及 11.0.9 分阶段迁移操作。中文字符串行数按 TypeScript AST 实测为 1,355 行 / 81 文件，不含注释。

日志：`/tmp/copy-ninjia-review-check-complete.log`、`/tmp/copy-ninjia-review-fault-final.log`、`/tmp/copy-ninjia-review-install-network-final.log`、`/tmp/copy-ninjia-release-migration-final.log`。

## 已完成的现有数据迁移

此前按用户授权停机、外部备份 36 文件、迁移副本并逐项核对后，已原子替换真实数据库且恢复原权限/属主。47 成员中 24 true / 23 false，原权限及其他业务数据保持，7 份上下文保留。服务于 2026-09-16 00:09:58 JST 恢复，跨两个重启间隔后 active/running、NRestarts=0，无新增非零退出。本轮仅做开发与隔离验证。

原外部备份保留在 `/tmp/copy-ninjia-permission-backup-KnELij/`，核验清单在 `/tmp/copy-ninjia-permission-output-KnELij/`。只读 SQLite 校验引起的 SHM 索引变化已单独记录，主库及空 WAL 的原哈希保持。

官方依据：[文件 I/O](https://bun.sh/docs/runtime/file-io)、[增量哈希](https://bun.sh/docs/runtime/hashing)、[AbortSignal.any](https://bun.sh/reference/globals/AbortSignal/any)、[Worker preload](https://bun.com/reference/bun/WorkerOptions/preload)、[Bun SQLite](https://bun.sh/docs/runtime/sqlite)、[Drizzle Bun SQLite](https://orm.drizzle.team/docs/sqlite/connect-bun-sqlite)。
