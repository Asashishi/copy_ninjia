import { diskIORuntime } from "../../cache/main/diskIO";
import type {
  DiskIORespawnListener,
  DiskIORespawnRegistration,
} from "../../types/diskIO/messages";
import type { DiskIOReplyListenerMap } from "../../types/diskIO/replies";

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

/**
 * 模块初始化时登记某类 Disk I/O 回执的主线程 owner 回调；回调同步执行，只接纳
 * 结果或结算本 owner 的等待，不等待后续工作。回执语义见 types/diskIO/replies.ts
 * 的各回执类型。
 */
export function onDiskIOReply<K extends keyof DiskIOReplyListenerMap>(
  type: K,
  listener: (reply: DiskIOReplyListenerMap[K]) => void
): void {
  diskIORuntime.replyListeners[type].push(listener);
}

/** Worker 耗尽重启预算后通知仍在等待 durable 回执的 owner 立即按失败结算。 */
export function onDiskIOGiveUp(callback: () => void): void {
  diskIORuntime.giveUpListeners.push(callback);
}
