import { ANTI_RAID_PER_MINUTE_LIMIT, JOIN_WINDOW_MS } from "../consts/antiRaid/lockdown";
import { KICKED_REJOIN_GRACE_MS, VERIFICATION_TIMEOUT_MS } from "../consts/antiRaid/verification";
import type { VerificationEffect, VerificationTransition } from "./verification/effects";
import type { JoinEvent, VerificationEvent } from "./verification/events";
import type { ExpelSnapshot, PendingState, VerificationState } from "./verification/state";

export type { VerificationEffect, VerificationTransition } from "./verification/effects";
export type { JoinEvent, VerificationEvent } from "./verification/events";
export type {
  ExemptState,
  ExpelSnapshot,
  KickedState,
  PendingState,
  RecentComment,
  VerificationState,
} from "./verification/state";

/**
 * 入群验证生命周期的显式状态机（纯逻辑，不做 I/O、不持有计时器）。状态模型、
 * 输入事件和输出副作用分别位于 verification/*；所有状态转移仍集中在本文件，
 * 让状态图和跨事件不变量可以在一个位置完整审计。
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
 * EXEMPT/KICKED 是 chat_member 与服务消息双路投递之间的短期去重占位。
 * 同 kind 字段更新原地修改并原样返回；kind 变化才返回新对象，解释器据此管理
 * 计时器，异步回调也依赖对象同一性拒绝迟到结果。
 */

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
    let snapshotChanged: boolean = false;
    if (event.announcementMessageId !== undefined) {
      if (state.kind === "kicked") {
        // 人已在私密模式下被踢出，姗姗来迟的入群公告顺手清理。
        effects.push({ kind: "deleteMessage", messageId: event.announcementMessageId });
      } else if (state.kind === "pending") {
        state.messageIds.push(event.announcementMessageId);
        snapshotChanged = true;
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
      if (state.invitedBy === undefined) {
        state.invitedBy = event.actorId;
        snapshotChanged = true;
      }
      effects.push({ kind: "startAdminCheck", actorId: event.actorId! });
    }
    return { next: state, effects, snapshotChanged };
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
    trackedMessageTimes: [],
    invitedBy: invitedByOther ? event.actorId : undefined,
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: event.now,
    expiresAt: event.now + VERIFICATION_TIMEOUT_MS,
  };
  const effects: VerificationEffect[] = [];
  if (event.recentComment !== undefined) {
    // 楼中楼回复先到、入群更新后到：验证提醒直接以回复 TA 那条评论的形式发
    // （频道侧看得到按钮），原始独立提醒不再发。评论本身补进追踪，超时一并清理。
    pending.messageIds.push(event.recentComment.messageId);
    pending.trackedMessageTimes.push(event.recentComment.observedAt);
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
  event: { messageId: number; inCommentThread: boolean; repliesToChannelPost: boolean; now: number }
): VerificationTransition {
  // 占位记录不是真的在等验证；无记录的消息与验证无关。
  if (state?.kind !== "pending") return { next: state, effects: [] };

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

  // 频道帖子直属评论在上方先完成豁免，不能进入刷屏计数。其余待验证消息按
  // 成员自己的滑动窗口统计；第 46 条同步删除状态，迟到事件因查无记录不会
  // 再产生第二次踢人。messageIds 不截断，确保已制造的痕迹仍全部进入清理。
  const cutoff: number = event.now - JOIN_WINDOW_MS;
  state.trackedMessageTimes = state.trackedMessageTimes.filter((timestamp) => timestamp > cutoff);
  state.trackedMessageTimes.push(event.now);
  state.messageIds.push(event.messageId);
  if (state.trackedMessageTimes.length > ANTI_RAID_PER_MINUTE_LIMIT) {
    return { next: undefined, effects: [{ kind: "expelFlood", snapshot: snapshotOf(state) }] };
  }
  // TA 开口说话了还没点按钮：把提醒补发为回复 TA 消息的形式（只补发一次）。
  if (state.replyReminderRequested) return { next: state, effects: [], snapshotChanged: true };
  state.replyReminderRequested = true;
  state.welcomeAnchorMessageId = event.messageId;
  state.reminderSuperseded = true;

  const effects: VerificationEffect[] = [];
  // 楼中楼：TA 在频道侧此刻才看得到按钮，验证计时重新给满；普通发言不重置。
  // 排在列表最前——解释器按序执行且会 await 删除调用，重置不能被限流队列拖后。
  if (event.inCommentThread) {
    state.expiresAt = event.now + VERIFICATION_TIMEOUT_MS;
    effects.push({ kind: "restartVerifyTimer" });
  }
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
  return { next: state, effects, snapshotChanged: true };
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

  if (state?.kind !== "pending") {
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
  if (state?.kind !== "pending") return { next: state, effects: [] };
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
  if (state?.kind !== "pending") {
    return { next: state, effects: [{ kind: "deleteMessage", messageId: event.messageId }] };
  }
  if (event.reminderKind === "original" && state.reminderSuperseded) {
    // 原始提醒还没落地就已被回复式提醒取代（TA 抢先开口说话了），落地即自删。
    return { next: state, effects: [{ kind: "deleteMessage", messageId: event.messageId }] };
  }
  state.messageIds.push(event.messageId);
  if (event.reminderKind === "original") state.reminderMessageId = event.messageId;
  else state.replyReminderMessageId = event.messageId;
  return { next: state, effects: [], snapshotChanged: true };
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
      if (state?.kind !== "pending") return { next: state, effects: [] };
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
