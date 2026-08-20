import type { ChatPermissions } from "@grammyjs/types";
import type { RemoveBlockedMembersParams } from "../blocklist";
import type { LockdownPhase } from "../chatState";
import type { AdDetectAgentConfig } from "../config";
import type { BotActionPermissions } from "../telegram";
import type { TelegramWorkerRequest } from "../telegramWorker";
import type {
  AdCandidateMessage,
  ClearAdDetectMessage,
} from "./adDetect";
import type {
  DeferredVerificationRecord,
  VerificationSnapshot,
} from "./verification";

/** 主线程投递给入群守卫 Worker 的成员身份（生成展示标签所需的最小字段）。 */
export interface AntiRaidMember {
  id: number;
  username?: string;
  first_name?: string;
  /** 是不是机器人（本机器人自身不投递）。机器人入群走白名单用户代点验证的流程。 */
  isBot?: boolean;
}

/** 主线程 -> Worker：一位新成员（真人或机器人，但不含本机器人自身）加入了群聊。 */
export interface NewMemberMessage {
  type: "join";
  chatId: number;
  member: AntiRaidMember;
  /** 若本次由 new_chat_members 服务消息触发，该消息的 ID（用于之后删除）。 */
  announcementMessageId?: number;
  /** 管理员/群主身份入群时免验证、免刷群统计和私密模式踢出。 */
  exempt?: boolean;
  /** 触发该入群事件的操作者 ID。 */
  actorId?: number;
  /** 投递当刻操作者是否在主线程白名单边界内。 */
  actorIsWhitelisted: boolean;
}

/** 主线程 -> Worker：某成员离开了群聊（取消其待验证记录）。 */
export interface MemberLeftMessage {
  type: "left";
  chatId: number;
  userId: number;
}

/** 主线程 -> Worker：统一拆除某群的验证计时器，并恢复/保留 lockdown owner。 */
export interface DeactivateChatMessage {
  type: "deactivateChat";
  chatId: number;
  /** 主动 `/init disable` 时清理验证按钮；失权/离群时不得发无权限请求。 */
  cleanupVerificationMessages: boolean;
}

/** 主线程 -> Worker：只拆入群守卫链路，保留广告检测与防刷屏等独立能力。 */
export interface DeactivateJoinGuardMessage {
  type: "deactivateJoinGuard";
  chatId: number;
}

/** 主线程 -> Worker：一条普通群消息的待验证成员追踪投影。 */
export interface TrackedChatMessage {
  type: "message";
  chatId: number;
  userId: number;
  messageId: number;
  /** 是否直接回复自动转发的频道帖。 */
  repliesToChannelPost?: boolean;
  /** 是否为带 message_thread_id 的线程内回复。 */
  isThreadReply?: boolean;
}

/** 主线程 -> Worker：入群验证按钮被点击（callback_query）。 */
export interface VerifyCallbackMessage {
  type: "callback";
  callbackQueryId: string;
  /** 按钮所在消息的聊天；缺失时 Worker 只应答不处理。 */
  chatId?: number;
  /** callback_data 里携带的待验证成员 userId。 */
  targetUserId: number;
  /** 实际点击按钮的用户。 */
  from: AntiRaidMember;
  /** 投递当刻点击者是否在主线程白名单边界内。 */
  fromIsWhitelisted: boolean;
}

/** adopt 重放里的一条私密模式记录（见 AdoptLockdownsMessage）。 */
export interface AdoptableLockdown {
  chatId: number;
  phase: LockdownPhase;
  intentId: number;
  originalPermissions: ChatPermissions;
  announced: boolean;
  /** false 表示仅存在主线程 LRU 最终值，必须继续等待 SQLite 的落盘回执。 */
  persisted?: boolean;
  /** 距离应当恢复原始权限还剩多久。 */
  remainingMs: number;
}

/** 主线程 -> Worker：Worker 重建后接管主线程镜像里仍生效的私密模式。 */
export interface AdoptLockdownsMessage {
  type: "adopt";
  lockdowns: AdoptableLockdown[];
}

/** 主线程 -> Worker：Worker 重建时接管尚未结束的验证。 */
export interface AdoptVerificationsMessage {
  type: "adoptVerifications";
  generation: number;
  verifications: VerificationSnapshot[];
  /** 本进程已耗尽预算的最小索引；同 key 新事件不得重新创建验证运行态。 */
  deferredVerifications?: DeferredVerificationRecord[];
  /** 进程启动恢复来自磁盘，可直接续跑终态；Worker 内重建则重新等待落盘回执。 */
  resumePersistedTerminals?: boolean;
}

