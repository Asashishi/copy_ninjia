import { verificationEntries } from "../../../cache/workers/antiRaid/verification";
import {
  VERIFICATION_TERMINAL_RETRY_MAX_MS,
  VERIFICATION_TERMINAL_RETRY_MS,
  VERIFICATION_TIMEOUT_MS,
} from "../../../consts/antiRaid/verification";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../../../consts/telegram";
import { logger } from "../../../infra/logger";
import {
  deleteMessageAfter,
  deleteMessageWithOutcome,
  joinVerificationApi,
  kickChatMember,
  probeChatMembership,
  sendMessage,
} from "../../../infra/telegram";
import { formatMinSec } from "../../../libs/time";
import { verificationKey } from "../../../libs/verificationKey";
import type {
  VerificationDispatcher,
  VerificationEntry,
} from "../../../types/antiRaid/internal";
import type {
  ExpelSnapshot,
  VerificationEffect,
  VerificationState,
  VerificationTerminalState,
} from "../../../types/states/verification";
import type { DeleteMessageOutcome } from "../../../infra/telegram";
import { fetchAdminIds, freshAdminIds } from "../adminCache";
import { botCanDeleteIn } from "../botPermissions";

/** 终态原地标记变化后发布新 revision 的边界。 */
export type VerificationChangePublisher = (
  chatId: number,
  userId: number,
  previousWasPersisted: boolean
) => void;

interface RunRecheckInviterEffectParams {
  chatId: number;
  userId: number;
  effect: Extract<VerificationEffect, { kind: "recheckInviter" }>;
  dispatchVerification: VerificationDispatcher;
}

/** 只为仍匹配快照的 checkingInviter 终态执行拉人者终核。 */
export async function runRecheckInviterEffect({
  chatId,
  userId,
  effect,
  dispatchVerification,
}: RunRecheckInviterEffectParams): Promise<void> {
  const expectedState: VerificationState | undefined =
    verificationEntries.get(verificationKey(chatId, userId))?.state;
  if (
    expectedState?.kind !== "checkingInviter" ||
    expectedState.snapshot !== effect.snapshot
  ) return;
  await recheckInviterThenSettle({
    chatId,
    userId,
    inviterId: effect.inviterId,
    expectedState,
    dispatchVerification,
  });
}

interface RunExpelEffectParams {
  chatId: number;
  userId: number;
  effect: Extract<VerificationEffect, { kind: "expel" | "expelFlood" }>;
  dispatchVerification: VerificationDispatcher;
  publishVerificationChange: VerificationChangePublisher;
}

/** 执行仍匹配快照的处置终态，并为未结算动作安排有上限的指数退避。 */
export async function runExpelEffect({
  chatId,
  userId,
  effect,
  dispatchVerification,
  publishVerificationChange,
}: RunExpelEffectParams): Promise<void> {
  const key: string = verificationKey(chatId, userId);
  const expectedState: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  const reason: "timeout" | "flood" =
    effect.kind === "expelFlood" ? "flood" : "timeout";
  if (
    expectedState?.kind !== "expelling" ||
    expectedState.reason !== reason ||
    expectedState.snapshot !== effect.snapshot
  ) return;
  const settled: boolean = await expelMember({
    chatId,
    userId,
    snapshot: effect.snapshot,
    reason,
    expectedState,
    publishVerificationChange,
  });
  if (settled && verificationEntries.get(key)?.state === expectedState) {
    dispatchVerification(chatId, userId, { type: "expelSettled" });
    return;
  }
  if (
    verificationEntries.get(key)?.state !== expectedState ||
    expectedState.successNoticeSent === true
  ) return;

  // 成功播报已发送时等待落盘回执；只有未结算处置才进入本地指数退避。
  expectedState.executionStarted = false;
  const entry: VerificationEntry | undefined = verificationEntries.get(key);
  if (entry === undefined) return;
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  const retries: number = entry.terminalRetries ?? 0;
  entry.terminalRetries = retries + 1;
  entry.timer = setTimeout(
    (): void => dispatchVerification(chatId, userId, { type: "terminalPersisted" }),
    Math.min(
      VERIFICATION_TERMINAL_RETRY_MS * (2 ** retries),
      VERIFICATION_TERMINAL_RETRY_MAX_MS
    )
  );
}

