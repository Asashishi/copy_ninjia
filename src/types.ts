/**
 * Cached user or channel information, keyed by lowercase username in the
 * in-memory users map. `username` is optional: a target resolved by replying
 * to one of their messages (see resolveReplyTarget) may not have a public
 * username at all, and is never stored in the username-keyed map.
 */
export interface CachedUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  isChannel?: boolean;
}

/** Text transform applied to the copy target's plain-text messages before echoing them back. */
export type CopyMode = "reverse" | "nya" | "ja";

/** Persistent state of the bot. */
export interface BotState {
  copiedUserId: number | null;
  isCopying: boolean;
  lastCopiedUserId?: number | null;
  lastCopyTime?: number;
  copiedIsChannel?: boolean;
  copyMode?: CopyMode;
}

/** Schema of users.json: the cooldown timestamp and the currently active copy target. */
export interface UsersFileSchema {
  lastCopyTime: number;
  copiedUser: CachedUser | null;
}

/**
 * Tracks a new group member who hasn't yet sent the join-verification code.
 * In-memory only (see src/joinVerification.ts) — doesn't survive a restart.
 */
export interface PendingVerification {
  chatId: number;
  userId: number;
  /** Display label captured at join time, used in the kick announcement (the join/reminder messages that named them get deleted). */
  label: string;
  /** Message IDs to delete if the window expires: the join announcement, the reminder, and anything the user sent while pending. */
  messageIds: number[];
  timeout: ReturnType<typeof setTimeout>;
}
