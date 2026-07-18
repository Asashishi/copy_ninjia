/** 早于入群更新到达、被暂存下来的评论区留言。 */
export interface RecentComment {
  messageId: number;
  /** 收到评论投递的时刻；评论先到时仍按真实消息时刻计入窗口。 */
  observedAt: number;
  /** 是否直接回复频道帖；该操作足以确证真人并豁免验证。 */
  repliesToChannelPost: boolean;
}

/** 正在等待点击验证按钮的成员。 */
export interface PendingState {
  kind: "pending";
  label: string;
  isBot: boolean;
  /** 超时踢出时要删除的入群公告、提醒和等待期间发言。 */
  messageIds: number[];
  /** 最近 JOIN_WINDOW_MS 内由该成员发送的消息时间。 */
  trackedMessageTimes: number[];
  /** 被他人拉入群时的拉人者 ID；超时前要做最终管理员核查。 */
  invitedBy?: number;
  reminderMessageId?: number;
  replyReminderMessageId?: number;
  replyReminderRequested: boolean;
  welcomeAnchorMessageId?: number;
  reminderSuperseded: boolean;
  /** 创建记录的入群时刻，也是刷群窗口中待精确撤销的时间戳。 */
  joinedAt: number;
  /** 验证结束的绝对毫秒时刻；恢复时据此重建剩余时间。 */
  expiresAt: number;
}

/** 已豁免的短期去重占位。 */
export interface ExemptState {
  kind: "exempt";
  label: string;
  isBot: boolean;
}

/** 已秒踢的短期去重占位。 */
export interface KickedState {
  kind: "kicked";
  label: string;
  isBot: boolean;
  /** 用于区分同一次入群的双路投递与真正重新入群。 */
  kickedAt: number;
}

export type VerificationState = PendingState | ExemptState | KickedState;

/** 超时流程删除状态后，供异步终核与最终清理继续使用的不可变语义快照。 */
export interface ExpelSnapshot {
  label: string;
  isBot: boolean;
  messageIds: number[];
  reminderMessageId?: number;
  replyReminderMessageId?: number;
  joinedAt: number;
}
