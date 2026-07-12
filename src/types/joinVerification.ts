/**
 * 追踪一位尚未发送入群验证口令的新成员。仅存于内存中（见 src/joinVerification.ts）
 * ——不会在重启后保留。
 */
export interface PendingVerification {
  chatId: number;
  userId: number;
  /** 入群时捕获的展示用标签，用于踢人公告（提到 TA 的入群公告/提醒消息届时会被删除）。 */
  label: string;
  /** 验证窗口过期时要删除的消息 ID：入群公告、提醒消息、以及验证期间 TA 发的所有消息。 */
  messageIds: number[];
  timeout: ReturnType<typeof setTimeout>;
  /**
   * 若为 true，说明这不是真正在等待验证口令的记录，而是反防刷群私密模式下
   * 直接踢人后留下的短期占位——用于给 chat_member 更新和 new_chat_members
   * 服务消息（针对同一次入群各自触发）去重，避免重复计数/重复踢人。
   */
  kicked?: boolean;
}
