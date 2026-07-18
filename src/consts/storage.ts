import type { ChatState } from "../types/chatState";

/** 状态持久化（src/infra/storage.ts）的常量。文件路径见 paths.ts。 */

/**
 * 默认（空）的群聊状态，用于本群从未写过任何状态时的只读查询。
 * 冻结它：这个对象在所有没有状态的群之间共享，若有调用方误对它赋值，
 * 会静默污染所有这些群的查询结果——冻结后误写会直接抛错暴露问题。
 */
export const DEFAULT_CHAT_STATE: Readonly<ChatState> = Object.freeze({});

/** bot.lock 每行的持久化格式：PID + SHA-256 token 指纹。 */
export const BOT_LOCK_LINE_PATTERN: RegExp = /^([1-9]\d*):([0-9a-f]{64})$/;

/** state.json 后台写入失败后的退避序列；用尽后固定使用最后一档。 */
export const STATE_SAVE_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 5_000, 30_000];
