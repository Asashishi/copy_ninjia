import { logger } from "../../infra/logger";
import { answerCallbackQuery, joinVerificationApi } from "../../infra/telegram";
import { lockdownEntries } from "../../cache/workers/antiRaid/lockdown";
import {
  threadCommentConfirmations,
  verificationEntries,
} from "../../cache/workers/antiRaid/verification";
import { formatUserLabel } from "../../users/userLabel";
import { verificationKey } from "../../libs/verificationKey";
import { THREAD_COMMENT_CONFIRMATION_MAX } from "../../consts/antiRaid/cache";
import type {
  AntiRaidMember,
  NewMemberMessage,
  TrackedChatMessage,
  VerifyCallbackMessage,
} from "../../types/antiRaid";
import type {
  ThreadCommentConfirmation,
  VerificationDispatcher,
} from "../../types/antiRaid/internal";
import { joinCreatesNewRecord } from "../../states/verification";
import type {
  JoinEvent,
  VerificationState,
} from "../../types/states/verification";
import { freshAdminIds } from "./adminCache";
import { trackAntiRaidTask } from "./taskTracker";
import {
  cachedChatHasLinkedChannel,
  fetchChatHasLinkedChannel,
} from "./linkedChannel";
import { recordJoin } from "./lockdownRuntime";
import {
  rememberRecentComment,
  takeRecentComment,
} from "./recentComments";

/**
 * Anti-Raid Worker 入站消息到纯验证状态机事件的翻译层。
 * 这里预计算管理员、lockdown 与评论区线索，状态转移仍由 dispatcher 统一执行。
 */

function memberLabel(member: AntiRaidMember): string {
  return formatUserLabel({
    id: member.id,
    username: member.username,
    first_name: member.first_name,
  });
}

export interface HandleJoinEventParams {
  message: NewMemberMessage;
  dispatchVerification: VerificationDispatcher;
}

export function handleJoinEvent({
  message,
  dispatchVerification,
}: HandleJoinEventParams): void {
  const { chatId, member }: NewMemberMessage = message;
  const key: string = verificationKey(chatId, member.id);
  const entryState: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  const actorId: number | undefined = message.actorId;
  const invitedByOther: boolean =
    actorId !== undefined && actorId !== member.id;
  const adminIds: Set<number> | undefined = freshAdminIds(chatId);
  const event: JoinEvent = {
    type: "join",
    memberId: member.id,
    label: memberLabel(member),
    isBot: member.isBot === true,
    announcementMessageId: message.announcementMessageId,
    actorId,
    identityExempt: message.exempt === true,
    // 私密模式期间只认同步命中的白名单或新鲜管理员缓存。
    actorSyncExempt: invitedByOther &&
      (
        message.actorIsWhitelisted ||
        (actorId !== undefined && adminIds?.has(actorId) === true)
      ),
    adminCacheFresh: adminIds !== undefined,
    lockdownActive: lockdownEntries.has(chatId),
    recentComment: takeRecentComment(chatId, member.id),
    now: Date.now(),
  };
  if (joinCreatesNewRecord(entryState, event)) {
    // joinedAt 与滑动窗口使用同一个时间戳，retractJoin 才能按值精确撤销。
    recordJoin(chatId, event.now);
  }
  dispatchVerification(chatId, member.id, event);

  // 把早到的楼中楼确认绑定到本次 join 的精确状态对象。
  const currentState: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  const confirmation: ThreadCommentConfirmation | undefined =
    threadCommentConfirmations.get(key);
  if (
    confirmation !== undefined &&
    currentState !== undefined &&
    !confirmation.boundToJoin
  ) {
    confirmation.expectedState = currentState;
    confirmation.boundToJoin = true;
  }
}

interface ConfirmedCommentParams {
  message: TrackedChatMessage;
  observedAt: number;
  dispatchVerification: VerificationDispatcher;
}

interface ConfirmThreadCommentParams extends ConfirmedCommentParams {
  key: string;
  allowFloodTerminalExemption: boolean;
}

function rememberOrDispatchConfirmedComment({
  message,
  observedAt,
  dispatchVerification,
}: ConfirmedCommentParams): void {
  const key: string = verificationKey(message.chatId, message.userId);
  if (!verificationEntries.has(key)) {
    rememberRecentComment({
      chatId: message.chatId,
      userId: message.userId,
      messageId: message.messageId,
      observedAt,
    });
    return;
  }
  dispatchVerification(message.chatId, message.userId, {
    type: "trackedMessage",
    messageId: message.messageId,
    inCommentThread: true,
    now: observedAt,
  });
}

