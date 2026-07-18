import { KICKED_REJOIN_GRACE_MS } from "../consts/antiRaid";

/**
 * 入群验证生命周期的显式状态机（纯逻辑，不做任何 I/O、不持有计时器）。
 * 状态按 (chatId, userId) 归属，由 workers/antiRaidWorker.ts 持有并解释执行：
 * Worker 把每条投递翻译成 VerificationEvent 喂给 transitionVerification，
 * 拿到「下一个状态 + 待执行副作用」后自己去落状态、排计时器、打 Telegram API。
 *
 * 状态图（ABSENT = Map 里没有这个 key）：
 *
 *   ABSENT ──身份豁免/白名单拉人/管理员缓存命中/频道评论确证──> EXEMPT
 *   ABSENT ──私密模式期间入群──────────────────────────────> KICKED
 *   ABSENT ──普通入群──────────────────────────────────────> PENDING
 *   PENDING ──频道评论确证 / 异步管理员核查通过──────────────> EXEMPT
 *   PENDING ──验证按钮通过 / 中途离群────────────────────────> ABSENT
 *   PENDING ──超时（拉人者最终核对非管理员 → 踢人）──────────> ABSENT
 *   PENDING ──超时（拉人者最终核对是管理员）─────────────────> EXEMPT
 *   EXEMPT/KICKED ──去重窗口到期 / 离群──────────────────────> ABSENT
 *
 * EXEMPT/KICKED 都是「已终结但短暂保留」的去重占位：chat_member 更新与
 * new_chat_members 服务消息会针对同一次入群各自投递一次、到达顺序不保证，
 * 占位防止后到的那一路重新开验证窗口/重复踢人。
 *
 * 同一 kind 内的字段更新会原地修改传入的状态对象并原样返回（next === state），
 * kind 变化才返回新对象——解释器据此判断要不要换计时器，异步回调（提醒回填、
 * 管理员核查）也沿用旧实现的对象同一性判断来识别「状态是否已被替换」。
 */

/** 早于入群更新到达、被暂存下来的评论区留言（消费逻辑见 join 事件）。 */
export interface RecentComment {
  messageId: number;
  /** 是否直接回复频道帖——确证的真人评论区留言，足以豁免验证。 */
  repliesToChannelPost: boolean;
}

/** 正在等待点击验证按钮的成员。字段含义与旧 PendingVerification 一一对应。 */
export interface PendingState {
  kind: "pending";
  /** 入群时捕获的展示用标签，用于踢人公告（提到 TA 的消息届时都已被删除）。 */
  label: string;
  /** 是不是机器人——机器人点不了按钮，只能由白名单用户代点作保，文案也单独措辞。 */
  isBot: boolean;
  /** 验证超时被踢出时要删除的消息：入群公告、提醒、以及 TA 等待期间发的一切。 */
  messageIds: number[];
  /** 若为被他人拉入群，拉人者的 userId——超时踢人前要对其身份做最后核对。 */
  invitedBy?: number;
  /** 带验证按钮的原始独立提醒的消息 ID（发送成功回填后才有）。 */
  reminderMessageId?: number;
  /** 以「回复 TA 的消息」形式补发的提醒的消息 ID（发送成功回填后才有）。 */
  replyReminderMessageId?: number;
  /** 是否已补发过回复式提醒——TA 连发多条消息也只补发一次。 */
  replyReminderRequested: boolean;
  /** 回复式提醒锚定的消息 ID，验证通过后的欢迎消息也回复它（楼中楼场景落进评论线程）。 */
  welcomeAnchorMessageId?: number;
  /** 原始提醒已被回复式提醒取代：还没落地的原始提醒落地即自删（见 reminderLanded）。 */
  reminderSuperseded: boolean;
  /** 创建本记录那次入群的时刻（= JoinEvent.now，与 recordJoin 压进
   *  刷群滑动窗口的时间戳同一个值）。retractJoinCount 撤销计数时要精确
   *  找到并移除这一条，不能牵连窗口内其它入群的时间戳，见
   *  workers/antiRaid/lockdownRuntime.ts 的 retractJoin。 */
  joinedAt: number;
}

