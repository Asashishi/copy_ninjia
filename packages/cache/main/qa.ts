/** Owner: 主线程。群问答的权威热缓存与 `/set_qa` 表单会话。 */

import type { QaFormSession } from "../../types/qa";

/**
 * 群 -> 问题原文 -> 答案。主线程是唯一 owner：直答路径每条群消息读它一次，
 * `/set_qa`、`/remove_qa` 写它，写完再投给 Disk I/O Worker 落盘。
 *
 * **填充**：启动时由 Disk I/O Worker 的 hydrate 结果整表灌入。
 * **清理**：`/remove_qa` 删单条；群 teardown 删整群；进程重启后从 SQLite 重建。
 * **容量**：受管群不超过 STATE_MANAGED_CHAT_LIMIT，每群不超过 CHAT_QA_MAX_PER_CHAT，
 * 因此整表恒定不超过 125 条，不需要淘汰策略。一群的最后一条被删除后外层随之
 * 移除，空 Map 不留存。
 *
 * **为什么按原文而不是归一化文本索引**：直答只认完全一致，热路径直接拿
 * `message.text` 查表即可命中，不必为每条群消息造一个归一化字符串。语义相近
 * 的提问由模型侧的 group_qa_answer 处理，不走这张表的键。
 */
export const chatQaEntries: Map<number, Map<string, string>> = new Map();

/**
 * `/set_qa` 未完成的按钮表单，**按群唯一**。
 *
 * 不按发起人索引：inline 查询永远来自真实用户账号，而匿名管理员/频道身份发出的
 * 命令在命令侧是 `sender_chat`，两个 id 对不上（见 types/qa.ts 的 QaFormSession）。
 * 「谁有资格写」改由落群那一步重新校验权限决定。
 *
 * **填充**：`/set_qa` 建立会话；同一群重开会替换掉旧的那张并清掉它的 timer。
 * **清理**：两项填齐后结算、TTL 到期、`/init disable` 或群 teardown 时清除。
 * **容量**：受管群不超过 STATE_MANAGED_CHAT_LIMIT，因此本表天然有界；
 * QA_FORM_SESSION_MAX 再兜一道，达到上限后拒绝新建而不是淘汰别人的表单。
 * **Worker 崩溃**：本表只在主线程，不受 Worker 生命周期影响；进程重启即清空，
 * 届时按钮点下去会因找不到会话被拒绝，重开一张即可。
 */
export const qaFormSessions: Map<number, QaFormSession> = new Map();

/**
 * 已投给 Disk I/O Worker 但尚未收到精确 ACK 的问答写入，按 (群, 问题) 记 revision。
 *
 * 与白名单同一套 write-through 语义：命令回执要等本领域 durable 确认，未确认的
 * 最终值留在这里，Worker 重建后按 revision 顺序重放。容量与 chatQaEntries 同阶，
 * 且每条被 ACK 后立即移除。
 */
export const unacknowledgedChatQaWrites: Map<number, Map<string, number>> = new Map();

/** 主线程为问答写入分配的单调 revision；进程内唯一，重启从 1 重新开始。 */
export const nextChatQaRevision: { current: number } = { current: 1 };

/**
 * 整表复位；不触碰 SQLite，只清进程内状态。
 *
 * **仅供测试隔离**。这里曾写着「测试与 `/init disable` 复用」，但生产里没有任何
 * 调用方，而且也不该有：`/init disable` 的语义是「本天才不再管这个群」，已登记的
 * 问答是部署方写下的配置，重新 enable 之后应当照旧生效（见 commands/qa.ts
 * 的 teardownQaInChat——它只收表单，不删问答）。真要删得走 /remove_qa。
 */
export function resetChatQaCache(): void {
  chatQaEntries.clear();
  for (const session of qaFormSessions.values()) {
    if (session.timer !== null) clearTimeout(session.timer);
  }
  qaFormSessions.clear();
  unacknowledgedChatQaWrites.clear();
  nextChatQaRevision.current = 1;
}
