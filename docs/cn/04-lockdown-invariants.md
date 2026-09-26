# 04 · 锁定镜像与终态标志

[简体中文](../cn/04-lockdown-invariants.md) · [English](../en/04-lockdown-invariants.md) · [日本語](../ja/04-lockdown-invariants.md)

[← 04 运行时权威约束](04-invariants.md)

- lockdown 落盘握手的指纹由 `phase`、`intentId` 与 `announced` 组成。前两项是一次锁定意图的稳定身份；`announced` 虽然每轮最多只从 false 变为 true 一次，却直接决定恢复后能否发解锁公告，因此落盘回执必须覆盖它。紧急权限恢复判断迟到结果是否仍属于当前意图时仍只比较 `phase` 与 `intentId`，公告落盘不应创建新的权限意图。两类指纹都不得含 `expiresAt`：`APPLYING`/`RESTORING` 阶段发布时它填的是当刻墙钟，同一份意图前后两次发布（例如公告结果落盘）就会不相等；把它算进落盘指纹，主线程「存下去 → 再看一眼还是不是同一份」的对账循环永远等不到相等，每轮一次带 fsync 的 `chat_states` 写入，发布比写盘更快时循环不终止，既写不下指纹也发不出落盘回执。

  倒计时本身照常落在镜像的 `expiresAt` 里，adopt 时据此换算剩余时长。该对账循环另有轮次上限兜底；持久化在途期间到达的新事件会置位待续跑标记，用尽后当前任务只留下错误日志并让出微任务，随后自动以最新镜像开启新任务，不得依赖下一条外部 lockdown 事件补回最后一次唤醒。
- Worker 放弃自愈后，主线程的 `recoverAbandonedLockdowns` 按插入顺序直接遍历群状态热读副本（`cache/main/chatState.ts` 的 `Map`），不取快照。恢复链在第一次 `await` 之前同步读取当前这一条，`Map.get` 不改变迭代顺序，因此每个带 lockdown 的群只产出一次，接管日志里每群也只列一次；同一群的恢复已在册时，`startEmergencyLockdownRecovery` 按指纹直接返回。
- 当前 lockdown 镜像要求 `phase` 与正数 `intentId`；待验证 active 记录要求 `phase` 与 `trackedMessageTimes`。reminder ID 与 `announcementMessageId` 仍是业务可选字段：缺失只表示提醒尚未成功落地、或这条记录压根没观测到入群公告，恢复后各走自己的补发/清理路径。其它缺失或不兼容字段必须在旧进程停止期间人工迁移，生产读取路径不保留兼容逻辑。
- **终态播报的三个标志均须持久化**：`successNoticeSent` 表示成功战报，`failureNoticeSent` 表示无法踢人或缺少 `can_restrict_members`，`unconfirmedNoticeSent` 表示无法确认成员或群类型。三类提示均在发送成功后由主线程于 30 秒后删除。各标志独立阻止对应播报在 Worker 重建或进程重启后重复发送，不能互相替代；设置标志须发布新 revision，并由终态重试等待该 revision 的持久化确认。

  **踢成功、成功战报却没发出去时不得结算**：结算等于删记录，群里看着一个成员凭空消失，而那句唯一的说明再也没有第二次机会。这一路要先把 `removalConfirmed` 写进快照再退避重试——它同样必须持久化，否则下一轮的成员探测只会答「人已经不在群里」，终态按「别人处置的」静默结算，等于把战报永久吞掉。它只在战报发送失败时才写，正常一轮里踢人与战报同轮结算，不多付一次落盘。
- **「确证没有封禁权限就不再发请求」这道短路要以清理已经清完为前提**（`cleanupSettled`）。只认 `failureNoticeSent` 的话，一条因为网络抖动删失败过的验证公告会就此定格：此后每轮都在短路处返回，那段清理代码再也不会执行，群里于是永远挂着一条带可点击验证按钮的公告，而对应的成员根本没被踢走。清理还欠账时照常走完整条处置——踢人被 `canRestrict` 短路、战报被 `failureNoticeSent` 短路，确证没有 `can_delete_messages` 时删除也被镜像短路，因此「一个请求都不发」这条性质仍然成立。这个标志与 `executionStarted` 同属 **Worker 本地幂等门、不进快照**：重放一次删除是幂等的，重发一条战报不是。

<p align="right"><a href="04-invariants.md#快速导航">↑ 返回快速导航</a></p>
