import { diskIORuntime } from "../../cache/main/diskIO";
import type {
  DiskIORespawnListener,
  DiskIORespawnRegistration,
} from "../../types/diskIO/messages";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
  IdentityStoragePersistedReply,
  LuckAppendStalledReply,
  VerificationPersistedReply,
} from "../../types/diskIO/replies";

/**
 * 注册一个恢复 listener：diskIOWorker 崩溃重建后调用，用于把主线程侧的镜像
 * 重新投递给新实例。listener 必须等待本领域全部异步工作并明确返回成败；普通
 * postDiskIO 会进入恢复缓冲，镜像重放只能使用传入的 scoped transport。
 */
export function onDiskIORespawn(
  owner: string,
  priority: number,
  listener: DiskIORespawnListener
): void {
  if (owner.length === 0) throw new RangeError("Disk I/O respawn listener owner must not be empty.");
  if (!Number.isSafeInteger(priority)) {
    throw new RangeError("Disk I/O respawn listener priority must be a safe integer.");
  }
  if (diskIORuntime.respawnListeners.some(
    (registration: DiskIORespawnRegistration): boolean => registration.owner === owner
  )) {
    throw new Error(`Disk I/O respawn listener owner ${owner} is already registered.`);
  }
  const insertionIndex: number = diskIORuntime.respawnListeners.findIndex(
    (registration: DiskIORespawnRegistration): boolean => registration.priority > priority ||
      (registration.priority === priority && registration.owner.localeCompare(owner) > 0)
  );
  const registration: DiskIORespawnRegistration = { owner, priority, listener };
  if (insertionIndex === -1) {
    diskIORuntime.respawnListeners.push(registration);
    return;
  }
  diskIORuntime.respawnListeners.splice(insertionIndex, 0, registration);
}

/** 注册待验证增量 JSON 真正写入后的确认回调。 */
export function onVerificationPersisted(callback: (reply: VerificationPersistedReply) => void): void {
  diskIORuntime.verificationPersistedListeners.push(callback);
}

/** 注册 AI 记忆删除真正 durable（或被更新 revision 覆盖）的确认回调。 */
export function onAiMemoryDeletedPersisted(callback: (reply: AiMemoryDeletedPersistedReply) => void): void {
  diskIORuntime.aiMemoryDeletedPersistedListeners.push(callback);
}

/** 注册 purge 后首份新 AI 记忆真正 durable 的确认回调。 */
export function onAiMemoryPersisted(callback: (reply: AiMemoryPersistedReply) => void): void {
  diskIORuntime.aiMemoryPersistedListeners.push(callback);
}

/** Worker 耗尽重启预算后通知仍在等待 durable 回执的 owner 立即按失败结算。 */
export function onDiskIOGiveUp(callback: () => void): void {
  diskIORuntime.giveUpListeners.push(callback);
}

/** 注册当日运势追加连续失败到阈值后的领域诊断回调。 */
export function onLuckAppendStalled(callback: (reply: LuckAppendStalledReply) => void): void {
  diskIORuntime.luckAppendStalledListeners.push(callback);
}

/** 注册 SQLite 事务 ACK；各 owner 只消费自己的 revision。 */
export function onIdentityStoragePersisted(
  callback: (reply: IdentityStoragePersistedReply) => void
): void {
  diskIORuntime.identityStoragePersistedListeners.push(callback);
}
