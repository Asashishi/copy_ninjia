/** /block 黑名单的跨模块契约。 */

import type { BLOCKLIST_REMOVAL_FAILURE_TYPES } from "../consts/antiRaid/blocklist";

/**
 * BlockedMemberRemover 的入参，也是投给 Worker 的 wire 形态。
 *
 * 投递出去的批次一定带着一份具体名单，`userIds` 必填。补扫在 outbox 里不冻结名单
 * （见 PendingBlockedRemovalParams），投递或重放时按当时的黑名单现算。
 */
export interface RemoveBlockedMembersParams {
  /** 要清理的群。 */
  chatId: number;
  /** 待处置的 id；正数是用户，负数是频道马甲（没有「成员」概念，直接封发言权）。 */
  userIds: number[];
  /**
   * true 表示这批只是名单快照、不确定人在不在群里（新晋管理员后的补扫），
   * 执行侧必须先逐个探一次成员身份；false 表示人此刻确定在群里，直接封。
   */
  probeMembership: boolean;
  /**
   * 本批处置的幂等编号。主线程按它保留镜像，Worker 处置完回执后才销账；
   * Worker 崩溃重建时未销账的批次整批重投（见 cache/main/blocklist.ts）。
   */
  removalId: number;
  /**
   * 入群那一刻的时间戳，只有秒踢路径有。Worker 用它补记一次入群计数，计入反刷群窗口。
   */
  joinedAt?: number;
  /**
   * 入群服务消息 id，只有秒踢路径且群没隐藏入群消息时有；处置落地后一并删除。
   */
  announcementMessageId?: number;
}

/**
 * outbox 里持久化并镜像的任务参数，按 `probeMembership` 区分形态。
 *
 * 补扫（`probeMembership: true`）不带 `userIds`：投递与重放按页从 Disk I/O 边界读取
 * 当时的黑名单，`pending_blocked_removals` 里补扫行的大小不随黑名单长度增长；
 * `forgetUserBlocklistRemovals` 不改写补扫行，只在黑名单清空时整条删除。
 * 约束全文见 docs/cn/04-invariants.md。
 *
 * 秒踢与广告处置（`probeMembership: false`）的名单随任务冻结，是投递时确定在群里的
 * 那几个，与黑名单当前内容无关。
 */
export type PendingBlockedRemovalParams =
  | {
    readonly chatId: number;
    readonly probeMembership: true;
    readonly removalId: number;
  }
  | {
    readonly chatId: number;
    readonly probeMembership: false;
    readonly userIds: number[];
    readonly removalId: number;
    readonly joinedAt?: number;
    readonly announcementMessageId?: number;
  };

/**
 * trackBlockedRemoval 的入参；判别联合：补扫不带 `userIds`，秒踢与广告处置必带 `userIds`。
 */
export type TrackBlockedRemovalInput =
  | { readonly chatId: number; readonly probeMembership: true }
  | {
    readonly chatId: number;
    readonly probeMembership: false;
    readonly userIds: number[];
    readonly joinedAt?: number;
    readonly announcementMessageId?: number;
  };

/** durable outbox 最近一次已知失败所处的边界。 */
export type BlocklistRemovalFailure =
  (typeof BLOCKLIST_REMOVAL_FAILURE_TYPES)[number];

/**
 * 镜像里的一条在途批次。attempts 记的是「已经确认没能落地的次数」；诊断
 * 元数据随任务一起持久化，但任务必须保留到完成或被权威状态判定为不再需要。
 */
export interface PendingBlockedRemoval {
  /** 任务参数；补扫不含名单，投递前由 materializeRemovalParams 现算。 */
  params: PendingBlockedRemovalParams;
  /** 首次登记任务的 Unix 毫秒时间戳；重放和更新诊断信息时保持不变。 */
  createdAt: number;
  /** 已确认未落地的次数；达到阈值会告警，但不会删除任务。 */
  attempts: number;
  /** 最近一次已知失败分类；尚未观测到失败时为 null。 */
  lastFailure: BlocklistRemovalFailure | null;
}

/** 单个群的黑名单补扫进度。 */
export interface BlocklistSweepRecord {
  /** 在途批次的编号；null 表示当前没有批次在跑。 */
  removalId: number | null;
  /** 已完整扫过一次的时刻；null 表示还没扫成功过，仍欠这个群一次。 */
  sweptAt: number | null;
  /** 上一次没能全部落定后，允许再试的最早时刻。 */
  nextRetryAt: number;
  /**
   * 在途批次落定后是否必须立刻再欠一次；迟到的 complete 回执不覆盖它。
   */
  resweepRequested: boolean;
  /**
   * 连续未能全部落定的补扫次数，只用于计算退避延迟；成功回执清零，延迟达到上限后
   * 不再增长。
   */
  failedSweeps: number;
  /**
   * 是否已确认卡在机器人缺少封禁权限。置真后停止按时间重试，只能由一次确证
   * 的权限变更观测解除。
   */
  permissionBlocked: boolean;
}

/**
 * 一条补扫任务当前唯一允许在途的 SQLite 游标页。
 *
 * awaitingAck=false 表示上一页已经落定、下一页正在读取；迟到的重复回执必须忽略。
 * Worker 或进程重建时从空游标重放，重复封禁保持幂等，不持久化这个运行态游标。
 */
export interface BlocklistSweepPageState {
  readonly chatId: number;
  readonly nextCursor: number | null;
  readonly done: boolean;
  readonly awaitingAck: boolean;
}

/** 补扫调度器唯一的执行入口函数类型；init 时登记进 BlocklistSweepSchedulerState.runSweep，quiesce 时清除。 */
export type BlocklistSweepRunner = () => Promise<void>;

/** 主线程黑名单补扫最近截止时间调度器的固定容量运行态。 */
export interface BlocklistSweepSchedulerState {
  timer: ReturnType<typeof setTimeout> | null;
  scheduledAt: number | null;
  accepting: boolean;
  /** init 时登记、quiesce 时清除的唯一执行入口。 */
  runSweep: BlocklistSweepRunner | null;
}

/**
 * 把一批黑名单 id 清出某个群的执行 owner。判定在主线程做完后调用它，真正的
 * 探测与封禁由入群守卫线程执行（见 workers/antiRaid/blocklistEffects.ts）。
 * 返回只代表 Worker 已经收下这些处置，处置结果由 Worker 自己记日志。
 *
 * Worker 未收到、屏障失败或落盘失败都会向调用方抛错，抛错时 durable outbox 条目保留；
 * 它与 Telegram update 重投共同提供恢复，不能互相替代。
 *
 * @returns 真正投给 Worker 的处置条数。durable 对账（antiRaid/blocklistDelivery.ts）
 *   在 BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS 轮内未收敛时扣下整批 removeBlockedMembers，
 *   此时正常 resolve 且返回 0。调用方（infra/blocklist/sweep.ts）把 0 判成失败并推进退避。
 */
export type BlockedMemberRemover = (
  removals: readonly RemoveBlockedMembersParams[]
) => Promise<number>;
