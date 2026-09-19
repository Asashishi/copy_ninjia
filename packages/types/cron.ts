import type { LruCache } from "../libs/lruCache";

/** 图片或文件的来源：交给 Telegram 拉取的地址，或本机任意绝对路径的文件。 */
export type CronFileSource =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "path"; readonly path: string };

/**
 * `send_image` 的来源；`random` 从目录均匀抽一张（infra/randomImage.ts）。
 * `directory` 为 null 表示用 state 的随机图片目录（getRandomImageDirectory）。
 */
export type CronImageSource =
  | CronFileSource
  | { readonly kind: "random"; readonly directory: string | null };

/** cron.json 的一个动作；`content` 缺省为 undefined（图片与文件不带附加文字）。 */
export type CronAction =
  | { readonly type: "send_message"; readonly content: string }
  | { readonly type: "send_image"; readonly content: string | undefined; readonly source: CronImageSource }
  | { readonly type: "send_file"; readonly content: string | undefined; readonly source: CronFileSource };

/** 任务 `chat_id` 的「所有群」写法（consts/cron.ts 的 CRON_ALL_CHATS）。 */
export type CronAllChats = "all";

/** `rand_cron` 区间：每轮结束后在 [minMs, maxMs] 内均匀随机等待。 */
export interface CronRandomInterval {
  readonly minMs: number;
  readonly maxMs: number;
}

/**
 * 严格解析后的一个定时任务（packages/config/cron.ts）。字段固定、一次写齐，可选项缺省
 * 为 undefined；热重载按 `name` 与深相等判断任务是否变化。
 */
export interface CronTask {
  readonly name: string;
  /** 目标会话 id；`"all"`（CRON_ALL_CHATS）表示所有能发送的已启用群。 */
  readonly chatId: number | CronAllChats;
  readonly cron: string;
  readonly timeZone: string;
  readonly randomInterval: CronRandomInterval | undefined;
  readonly justOnce: boolean;
  readonly actions: readonly Readonly<CronAction>[];
}

/** 整份 cron.json；空数组与文件缺省等价。 */
export type CronConfig = readonly Readonly<CronTask>[];

/** 一个任务的调度句柄（cache/main/cron.ts）。 */
export interface CronTaskSchedule {
  readonly task: Readonly<CronTask>;
  /** 按 `cron` 表达式触发的 Bun 原生任务；just_once 或 rand_cron 首次触发后置 null。 */
  job: Bun.CronJob | null;
  /** rand_cron 的下一次随机等待。 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 已被对账撤销或停机关闭；在途一轮在下一个动作或下一次重试前据此停下。 */
  cancelled: boolean;
}

/** cron 调度器的主线程运行时（cache/main/cron.ts）。 */
export interface CronRuntime {
  accepting: boolean;
  /** 停机超时时取消在途请求与等待。 */
  readonly controller: AbortController;
  readonly schedules: Map<string, CronTaskSchedule>;
  /** 在途的轮次；结算自摘除。 */
  readonly runs: Set<Promise<void>>;
  /** 已执行过的 just_once 任务名。 */
  readonly justOnceRecords: LruCache<string, true>;
}

/** 一个任务的动作需要哪几类发送权限（packages/cron/targets.ts）。 */
export interface CronSendNeeds {
  readonly text: boolean;
  readonly photos: boolean;
  readonly documents: boolean;
}

/**
 * `chat_id: "all"` 一轮的投递目标（packages/cron/targets.ts）：按 chat id 升序的可发送群，
 * 以及因缺权限或查询失败被跳过的群数。
 */
export interface CronGroupTargets {
  readonly chatIds: readonly number[];
  readonly skipped: number;
}

/** 一次动作投递的结果（packages/cron/delivery.ts），决定是否重试。 */
export type CronDeliveryOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "retryable"; readonly detail: string }
  | { readonly kind: "permanent"; readonly detail: string }
  | { readonly kind: "aborted" };
