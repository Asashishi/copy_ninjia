# 04 · 锁定镜像与终态标志

[简体中文](../cn/04-lockdown-invariants.md) · [English](../en/04-lockdown-invariants.md) · [日本語](../ja/04-lockdown-invariants.md)

[← 04 运行时权威约束](04-invariants.md)

- **Lockdown 落盘握手指纹（`lockdownFingerprint`）**：
  - 指纹由 `phase`、`intentId` 与 `announced` 三项构成。
    - `phase` 与 `intentId`：代表一次锁定意图的稳定唯一身份；
    - `announced`：决定系统重启或恢复后是否补发解锁公告，持久化落盘回执必须覆盖此字段；
    - 紧急权限恢复在核验迟到结果是否仍属于当前意图时，仅比较 `phase` 与 `intentId`；公告落盘不会创建新的权限意图。两类指纹均严禁包含易变的 `expiresAt`。
  - **倒计时与对账循环**：
    - 锁定倒计时存储在镜像的 `expiresAt` 绝对时间戳中，接管（adopt）时按当前时钟动态换算为 `remainingMs`。
    - 落盘对账循环以 `LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS` 为轮次上限。若持久化在途期间有新事件到达，置位待续跑标记；用尽轮次后记录错误日志并让出微任务，随后自动加载最新镜像开启新任务，不依赖后续外部事件唤醒。
- **Worker 崩溃后的紧急恢复接管**：
  - 当 Anti-Raid Worker 耗尽重启预算放弃自愈时，主线程通过 `recoverAbandonedLockdowns` 直接遍历群状态热读副本（`cache/main/chatState.ts` 中的 `chatStateCache`），不创建中间快照，也不依赖特定遍历顺序。
  - 恢复链在首个 `await` 之前同步读取当前群状态，每个处于锁定态的群仅触发一次恢复接管并在日志中打印一次。
  - 若某群的恢复任务已在册且 `phase` 与 `intentId` 相同，`startEmergencyLockdownRecovery` 直接返回；若锁定意图不同，则先注销旧任务再开启新恢复。
- **镜像格式与严格校验**：
  - 运行时 lockdown 镜像必须包含 `phase` 与正整数 `intentId`；`announcementMessageId` 仅允许在 `announced === true` 时出现。
  - 验证快照必须包含 `phase` 与 `trackedMessageTimes`。选填字段 `reminderMessageId` 与 `announcementMessageId` 缺失仅表示提醒尚未成功发出或未检测到入群公告，恢复后各自独立执行补发或清理逻辑。
  - 其它字段缺失或格式不符时由解码器严格拒绝启动，必须在停机期间人工修复，生产读取路径不保留向前兼容降级。
- **终态播报标志持久化**：
  - 终态提示的三个状态标志必须持久化落盘：
    - `successNoticeSent`：成功踢人战报已发送；
    - `failureNoticeSent`：无法执行踢人或缺乏 `can_restrict_members` 权限；
    - `unconfirmedNoticeSent`：无法确认成员在群状态或群类型。
  - 三类提示发送成功后，均通过主线程挂载 `COMMAND_MESSAGE_AUTO_DELETE_MS` 定时自动删除。
  - 三个标志各自独立防止对应消息在 Worker 重建或服务重启后重复发送，不可相互替代；设置标志时发布新 revision 并等待持久化确认。
  - **踢人成功未播报时的断点保护**：若踢人已成功但战报发送失败，严禁直接结算。先将 `removalConfirmed` 写入快照并进入退避重试；下一轮探测确认目标已离群时，据此认定为已被本 bot 踢出并补发战报。`removalConfirmed` 仅在战报失败时持久化写入。
- **权限缺失短路门禁（`cleanupSettled`）**：
  - 确证无封禁权限（`botCanRestrictIn === false`）时的提前短路，必须以**关联清理已全部完成**（`cleanupSettled === true`）为前提：仅当 `failureNoticeSent` 与 `cleanupSettled` 同时为真时才短路，此时每轮只发一次成员探测，成员已离群即结算，否则继续退避。
  - 私密模式秒踢（`kickPending`）在无封禁权限时同样先做成员探测：成员已离群即结算并释放该条记录；仍在群内则记日志并退避，不发踢人请求。
  - 若仍有未完成的清理动作，照常推进处置流程：踢人被封禁权限短路、战报被已发送标志短路、删消息在无删除权限时短路，确保所有可执行且需重试的清理工作（如删除消息）均得到执行。
  - `cleanupSettled` 与 `executionStarted` 属于 **Worker 本地内存幂等控制标志，不进入持久化快照**。

<p align="right"><a href="04-invariants.md#快速导航">↑ 返回快速导航</a></p>
