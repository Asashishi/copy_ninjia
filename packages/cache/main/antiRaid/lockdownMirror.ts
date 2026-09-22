import type {
  EmergencyLockdownRecovery,
  PersistedLockdownFingerprint,
} from "../../../types/antiRaid/internal";

/**
 * 私密模式的主线程侧镜像与紧急恢复状态（owner 是
 * packages/antiRaid/lockdownMirror.ts，落盘对账循环在
 * packages/antiRaid/workerBridge/events.ts 的 persistCurrentLockdown）。
 *
 * 这里全是**主线程**状态，与 cache/workers/antiRaid/lockdown.ts 那份入群守卫线程的
 * lockdown 状态机没有任何共享：真正的私密模式状态在 ChatState.lockdown
 * （stateStore 持有），本模块只记「哪一份意图已经确认落盘」。
 */

/**
 * 记录某群当前 lockdown 记录是否已确认落盘，而非 lockdown 本身——真正的
 * 私密模式状态在 ChatState.lockdown（stateStore 持有）。
 *
 * 指纹由 `phase`、`intentId` 与 `announced` 组成，不含 `expiresAt`（判据见
 * types/antiRaid/internal.ts 的 PersistedLockdownFingerprint）；倒计时照常落在
 * ChatState.lockdown.expiresAt 里，adopt 时按它换算剩余时长。initAntiRaid 启动时
 * 先清空，再用已加载的 SQLite 记录播种（能载入即视为上次已持久化）；
 * Worker 报告新的 lockdown 持久化事实或 unlock（onEvent）时先删除旧指纹，
 * persistCurrentLockdown 待 SQLite ACK 成功且记录未被更新覆盖后才重新写入
 * 并通知 Worker；落盘失败且记录仍是该次意图时、主线程紧急恢复权限成功后同样
 * 删除。仅供
 * antiRaid/lockdownMirror.ts 构建 adopt 消息时判断某条记录是否已知持久化。
 *
 * 容量：每个受管群至多一项，上界 STATE_MANAGED_CHAT_LIMIT（见 consts/storage.ts）；
 * 不设淘汰——丢掉一项只会让下一轮对账多等一次 ACK，但按容量淘汰会让已确认的
 * 意图被当成未落盘反复重写。
 */
export const persistedLockdownFingerprints: Map<number, PersistedLockdownFingerprint> = new Map();

/**
 * 每群至多保留一个 durability waiter；期间的新阶段由完成后的循环补写。
 * 清理：该群的 barrier 任务 finally 时移出。容量：每个受管群至多一项，
 * 上界 STATE_MANAGED_CHAT_LIMIT。进程重启归零，未确认的意图由 SQLite 记录重建。
 */
export const pendingLockdownPersistence: Set<number> = new Set();

/**
 * 在某群 SQLite barrier 等待期间到达的新 lockdown 事件。每轮读取最终值前消费一次；
 * 最后一轮或同指纹倒计时刷新留下的标记会在当前任务 finally 后触发下一任务。
 * 清理：每轮消费时按 chatId 移出。容量与 pendingLockdownPersistence 同界，
 * 每个受管群至多一项。
 */
export const queuedLockdownPersistence: Set<number> = new Set();

/**
 * Worker 放弃自愈后，主线程每群至多持有一条权限恢复链。
 * 清理：恢复成功、显式 unlock 或 terminate 关闸时按 chatId 删除。
 * 容量：每个受管群至多一条，上界 STATE_MANAGED_CHAT_LIMIT。
 */
export const emergencyLockdownRecoveries: Map<number, EmergencyLockdownRecovery> = new Map();

/** terminate 关闸后，迟到 API 结果不得修改 state 或重新挂 timer。 */
export const emergencyLockdownRecoveryRuntime: { stopped: boolean } = { stopped: true };
