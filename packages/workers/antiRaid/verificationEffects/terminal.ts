import { workerAtmosphere } from "../atmosphere";
import type { TelegramWorkerTemporaryMessageResult } from "../../../types/telegramWorker";
import { sendTemporaryMessageFromMain } from "../../../infra/telegram/workerClient";
import { runTelegramAction } from "../../../infra/telegram/actions/core";
import { verificationEntries } from "../../../cache/workers/antiRaid/verification";
import { logger } from "../../../infra/logger";
import {
  deleteMessageWithOutcome,
  kickChatMemberWithOutcome,
  probeChatMembership,
  telegramApi,
} from "../../../infra/telegram";
import { verificationKey } from "../../../libs/verificationKey";
import { isMessageDeletionSettled } from "../../../libs/messageDeletion";
import type { VerificationDispatcher } from "../../../types/antiRaid/internal";
import type {
  ExpelSnapshot,
  VerificationEffect,
  VerificationState,
  VerificationTerminalState,
} from "../../../types/states/verification";
import type { KickChatMemberOutcome } from "../../../infra/telegram";
import type { DeleteMessageOutcome } from "../../../types/telegram";
import { isChatAdmin } from "../adminCache";
import { botCanDeleteIn, botCanRestrictIn } from "../botPermissions";
import { resolveChatIsSupergroup } from "../chatKind";
import { scheduleTerminalRetry } from "./retry";
import { expelNoticeText } from "./expelNotice";
import type { ExpelRemovalOutcome, VerificationCleanupResult } from "../../../types/antiRaid/verification";

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

/** retryTerminalLater 的入参。 */
interface RetryTerminalLaterParams {
  readonly chatId: number;
  readonly userId: number;
  readonly state: VerificationTerminalState;
  readonly dispatchVerification: VerificationDispatcher;
}

/**
 * 终态动作这一轮没有结算：重新允许权威豁免替换 token，再按条目的退避序列排一次
 * terminalPersisted 重试（见 retry.ts 的 scheduleTerminalRetry）。
 */
function retryTerminalLater({
  chatId,
  userId,
  state,
  dispatchVerification,
}: RetryTerminalLaterParams): void {
  state.executionStarted = false;
  scheduleTerminalRetry({
    chatId,
    userId,
    state,
    event: { type: "terminalPersisted" },
    dispatchVerification,
  });
}

interface RunExpelEffectParams {
  chatId: number;
  userId: number;
  effect: Extract<VerificationEffect, { kind: "expel" | "expelFlood" }>;
  dispatchVerification: VerificationDispatcher;
}