/** 豁免占位：管理员拉人/身份入群/频道评论确证，不需要验证，只用于给重复投递去重。 */
export interface ExemptState {
  kind: "exempt";
  label: string;
  isBot: boolean;
}

/** 秒踢占位：私密模式下已直接踢出，防止另一路投递重复计数/重复踢。 */
export interface KickedState {
  kind: "kicked";
  label: string;
  isBot: boolean;
  /** 本占位创建（踢出）时的时刻，用于在新 join 事件到达时区分"同一次入群的
   * 另一条投递"与"真的重新入群"，见 KICKED_REJOIN_GRACE_MS。 */
  kickedAt: number;
}

export type VerificationState = PendingState | ExemptState | KickedState;

/**
 * 超时踢人流程的记录快照。verifyTimeout 会立即删除状态（等待期间迟到的
 * 按钮点击要能查无记录而安全失效），但异步的拉人者身份终核与最终的
 * 删消息/踢人还需要这些字段，所以摘出来随事件流转。
 */
export interface ExpelSnapshot {
  label: string;
  isBot: boolean;
  messageIds: number[];
  reminderMessageId?: number;
  replyReminderMessageId?: number;
  /** 见 PendingState.joinedAt——终核收尾时撤销刷群计数要用到。 */
  joinedAt: number;
}

export interface JoinEvent {
  type: "join";
  memberId: number;
  label: string;
  isBot: boolean;
  /** 若由 new_chat_members 服务消息触发，该消息的 ID。 */
  announcementMessageId?: number;
  /** 触发本次入群的操作者；undefined 或等于 memberId 视为自主入群。 */
  actorId?: number;
  /** chat_member 路径可见：入群者本身就是管理员/群主。 */
  identityExempt: boolean;
  /** 拉人者在特权白名单里，或命中未过期的管理员缓存（Worker 预计算；自主入群恒为 false）。 */
  actorSyncExempt: boolean;
  /** 管理员缓存当前是否未过期——决定要不要给已有记录补挂异步核查。 */
  adminCacheFresh: boolean;
  /**
   * 本群是否处于私密模式。必须在 recordJoin（可能同步触发锁定）之后取值，
   * 越过阈值的那次入群自己才会被秒踢——调用顺序见 joinCreatesNewRecord。
   */
  lockdownActive: boolean;
  /** 本次入群前暂存的评论区留言（Worker 已从暂存区消费，无论本转移用不用都不退回）。 */
  recentComment?: RecentComment;
  /** 解释器观测到本次投递的时刻，供区分"kicked 占位遇到的新 join 是同一次
   * 入群的另一条腿，还是真的重新入群"，见 KICKED_REJOIN_GRACE_MS。 */
  now: number;
}

export type VerificationEvent =
  | JoinEvent
  | { type: "left" }
  | { type: "trackedMessage"; messageId: number; inCommentThread: boolean; repliesToChannelPost: boolean }
  | { type: "callback"; callbackQueryId: string; isSelf: boolean; fromIsPrivileged: boolean; fromLabel: string }
  /** 异步管理员核查确认拉人者是管理员（仅在核查发起时的状态对象未被替换时投递）。 */
  | { type: "adminCheckResolved" }
  | { type: "verifyTimeout" }
  /** 超时踢人前对拉人者身份的最后核对结果（recheckInviter 副作用的回执）。 */
  | { type: "timeoutInviterVerdict"; inviterIsAdmin: boolean; snapshot: ExpelSnapshot }
  /** 提醒消息经限流队列落地，回填其消息 ID（仅在状态对象未被替换时投递）。 */
  | { type: "reminderLanded"; reminderKind: "original" | "reply"; messageId: number }
  | { type: "dedupeExpired" };

