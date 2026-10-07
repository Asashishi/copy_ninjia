import type { ChatPermissions } from "grammy/types";
import { DATABASE_DIR_NAME, GLOBAL_STATE_DIR_NAME, LOGS_DIR_NAME, MEMORY_DIR_NAME } from "./dataRootLayout";
import { exhaustiveList } from "./exhaustiveList";

/** 全局状态持久化、实例锁、数据根预检与群状态存储（packages/infra/storage/ 等）的常量。文件路径见 paths.ts。 */

// DEFAULT_CHAT_STATE 与 createChatState() 的唯一形状定义位于 libs/chatState.ts。

/** Linux boot_id 的内核格式；持久化时统一使用小写。 */
export const LINUX_BOOT_ID_PATTERN: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** guard/recovery 的进程身份格式：v2:PID:/proc starttime:boot_id。 */
export const PROCESS_IDENTITY_PATTERN: RegExp =
  /^v2:([1-9]\d*):(0|[1-9]\d*):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** bot.lock 唯一一行属主记录的格式：进程身份 + SHA-256 token 指纹；文件内容必须恰好是这一行加换行（infra/storage/instanceLock.ts）。 */
export const BOT_LOCK_LINE_PATTERN: RegExp =
  /^v2:([1-9]\d*):(0|[1-9]\d*):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{64})$/;

/** 全局状态文件后台写入失败后的退避序列；用尽后固定使用最后一档。 */
export const STATE_SAVE_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 5_000, 30_000];

/** 单份最新 state 快照的最大落盘尝试数；用尽后进入 fatal 停机路径。 */
export const STATE_SAVE_MAX_ATTEMPTS: number = STATE_SAVE_RETRY_DELAYS_MS.length + 1;

/**
 * 全局状态文件后台写入（不等待落盘的 save）的合并窗口：从首个未落盘变化计时，到期
 * 写出窗口内的最新值；等待落盘的写入与停机 flush 立即写出并取消该窗口。
 * 所属模块：infra/storage/statePersistence.ts。
 */
export const STATE_BACKGROUND_SAVE_DELAY_MS: number = 5_000;

/**
 * 本机器人同时接管的最大群数。它是启动期和运行期均不可放宽的容量不变量；
 * 超出时必须由部署方删除不再管理的群后重新启动。
 *
 * 这一个数同时封住两处存储和一道命令闸，改动必须同批复核：
 * - SQLite `chat_states`：主线程热读副本的容量上界与建新记录的硬闸
 *   （cache/main/chatState.ts、infra/chatStateStorage.ts 的 assertChatStateCapacity），
 *   以及启动期的行数校验（database/validation/storageRows.ts）。按群翻译会话保存在
 *   同一行里，translate/state.ts 新建群状态前按同一上限判定。
 * - `memory/wed/`：每群成员快照的文件数上限（workers/diskIO/wedMemberFiles.ts）。
 * - `/init enable`：接管一个新群前的名额判定（commands/init.ts）。
 *
 * 群问答（cache/main/qa.ts）与 wed 成员表（cache/main/wedMembers.ts）不单独设界，
 * 它们的容量由「受管群数 × 每群上限」推出，因此同样依赖这个常量。
 */
export const STATE_MANAGED_CHAT_LIMIT: number = 25;

/**
 * 显式配置的数据根允许的最大 Unix 权限：owner 可读写遍历，group 与 other 只读
 * 遍历。现有目录只能比它更严格，启动预检不 chmod。
 *
 * 这道闸只拦**写**：group 或 other 拿到 w 位一律拒绝启动；读侧按单租户部署基线放开。
 *
 * `memory/` 下的文件权限见 docs/cn/07-operations.md，群聊逐字记录的读取边界由数据根目录权限
 * 提供，同机本地账号可读。多租户或有非特权登录用户的机器上，部署方须自行把数据根收得更严，
 * 预检只保证不比本值更宽。`database/` 走 IDENTITY_DATABASE_DIRECTORY_MODE。
 */
export const RUNTIME_DATA_ROOT_MAX_MODE: number = 0o755;

/**
 * 数据根下承载敏感运行时文件的目录，按创建顺序排列（父目录在前）。显式数据根预检会
 * 提前建立并验证这些边界；更深层文件的权限不能绕过这些目录的权限。
 * `memory/global` 是主线程独占的全局状态目录，其余 memory/ 子目录归 Disk I/O Worker。
 */
export const RUNTIME_SENSITIVE_DIRECTORY_NAMES: readonly string[] = [
  LOGS_DIR_NAME,
  MEMORY_DIR_NAME,
  `${MEMORY_DIR_NAME}/${GLOBAL_STATE_DIR_NAME}`,
  DATABASE_DIR_NAME,
];

/** SQLite 群状态中允许持久化的 Telegram 群权限字段全集。 */
export const CHAT_PERMISSION_KEYS: readonly (keyof ChatPermissions)[] = exhaustiveList<keyof ChatPermissions>()([
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

/** 存储候选文件名中的 owner PID 与 UUID 格式。 */
export const CANDIDATE_OWNER_PID_PATTERN: RegExp =
  /\.guard\.candidate\.([1-9]\d*)\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
