import { KICKED_REJOIN_GRACE_MS, VERIFICATION_TIMEOUT_MS } from "../../consts/antiRaid/verification";
import type {
  JoinEvent,
  PendingState,
  VerificationEffect,
  VerificationState,
  VerificationTransition,
} from "../../types/states/verification";
import { pendingUpdated, remindersOf } from "./shared";

/**
 * 汇总一次入群的全部豁免来源。关联频道评论区的直属评论和楼中楼回复都视为
 * 已实际参与讨论：Telegram 的入群/消息投递顺序不稳定，机器人也无法可靠
 * 反查线程根，因此只要在关联讨论线程观察到消息就豁免且不计刷群统计。
 */
function resolveJoinExemption(event: JoinEvent): { exempt: boolean; viaChannelComment: boolean } {
  if (event.identityExempt || event.actorSyncExempt) return { exempt: true, viaChannelComment: false };
  if (event.recentComment !== undefined) return { exempt: true, viaChannelComment: true };
  return { exempt: false, viaChannelComment: false };
}

/**
 * 本次入群是否会新建一条记录（= 计入刷群统计）。调用方必须先用它决定是否
 * recordJoin，再取 lockdownActive、再 dispatch——recordJoin 可能同步触发
 * 私密模式，越过阈值的那次入群自己就要走秒踢分支，顺序不能反。
 */
export function joinCreatesNewRecord(
  state: VerificationState | undefined,
  event: JoinEvent
): boolean {
  return (state === undefined || state.kind === "checkingInviter" || state.kind === "expelling") &&
    !resolveJoinExemption(event).exempt;
}

