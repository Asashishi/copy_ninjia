export interface RecentChannelComment {
  messageId: number;
  observedAt: number;
}

/** 评论先于入群事件到达时的短期关联缓冲，以 "chatId:userId" 为键。 */
export const recentChannelComments: Map<string, RecentChannelComment> = new Map();
