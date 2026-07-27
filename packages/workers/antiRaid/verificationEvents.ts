import { logger } from "../../infra/logger";
import { PRIVILEGED_USERS_ID } from "../../infra/config";
import {
  answerCallbackQuery,
  joinVerificationApi,
} from "../../infra/telegram";
import { lockdownEntries } from "../../cache/antiRaid/lockdown";
import {
  threadCommentConfirmations,
  verificationEntries,
} from "../../cache/antiRaid/verification";
import { formatUserLabel } from "../../users/userLabel";
import { verificationKey } from "../../libs/verificationKey";
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
  const entryState: VerificationState | undefined =
    verificationEntries.get(verificationKey(chatId, member.id))?.state;
  const invitedByOther: boolean =
    message.actorId !== undefined && message.actorId !== member.id;
  const event: JoinEvent = {
    type: "join",
    memberId: member.id,
    label: memberLabel(member),
    isBot: member.isBot === true,
    announcementMessageId: message.announcementMessageId,
    actorId: message.actorId,
    identityExempt: message.exempt === true,
    // 私密模式期间只认同步命中的白名单或新鲜管理员缓存。
    actorSyncExempt: invitedByOther &&
      (
        PRIVILEGED_USERS_ID.includes(message.actorId!) ||
        freshAdminIds(chatId)?.has(message.actorId!) === true
      ),
    adminCacheFresh: freshAdminIds(chatId) !== undefined,
    lockdownActive: false,
    recentComment: takeRecentComment(chatId, member.id),
    now: Date.now(),
  };
  if (joinCreatesNewRecord(entryState, event)) {
    // joinedAt 与滑动窗口使用同一个时间戳，retractJoin 才能按值精确撤销。
    recordJoin(chatId, event.now);
  }
  event.lockdownActive = lockdownEntries.has(chatId);
  dispatchVerification(chatId, member.id, event);

  // 把早到的楼中楼确认绑定到本次 join 的精确状态对象。
  const key: string = verificationKey(chatId, member.id);
  const currentState: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  const confirmations: Set<ThreadCommentConfirmation> | undefined = threadCommentConfirmations.get(key);
  if (confirmations && currentState !== undefined) {
    for (const confirmation of confirmations) {
      if (!confirmation.boundToJoin) {
        confirmation.expectedState = currentState;
        confirmation.boundToJoin = true;
      }
    }
  }
}

interface ConfirmedCommentParams {
  message: TrackedChatMessage;
  observedAt: number;
  dispatchVerification: VerificationDispatcher;
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
}: ConfirmedCommentParams): void {
  const key: string = verificationKey(message.chatId, message.userId);
  const expectedState: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  const confirmation: ThreadCommentConfirmation = {
    messageId: message.messageId,
    observedAt,
    expectedState,
    boundToJoin: expectedState !== undefined,
  };
  let confirmations: Set<ThreadCommentConfirmation> | undefined = threadCommentConfirmations.get(key);
  if (!confirmations) {
    confirmations = new Set();
    threadCommentConfirmations.set(key, confirmations);
  }
  confirmations.add(confirmation);

  void trackAntiRaidTask({
    task: fetchChatHasLinkedChannel(message.chatId).then((hasLinked: boolean | undefined): void => {
      const activeConfirmations: Set<ThreadCommentConfirmation> | undefined = threadCommentConfirmations.get(key);
      activeConfirmations?.delete(confirmation);
      if (activeConfirmations?.size === 0) threadCommentConfirmations.delete(key);
      if (hasLinked !== true) return;

      const currentState: VerificationState | undefined =
        verificationEntries.get(key)?.state;
      if (currentState !== confirmation.expectedState) return;
      if (currentState === undefined && confirmation.boundToJoin) return;
      rememberOrDispatchConfirmedComment({
        message,
        observedAt: confirmation.observedAt,
        dispatchVerification,
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
    dispatchVerification(message.chatId, message.userId, {
      type: "trackedMessage",
      messageId: message.messageId,
      inCommentThread: false,
      now: observedAt,
    });
    if (cachedHasLinked === undefined) {
      confirmThreadComment({
        message,
        observedAt,
        dispatchVerification,
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
    fromIsPrivileged: PRIVILEGED_USERS_ID.includes(message.from.id),
    fromLabel: memberLabel(message.from),
  });
}
