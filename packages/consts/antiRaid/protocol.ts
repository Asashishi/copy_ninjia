/** 单次 update 等待 Anti-Raid mailbox 处理到 barrier 的最长时间。 */
export const ANTI_RAID_BARRIER_TIMEOUT_MS: number = 3_000;

/**
 * lockdown 意图落盘时，「存下去 → 再看一眼还是不是同一份」的对账最多重来几轮。
 *
 * 正常情况下一轮就够：指纹只含 phase + intentId，重来意味着状态机真的推进了一个
 * 阶段，而那是事件驱动、次数有界的。这道闸是兜底——每一轮都是一次带 fsync 的
 * state.json + .bak 整文件重写，绝不能让主线程陷在里面出不来。用尽只是这个群的
 * 握手暂停并留下一行错误日志，下一条 lockdown 事件会重新进来。
 * 所属模块：antiRaid/index.ts。
 */
export const LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS: number = 5;
