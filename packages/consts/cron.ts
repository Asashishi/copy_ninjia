import type { CronAllChats, CronExceptChats } from "../types/cron";
import { DAY_MS } from "./time";

/**
 * cron.json 任务 `chat_id` 数组的「所有群」写法，属 packages/config/cron.ts：
 * 写成 `["all"]` 时每一轮向所有已启用、且机器人此刻能发出全部动作的群逐个发送。
 */
export const CRON_ALL_CHATS: CronAllChats = "all";

/**
 * cron.json 任务 `chat_id` 数组的「排除」写法，属 packages/config/cron.ts：
 * 首项写成 `"except"` 时，其余会话 id 从「所有已启用、且机器人此刻能发出全部动作的群」里剔除。
 */
export const CRON_EXCEPT_CHATS: CronExceptChats = "except";

/**
 * 单个任务 `chat_id` 数组里最多的会话 id，属 packages/config/cron.ts；超出拒绝整份文件。
 * 逐个列出与 `"except"` 排除共用这一个上限，限定一轮要遍历的会话数。
 */
export const CRON_MAX_CHAT_IDS_PER_TASK: number = 64;

/** cron.json 最多的任务数，属 packages/config/cron.ts；超出拒绝整份文件，同时给调度表定容量。 */
export const CRON_MAX_TASKS: number = 128;

/** 单个任务最多的动作数，属 packages/config/cron.ts；超出拒绝整份文件，限定一轮的长度。 */
export const CRON_MAX_ACTIONS_PER_TASK: number = 16;

/** 任务名（任务身份）的最大 UTF-16 长度，属 packages/config/cron.ts；限定 just_once 记录的单条大小。 */
export const CRON_TASK_NAME_MAX_CHARS: number = 64;

/** `rand_cron` 区间允许的最小等待毫秒数，属 packages/config/cron.ts。 */
export const CRON_RANDOM_INTERVAL_MIN_MS: number = 60_000;

/** `rand_cron` 区间允许的最大等待毫秒数，属 packages/config/cron.ts。 */
export const CRON_RANDOM_INTERVAL_MAX_MS: number = 24 * DAY_MS;

/**
 * cron 表达式的时间粒度（一分钟）毫秒数，属 packages/cron/scheduler.ts：`rand_cron` 的随机
 * 时刻向上取整到它的整数倍，再写成只匹配那一分钟的表达式。
 */
export const CRON_MINUTE_MS: number = 60_000;

/**
 * `rand_cron` 随机时刻所注册的一次性 cron 的时区，属 packages/cron/scheduler.ts；表达式按
 * UTC 字段写出，与任务自己的 `time_zone` 无关。
 */
export const CRON_RANDOM_FIRE_TIME_ZONE: string = "UTC";

/**
 * `chat_id: ["all"]` 交给目标解析的空排除表，属 packages/cron/run.ts；
 * 只有 `["except", ...]` 才带排除名单；本常量是共用的空排除表。
 */
export const CRON_NO_EXCLUDED_CHAT_IDS: readonly number[] = [];

/** 同一轮里相邻两个动作之间的间隔，属 packages/cron/run.ts。 */
export const CRON_ACTION_GAP_MS: number = 1_000;

/**
 * 单个动作可重试失败后的退避序列，属 packages/cron/run.ts；长度即最多重试次数，
 * 每次重试仍经同一出站边界。
 */
export const CRON_ACTION_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000];

/**
 * just_once 执行记录（任务名）的 LRU 上限，属 cron/scheduler.ts（创建 cache/main/cron.ts 里运行时的 justOnceRecords）；当前配置里的任务
 * 每次对账都会刷新自己的记录，淘汰只落在早已删除的旧名字上。
 */
export const CRON_JUST_ONCE_RECORD_MAX: number = 1_024;

/** cron.json 单个任务对象允许的键，属 packages/config/cron.ts；出现其它键即拒绝整份文件。 */
export const CRON_TASK_KEYS: readonly string[] = [
  "name",
  "chat_id",
  "cron",
  "time_zone",
  "rand_cron",
  "just_once",
  "actions",
];

/** cron 单次图片动作的图片数上限，等于 Telegram 相册容量，不拆分发送。 */
export const CRON_MAX_IMAGES: number = 10;