/** 执行仍匹配快照的处置终态，并为未结算动作安排有上限的指数退避。 */
export async function runExpelEffect({
  chatId,
  userId,
  effect,
  dispatchVerification,
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
  // 权限镜像是三态：只有确证没有限制成员权限时才跳过踢人请求；未知交给 Telegram 裁判。
  // 每轮保留一次 O(1) 判定并继续退避，权限恢复后下一轮重新执行。
  //
  // 短路的只是踢人请求，不是成员探测与诊断：第一次进这条分支时照常走一遍 expelMember——
  // 探测成员是否还在群里（已离群即结算，不占记录）、清机器人自己的验证消息、发出点名
  // 封禁权限的群内提示、记一行日志。之后由 failureNoticeSent 闩住：它随快照持久化，
  // Worker 重生与进程重启后也不会重发，每轮重试只发一次成员探测并推进本地退避；探测到
  // 已自行离群时直接结算，removalConfirmed 记着「上一轮已踢掉、战报未发出」时交给 expelMember
  // 补发战报。提示自己没发出去时不置位（见 expelMember 收尾），下一轮重来。
  //
  // 清理还欠着账（cleanupSettled 为假）时不短路：照常走 expelMember，踢人被 canRestrict
  // 短路、播报被 failureNoticeSent 短路、确证没有删除权限时删除被 botCanDeleteIn 短路，
  // 只有仍能删且需要重试的清理才会发出请求。
  const permissionBlocked: boolean = botCanRestrictIn(chatId) === false;
  if (
    permissionBlocked &&
    expectedState.failureNoticeSent === true &&
    expectedState.cleanupSettled === true
  ) {
    const removal: ExpelRemovalOutcome = await probeBlockedMember(
      chatId,
      userId,
      (): boolean => verificationEntries.get(key)?.state === expectedState
    );
    if (removal === "stale") return;
    if (removal !== "absent") {
      retryTerminalLater({ chatId, userId, state: expectedState, dispatchVerification });
      return;
    }
    if (expectedState.removalConfirmed !== true) {
      dispatchVerification(chatId, userId, { type: "expelSettled" });
      return;
    }
  }
  if (permissionBlocked) {
    logger.error(
      `Verification expel for user ${userId} in chat ${chatId} cannot kick: the bot is confirmed to lack ` +
      "can_restrict_members there. Cleaning up the bot's own verification messages and notifying the chat once, then " +
      "backing off with only a membership probe per retry until the member leaves or the permission returns."
    );
  }
  const settled: boolean = await expelMember({
    chatId,
    userId,
    snapshot: effect.snapshot,
    reason,
    canRestrict: !permissionBlocked,
    expectedState,
    dispatchVerification,
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
  retryTerminalLater({ chatId, userId, state: expectedState, dispatchVerification });
}

interface RecheckInviterThenSettleParams {
  chatId: number;
  userId: number;
  inviterId: number;
  expectedState: VerificationTerminalState & { kind: "checkingInviter" };
  dispatchVerification: VerificationDispatcher;
}

/** 超时踢人前核对拉人者身份；未知时保留终态并按既有执行预算退避。 */
async function recheckInviterThenSettle({
  chatId,
  userId,
  inviterId,
  expectedState,
  dispatchVerification,
}: RecheckInviterThenSettleParams): Promise<void> {
  const inviterIsAdmin: boolean | undefined = await isChatAdmin(chatId, inviterId, "verification inviter");
  if (verificationEntries.get(verificationKey(chatId, userId))?.state !== expectedState) return;
  if (inviterIsAdmin === undefined) {
    retryTerminalLater({ chatId, userId, state: expectedState, dispatchVerification });
    return;
  }
  dispatchVerification(chatId, userId, { type: "timeoutInviterVerdict", inviterIsAdmin });
}

interface ExpelMemberParams {
  chatId: number;
  userId: number;
  snapshot: ExpelSnapshot;
  reason: "timeout" | "flood";
  /**
   * 确证没有限制成员权限时为 false：只做成员探测、不发踢人请求（见 probeBlockedMember），
   * 其余（清理机器人自己的验证消息、战报措辞、诊断名额）全部照旧；成员仍在群里或查询
   * 失败时结局按「没踢动」结算。
   */
  canRestrict: boolean;
  expectedState: VerificationTerminalState & { kind: "expelling" };
  dispatchVerification: VerificationDispatcher;
}

/**
 * 跨落盘重放的终态在踢人前重新确认成员仍在群里。查询失败不等于不在群，
 * 也不足以授权破坏性操作；每个 await 后都用状态对象同一性拒绝迟到结果。
 */
async function kickPresentMember(
  chatId: number,
  userId: number,
  isCurrent: () => boolean
): Promise<ExpelRemovalOutcome> {
  const isSupergroup: boolean | undefined =
    await resolveChatIsSupergroup(chatId);
  if (!isCurrent()) return "stale";
  if (isSupergroup === undefined) return "kindUnknown";
  const present: boolean | undefined =
    await probeChatMembership(chatId, userId, telegramApi);
  if (present === false) return "absent";
  if (present === undefined) return "unconfirmed";
  if (!isCurrent()) return "stale";
  const outcome: KickChatMemberOutcome = await kickChatMemberWithOutcome({
    chatId,
    userId,
    isSupergroup,
    api: telegramApi,
  });
  if (outcome === "kicked") return "kicked";
  if (outcome === "absent") return "absent";
  return "failed";
}

/**
 * 确证没有限制成员权限时只探测成员、不发踢人请求：已离群为 absent，在群或查询失败为
 * failed（与请求被拒的结局一致），探测期间状态被替换为 stale。
 */
async function probeBlockedMember(
  chatId: number,
  userId: number,
  isCurrent: () => boolean
): Promise<ExpelRemovalOutcome> {
  const present: boolean | undefined =
    await probeChatMembership(chatId, userId, telegramApi);
  if (!isCurrent()) return "stale";
  return present === false ? "absent" : "failed";
}

interface DeleteVerificationMessagesOptions {
  readonly chatId: number;
  readonly userId: number;
  readonly snapshot: ExpelSnapshot;
  /** 状态对象同一性检查；每次删除前调用，拒绝替换后的迟到处理。 */
  readonly isCurrent: () => boolean;
}

/**
 * 删除机器人/Telegram 制造的验证消息（入群公告、提醒、回复提醒，去重），不删除成员自己的发言。
 * 确证没有删除权限时不发请求、整批记为未删；有未删的消息时按是否被拒绝记一条错误日志。
 * 删除途中状态被替换时返回 null。
 */
async function deleteVerificationMessages({
  chatId,
  userId,
  snapshot,
  isCurrent,
}: DeleteVerificationMessagesOptions): Promise<VerificationCleanupResult | null> {
  const messageIds: number[] = [];
  for (const messageId of [
    snapshot.announcementMessageId,
    snapshot.reminderMessageId,
    snapshot.replyReminderMessageId,
  ]) {
    if (messageId !== undefined && !messageIds.includes(messageId)) {
      messageIds.push(messageId);
    }
  }
  let missed: number = 0;
  let permissionDenied: boolean = false;
  if (messageIds.length > 0 && botCanDeleteIn(chatId) === false) {
    missed = messageIds.length;
    permissionDenied = true;
  } else {
    for (const messageId of messageIds) {
      if (!isCurrent()) return null;
      const outcome: DeleteMessageOutcome =
        await deleteMessageWithOutcome(chatId, messageId, telegramApi);
      if (isMessageDeletionSettled(outcome)) continue;
      missed++;
      if (outcome === "forbidden") permissionDenied = true;
    }
  }
  if (missed > 0) {
    logger.error(
      `Verification expel could not delete ${missed} of ${messageIds.length} ` +
      `verification-owned message(s) for user ${userId} in chat ${chatId}: ` +
      (permissionDenied
        ? "Telegram denied the deletion, so the bot most likely lacks can_delete_messages."
        : "the deletions failed without a permission error, so this is most likely transient.")
    );
  }
  return { total: messageIds.length, missed, permissionDenied };
}

/** 清理机器人验证痕迹并按现查结果踢出，成功播报先写入新 revision 再收尾。 */
async function expelMember({
  chatId,
  userId,
  snapshot,
  reason,
  canRestrict,
  expectedState,
  dispatchVerification,
}: ExpelMemberParams): Promise<boolean> {
  const stillCurrent = (): boolean =>
    verificationEntries.get(verificationKey(chatId, userId))?.state === expectedState;
  let removalOutcome: ExpelRemovalOutcome = "failed";
  if (!stillCurrent()) return false;
  if (reason === "flood") {
    removalOutcome = canRestrict
      ? await kickPresentMember(chatId, userId, stillCurrent)
      : await probeBlockedMember(chatId, userId, stillCurrent);
    if (removalOutcome === "stale") return false;
  }
  const cleanup: VerificationCleanupResult | null =
    await deleteVerificationMessages({ chatId, userId, snapshot, isCurrent: stillCurrent });
  if (cleanup === null) return false;
  // 只在真的一条不剩时置位；欠着账就留给下一轮重试（见 ExpellingState.cleanupSettled）。
  if (cleanup.missed === 0) expectedState.cleanupSettled = true;
  if (!stillCurrent()) return false;
  if (reason === "timeout") {
    removalOutcome = canRestrict
      ? await kickPresentMember(chatId, userId, stillCurrent)
      : await probeBlockedMember(chatId, userId, stillCurrent);
    if (removalOutcome === "stale") return false;
  }
  // 「人已经不在群里」分两种来路：本来就走了（静默结算，不认领别人的处置）；
  // 上一轮由机器人踢掉、播报未发出（removalConfirmed 记着，见 ExpellingState），
  // 仍走播报路径。
  const kicked: boolean = removalOutcome === "kicked" ||
    (removalOutcome === "absent" && expectedState.removalConfirmed === true);
  if (removalOutcome === "absent" && !kicked) return stillCurrent();
  if (!stillCurrent()) return false;

  // 三类诊断（success、unconfirmed、failure）各有各的持久化标记。
  const unconfirmed: boolean = removalOutcome === "unconfirmed" || removalOutcome === "kindUnknown";
  const shouldSendNotice: boolean = kicked
    ? expectedState.successNoticeSent !== true
    : unconfirmed
      ? expectedState.unconfirmedNoticeSent !== true
      : expectedState.failureNoticeSent !== true;
  // 播报经统一 Telegram 动作边界发送：请求 reject（含 Worker→主线程请求失败）记一行 API 错误，
  // 按「没发出去」走下面的退避分支。
  const noticeMessageId: number | undefined = shouldSendNotice
    ? await runTelegramAction({
      action: "send message",
      execute: (signal?: AbortSignal): Promise<TelegramWorkerTemporaryMessageResult | undefined> => sendTemporaryMessageFromMain({
        purpose: "notice",
        chatId,
        text: expelNoticeText({
          texts: workerAtmosphere().NOTICE_TEXTS,
          reason,
          removalOutcome,
          kicked,
          cleanup,
          label: snapshot.label,
          isBot: snapshot.isBot,
        }),
        signal,
      }),
      map: (result: TelegramWorkerTemporaryMessageResult | undefined): number | undefined =>
        result !== undefined && "messageId" in result ? result.messageId : undefined,
      fallback: undefined,
    })
    : undefined;
  // 播报 await 期间条目可能已被替换或移除；持久标记只经状态机写给仍是 expectedState 的条目。
  if (!stillCurrent()) return false;
  if (noticeMessageId !== undefined) {
    dispatchVerification(chatId, userId, {
      type: "expelNoticeSent",
      notice: kicked ? "success" : unconfirmed ? "unconfirmed" : "failure",
    });
    // 成功播报已进入新快照：等落盘回执结束终态。
    if (kicked) return false;
  } else if (kicked && shouldSendNotice) {
    // 踢成功但播报没发出去：不结算，先把 removalConfirmed 记进快照再退避重试
    // （见上面 kicked 的两条来路）。
    dispatchVerification(chatId, userId, { type: "removalConfirmed" });
    return false;
  }
  return kicked;
}