export type VerificationEffect =
  | { kind: "deleteMessage"; messageId: number }
  | { kind: "kickMember" }
  /** 发送原始独立提醒（带验证按钮），落地后以 reminderLanded 回填。 */
  | { kind: "sendReminder"; label: string; isBot: boolean }
  /** 以回复 targetMessageId 的形式补发提醒；inCommentThread 时文案不同且要重置验证计时。 */
  | { kind: "sendReplyReminder"; label: string; targetMessageId: number; inCommentThread: boolean }
  | { kind: "sendWelcome"; variant: "verified" | "vouchedBot" | "channelComment"; targetLabel: string; fromLabel?: string; anchorMessageId?: number }
  | { kind: "answerCallback"; callbackQueryId: string; reply: "ok" | "invalid" | "notYourButton" | "notYourBotButton" }
  /** 删除已落地的提醒消息（撤销验证的各路径共用；还没落地的由回填回调自删）。 */
  | { kind: "deleteReminders"; reminderMessageId?: number; replyReminderMessageId?: number }
  /** 发起「拉人者是不是管理员」的异步全量核查，确认则回投 adminCheckResolved。 */
  | { kind: "startAdminCheck"; actorId: number }
  /** 已经是 KICKED 占位（踢的动作已实际执行）时又收到确凿的豁免证明——
   *  Telegram 没有"撤销踢出"这回事，占位本身不动，只留一条日志方便管理员
   *  事后手动把人拉回来，见 handleJoin 里 exempt 分支对 kicked 占位的处理。 */
  | { kind: "logStaleKickedExemption"; label: string }
  /** 撤销一次此前 recordJoin 计入的刷群窗口计数：一条 PENDING 记录（创建时
   *  必然已被计入，见 joinCreatesNewRecord）事后才被确证豁免（管理员拉人
   *  异步核查通过、频道评论确证、超时终核确认拉人者是管理员、第二路投递
   *  带着豁免证明追上来），不该继续占着刷群统计的名额，见
   *  workers/antiRaid/lockdownRuntime.ts 的 retractJoin。joinedAt 必须精确
   *  指向创建这条记录那次入群自己的时间戳（PendingState.joinedAt /
   *  ExpelSnapshot.joinedAt）——按值移除而非无差别 shift 队首，否则可能
   *  牵连窗口内其它真实入群的计数（该时间戳若已被窗口自然修剪出局，说明
   *  本就无需撤销，按值移除会正确地找不到、no-op）。 */
  | { kind: "retractJoinCount"; joinedAt: number }
  /** 超时后的拉人者身份终核（缓存热直接判、冷则等一次全量拉取），结果以 timeoutInviterVerdict 回投。 */
  | { kind: "recheckInviter"; inviterId: number; snapshot: ExpelSnapshot }
  /** 删除快照里的全部追踪消息、踢人、发踢人通知（超时未验证的最终收尾）。 */
  | { kind: "expel"; snapshot: ExpelSnapshot }
  /** 楼中楼补发提醒时重置验证倒计时（TA 在频道侧刚看到按钮，重新给满时长）。 */
  | { kind: "restartVerifyTimer" };

export interface VerificationTransition {
  /** 下一个状态：undefined = 删除记录；与传入同一对象 = 原地更新（计时器不动）。 */
  next: VerificationState | undefined;
  effects: VerificationEffect[];
}

/** 汇总一次入群的全部豁免来源；viaChannelComment 标记豁免是否由频道评论确证（要补欢迎）。 */
function resolveJoinExemption(event: JoinEvent): { exempt: boolean; viaChannelComment: boolean } {
  if (event.identityExempt || event.actorSyncExempt) return { exempt: true, viaChannelComment: false };
  if (event.recentComment?.repliesToChannelPost === true) return { exempt: true, viaChannelComment: true };
  return { exempt: false, viaChannelComment: false };
}

/**
 * 本次入群是否会新建一条记录（= 计入刷群统计）。调用方必须先用它决定是否
 * recordJoin，再取 lockdownActive、再 dispatch——recordJoin 可能同步触发
 * 私密模式，越过阈值的那次入群自己就要走秒踢分支，顺序不能反。
 */
export function joinCreatesNewRecord(state: VerificationState | undefined, event: JoinEvent): boolean {
  return state === undefined && !resolveJoinExemption(event).exempt;
}

