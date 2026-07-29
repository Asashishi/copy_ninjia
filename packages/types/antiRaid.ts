import type { RemoveBlockedMembersParams } from "./blocklist";
import type { ChatPermissions } from "@grammyjs/types";
export type * from "./antiRaid/internal";
export type * from "./antiRaid/adDetect";

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
  /**
   * 若为 true，该成员以管理员/群主身份入群（典型如群主退群重进；只有
   * chat_member 路径能看到身份），免验证、不计入刷群统计、私密模式下也不踢。
   */
  exempt?: boolean;
  /** 触发该入群事件的操作者 ID。 */
  actorId?: number;
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
}

/**
 * 主线程 -> Worker：一条普通群消息的（chatId, userId, messageId）三元组。
 * Worker 用它追踪待验证成员在等待期间发送的消息，验证超时被踢出时一并清理；
 * 与验证无关的（绝大多数）投递会在 Worker 侧的一次 Map 查找后被丢弃。
 */
export interface TrackedChatMessage {
  type: "message";
  chatId: number;
  userId: number;
  messageId: number;
  /**
   * 该消息是否直接回复了一条自动转发的频道帖（即在评论区对帖子本身留言）。
   * 这是确证的评论区活动——留言者是被这条留言自动拉进群的真人。
   */
  repliesToChannelPost?: boolean;
  /**
   * 该消息是否为线程内的回复（带 message_thread_id）。评论区的楼中楼回复
   * 都带；但 Bot API 无法按 ID 反查线程根，无法确证线程根就是频道帖，
   * 因此 Worker 还会结合本群是否关联频道；命中后按既定策略豁免验证。
   */
  isThreadReply?: boolean;
}

/** 主线程 -> Worker：入群验证按钮被点击（callback_query）。 */
export interface VerifyCallbackMessage {
  type: "callback";
  callbackQueryId: string;
  /** 按钮所在消息的聊天；极端情况下（消息太旧等）Telegram 可能不给，Worker 只应答不处理。 */
  chatId?: number;
  /** callback_data 里携带的待验证成员 userId。 */
  targetUserId: number;
  /** 实际点击按钮的用户。 */
  from: AntiRaidMember;
}

/** adopt 重放里的一条私密模式记录（见 AdoptLockdownsMessage）。 */
export interface AdoptableLockdown {
  chatId: number;
  phase: "applying" | "active" | "restoring";
  intentId: number;
  originalPermissions: ChatPermissions;
  /** false 表示仅存在主线程内存镜像，必须继续等待原 saveState 的落盘回执。 */
  persisted?: boolean;
  /**
   * 距离应当恢复原始权限还剩多久（ms，已按 Math.max(0, ...) 夹到不为负）
   * ——由主线程根据持久化的 LockdownRecord.expiresAt 与当前时刻算出，见
   * packages/antiRaid/lockdownMirror.ts 的 buildAdoptLockdownsMessage。
   */
  remainingMs: number;
}

/**
 * 主线程 -> Worker：Worker 崩溃重启后，把主线程镜像里仍在生效的私密模式
 * 交给新 Worker 接管——权限限制已实际落在群上，必须重新排恢复计时，
 * 否则无人解锁。
 */
export interface AdoptLockdownsMessage {
  type: "adopt";
  lockdowns: AdoptableLockdown[];
}

/**
 * pending 验证的纯数据快照。主线程持有镜像、Disk I/O Worker 按日落盘；
 * 计时器、Promise 和 API 在途状态由业务 Worker 按 expiresAt 重建。
 */
export interface VerificationSnapshot {
  chatId: number;
  userId: number;
  /** 当前 Anti-Raid Worker 代际；主线程据此拒绝旧实例的迟到事件。 */
  generation: number;
  /** 同一代际、同一 key 内单调递增的状态修订号。 */
  revision: number;
  /** 当前持久化阶段；终态必须在落盘确认后才能执行外部处置。 */
  phase: "pending" | "checkingInviter" | "expelling";
  label: string;
  isBot: boolean;
  messageIds: number[];
  /** 入群公告 id；与 messageIds 分开存，不参与上限截断（见 PendingState）。 */
  announcementMessageId?: number;
  /** 最近一分钟的待验证成员消息时间戳。 */
  trackedMessageTimes: number[];
  invitedBy?: number;
  reminderMessageId?: number;
  replyReminderMessageId?: number;
  replyReminderRequested: boolean;
  welcomeAnchorMessageId?: number;
  reminderSuperseded: boolean;
  joinedAt: number;
  expiresAt: number;
  /** checkingInviter 终态的最终核查对象。 */
  terminalInviterId?: number;
  /** expelling 终态的处置原因。 */
  expelReason?: "timeout" | "flood";
  /** 成功处置播报已发送；仅 expelling 终态可携带。 */
  successNoticeSent?: boolean;
  /** 「踢不动」告警已发送；仅 expelling 终态可携带（见 ExpellingState）。 */
  failureNoticeSent?: boolean;
  /** 「没能确认还在不在群里」告警已发送；仅 expelling 终态可携带。 */
  unconfirmedNoticeSent?: boolean;
}

