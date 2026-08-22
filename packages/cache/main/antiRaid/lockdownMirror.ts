import type {
  EmergencyLockdownRecovery,
  PersistedLockdownFingerprint,
} from "../../../types/antiRaid/internal";

/**
 * 私密模式的主线程侧镜像与紧急恢复状态（owner 是
 * packages/antiRaid/lockdownMirror.ts，落盘对账循环在 packages/antiRaid/workerBridge.ts
 * 的 persistCurrentLockdown）。
 *
 * 这里全是**主线程**状态，与 cache/workers/antiRaid/lockdown.ts 那份入群守卫线程的
 * lockdown 状态机没有任何共享：真正的私密模式状态在 ChatState.lockdown
 * （stateStore 持有），本模块只记「哪一份意图已经确认落盘」。
 */

/**
 * 主线程判断 lockdown 落盘回执是否仍对应当前意图的指纹。
 *
 * 只由 `phase` + `intentId` 组成——它们才是一次锁定意图的身份。刻意**不含**
 * `expiresAt`：`APPLYING`/`RESTORING` 阶段发布时它填的是当刻墙钟（见
 * workers/antiRaid/lockdownRuntime.ts 的 publishLockdownState），同一份意图前后
 * 两次发布就会不相等。把它算进指纹，antiRaid/workerBridge.ts 的对账循环就永远
 * 等不到一次「存下去的还是当前这份」——每轮都要等待 SQLite 精确事务 ACK；发布
 * 比 ACK 更快时循环不终止，既写不下指纹也发不出 lockdownPersisted。
 * 倒计时本身照常落在 ChatState.lockdown.expiresAt 里，adopt 时按它换算剩余时长。
 */
/**
 * 记录某群当前 lockdown 记录是否已确认落盘，而非 lockdown 本身——真正的
 * 私密模式状态在 ChatState.lockdown（stateStore 持有）。initAntiRaid 启动时
 * 先清空，再用已加载的 SQLite 记录播种（能载入即视为上次已持久化）；
 * Worker 报告新的 lockdown 持久化事实或 unlock（onEvent）时先删除旧指纹，
 * persistCurrentLockdown 待 SQLite ACK 成功且记录未被更新覆盖后才重新写入
 * 并通知 Worker；主线程紧急恢复权限成功后同样删除。仅供
 * antiRaid/lockdownMirror.ts 构建 adopt 消息时判断某条记录是否已知持久化。
 */
export const persistedLockdownFingerprints: Map<number, PersistedLockdownFingerprint> = new Map();

/** 每群至多保留一个 durability waiter；期间的新阶段由完成后的循环补写。 */
export const pendingLockdownPersistence: Set<number> = new Set();

/**
 * 在某群 SQLite barrier 等待期间到达的新 lockdown 事件。每轮读取最终值前消费一次；
 * 最后一轮或同指纹倒计时刷新留下的标记会在当前任务 finally 后触发下一任务。
 */
export const queuedLockdownPersistence: Set<number> = new Set();

/** Worker 放弃自愈后，主线程每群至多持有一条权限恢复链。 */
export const emergencyLockdownRecoveries: Map<number, EmergencyLockdownRecovery> = new Map();

/** terminate 关闸后，迟到 API 结果不得修改 state 或重新挂 timer。 */
export const emergencyLockdownRecoveryRuntime: { stopped: boolean } = { stopped: true };