function snapshotOf(state: PendingState): ExpelSnapshot {
  return {
    label: state.label,
    isBot: state.isBot,
    messageIds: state.messageIds,
    reminderMessageId: state.reminderMessageId,
    replyReminderMessageId: state.replyReminderMessageId,
    joinedAt: state.joinedAt,
  };
}

function remindersOf(source: Pick<PendingState, "reminderMessageId" | "replyReminderMessageId">): VerificationEffect {
  return { kind: "deleteReminders", reminderMessageId: source.reminderMessageId, replyReminderMessageId: source.replyReminderMessageId };
}

function handleJoin(state: VerificationState | undefined, event: JoinEvent): VerificationTransition {
  const { exempt, viaChannelComment } = resolveJoinExemption(event);
  const invitedByOther: boolean = event.actorId !== undefined && event.actorId !== event.memberId;

  if (exempt) {
    // 已有豁免占位时不动它，也不刷新其去重计时——与旧实现一致。
    if (state?.kind === "exempt") return { next: state, effects: [] };
    if (state?.kind === "kicked") {
      // 已经踢出去了（私密模式秒踢，或超时踢人后 KICKED_REJOIN_GRACE_MS 去重
      // 窗口内的另一路投递），但这次事件带着确凿的豁免证明（比如姗姗来迟的
      // 管理员身份证明）——踢的动作已经执行完毕，Telegram 没有"撤销踢出"
      // 这回事，占位本身仍不动、去重语义不变，唯一能做的是留一条日志，方便
      // 管理员发现后手动把人重新拉回来。
      return { next: state, effects: [{ kind: "logStaleKickedExemption", label: event.label }] };
    }
    const effects: VerificationEffect[] = [];
    // 服务消息那一路先到、已开了真实验证窗口：撤销并删提醒（还在限流队列
    // 里没落地的提醒由回填回调自删）。TA 的入群公告不删、发言不追踪——合法成员。
    // 这个分支走到这里时 state 只可能是 undefined（此前从未有过记录，纯粹
    // 首次即豁免，没计过数）或 pending（已创建 PENDING 时必然计过数，见
    // joinCreatesNewRecord）——exempt/kicked 两种已在上面提前 return。
    if (state !== undefined) {
      effects.push(remindersOf(state));
      effects.push({ kind: "retractJoinCount", joinedAt: state.joinedAt });
    }
    if (viaChannelComment && event.recentComment !== undefined) {
      // 直接回复频道帖免验证：不点按钮的豁免路径原本没有任何反馈，在帖子
      // 底下补一条欢迎，让 TA 在频道侧知道自己已被放行。
      effects.push({ kind: "sendWelcome", variant: "channelComment", targetLabel: event.label, anchorMessageId: event.recentComment.messageId });
    }
    return { next: { kind: "exempt", label: event.label, isBot: event.isBot }, effects };
  }

  if (state !== undefined) {
    // 同一次入群的另一路投递：只补充，不重启计时器/不再发提醒（幂等）。
    const effects: VerificationEffect[] = [];
    if (event.announcementMessageId !== undefined) {
      if (state.kind === "kicked") {
        // 人已在私密模式下被踢出，姗姗来迟的入群公告顺手清理。
        effects.push({ kind: "deleteMessage", messageId: event.announcementMessageId });
      } else if (state.kind === "pending") {
        state.messageIds.push(event.announcementMessageId);
      }
    }
    if (state.kind === "kicked" && event.now - state.kickedAt > KICKED_REJOIN_GRACE_MS) {
      // 距上次踢出已经超过"两路投递同一次入群"的合理误差范围，说明这是
      // TA 真的重新申请了入群（kickChatMember 只踢不封，本就能立刻
      // 重进）——不是同一次物理入群的第二条投递，得补一次真正的踢人效果。
      // 返回新对象而非原地改字段：解释器按对象同一性判断要不要换计时器，
      // 这里就是要换——让这次新入群拥有自己完整的一份去重窗口，覆盖它
      // 自己两条投递之间的间隔，而不是共用旧占位所剩无几的窗口。
      return { next: { kind: "kicked", label: state.label, isBot: state.isBot, kickedAt: event.now }, effects: [...effects, { kind: "kickMember" }] };
    }
    // 两路投递携带的 actor 不保证一致：本路带着拉人者而验证窗口还开着时补挂
    // 异步核查。缓存热时不必挂——resolveJoinExemption 的同步快路径刚查过，
    // 没命中就是真不是管理员。
    if (state.kind === "pending" && invitedByOther && !event.adminCacheFresh) {
      state.invitedBy ??= event.actorId;
      effects.push({ kind: "startAdminCheck", actorId: event.actorId! });
    }
    return { next: state, effects };
  }

  // 全新入群（调用方已按 joinCreatesNewRecord 完成 recordJoin）。
  if (event.lockdownActive) {
    // 私密模式：跳过质询直接踢出（只踢不封、可重进），不开验证窗口。
    // 管理员拉人只认同步缓存判定（触发/接管锁定时已预热），异步兜底一律没有。
    const effects: VerificationEffect[] = [];
    if (event.announcementMessageId !== undefined) effects.push({ kind: "deleteMessage", messageId: event.announcementMessageId });
    // 楼中楼评论触发的自动入群也被秒踢：那条评论按刷群痕迹一并清理。
    if (event.recentComment !== undefined) effects.push({ kind: "deleteMessage", messageId: event.recentComment.messageId });
    effects.push({ kind: "kickMember" });
    return { next: { kind: "kicked", label: event.label, isBot: event.isBot, kickedAt: event.now }, effects };
  }

  const pending: PendingState = {
    kind: "pending",
    label: event.label,
    isBot: event.isBot,
    messageIds: event.announcementMessageId !== undefined ? [event.announcementMessageId] : [],
    invitedBy: invitedByOther ? event.actorId : undefined,
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: event.now,
  };
  const effects: VerificationEffect[] = [];
  if (event.recentComment !== undefined) {
    // 楼中楼回复先到、入群更新后到：验证提醒直接以回复 TA 那条评论的形式发
    // （频道侧看得到按钮），原始独立提醒不再发。评论本身补进追踪，超时一并清理。
    pending.messageIds.push(event.recentComment.messageId);
    pending.replyReminderRequested = true;
    pending.reminderSuperseded = true;
    pending.welcomeAnchorMessageId = event.recentComment.messageId;
    effects.push({ kind: "sendReplyReminder", label: event.label, targetMessageId: event.recentComment.messageId, inCommentThread: true });
  }
  // 他人拉入群但同步快路径没命中：异步全量核查兜底（顺手把缓存补热，
  // 同群下一次管理员拉人就能走同步快路径、不再闪验证按钮）。
  if (invitedByOther) effects.push({ kind: "startAdminCheck", actorId: event.actorId! });
  if (event.recentComment === undefined) effects.push({ kind: "sendReminder", label: event.label, isBot: event.isBot });
  return { next: pending, effects };
}