/** 主线程 -> Worker：Worker 重建时接管尚未结束的验证。 */
export interface AdoptVerificationsMessage {
  type: "adoptVerifications";
  generation: number;
  verifications: VerificationSnapshot[];
  /** 进程启动恢复来自磁盘，可直接续跑终态；Worker 内重建则重新等待落盘回执。 */
  resumePersistedTerminals?: boolean;
}

/** 主线程 -> Worker：某条验证 revision 已进入当天文件，可安全执行终态副作用。 */
export interface VerificationPersistedMessage {
  type: "verificationPersisted";
  key: string;
  generation: number;
  revision: number;
}

/**
 * 主线程 -> Worker：某成员的“邀请新成员可豁免验证”管理员资格发生变化。
 * 任免、入离群或匿名模式切换都会以 chat_member 更新送达，借此让 Worker
 * 侧缓存近乎实时，TTL 只是兜底。
 */
export interface AdminsChangedMessage {
  type: "adminsChanged";
  chatId: number;
  userId: number;
  /** 变化后是否为非匿名管理员/群主；匿名管理员不提供邀请者豁免。 */
  isInviterExempt: boolean;
}

/** 主线程完成 state.json 写入后，允许 Worker 执行对应权限副作用。 */
export interface LockdownPersistedMessage {
  type: "lockdownPersisted";
  chatId: number;
  phase: "applying" | "active" | "restoring";
  intentId: number;
}

/**
 * 主线程 -> Worker：把这些 id 从本群清出去（/block 黑名单）。判定留在主线程、
 * 执行放 Worker 的理由见 docs/04-invariants.md。字段与执行 owner 的入参同形，
 * 直接复用 types/blocklist.ts 的定义。
 */
export interface RemoveBlockedMembersMessage extends RemoveBlockedMembersParams {
  type: "removeBlockedMembers";
}

/**
 * 主线程 -> Worker：一条待广告判定的群消息。只有本群开了 /ad_detect enable、
 * 机器人是本群管理员、且发送者不是自己人时才投递（见 antiRaid/adDetect.ts）。
 * Worker 侧按发送者归并成消息串排队送检，见 workers/antiRaid/adDetect/queue.ts。
 */
export interface AdCandidateMessage {
  type: "adCandidate";
  chatId: number;
  /** 用户 id；频道马甲发言时是该频道的负数 id。 */
  senderId: number;
  messageId: number;
  /** 已清洗成单行的正文（文本或图片说明）。 */
  text: string;
  /**
   * 只写进命中样本文件、**绝不参与判定**的上下文（被引用段与被回复原文）。
   *
   * 判定文本只取发送者自己写的那部分——引用别人的广告吐槽不该让吐槽的人背锅，
   * 而那条原消息在它自己发出时已经判过一次（见 docs/04-invariants.md）。但人
   * 回头翻样本、调 config/ad_samples.json 时，「它当时在回谁、引了什么」往往
   * 正是判断误判与否的关键，所以另开一个字段带过来，与 text 严格分开。
   */
  sampleContext?: AdSampleContext;
  /**
   * 正文里看不见的 text_link 落地页 URL，已清洗并按 AD_DETECT_LINK_URL_MAX_CHARS
   * 截断。与正文分开带：拼进正文的话，Worker 侧按字数从头保留的截断正好切掉
   * 尾部这几个 URL（见 antiRaid/adDetect.ts 的 collectHiddenLinkUrls）。
   */
  linkUrls: string[];
  /** 处置播报里的展示标签，由主线程按可见发送者算好。 */
  label: string;
  /** 发送者是频道马甲（sender_chat）而非真人。 */
  isChannel: boolean;
  /**
   * 该发送者此刻已经在永久黑名单里（封禁多半还没落地）。
   *
   * 名单是主线程的同步安全边界，Worker 侧没有镜像，只能随投递带过来。真人在
   * 主线程就被挡掉了、不会带着 true 走到这里；频道马甲则必须投过来——它的封禁
   * 走 banChatSenderChat，没有 revoke_messages，这段落地空档里发出来的广告只有
   * Worker 侧的 deleteStraggler 这一条清理路径（见 states/adDetectAdmission.ts）。
   */
  blocked: boolean;
  /**
   * 该发送者此刻是否仍在入群验证窗口内（主线程按待验证镜像判定）。这是模型
   * 自己看不到的事实——群聊转录里没有入群时间——只能由这里喂进去，见
   * consts/antiRaid/adDetect.ts 的 AD_DETECT_JUST_JOINED_FACT。
   */
  justJoined: boolean;
}

