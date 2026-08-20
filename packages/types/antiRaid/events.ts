import type { ChatPermissions } from "@grammyjs/types";
import type { LockdownPhase } from "../chatState";
import type { AdDetectedEvent } from "./adDetect";
import type {
  DeferredVerificationRecord,
  VerificationSnapshot,
} from "./verification";

/** Worker -> 主线程：一批黑名单处置已经走完。 */
export interface BlockedMembersRemovedEvent {
  type: "blockedMembersRemoved";
  chatId: number;
  removalId: number;
  /** 每个 id 都已确定结局时才为 true。 */
  complete: boolean;
  /** 没落定的原因里包含机器人权限不足。 */
  permissionDenied?: boolean;
  /** 批次里有目标因自身管理员身份未被移除。 */
  targetIsAdmin?: boolean;
}

/** Worker -> 主线程：写入 lockdown 非 idle 阶段。 */
export interface LockdownEvent {
  type: "lockdown";
  chatId: number;
  phase: LockdownPhase;
  intentId: number;
  originalPermissions: ChatPermissions;
  announced: boolean;
  expiresAt: number;
}

/** Worker -> 主线程：某群的私密模式已解除。 */
export interface UnlockEvent {
  type: "unlock";
  chatId: number;
}

/** Worker -> 主线程：新增或更新一条仍待验证的纯数据记录。 */
export interface VerificationUpsertEvent {
  type: "verificationUpsert";
  record: VerificationSnapshot;
}

/** Worker -> 主线程：验证已终结。 */
export interface VerificationDeleteEvent {
  type: "verificationDelete";
  chatId: number;
  userId: number;
  generation: number;
  revision: number;
}

/** Worker -> 主线程：预算耗尽，仅卸载运行态并保留磁盘终态。 */
export interface VerificationDeferredEvent {
  type: "verificationDeferred";
  record: DeferredVerificationRecord;
}

/** Worker -> 主线程：barrier 之前的消息均已完成同步路由和镜像发布。 */
export interface AntiRaidBarrierCompleteEvent {
  type: "barrierComplete";
  barrierId: number;
}

/** Worker -> 主线程：drain 之前启动的异步副作用均已结算。 */
export interface AntiRaidDrainCompleteEvent {
  type: "drainComplete";
  drainId: number;
}

/** Anti-Raid Worker 发回主线程的完整事件协议。 */
export type AntiRaidWorkerEvent =
  | LockdownEvent
  | UnlockEvent
  | VerificationUpsertEvent
  | VerificationDeleteEvent
  | VerificationDeferredEvent
  | BlockedMembersRemovedEvent
  | AdDetectedEvent
  | AntiRaidBarrierCompleteEvent
  | AntiRaidDrainCompleteEvent;
