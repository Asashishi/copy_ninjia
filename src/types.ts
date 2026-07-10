/**
 * 缓存的用户或频道信息，在内存中的 users map 里以小写 username 为键。`username`
 * 是可选的：通过回复某人消息解析出的目标（见 resolveReplyTarget）可能根本没有
 * 公开 username，这种情况下也不会被存入以 username 为键的 map。
 */
export interface CachedUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  isChannel?: boolean;
}

/** 在复读复制目标的纯文本消息前对其应用的文本变换。 */
export type CopyMode = "reverse" | "nya" | "ja";

/** 机器人的持久化状态。 */
export interface BotState {
  copiedUserId: number | null;
  isCopying: boolean;
  lastCopiedUserId?: number | null;
  lastCopyTime?: number;
  copiedIsChannel?: boolean;
  copyMode?: CopyMode;
}

/** users.json 的结构：冷却时间戳和当前正在被复制的目标。 */
export interface UsersFileSchema {
  lastCopyTime: number;
  copiedUser: CachedUser | null;
}

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
}