function handleTrackedMessage(
  state: VerificationState | undefined,
  event: { messageId: number; inCommentThread: boolean; repliesToChannelPost: boolean }
): VerificationTransition {
  // 占位记录不是真的在等验证；无记录的消息与验证无关。
  if (state === undefined || state.kind !== "pending") return { next: state, effects: [] };

  if (event.repliesToChannelPost) {
    // 在关联频道的帖子下留言是确证的真人操作，免验证放行。TA 已发的消息
    // 一概不删（合法评论），在这条评论下补欢迎让 TA 知道已通过。这里的
    // state 一定是 pending（函数顶部已排除 undefined/非 pending），创建时
    // 必然计过数，见 joinCreatesNewRecord，事后确证豁免要撤销那次计数。
    return {
      next: { kind: "exempt", label: state.label, isBot: state.isBot },
      effects: [
        remindersOf(state),
        { kind: "retractJoinCount", joinedAt: state.joinedAt },
        { kind: "sendWelcome", variant: "channelComment", targetLabel: state.label, anchorMessageId: event.messageId },
      ],
    };
  }

  state.messageIds.push(event.messageId);
  // TA 开口说话了还没点按钮：把提醒补发为回复 TA 消息的形式（只补发一次）。
  if (state.replyReminderRequested) return { next: state, effects: [] };
  state.replyReminderRequested = true;
  state.welcomeAnchorMessageId = event.messageId;
  state.reminderSuperseded = true;

  const effects: VerificationEffect[] = [];
  // 楼中楼：TA 在频道侧此刻才看得到按钮，验证计时重新给满；普通发言不重置。
  // 排在列表最前——解释器按序执行且会 await 删除调用，重置不能被限流队列拖后。
  if (event.inCommentThread) effects.push({ kind: "restartVerifyTimer" });
  // 补发提醒排在删旧提醒之前：解释器对 deleteMessage 是 await 的，中间会让出
  // 事件循环，若先执行删除，补发提醒真正发出时可能已经隔了一段时间——其间
  // 状态可能被交错到达的其他投递替换/重建，捕获到错误的记录（回填打进新
  // 记录、或对已离群/已豁免成员发出过期提醒）。发提醒本身不 await，紧跟在
  // 状态转移的同一 tick 内同步执行，不受后面的 await 影响。
  effects.push({ kind: "sendReplyReminder", label: state.label, targetMessageId: event.messageId, inCommentThread: event.inCommentThread });
  if (state.reminderMessageId !== undefined) {
    // 原提醒被取代，立刻删除（顺手从待清理列表去掉，免得过期清理时再对它
    // 多打一次注定失败的删除调用）。
    const reminderIndex: number = state.messageIds.indexOf(state.reminderMessageId);
    if (reminderIndex >= 0) state.messageIds.splice(reminderIndex, 1);
    effects.push({ kind: "deleteMessage", messageId: state.reminderMessageId });
    state.reminderMessageId = undefined;
  }
  return { next: state, effects };
}

