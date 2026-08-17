/** /block 黑名单的跨模块契约。 */

import type { BLOCKLIST_REMOVAL_FAILURE_TYPES } from "../consts/antiRaid/blocklist";

/**
 * BlockedMemberRemover 的入参，也是投给 Worker 的 wire 形态。
 *
 * **投递出去的批次一定带着一份具体名单**——`userIds` 在这里是必填的。补扫在
 * outbox 里不冻结名单（见 PendingBlockedRemovalParams），那一份是投递/重放的
 * 那一刻按当时的黑名单现算出来的。
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
   * 入群那一刻的时间戳，只有秒踢路径有。Worker 用它补记一次入群计数：
   * 黑名单入群不再走 join 消息，若不补记，一波以黑名单账号为主的刷群就
   * 凑不够反刷群窗口的阈值，群不会进紧急私密模式。
   */
  joinedAt?: number;
  /**
   * 入群服务消息 id，只有秒踢路径且群没隐藏入群消息时有。处置落地后一并
   * 删掉——不投 join 就没人再管这条公告了。
   */
  announcementMessageId?: number;
}

/**
 * outbox 里**持久化并镜像**的那一份任务参数，按 `probeMembership` 分成两种形态。
 *
 * 补扫（`probeMembership: true`）刻意不带 `userIds`：它欠的活是「拿黑名单把这个群
 * 扫一遍」，不是「拿这 1000 个具体 id 把这个群扫一遍」。冻一份 id 列表进来有三个
 * 坏处——
 * 1. **写盘量按群数 × 名单长度放大**：每次变更都要整份 outbox 重写，而 N 个群的
 *    补扫条目装的是同一份内容，加起来就是 O(N² × 名单长度) 的落盘，正是
 *    docs/cn/04-invariants.md 点名要避开的形态；`removals.json` 也因此成为整个持久化
 *    里唯一一个大小随黑名单长度增长的文件，而它在启动恢复的关键路径上。
 * 2. **重放时那份快照可能已经过期**：Worker 重建后重投的应该是「用**此刻**的名单
 *    扫这个群」，而不是当初那一份。
 * 3. **`/unblock` 被迫改写它**：`forgetUserBlocklistRemovals` 要把这个 id 从每一条
 *    批次里滤掉再整份重新落盘，而这件事只是因为当初冻了一份不该冻的列表。
 *
 * 秒踢与广告处置（`probeMembership: false`）相反，名单**必须**随任务冻结：那批人
 * 是「此刻确定在群里的这几个」，与名单当前内容无关，现算会扫到一群不相干的人。
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
 * trackBlockedRemoval 的入参。用判别联合而不是「userIds 可选」：补扫带上名单、
 * 或秒踢漏掉名单，都该是编译期就过不去的写法。
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
   * 在途批次落定后是否必须立刻再欠一次。显式标志避免迟到的 complete 回执
   * 把新到达的重扫请求覆盖掉。
   */
  resweepRequested: boolean;
  /**
   * 连续未能全部落定的补扫次数，只用于放大退避；成功回执清零，达到最大
   * 退避档后不再增长。
   */
  failedSweeps: number;
  /**
   * 是否已确认卡在机器人缺少封禁权限。置真后停止时间重试，只能由一次确证
   * 的权限变更观测解除，避免永久重扫和重复错误日志。
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

/** 主线程黑名单补扫最近截止时间调度器的固定容量运行态。 */
export interface BlocklistSweepSchedulerState {
  timer: ReturnType<typeof setTimeout> | null;
  scheduledAt: number | null;
  accepting: boolean;
}

/**
 * 把一批黑名单 id 清出某个群的执行 owner。判定在主线程做完后调用它，真正的
 * 探测与封禁由入群守卫线程执行（见 workers/antiRaid/blocklistEffects.ts）。
 * 返回只代表「Worker 已经收下这些处置」，不代表踢完了——副作用按该线程的
 * 惯例事后跑，处置结果由 Worker 自己记日志。
 *
 * Worker 未收到、屏障失败或落盘失败都会向调用方抛错，但都不得销毁 durable
 * outbox 条目；它与 Telegram update 重投共同提供恢复，不能互相替代。
 *
 * @returns **真正投给 Worker 的处置条数**。正常 resolve 不等于「都投出去了」：
 *   durable 对账（antiRaid/blocklistDelivery.ts）在并发 `/unblock` 反复裁剪
 *   同一批时会把整批 removeBlockedMembers 全部扣下、只留其余消息，随后 post
 *   路径以 `length === 0` 早退并正常 resolve。调用方（infra/blocklist/sweep.ts）
 *   必须据此把「一条都没投出去」判成失败并推进退避，否则 claim 里的 removalId
 *   停在原值、回执永不会来，`prepareBlocklistSweep` 对这个群永久早退——本进程
 *   生命周期内它再也不会被清扫。
 */
export type BlockedMemberRemover = (
  removals: readonly RemoveBlockedMembersParams[]
) => Promise<number>;