/** Anti-Raid Worker -> 主线程：为一轮验证终态副作用申请进程级执行许可。 */
export interface VerificationAttemptPermitRequest {
  readonly operation: "verificationAttemptPermit";
  readonly key: string;
  readonly generation: number;
  readonly revision: number;
}

/** 主线程对验证终态执行许可的固定形态回执。 */
export interface VerificationAttemptPermitResult {
  readonly status: "granted" | "exhausted" | "stale";
  readonly attempt: number;
}

/** Anti-Raid Worker 允许反向调用的主线程能力。 */
export type AntiRaidWorkerRequest =
  | TelegramWorkerRequest
  | VerificationAttemptPermitRequest;

/** 主线程 -> Worker：某条验证 revision 已进入当天文件，可执行终态副作用。 */
export interface VerificationPersistedMessage {
  type: "verificationPersisted";
  key: string;
  generation: number;
  revision: number;
}

/** 主线程 -> Worker：某成员的邀请者管理员豁免资格发生变化。 */
export interface AdminsChangedMessage {
  type: "adminsChanged";
  chatId: number;
  userId: number;
  /** 变化后是否为非匿名管理员/群主。 */
  isInviterExempt: boolean;
}

/** 主线程收到 SQLite 精确事务 ACK 后，允许 Worker 执行对应权限副作用。 */
export interface LockdownPersistedMessage {
  type: "lockdownPersisted";
  chatId: number;
  phase: LockdownPhase;
  intentId: number;
}

/** 主线程 -> Worker：把冻结目标从本群移除。 */
export interface RemoveBlockedMembersMessage extends RemoveBlockedMembersParams {
  type: "removeBlockedMembers";
}

/** 主线程 -> Worker：一条参与刷屏计数的群消息。 */
export interface FloodCandidateMessage {
  type: "floodCandidate";
  chatId: number;
  userId: number;
  /** 禁言通知里的展示标签。 */
  label: string;
}

/** 主线程 -> Worker：关闭防刷屏后清除该群全部发言窗口。 */
export interface ClearFloodControlMessage {
  type: "clearFloodControl";
  chatId: number;
}

/** 主线程 -> Worker：机器人自己的破坏性动作权限投影发生变化。 */
export interface BotPermissionsChangedMessage {
  type: "botPermissionsChanged";
  chatId: number;
  /** 省略表示未知，Worker 不得沿用旧值。 */
  permissions?: BotActionPermissions;
}

/** 主线程 -> Worker：某群是否为超级群。 */
export interface ChatKindChangedMessage {
  type: "chatKind";
  chatId: number;
  isSupergroup: boolean;
}

/** 主线程 -> Worker：本进程唯一一代广告检测能力配置。 */
export interface AntiRaidAgentConfigMessage {
  type: "agentConfig";
  adDetect: AdDetectAgentConfig | null;
}

/** 主线程 -> Worker：FIFO mailbox barrier；此前消息完成同步状态转移后回执。 */
export interface AntiRaidBarrierMessage {
  type: "barrier";
  barrierId: number;
}

/** 主线程 -> Worker：等待此前启动的异步副作用全部结算后回执。 */
export interface AntiRaidDrainMessage {
  type: "drain";
  drainId: number;
}

/** 主线程投递给 Anti-Raid Worker 的完整协议。 */
export type AntiRaidWorkerMessage =
  | AntiRaidAgentConfigMessage
  | NewMemberMessage
  | MemberLeftMessage
  | DeactivateChatMessage
  | DeactivateJoinGuardMessage
  | TrackedChatMessage
  | VerifyCallbackMessage
  | AdoptLockdownsMessage
  | AdoptVerificationsMessage
  | VerificationPersistedMessage
  | LockdownPersistedMessage
  | AdminsChangedMessage
  | RemoveBlockedMembersMessage
  | AdCandidateMessage
  | ClearAdDetectMessage
  | FloodCandidateMessage
  | ClearFloodControlMessage
  | BotPermissionsChangedMessage
  | ChatKindChangedMessage
  | AntiRaidBarrierMessage
  | AntiRaidDrainMessage;