interface RecheckInviterThenSettleParams {
  chatId: number;
  userId: number;
  inviterId: number;
  expectedState: VerificationTerminalState & { kind: "checkingInviter" };
  dispatchVerification: VerificationDispatcher;
}

/** 超时踢人前最终核对拉人者身份，避免管理员缓存过期造成误踢。 */
async function recheckInviterThenSettle({
  chatId,
  userId,
  inviterId,
  expectedState,
  dispatchVerification,
}: RecheckInviterThenSettleParams): Promise<void> {
  const cachedAdmins: Set<number> | undefined = freshAdminIds(chatId);
  let inviterIsAdmin: boolean = cachedAdmins?.has(inviterId) === true;
  if (cachedAdmins === undefined) {
    try {
      inviterIsAdmin = (await fetchAdminIds(chatId)).has(inviterId);
    } catch (error: unknown) {
      logger.error(
        `Error rechecking admin-invite exemption before expiring verification in chat ${chatId}:`,
        error
      );
    }
  }
  if (verificationEntries.get(verificationKey(chatId, userId))?.state === expectedState) {
    dispatchVerification(chatId, userId, {
      type: "timeoutInviterVerdict",
      inviterIsAdmin,
    });
  }
}

interface ExpelMemberParams {
  chatId: number;
  userId: number;
  snapshot: ExpelSnapshot;
  reason: "timeout" | "flood";
  expectedState: VerificationTerminalState & { kind: "expelling" };
  publishVerificationChange: VerificationChangePublisher;
}

type ExpelRemovalOutcome = "kicked" | "absent" | "unconfirmed" | "failed" | "stale";

/**
 * 跨落盘重放的终态在踢人前重新确认成员仍在群里。查询失败不等于不在群，
 * 也不足以授权破坏性操作；每个 await 后都用状态对象同一性拒绝迟到结果。
 */
async function kickPresentMember(
  chatId: number,
  userId: number,
  isCurrent: () => boolean
): Promise<ExpelRemovalOutcome> {
  const present: boolean | undefined =
    await probeChatMembership(chatId, userId, joinVerificationApi);
  if (present === false) return "absent";
  if (present === undefined) return "unconfirmed";
  if (!isCurrent()) return "stale";
  return await kickChatMember(chatId, userId, joinVerificationApi) ? "kicked" : "failed";
}

