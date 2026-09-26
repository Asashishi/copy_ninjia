import type { LruCache } from "../libs/lruCache";
import type { EncodedVoiceMessage } from "./aiChat/voiceMessage";

/** send_file 的单个来源：Telegram 拉取的地址，或已按项目根解析成绝对路径的本机文件。 */
export type CronFileSource =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "path"; readonly path: string };

/**
 * `send_image` 的来源；固定图片使用 1–10 项地址或文件数组，单张也使用数组。
 * `random` 从目录均匀抽一张（infra/randomImage.ts）；directory 为 null 时使用
 * config/dynamic/assets.json 的专用图库（getAssetConfig().randomHImageDirectory），显式目录已按项目根解析为绝对路径。
 */
export type CronImageSource =
  | { readonly kind: "urls"; readonly urls: readonly string[] }
  | { readonly kind: "paths"; readonly paths: readonly string[] }
  | { readonly kind: "random"; readonly directory: string | null };

/**
 * cron.json 的一个动作；`content` 缺省为 undefined（图片与文件不带附加文字）。
 * `send_image` 的 `isBlurred` 取自 `is_blurred`，缺省 false；为 true 时给全部图片加剧透遮罩。
 * 多图共用一份 content，只作为相册首图的 caption。`send_voice` 的 content 是要念的台词、
 * tone 是拼在基础朗读风格之后的语气（缺省 undefined），两者已清洗成单行。
 */
export type CronAction =
  | { readonly type: "send_message"; readonly content: string }
  | {
    readonly type: "send_image";
    readonly content: string | undefined;
    readonly source: CronImageSource;
    readonly isBlurred: boolean;
  }
  | { readonly type: "send_file"; readonly content: string | undefined; readonly source: CronFileSource }
  | { readonly type: "send_voice"; readonly content: string; readonly tone: string | undefined };

/** 任务 `chat_id` 数组的「所有群」写法（consts/cron.ts 的 CRON_ALL_CHATS）。 */
export type CronAllChats = "all";

/** 任务 `chat_id` 数组首项的「排除」写法（consts/cron.ts 的 CRON_EXCEPT_CHATS）。 */
export type CronExceptChats = "except";

/**
 * 严格解析后的投递目标（packages/config/cron.ts 的 chat_id 数组）：
 * - `list`：按配置书写顺序列出的会话，逐个直接投递，不查发送权限；
 * - `all`：所有已启用、且机器人此刻能发出全部动作的群（packages/cron/targets.ts 现查）；
 * - `except`：口径同 `all`，但先把 `chatIds` 里的会话从候选里剔除。
 *
 * `chatIds` 在解析时已去重，`list` 与 `except` 都至少有一个 id。
 */
export type CronChatTargets =
  | { readonly kind: "list"; readonly chatIds: readonly number[] }
  | { readonly kind: "all" }
  | { readonly kind: "except"; readonly chatIds: readonly number[] };

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
  /** 本任务这一轮要投递的会话，由 `chat_id` 数组解析而来。 */
  readonly chatTargets: CronChatTargets;
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
  readonly voiceNotes: boolean;
}

/**
 * `["all"]` 与 `["except", ...]` 一轮的投递目标（packages/cron/targets.ts）：按 chat id
 * 升序的可发送群，以及因缺权限或查询失败被跳过的群数（被 `except` 剔除的群不计入）。
 */
export interface CronGroupTargets {
  readonly chatIds: readonly number[];
  readonly skipped: number;
}

/** 一轮里一个 `send_voice` 动作已合成好的语音（packages/cron/delivery.ts）。 */
export interface CronRoundVoice {
  readonly voice: EncodedVoiceMessage;
  /**
   * 本轮首次发送成功后 Telegram 交回的语音 file_id；取得前为 undefined，按字节上传。
   * 取得后本轮的后续会话与重试直接引用它，不再上传。
   */
  fileId: string | undefined;
}

/**
 * 一轮里已合成好的 `send_voice` 语音，按动作对象身份索引（packages/cron/run.ts 每轮新建、
 * 轮次结束即丢弃）。同一轮的重试与后续会话直接复用，不再重新合成；合成失败不登记。
 */
export type CronRoundVoices = Map<Readonly<CronAction>, CronRoundVoice>;

/** 一次动作投递的结果（packages/cron/delivery.ts），决定是否重试。 */
export type CronDeliveryOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "retryable"; readonly detail: string }
  | { readonly kind: "permanent"; readonly detail: string }
  | { readonly kind: "aborted" };
