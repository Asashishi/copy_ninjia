import type { LinkedQueue } from "../../libs/linkedQueue";
import type { PendingState, VerificationState } from "../states/verification";

/** 反刷群 Worker 的入群滑动计数窗口。 */
export interface JoinWindow {
  timestamps: LinkedQueue<number>;
  resetTimeout: ReturnType<typeof setTimeout>;
}

/** 某群是否有关联频道的 TTL 缓存条目。 */
export interface LinkedChannelCache {
  hasLinked: boolean;
  fetchedAt: number;
}

/** 某群管理员表的 TTL 缓存条目。 */
export interface ChatAdminCache {
  adminIds: Set<number>;
  fetchedAt: number;
}

/** 评论先于入群事件到达时暂存的最近消息。 */
export interface RecentChannelComment {
  messageId: number;
  observedAt: number;
}

/** 冷缓存楼中楼消息等待关联频道确认时的单条在途记录。 */
export interface ThreadCommentConfirmation {
  messageId: number;
  observedAt: number;
  expectedState: VerificationState | undefined;
  boundToJoin: boolean;
}

/** 验证提醒的发送形态。 */
export type ReminderKind = "original" | "reply";

/** 每名待验证成员唯一的提醒投递 owner。 */
export interface ReminderDelivery {
  key: string;
  chatId: number;
  userId: number;
  kind: ReminderKind;
  text: string;
  replyToMessageId: number | undefined;
  expectedState: PendingState;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  inFlight: boolean;
}
