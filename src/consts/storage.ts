import type { ChatState } from "../types/chatState";

/** 状态持久化（src/infra/storage/stateStore.ts）的常量。文件路径见 paths.ts。 */

/**
 * 默认（空）的群聊状态，用于本群从未写过任何状态时的只读查询。
 * 冻结它：这个对象在所有没有状态的群之间共享，若有调用方误对它赋值，
 * 会静默污染所有这些群的查询结果——冻结后误写会直接抛错暴露问题。
 */
export const DEFAULT_CHAT_STATE: Readonly<ChatState> = Object.freeze({});

/** Linux boot_id 的内核格式；持久化时统一使用小写。 */
export const LINUX_BOOT_ID_PATTERN: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** guard/recovery 当前唯一格式：v2:PID:/proc starttime:boot_id。 */
export const PROCESS_IDENTITY_PATTERN: RegExp =
  /^v2:([1-9]\d*):(0|[1-9]\d*):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** bot.lock 当前唯一格式：process identity + SHA-256 token 指纹。 */
export const BOT_LOCK_LINE_PATTERN: RegExp =
  /^v2:([1-9]\d*):(0|[1-9]\d*):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{64})$/;

/** state.json 后台写入失败后的退避序列；用尽后固定使用最后一档。 */
export const STATE_SAVE_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 5_000, 30_000];

/** 单份最新 state 快照的最大落盘尝试数；用尽后进入 fatal 停机路径。 */
export const STATE_SAVE_MAX_ATTEMPTS: number = STATE_SAVE_RETRY_DELAYS_MS.length + 1;
