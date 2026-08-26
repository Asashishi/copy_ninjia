import type { ChatPermissions } from "@grammyjs/types";

/** 状态持久化实现（packages/infra/storage/statePersistence.ts）的常量。文件路径见 paths.ts。 */

// DEFAULT_CHAT_STATE 与 createChatState() 的唯一形状定义位于 libs/chatState.ts。

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

/**
 * SQLite `chat_states` 允许管理的最大群数。它是启动期和运行期均不可放宽的
 * 容量不变量；超出时必须由部署方删除不再管理的群后重新启动。
 */
export const STATE_MANAGED_CHAT_LIMIT: number = 25;

/**
 * 显式配置的数据根允许的最大 Unix 权限：owner 可读写遍历，group 与 other 只读
 * 遍历。现有目录只能比它更严格，启动预检不会擅自 chmod。
 *
 * 这道闸拦的是**写**：group 或 other 拿到 w 位一律拒绝启动，因为那意味着别的
 * 账号能改运行状态。读侧按部署基线放开到 0755——本项目按单租户处理，绝大多数
 * 部署是 root 直接跑，而用默认 umask 建出来的目录就是 0755，卡在这里只是摩擦。
 *
 * `memory/` 下的文件本身是 0644（见 docs/cn/07-operations.md），所以群聊逐字记录
 * 的读取边界由数据根目录权限提供。0755 会允许同机本地账号读取；多租户或有非
 * 特权登录用户的机器上，
 * 部署方必须自己把数据根收回 0750——预检只保证不比这更宽，不替谁做决定。
 * `database/` 不受影响，仍走 IDENTITY_DATABASE_DIRECTORY_MODE 的 0770。
 */
export const RUNTIME_DATA_ROOT_MAX_MODE: number = 0o755;

/**
 * 数据根下承载敏感运行时文件的顶层目录。显式数据根预检会提前建立并验证
 * 这些边界；更深层文件即使是 0644，也不能绕过顶层目录权限。
 */
export const RUNTIME_SENSITIVE_DIRECTORY_NAMES: readonly string[] = [
  "logs",
  "memory",
  "database",
];

/** SQLite 群状态中允许持久化的 Telegram 群权限字段全集。 */
export const CHAT_PERMISSION_KEYS: readonly (keyof ChatPermissions)[] = [
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
];