/** 处理双路入群投递、豁免、私密模式秒踢及普通验证窗口创建。 */
export function handleJoin(
  state: VerificationState | undefined,
  event: JoinEvent
): VerificationTransition {
  // 终态属于上一次物理入群。若 Telegram 已经送来一次新入群，就以新记录
  // 替换它；解释器捕获的旧终态会因对象同一性不再匹配而停止踢人，避免误伤
  // 同一 userId 的新一代成员记录。
  if (state?.kind === "checkingInviter" || state?.kind === "expelling") {
    // 被替换掉的那条记录还挂着自己的验证提醒，而它的 expel 收尾（本该顺手删掉
    // 这些消息）会因为对象同一性复核不过而整段跳过。提醒带按钮，按 AGENTS.md
    // 不能挂固定 30 秒删除，没有任何兜底路径——不在这里发这条 effect，群里就
    // 永久留着一个指向已不存在记录的「验证」按钮。
    const replaced: VerificationTransition = handleJoin(undefined, event);
    return {
      ...replaced,
      effects: [remindersOf(state.snapshot), ...replaced.effects],
    };
  }
  const { exempt, viaChannelComment }: { exempt: boolean; viaChannelComment: boolean } =
    resolveJoinExemption(event);
  const invitedByOther: boolean = event.actorId !== undefined && event.actorId !== event.memberId;

  if (exempt) {
    // 已有豁免占位时不动它，也不刷新其去重计时。
    if (state?.kind === "exempt") return { next: state, effects: [] };
    if (state?.kind === "kickPending") {
      if (state.executionStarted === true) {
        // Telegram 调用已经同步发出，后来的身份证明无法再撤销；等待请求结算
        // 后进入正常去重窗口，并留下诊断供管理员人工纠正。
        return {
          next: state,
          effects: [{ kind: "logUncancelableKickExemption", label: event.label }],
        };
      }
      // 删除公告等前置 await 尚未完成：用新对象替换执行 token，旧副作用在
      // kickMember 前的对象同一性复核会自行失效。
      return {
        next: { kind: "exempt", label: event.label, isBot: event.isBot },
        // 只撤销确实计过数的那一格：重进补踢建出的 kickPending 没有对应的
        // recordJoin（见 KickPendingState.countedJoinAt），凭 requestedAt 撤
        // 会删掉同一 tick 里另一名合法计数成员，把刷群窗口压到阈值之下。
        effects: state.countedJoinAt === undefined
          ? []
          : [{ kind: "retractJoinCount", joinedAt: state.countedJoinAt }],
      };
    }
    if (state?.kind === "kicked") {
      // 动作已经完成，无法撤销；保留占位并留下诊断供管理员人工纠正。
      return {
        next: state,
        effects: [{ kind: "logUncancelableKickExemption", label: event.label }],
      };
    }
    const effects: VerificationEffect[] = [];
    // 已开验证窗口后才确证豁免：撤销计数并删提醒，入群公告与成员发言保留。
    if (state !== undefined) {
      effects.push(remindersOf(state));
      effects.push({ kind: "retractJoinCount", joinedAt: state.joinedAt });
    }
    if (viaChannelComment && event.recentComment !== undefined) {
      effects.push({
        kind: "sendWelcome",
        variant: "channelComment",
        targetLabel: event.label,
        anchorMessageId: event.recentComment.messageId,
      });
    }
    return { next: { kind: "exempt", label: event.label, isBot: event.isBot }, effects };
  }

  if (state !== undefined) {
    // 同一次入群的另一路投递：只补充，不重启计时器/不再发提醒（幂等）。
    const effects: VerificationEffect[] = [];
    let snapshotChanged: boolean = false;
    if (event.announcementMessageId !== undefined) {
      if (state.kind === "kickPending" || state.kind === "kicked") {
        effects.push({ kind: "deleteMessage", messageId: event.announcementMessageId });
      } else if (state.kind === "pending" && state.announcementMessageId === undefined) {
        state.announcementMessageId = event.announcementMessageId;
        snapshotChanged = true;
      } else if (
        state.kind === "pending" &&
        state.announcementMessageId !== event.announcementMessageId
      ) {
        effects.push({ kind: "deleteMessage", messageId: event.announcementMessageId });
      }
    }
    if (
      (state.kind === "kickPending" || state.kind === "kicked") &&
      event.now - (state.kind === "kickPending" ? state.requestedAt : state.kickedAt) >
        KICKED_REJOIN_GRACE_MS
    ) {
      // 超过双路投递误差范围视为真正重进；新对象为新一代执行 token。
      return {
        next: {
          kind: "kickPending",
          label: state.label,
          isBot: state.isBot,
          requestedAt: event.now,
          announcementMessageId: event.announcementMessageId,
          effectStarted: false,
          executionStarted: false,
        },
        effects,
      };
    }
    if (state.kind === "pending" && invitedByOther && !event.adminCacheFresh) {
      if (state.invitedBy === undefined) {
        state.invitedBy = event.actorId;
        snapshotChanged = true;
      }
      effects.push({ kind: "startAdminCheck", actorId: event.actorId! });
    }
    if (state.kind === "pending" && snapshotChanged) return pendingUpdated(state, effects);
    return { next: state, effects };
  }

  if (event.lockdownActive) {
    return {
      next: {
        kind: "kickPending",
        label: event.label,
        isBot: event.isBot,
        requestedAt: event.now,
        countedJoinAt: event.now,
        announcementMessageId: event.announcementMessageId,
        effectStarted: false,
        executionStarted: false,
      },
      effects: [],
    };
  }

  const pending: PendingState = {
    kind: "pending",
    label: event.label,
    isBot: event.isBot,
    announcementMessageId: event.announcementMessageId,
    trackedMessageTimes: [],
    invitedBy: invitedByOther ? event.actorId : undefined,
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: event.now,
    expiresAt: event.now + VERIFICATION_TIMEOUT_MS,
  };
  const effects: VerificationEffect[] = [];
  if (invitedByOther) effects.push({ kind: "startAdminCheck", actorId: event.actorId! });
  effects.push({ kind: "sendReminder", label: event.label, isBot: event.isBot });
  return { next: pending, effects };
}