function handleCallback(
  state: VerificationState | undefined,
  event: { callbackQueryId: string; isSelf: boolean; fromIsPrivileged: boolean; fromLabel: string }
): VerificationTransition {
  if (!event.isSelf) {
    // 只有本人点击才算数；唯一例外是白名单用户为机器人代点作保。
    const vouchingForBot: boolean = state?.isBot === true && event.fromIsPrivileged;
    if (!vouchingForBot) {
      return {
        next: state,
        effects: [{ kind: "answerCallback", callbackQueryId: event.callbackQueryId, reply: state?.isBot === true ? "notYourBotButton" : "notYourButton" }],
      };
    }
  }

  if (state === undefined || state.kind !== "pending") {
    return { next: state, effects: [{ kind: "answerCallback", callbackQueryId: event.callbackQueryId, reply: "invalid" }] };
  }

  // 状态同步清掉（解释器在任何 await 之前落地）：重复/并发点击的后到者
  // 会走上面的「已失效」分支，不会重复发欢迎消息。
  return {
    next: undefined,
    effects: [
      { kind: "answerCallback", callbackQueryId: event.callbackQueryId, reply: "ok" },
      remindersOf(state),
      {
        kind: "sendWelcome",
        variant: event.isSelf ? "verified" : "vouchedBot",
        targetLabel: state.label,
        fromLabel: event.fromLabel,
        anchorMessageId: state.welcomeAnchorMessageId,
      },
    ],
  };
}

function handleVerifyTimeout(state: VerificationState | undefined): VerificationTransition {
  if (state === undefined || state.kind !== "pending") return { next: state, effects: [] };
  const snapshot: ExpelSnapshot = snapshotOf(state);
  // 记录立即删除：终核等待期间迟到的撤销回调/按钮点击都会因查不到记录而安全失效。
  if (state.invitedBy !== undefined) {
    // 管理员拉人的异步豁免可能到期了还没落定（管理员表拉取在限流队列里排队
    // 或重试失败）：踢人前对拉人者身份做最后核对。
    return { next: undefined, effects: [{ kind: "recheckInviter", inviterId: state.invitedBy, snapshot }] };
  }
  return { next: undefined, effects: [{ kind: "expel", snapshot }] };
}

