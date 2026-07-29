import type { ChatPermissions } from "@grammyjs/types";
import type { ChatState } from "../types/chatState";

/** 状态持久化（packages/infra/storage/stateStore.ts）的常量。文件路径见 paths.ts。 */

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
export const STATE_SAVE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([250, 1_000, 5_000, 30_000]);

/** 单份最新 state 快照的最大落盘尝试数；用尽后进入 fatal 停机路径。 */
export const STATE_SAVE_MAX_ATTEMPTS: number = STATE_SAVE_RETRY_DELAYS_MS.length + 1;

/**
 * 显式配置的数据根允许的最大 Unix 权限：owner 可读写遍历、group 只读遍历、
 * other 无权访问。现有目录只能比它更严格，启动预检不会擅自 chmod。
 */
export const RUNTIME_DATA_ROOT_MAX_MODE: number = 0o750;

/**
 * 数据根下承载敏感运行时文件的顶层目录。显式数据根预检会提前建立并验证
 * 这些边界；更深层文件即使是 0644，也不能绕过顶层目录权限。
 */
export const RUNTIME_SENSITIVE_DIRECTORY_NAMES: readonly string[] = Object.freeze([
  "logs",
  "memory",
]);

/** state.json 中允许持久化的 Telegram 群权限字段全集。 */
export const CHAT_PERMISSION_KEYS: readonly (keyof ChatPermissions)[] = Object.freeze([
  "can_send_messages",
  "can_send_audios",
  "can_send_documents",
  "can_send_photos",
  "can_send_videos",
  "can_send_video_notes",
  "can_send_voice_notes",
  "can_send_polls",
  "can_send_other_messages",
  "can_add_web_page_previews",
  "can_react_to_messages",
  "can_change_info",
  "can_invite_users",
  "can_edit_tag",
  "can_pin_messages",
  "can_manage_topics",
]);