/**
 * 主线程 -> Worker：丢掉这个群尚未送检的广告判定队列。/ad_detect disable、
 * 停管与群 teardown 都会发；已经在途的那一次判定由 Worker 侧自行作废。
 */
export interface ClearAdDetectMessage {
  type: "clearAdDetect";
  chatId: number;
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

export type AntiRaidWorkerMessage =
  | NewMemberMessage
  | MemberLeftMessage
  | DeactivateChatMessage
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
  | AntiRaidBarrierMessage
  | AntiRaidDrainMessage;

/**
 * Worker -> 主线程：一批黑名单处置已经走完。complete 为 true 才允许主线程
 * 销掉镜像并把「这个群已清扫过」记进状态：处置没落地却把边沿消耗掉，等于
 * 让那些人永久坐在群里（见 infra/blocklist.ts 与 infra/botAdmin.ts）。
 */
export interface BlockedMembersRemovedEvent {
  type: "blockedMembersRemoved";
  chatId: number;
  removalId: number;
  /** 每个 id 都已确定结局（封成功、或确认不在群）为 true；有一个没落定就是 false。 */
  complete: boolean;
  /**
   * 没落定的原因里包含「权限不够」。这一档必须与其它失败分开：网络抖动值得按
   * 时间退避重试，而缺封禁权限时重试多少次都一样，只有权限本身变了才有意义
   * （见 docs/04-invariants.md）。
   */
  permissionDenied?: boolean;
  /**
   * 批次里有目标因**自身的管理员身份**没被封掉。这一档与 complete 正交：那个
   * id 在这个批次里已经结算（重投同一批只会再撞一次同样的 400），但这个群里
   * 确实还留着一个黑名单成员，因此不能把它记成「已扫干净」——否则 sweptAt 那
   * 道闩锁就此关死，目标降级为普通成员之后再也没有补扫会去清他。
   */
  targetIsAdmin?: boolean;
}

/** Worker -> 主线程：写入 applying/active/restoring 的持久化阶段。 */
export interface LockdownEvent {
  type: "lockdown";
  chatId: number;
  phase: "applying" | "active" | "restoring";
  intentId: number;
  originalPermissions: ChatPermissions;
  expiresAt: number;
}

/** Worker -> 主线程：某群的私密模式已解除（原始权限恢复成功）。 */
export interface UnlockEvent {
  type: "unlock";
  chatId: number;
}

/** Worker -> 主线程：新增或更新一条仍待验证的纯数据记录。 */
export interface VerificationUpsertEvent {
  type: "verificationUpsert";
  record: VerificationSnapshot;
}

/** Worker -> 主线程：验证已终结；主线程从内存镜像移除对应快照。 */
export interface VerificationDeleteEvent {
  type: "verificationDelete";
  chatId: number;
  userId: number;
  generation: number;
  revision: number;
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

/**
 * Worker -> 主线程：这个发送者被判成广告，请按 /block 同样的处置办。
 * Worker 已经删掉那一串消息并在群里播报过；名单与跨群封禁必须回主线程
 * （名单是主线程的同步安全边界，封禁批次要进 durable outbox）。
 */
export interface AdDetectedEvent {
  type: "adDetected";
  chatId: number;
  senderId: number;
  isChannel: boolean;
  label: string;
  /** 模型给出的简短理由，只进日志、播报与命中样本；不参与任何控制流。 */
  reason: string;
  /**
   * 本次判定依据的整串消息，原样带回主线程写进命中样本文件（见
   * workers/diskIO/adSampleFile.ts）。判定看的是整串而不是某一条，样本因此也
   * 按串记录——只留触发那一条的话，人回头看到的是一句孤立的话，根本复现不出
   * 模型当时读到的东西。
   */
  messages: readonly AdSampleMessage[];
}

/** 命中样本里的一条消息：判定读到的正文，以及只给人看的上下文。 */
export interface AdSampleMessage extends AdSampleContext {
  messageId: number;
  /** 送检时的正文（已截断、已补上 text_link 落地页），与模型读到的完全一致。 */
  text: string;
}

/** 只写进命中样本、不参与判定的上下文。两项都可能缺席。 */
export interface AdSampleContext {
  /** 这条消息里被引用的那一段（message.quote）。 */
  quote?: string;
  /** 这条消息回复的那条原消息的正文。 */
  replyTo?: string;
}

export type AntiRaidWorkerEvent =
  | LockdownEvent
  | UnlockEvent
  | VerificationUpsertEvent
  | VerificationDeleteEvent
  | BlockedMembersRemovedEvent
  | AdDetectedEvent
  | AntiRaidBarrierCompleteEvent
  | AntiRaidDrainCompleteEvent;
