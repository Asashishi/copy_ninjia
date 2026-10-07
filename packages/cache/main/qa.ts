/** owner: main。群问答的权威热缓存与 `/qa set` 表单会话。 */

import type { QaFormSession, UnacknowledgedChatQaWrite } from "../../types/qa";

/**
 * 群 -> 问题原文 -> 答案。主线程是唯一 owner：infra/qaStore.ts 是唯一写入者，
 * `/qa set`、`/qa remove` 经它写入后再投给 Disk I/O Worker 落盘；直答路径
 * （auto/message/qaDirectAnswer.ts，每条群消息一次）、AI 触发载荷（aiChat/messageIngress.ts）
 * 与 `/qa` 查询/翻页（commands/qa.ts、commands/qa/board.ts）直接只读，读取点以
 * ReadonlyMap 接收，不改写内容。
 *
 * 填充：启动时由 Disk I/O Worker 的 hydrate 结果整表灌入。
 * 清理：`/qa remove` 删单条；`/init disable` 与离群的 teardown 删整群，失权停管的
 * teardown 原样保留（见 libs/chatTeardown.ts 的 purgesChatData）；进程重启后从 SQLite 重建。
 * 容量：受管群不超过 STATE_MANAGED_CHAT_LIMIT，每群不超过 CHAT_QA_MAX_PER_CHAT，
 * 整表有界，不淘汰。一群的最后一条被删除后外层随之移除，空 Map 不留存。
 *
 * 按原文索引，不做归一化：直答只认完全一致，热路径直接拿 `message.text` 查表。
 * 语义相近的提问由模型侧的 group_qa_answer 处理，不走这张表的键。
 */
export const chatQaEntries: Map<number, Map<string, string>> = new Map();

/**
 * `/qa set` 未填完的表单会话，按群索引、按发起人鉴权。
 *
 * 表里按群唯一，同一群同时只有一张；`openedById` 决定谁能往里填，投递消息的
 * 可见身份（`sender_chat ?? from`）必须与它一致。开表单时已按
 * isCanControllQaPermission 校验权限，落群时不再复查（见 types/qa.ts 的
 * QaFormSession 与 commands/qa/ingress.ts）。
 *
 * 填充：`/qa set` 建立会话。同一发起人重开会把旧的那张连同它那条表单
 * 消息一起作废、清掉 timer，从两项皆空重新开始；其他身份的 `/qa set` 由命令层
 * 当场拒绝（见 commands/qa.ts 的 handleQaCommand）。
 * 清理：两项填齐后结算、TTL 到期、`/init disable` 或群 teardown 时清除。
 * 容量：受管群不超过 STATE_MANAGED_CHAT_LIMIT；QA_FORM_SESSION_MAX 为硬顶，
 * 达到上限后拒绝新建，不淘汰已有表单。
 * Worker 崩溃：本表只在主线程，不受 Worker 生命周期影响；进程重启后为空，
 * 重启前发起的表单不再被认领。
 */
export const qaFormSessions: Map<number, QaFormSession> = new Map();

/**
 * 已投给 Disk I/O Worker 但尚未收到精确 ACK 的问答写入，按 (群, 问题) 记 revision。
 *
 * 与白名单同一套 write-through 语义：命令回执等本领域 durable 确认，未确认的
 * 最终值留在这里，Worker 重建后重放。问题、正文和墓碑在发布前共同检查
 * STORAGE_PENDING_MAX_ENTRIES / STORAGE_PENDING_MAX_BYTES；精确 ACK 后移除。
 * 容量由这两个预算封顶（外层另受受管群数约束），本表不淘汰未落盘事实。
 */
export const unacknowledgedChatQaWrites: Map<number, Map<string, UnacknowledgedChatQaWrite>> = new Map();

/**
 * 上表的总条数与准入估算字节；登记或覆盖一项时按差额更新，精确 ACK 删除该项时扣回，
 * hydrate 与 reset 清零。
 */
export const unacknowledgedChatQaTotals: { entries: number; bytes: number } = { entries: 0, bytes: 0 };

/** 主线程为问答写入分配的单调 revision；进程内唯一，重启从 1 重新开始。 */
export const nextChatQaRevision: { current: number } = { current: 1 };

/**
 * 整表复位，只清进程内状态，不触碰 SQLite；仅供测试隔离。
 * 生产侧删除问答只经 `/qa remove` 与 commands/qa.ts 的 teardownQaInChat，两者都同时投递落盘删除。
 */
export function resetChatQaCache(): void {
  chatQaEntries.clear();
  for (const session of qaFormSessions.values()) {
    if (session.timer !== null) clearTimeout(session.timer);
  }
  qaFormSessions.clear();
  unacknowledgedChatQaWrites.clear();
  unacknowledgedChatQaTotals.entries = 0;
  unacknowledgedChatQaTotals.bytes = 0;
  nextChatQaRevision.current = 1;
}