/** 清理机器人验证痕迹并按现查结果踢出，成功播报先写入新 revision 再收尾。 */
async function expelMember({
  chatId,
  userId,
  snapshot,
  reason,
  expectedState,
  publishVerificationChange,
}: ExpelMemberParams): Promise<boolean> {
  const stillCurrent = (): boolean =>
    verificationEntries.get(verificationKey(chatId, userId))?.state === expectedState;
  let removalOutcome: ExpelRemovalOutcome = "failed";
  if (!stillCurrent()) return false;
  if (reason === "flood") {
    removalOutcome = await kickPresentMember(chatId, userId, stillCurrent);
    if (removalOutcome === "stale") return false;
  }

  // 只清理机器人/Telegram 制造的验证痕迹，不删除成员自己的发言。
  const cleanupMessageIds: number[] = [];
  for (const messageId of [
    snapshot.announcementMessageId,
    snapshot.reminderMessageId,
    snapshot.replyReminderMessageId,
  ]) {
    if (messageId !== undefined && !cleanupMessageIds.includes(messageId)) {
      cleanupMessageIds.push(messageId);
    }
  }
  let missedCleanup: number = 0;
  let permissionDenied: boolean = false;
  if (cleanupMessageIds.length > 0 && botCanDeleteIn(chatId) === false) {
    missedCleanup = cleanupMessageIds.length;
    permissionDenied = true;
  } else {
    for (const messageId of cleanupMessageIds) {
      if (!stillCurrent()) return false;
      const outcome: DeleteMessageOutcome =
        await deleteMessageWithOutcome(chatId, messageId, joinVerificationApi);
      if (outcome === "deleted" || outcome === "gone") continue;
      missedCleanup++;
      if (outcome === "forbidden") permissionDenied = true;
    }
  }
  const cleanupCleared: boolean = missedCleanup === 0;
  if (!cleanupCleared) {
    logger.error(
      `Verification expel could not delete ${missedCleanup} of ${cleanupMessageIds.length} ` +
      `verification-owned message(s) for user ${userId} in chat ${chatId}: ` +
      (permissionDenied
        ? "Telegram denied the deletion, so the bot most likely lacks can_delete_messages."
        : "the deletions failed without a permission error, so this is most likely transient.")
    );
  }
  if (!stillCurrent()) return false;
  if (reason === "timeout") {
    removalOutcome = await kickPresentMember(chatId, userId, stillCurrent);
    if (removalOutcome === "stale") return false;
  }
  if (removalOutcome === "absent") return stillCurrent();

  const kicked: boolean = removalOutcome === "kicked";
  const noticeText: string = !kicked
    ? removalOutcome === "unconfirmed"
      ? `啧，本天才没能确认 ${snapshot.label} 现在还在不在群里，所以这次没有贸然踢人；会继续重试，杂鱼管理员也检查下网络和本天才的成员查询权限！`
      : reason === "flood"
        ? `啧，${snapshot.label} 没完成验证还在刷屏，本天才想把 TA 踢出去却没踢动……管理员快检查本天才的封禁权限！`
        : `啧，${snapshot.label} 超时没验证，本天才本想把 TA 踢出去，结果居然没踢动……肯定是哪个杂鱼管理员没给本天才封禁权限！快去检查，不然只能你们自己动手请 TA 出去咯♡`
    : !cleanupCleared
      ? permissionDenied
        ? `啧，${snapshot.label} 没通过验证，本天才把 TA 踢出去了，可本天才自己的 ${cleanupMessageIds.length} 条验证消息里还有 ${missedCleanup} 条删不动……杂鱼管理员快看看本天才有没有删消息的权限♡`
        : `啧，${snapshot.label} 没通过验证，本天才把 TA 踢出去了，不过本天才自己的验证消息还有 ${missedCleanup} 条没清掉，多半是网络抽了一下♡`
      : reason === "flood"
        ? `啧，${snapshot.label} 验证都没过就开始刷屏，本天才已经把 TA 踢出去啦♡`
        : snapshot.isBot
          ? `啧，${formatMinSec(VERIFICATION_TIMEOUT_MS)} 过去了都没有白名单大人愿意为机器人 ${snapshot.label} 作保，本天才把这个来路不明的铁疙瘩踢出去啦♡`
          : `啧，${snapshot.label} 磨磨蹭蹭 ${formatMinSec(VERIFICATION_TIMEOUT_MS)} 都点不出验证按钮，本天才把 TA 踢出去啦，杂鱼动作太慢咯♡`;
  if (!stillCurrent()) return false;

  // 三类诊断分别持久化，网络探测失败不能占掉权限失败的唯一告警名额。
  const shouldSendNotice: boolean = kicked
    ? expectedState.successNoticeSent !== true
    : removalOutcome === "unconfirmed"
      ? expectedState.unconfirmedNoticeSent !== true
      : expectedState.failureNoticeSent !== true;
  const noticeMessageId: number | undefined = shouldSendNotice
    ? await sendMessage({
      chatId,
      text: noticeText,
      api: joinVerificationApi,
    })
    : undefined;
  if (!kicked && shouldSendNotice && noticeMessageId !== undefined) {
    if (removalOutcome === "unconfirmed") expectedState.unconfirmedNoticeSent = true;
    else expectedState.failureNoticeSent = true;
    publishVerificationChange(chatId, userId, true);
  }
  if (noticeMessageId !== undefined && kicked) {
    deleteMessageAfter({
      chatId,
      messageId: noticeMessageId,
      delayMs: KICK_NOTICE_AUTO_DELETE_MS,
      api: joinVerificationApi,
    });
    expectedState.successNoticeSent = true;
    publishVerificationChange(chatId, userId, true);
    return false;
  }
  return kicked && stillCurrent();
}
