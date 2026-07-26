/** /block 黑名单的跨模块契约。 */

import type { BLOCKLIST_REMOVAL_FAILURE_TYPES } from "../consts/antiRaid/blocklist";

/** BlockedMemberRemover 的入参。 */
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
   * Worker 崩溃重建时未销账的批次整批重投（见 cache/blocklist.ts）。
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

/** durable outbox 最近一次已知失败所处的边界。 */
export type BlocklistRemovalFailure =
  (typeof BLOCKLIST_REMOVAL_FAILURE_TYPES)[number];

/**
 * 镜像里的一条在途批次。attempts 记的是「已经确认没能落地的次数」；诊断
 * 元数据随任务一起持久化，但任务必须保留到完成或被权威状态判定为不再需要。
 */
export interface PendingBlockedRemoval {
  /** 原样入参，重投时直接复用。 */
  params: RemoveBlockedMembersParams;
  /** 首次登记任务的 Unix 毫秒时间戳；重放和更新诊断信息时保持不变。 */
  createdAt: number;
  /** 已确认未落地的次数；达到阈值会告警，但不会删除任务。 */
  attempts: number;
  /** 最近一次已知失败分类；尚未观测到失败时为 null。 */
  lastFailure: BlocklistRemovalFailure | null;
}

/**
 * 把一批黑名单 id 清出某个群的执行 owner。判定在主线程做完后调用它，真正的
 * 探测与封禁由入群守卫线程执行（见 workers/antiRaid/blocklistEffects.ts）。
 * 返回只代表「Worker 已经收下这些处置」，不代表踢完了——副作用按该线程的
 * 惯例事后跑，处置结果由 Worker 自己记日志。
 *
 * Worker 未收到、屏障失败或落盘失败都会向调用方抛错，但都不得销毁 durable
 * outbox 条目；它与 Telegram update 重投共同提供恢复，不能互相替代。
 */
export type BlockedMemberRemover = (
  removals: readonly RemoveBlockedMembersParams[]
) => Promise<void>;
