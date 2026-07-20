# Architecture decisions

本文档记录跨模块、跨生命周期的权威约束。源码注释应解释局部不变量，并引用这里，
不在多个模块重复维护整套启动或持久化叙述。

## 启动与 import 边界

- 生产模块 import 不启动 Worker、计时器、网络请求或共享目录写入。
- 主进程先取得 `bot.lock`，再校验 `config/`，随后显式初始化 Telegram 客户端、
  Disk I/O Worker、状态恢复、AI Worker 和 Anti-Raid Worker。
- 初始化失败和正常退出都由 `ApplicationLifecycle` 收口；只有已取得的资源才会释放或 flush。
- 配置解析器本身无 I/O；`getStickerConfig()` / `getReactionConfig()` 在业务首次使用时
  惰性加载，主进程会在持锁后预热，以便部署错误在联网前暴露。

## Worker 与状态所有权

- 主线程持有 Telegram runner、`state.json` 镜像和 Worker 监督句柄。
- AI Worker 独占群聊记忆、回复准入、媒体描述流水线和贴纸目录生成的运行时状态。
- Anti-Raid Worker 独占验证/锁定状态机和对应计时器；主线程只持可恢复镜像。
- Disk I/O Worker 是进程内唯一持久化线程，串行写日志、AI 记忆、贴纸目录、
  运势和待验证数据。业务 Worker 不直接写共享目录。
- 长期 Map、Set、队列和 timer 必须由对应 `src/cache/<domain>/` 与业务生命周期模块
  共同给出容量、清理和 Worker 重建语义。

## 持久化

- `state.json` 使用最新值合并、临时文件、fsync 和原子 rename。
- AI 记忆与贴纸目录按实体写原子快照；日志、运势和待验证状态使用可修复尾部截断的
  JSON 追加文件。每批追加在成功回执前 fsync；待验证终结追加 tombstone，只保留
  东京当天文件，并在条数/字节阈值处收敛为 active 快照。
- Telegram update 只有在对应 middleware 完成后才可推进确认边界；Anti-Raid mailbox、
  反应/头像后台 owner 与 AI/Disk I/O flush 都有显式有界 drain。任一关键 flush 失败
  必须返回失败、阻止最终 offset 确认并以非零状态退出。
- `memory/` 产物统一为 `0644`：属主可写、普通系统用户可读。敏感性由主机账户权限、
  部署隔离和备份策略控制，不通过制造不可读文件解决。
- 持久化 schema 不做猜测式自动迁移；不兼容输入会阻止启动，避免空状态覆盖原数据。

## 兼容入口

大文件拆分时保留的顶层 barrel 只用于渐进迁移。新增生产代码应从所属领域文件导入；
兼容入口不得重新持有状态、解析配置或引入 import 副作用。
