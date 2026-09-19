/** cron.json 任务缺省的 IANA 时区，属 packages/config/cron.ts；与 Disk I/O 每日维护一致，不继承宿主机时区。 */
export const CRON_DEFAULT_TIME_ZONE: string = "Asia/Tokyo";

/** cron.json 最多的任务数，属 packages/config/cron.ts；超出拒绝整份文件，同时给调度表定容量。 */
export const CRON_MAX_TASKS: number = 128;

/** 单个任务最多的动作数，属 packages/config/cron.ts；超出拒绝整份文件，限定一轮的长度。 */
export const CRON_MAX_ACTIONS_PER_TASK: number = 16;

/** 任务名（任务身份）的最大 UTF-16 长度，属 packages/config/cron.ts；限定 just_once 记录的单条大小。 */
export const CRON_TASK_NAME_MAX_CHARS: number = 64;

/** `rand_cron` 区间允许的最小等待毫秒数（1 分钟），属 packages/config/cron.ts。 */
export const CRON_RANDOM_INTERVAL_MIN_MS: number = 60_000;

/**
 * `rand_cron` 区间允许的最大等待毫秒数（24 天），属 packages/config/cron.ts；低于单个
 * JavaScript timer 能表达的上限（约 24.8 天），随机等待只需一个 setTimeout。
 */
export const CRON_RANDOM_INTERVAL_MAX_MS: number = 24 * 24 * 60 * 60_000;

/** 同一轮里相邻两个动作之间的间隔，属 packages/cron/run.ts。 */
export const CRON_ACTION_GAP_MS: number = 1_000;

/**
 * 单个动作可重试失败后的退避序列，属 packages/cron/run.ts；长度即最多重试次数（3 次），
 * 每次重试仍经同一出站边界。
 */
export const CRON_ACTION_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000];

/**
 * just_once 执行记录（任务名）的 LRU 上限，属 cache/main/cron.ts；当前配置里的任务
 * 每次对账都会刷新自己的记录，淘汰只落在早已删除的旧名字上。
 */
export const CRON_JUST_ONCE_RECORD_MAX: number = 1_024;

/** cron.json 单个任务对象允许的键，属 packages/config/cron.ts；出现其它键即拒绝整份文件。 */
export const CRON_TASK_KEYS: readonly string[] = [
  "name",
  "chat_id",
  "message_thread_id",
  "cron",
  "tz",
  "rand_cron",
  "just_once",
  "actions",
];