function handleTimeoutInviterVerdict(
  state: VerificationState | undefined,
  event: { inviterIsAdmin: boolean; snapshot: ExpelSnapshot }
): VerificationTransition {
  if (!event.inviterIsAdmin) {
    // 终核等待期间若有新投递重开了记录（比如这段时间里 TA 退群又重新进群），
    // 说明这份踢人结论已经过期——不能无条件执行 expel，否则会把当前占着
    // 这个 key 的全新合法状态连坐踢掉（这份新记录本身没被替换过，只是踢人
    // 副作用不认代际）。只清理旧快照里可能还挂着的提醒，新记录原样保留、
    // 不重启计时，对称于下方"拉人者确是管理员"分支的处理方式。
    if (state === undefined) return { next: undefined, effects: [{ kind: "expel", snapshot: event.snapshot }] };
    return { next: state, effects: [remindersOf(event.snapshot)] };
  }
  // 拉人者确是管理员：按豁免收尾——只删带按钮的提醒，入群公告和 TA 的发言
  // 都留下（合法成员），也不发踢人通知。终核等待期间若有新投递重开了记录，
  // 不去覆盖它。不论 state 此刻是否已被新记录占用，这里终结的都是"原来
  // 那次入群"的命运——它创建时必然已被计入刷群统计（能走到 verifyTimeout
  // 才有这次终核），事后确证是管理员就要撤销那次计数，与是否新建 exempt
  // 占位无关。
  const effects: VerificationEffect[] = [remindersOf(event.snapshot), { kind: "retractJoinCount", joinedAt: event.snapshot.joinedAt }];
  if (state === undefined) {
    return { next: { kind: "exempt", label: event.snapshot.label, isBot: event.snapshot.isBot }, effects };
  }
  return { next: state, effects };
}

function handleReminderLanded(
  state: VerificationState | undefined,
  event: { reminderKind: "original" | "reply"; messageId: number }
): VerificationTransition {
  // 解释器只在状态对象未被替换时才投递本事件，这里的防御分支正常不可达。
  if (state === undefined || state.kind !== "pending") {
    return { next: state, effects: [{ kind: "deleteMessage", messageId: event.messageId }] };
  }
  if (event.reminderKind === "original" && state.reminderSuperseded) {
    // 原始提醒还没落地就已被回复式提醒取代（TA 抢先开口说话了），落地即自删。
    return { next: state, effects: [{ kind: "deleteMessage", messageId: event.messageId }] };
  }
  state.messageIds.push(event.messageId);
  if (event.reminderKind === "original") state.reminderMessageId = event.messageId;
  else state.replyReminderMessageId = event.messageId;
  return { next: state, effects: [] };
}

export function transitionVerification(state: VerificationState | undefined, event: VerificationEvent): VerificationTransition {
  switch (event.type) {
    case "join":
      return handleJoin(state, event);
    case "left":
      // 人都走了，入群公告/发言不值得再刷一串删除调用；但带按钮的提醒必须删，
      // 不删就成了永远指向「已失效」的孤儿按钮。占位记录没有提醒可删。
      if (state?.kind === "pending") return { next: undefined, effects: [remindersOf(state)] };
      return { next: undefined, effects: [] };
    case "trackedMessage":
      return handleTrackedMessage(state, event);
    case "callback":
      return handleCallback(state, event);
    case "adminCheckResolved":
      if (state === undefined || state.kind !== "pending") return { next: state, effects: [] };
      // pending 记录创建时必然已被计入刷群统计（见 joinCreatesNewRecord），
      // 异步管理员核查事后才确证豁免，要撤销那次计数。
      return {
        next: { kind: "exempt", label: state.label, isBot: state.isBot },
        effects: [remindersOf(state), { kind: "retractJoinCount", joinedAt: state.joinedAt }],
      };
    case "verifyTimeout":
      return handleVerifyTimeout(state);
    case "timeoutInviterVerdict":
      return handleTimeoutInviterVerdict(state, event);
    case "reminderLanded":
      return handleReminderLanded(state, event);
    case "dedupeExpired":
      if (state?.kind === "exempt" || state?.kind === "kicked") return { next: undefined, effects: [] };
      return { next: state, effects: [] };
  }
}
