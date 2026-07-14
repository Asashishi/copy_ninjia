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
 * 单个群聊的复制状态（复制目标等）。机器人可能同时在多个群里运行，
 * 每个群各自独立维护一份，互不影响——见 storage.ts 中 Map<chatId, ChatState>
 * 的用法。copy 类命令的冷却时间不在这里——见 GlobalCopyState，所有群共用一份。
 *
 * 是否在复读、复读目标是不是频道皮套，都由 copiedUser 是否非 null 及其
 * isChannel 字段推出，不再单独存 isCopying/copiedUserId/copiedIsChannel 这些
 * 本该跟 copiedUser 保持同步、实际却要靠约定维护一致的冗余字段。
 */
export interface ChatState {
  /** 本群当前正在复读的目标；null 表示没有用 /copy 类命令锁定任何人。 */
  copiedUser: CachedUser | null;
  copyMode?: CopyMode;
  /**
   * /quiet 静默期的截止时间戳（ms）。在此之前机器人不主动刷存在感（AI 随机
   * 插话、随机复读等）；被动触发（回复/@机器人）和指令不受影响。
   */
  quietUntil?: number;
}

/**
 * copy 类命令的全局冷却状态：所有群共用同一份时钟（消耗的是机器人自己头像这
 * 一份全局资源，不该按群分别计时）。
 */
export interface GlobalCopyState {
  lastCopyTime?: number;
}

/**
 * state.json 的整体结构：chats 以 chatId（字符串）为键分别保存各群聊各自的
 * ChatState；globalCopy 是所有群共用的那一份 copy 类命令冷却时钟。两者本来
 * 分属"按群"和"全局"两种不同的维度，但都只有这一份、都不需要按群拆文件，
 * 合并进同一个文件能少一次磁盘 I/O，也不用再操心多个文件之间的写入顺序。
 */
export interface StateFileSchema {
  chats: Record<string, ChatState>;
  globalCopy: GlobalCopyState;
}