function confirmThreadComment({
  message,
  observedAt,
  dispatchVerification,
  key,
  allowFloodTerminalExemption,
}: ConfirmThreadCommentParams): void {
  const expectedState: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  const existing: ThreadCommentConfirmation | undefined =
    threadCommentConfirmations.get(key);
  if (existing !== undefined) {
    const sameStateToken: boolean = existing.expectedState === expectedState;
    existing.messageId = message.messageId;
    existing.observedAt = observedAt;
    existing.expectedState = expectedState;
    existing.boundToJoin = expectedState !== undefined;
    existing.allowFloodTerminalExemption =
      allowFloodTerminalExemption ||
      (
        sameStateToken &&
        existing.allowFloodTerminalExemption
      );
    return;
  }
  // 淘汰 Map 项并不能释放已挂到共享 Promise 上的 then closure；满载时必须
  // 直接拒绝新 owner，才是真正的全局常驻上限。该消息已按普通消息 fail closed。
  if (
    threadCommentConfirmations.size >=
    THREAD_COMMENT_CONFIRMATION_MAX
  ) {
    return;
  }
  const confirmation: ThreadCommentConfirmation = {
    messageId: message.messageId,
    observedAt,
    expectedState,
    boundToJoin: expectedState !== undefined,
    allowFloodTerminalExemption,
  };
  threadCommentConfirmations.set(key, confirmation);

  void trackAntiRaidTask({
    task: fetchChatHasLinkedChannel(message.chatId).then((hasLinked: boolean | undefined): void => {
      // 群停管、adopt、容量淘汰或同键新 owner 都会替换/删除 token；迟到结果
      // 必须在写 recent comment 或回投状态机之前止步。
      if (threadCommentConfirmations.get(key) !== confirmation) return;
      threadCommentConfirmations.delete(key);
      if (hasLinked !== true) return;

      const currentState: VerificationState | undefined =
        verificationEntries.get(key)?.state;
      if (currentState !== confirmation.expectedState) return;
      if (currentState === undefined && confirmation.boundToJoin) return;
      if (currentState === undefined) {
        rememberRecentComment({
          chatId: message.chatId,
          userId: message.userId,
          messageId: confirmation.messageId,
          observedAt: confirmation.observedAt,
        });
        return;
      }
      dispatchVerification(message.chatId, message.userId, {
        type: "confirmedThreadComment",
        messageId: confirmation.messageId,
        now: confirmation.observedAt,
        allowFloodTerminalExemption:
          confirmation.allowFloodTerminalExemption,
      });
    }),
  });
}

export interface HandleTrackedMessageEventParams {
  message: TrackedChatMessage;
  dispatchVerification: VerificationDispatcher;
}

export function handleTrackedMessageEvent({
  message,
  dispatchVerification,
}: HandleTrackedMessageEventParams): void {
  const observedAt: number = Date.now();
  if (message.repliesToChannelPost === true) {
    rememberOrDispatchConfirmedComment({
      message,
      observedAt,
      dispatchVerification,
    });
    return;
  }

  if (message.isThreadReply === true) {
    const key: string = verificationKey(message.chatId, message.userId);
    const cachedHasLinked: boolean | undefined =
      cachedChatHasLinkedChannel(message.chatId);
    if (cachedHasLinked === true) {
      rememberOrDispatchConfirmedComment({
        message,
        observedAt,
        dispatchVerification,
      });
      return;
    }
    // 冷缓存先 fail closed；确认有关联频道后再以状态对象同一性升级为豁免。
    const previousState: VerificationState | undefined =
      verificationEntries.get(key)?.state;
    dispatchVerification(message.chatId, message.userId, {
      type: "trackedMessage",
      messageId: message.messageId,
      inCommentThread: false,
      now: observedAt,
    });
    if (cachedHasLinked === undefined) {
      const currentState: VerificationState | undefined =
        verificationEntries.get(key)?.state;
      confirmThreadComment({
        message,
        observedAt,
        dispatchVerification,
        key,
        allowFloodTerminalExemption:
          previousState?.kind === "pending" &&
          currentState?.kind === "expelling" &&
          currentState.reason === "flood",
      });
    }
    return;
  }

  dispatchVerification(message.chatId, message.userId, {
    type: "trackedMessage",
    messageId: message.messageId,
    inCommentThread: false,
    now: observedAt,
  });
}

export interface HandleVerificationCallbackEventParams {
  message: VerifyCallbackMessage;
  dispatchVerification: VerificationDispatcher;
}

export function handleVerificationCallbackEvent({
  message,
  dispatchVerification,
}: HandleVerificationCallbackEventParams): void {
  if (message.chatId === undefined) {
    void trackAntiRaidTask({
      task: answerCallbackQuery({
        callbackQueryId: message.callbackQueryId,
        api: joinVerificationApi,
      }).catch((error: unknown): void => {
        logger.error("Error answering join verification callback:", error);
      }),
    });
    return;
  }
  dispatchVerification(message.chatId, message.targetUserId, {
    type: "callback",
    callbackQueryId: message.callbackQueryId,
    isSelf: message.from.id === message.targetUserId,
    fromIsPrivileged: message.fromIsWhitelisted,
    fromLabel: memberLabel(message.from),
  });
}
