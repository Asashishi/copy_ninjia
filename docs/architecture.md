# Architecture decisions

本文档记录跨模块、跨生命周期的权威约束。源码注释应解释局部不变量，并引用这里，
不在多个模块重复维护整套启动或持久化叙述。

## 启动与 import 边界

- 生产模块 import 不启动 Worker、计时器、网络请求或共享目录写入。
- 主进程先取得 `bot.lock`，再校验 `config/`，随后显式初始化 Telegram 客户端、
  Disk I/O Worker、状态恢复、AI Worker 和 Anti-Raid Worker。
- 初始化失败和正常退出都由 `ApplicationLifecycle` 收口；只有已取得的资源才会释放或 flush。
- 配置解析器本身无 I/O；`getStickerConfig()` / `getReactionConfig()` / `getMoodConfig()`
  在业务首次使用时惰性加载，主进程会在持锁后预热，以便部署错误在联网前暴露。
- `state.json`、`bot.lock`、`logs/` 与 `memory/` 全部从统一运行时数据根派生；
  生产缺省使用项目根目录，测试 preload 在任何生产模块 import 前注入逐隔离体的临时根，
  让真实文件 I/O 也不可能读写生产缓存。

## Worker 与状态所有权

- 主线程持有 Telegram runner、Worker 监督句柄，并由 `StateStore` 独立维护
  `state.json` 的内存镜像、latest-only 原子写、失败重试和退出 flush。
- AI Worker 独占群聊记忆、回复准入、媒体描述流水线和贴纸目录生成的运行时状态。
- Anti-Raid Worker 独占验证/锁定状态机和对应计时器；主线程只持可恢复镜像。
- 状态机的 `State/Event/Effect/Transition/Decision` 契约统一由 `src/types/states/`
  持有，`src/states/` 只实现无 I/O 的纯状态转移；解释器和 cache 直接依赖前者的类型。
- Disk I/O Worker 独占日志、AI 记忆、贴纸目录、运势和待验证数据的持久化，
  在单一 Worker 线程内串行读写这些共享目录；`state.json` 是明确的例外，由主线程
  `StateStore` 异步维护。业务 Worker 不直接写共享目录。
- 长期 Map、Set、队列和 timer 必须由对应 `src/cache/<domain>/` 与业务生命周期模块
  共同给出容量、清理和 Worker 重建语义。
- 业务 Worker 的主线程监督句柄把同步 `postMessage` 拒绝统一收敛为 `false` 并记录错误；
  需要确认处理与落盘边界的调用方必须把 `false` 当作失败，不能确认对应 Telegram update。
- AI 回复只把成功的文字、贴纸、反应和图片计入统一动作预算；仅在零成功动作时，
  最终正文才经 `send_message` 兜底。所有有意展示的文字必须由模型显式调用该工具。
- AI 回复的初始 Gemini 输入必须保持一个 `user Content` 下的三个有序 `text Part`：
  只读参考记忆、只读当前会话、本轮回复任务。每段只由模型可见的首尾标签加一行
  段首职责标注包围；防注入总规则（数据 vs 指令、伪造边界无效、不暴露内部结构）
  统一只在 `systemInstruction` 声明一次，不逐段重复。工具调用后的历史再按真实
  `model/user` 角色追加，不得把参考资料伪装成历史对话轮次。系统提示词只通过
  `GenerateContentConfig.systemInstruction` 独立字段发送，不得拼入普通对话 `contents`。
- 群聊转录的行内标注（回复引用、转发来源）由 `src/consts/aiChat/prompts/transcript.ts`
  的共享模板同时生成拼装文本与提示词说明里的占位形态，两侧不得各自手写同一格式；
  转发归属按标注层级区分：回复标注外层属于当前消息本身，内层属于被回复的原消息。
- Anti-Raid 对关联频道评论区的直属评论和楼中楼回复采用同一豁免语义；评论关联缓存
  只保存消息 ID 与观察时间，不把已无行为差异的来源标记泄漏进状态机。
- chat runtime teardown 的三个固定 owner 回调由 `src/cache/chatTeardown.ts` 持有，
  上层领域经 `src/infra/chatTeardown.ts` 反向注册；`src/infra/botAdmin.ts` 不得静态依赖
  `commands/`、AI 或 Anti-Raid 业务模块。

## 持久化

- `state.json` 使用最新值合并、临时文件、fsync 和原子 rename。
- AI 记忆与贴纸目录按实体写原子快照；日志、运势和待验证状态使用可修复尾部截断的
  JSON 追加文件。每批追加在成功回执前 fsync；待验证终结追加 tombstone，只保留
  东京当天文件，并在条数/字节阈值处收敛为 active 快照。截断修复必须按 JSON 字符串、
  转义与括号深度识别顶层成员边界，不能依赖对象值的收尾缩进；`null` tombstone 与其它
  基础类型都必须被视为完整的最后值。
- AI 记忆恢复必须按当前 `AI_MEMORY_HYDRATE_BUFFER_MAX` 与 `MAX_SUMMARY_ROUNDS`
  （当前为 149 条逐字消息与 7 轮冷摘要）从快照尾部截取最新数据；调整容量常量部署前，应在旧进程停止后以同一
  恢复逻辑原子重写现有 `memory/ai/`，避免旧进程的停机 flush 覆盖迁移结果。
- Telegram update 只有在对应 middleware 完成后才可推进确认边界；Anti-Raid mailbox、
  反应/头像后台 owner 与 StateStore、AI Worker、Disk I/O Worker 的 flush 都有显式有界 drain。任一关键 flush 失败
  必须返回失败、阻止最终 offset 确认并以非零状态退出。
- Worker flush 与 mailbox barrier 统一使用 `src/libs/flushBarrier.ts` 管理 ID、等待表、
  超时、迟到回执和崩溃批量结算；领域缓存不得重新暴露 resolver Map。
- `memory/` 产物统一为 `0644`：属主可写、普通系统用户可读。敏感性由主机账户权限、
  部署隔离和备份策略控制，不通过制造不可读文件解决。
- 持久化 schema 不做猜测式自动迁移；不兼容输入会阻止启动，避免空状态覆盖原数据。

## 兼容入口

大文件拆分时保留的顶层 barrel 只用于渐进迁移。新增生产代码应从所属领域文件导入；
兼容入口不得重新持有状态、解析配置或引入 import 副作用。
