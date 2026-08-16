/** 单次 update 等待 Anti-Raid mailbox 处理到 barrier 的最长时间。 */
export const ANTI_RAID_BARRIER_TIMEOUT_MS: number = 3_000;

/**
 * 停机时 Anti-Raid 完成业务取消、持久化对账与收尾删除的总预算。
 * 保留 15 秒让正常 Telegram 往返与最多五轮对账收敛，但绝不跟随 SDK 的分钟级
 * 网络超时；业务请求由 Worker 双工生命周期信号主动取消。
 * 所属模块：antiRaid/durableDelivery.ts。
 */
export const ANTI_RAID_DRAIN_TIMEOUT_MS: number = 15_000;

/**
 * 停机 drain 在「落盘镜像 → Worker 执行副作用 → 发布新镜像」之间最多对账轮数。
 * 状态机阶段有限，正常一至两轮收敛；上限防止异常状态永久阻塞停机。
 * 所属模块：antiRaid/workerBridge.ts。
 */
export const ANTI_RAID_DRAIN_MAX_ROUNDS: number = 5;

/**
 * lockdown 意图落盘时，「存下去 → 再看一眼还是不是同一份」的对账最多重来几轮。
 *
 * 正常情况下一轮就够：指纹只含 phase、intentId 与单向变化一次的 announced，
 * 重来意味着恢复语义真的推进，而高频倒计时不参与。这道闸是兜底——每一轮都是
 * 一次带 fsync 的 SQLite 事务和精确 ACK，绝不能让主线程陷在里面出不来。
 * 用尽只是这个群的当前任务暂停并留下一行错误日志；期间已到达的新事件会续跑
 * 一个新任务。
 * 所属模块：antiRaid/workerBridge.ts。
 */
export const LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS: number = 5;
