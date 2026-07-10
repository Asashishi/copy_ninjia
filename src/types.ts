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

/**
 * 单个群聊的复制状态（复制目标、冷却时间等）。机器人可能同时在多个群里运行，
 * 每个群各自独立维护一份，互不影响——见 storage.ts 中 Map<chatId, ChatState>
 * 的用法。
 */
export interface ChatState {
  copiedUserId: number | null;
  isCopying: boolean;
  lastCopiedUserId?: number | null;
  lastCopyTime?: number;
  copiedIsChannel?: boolean;
  copyMode?: CopyMode;
}

/** state.json 的结构：以 chatId（字符串）为键，分别保存各群聊各自的 ChatState。 */
export type ChatStateFileSchema = Record<string, ChatState>;

/** users.json 中单个群聊的记录：该群的冷却时间戳和当前正在被复制的目标。 */
export interface ChatUsersEntry {
  lastCopyTime: number;
  copiedUser: CachedUser | null;
}

/** users.json 的结构：以 chatId（字符串）为键，分别保存各群聊各自的记录。 */
export type UsersFileSchema = Record<string, ChatUsersEntry>;

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
