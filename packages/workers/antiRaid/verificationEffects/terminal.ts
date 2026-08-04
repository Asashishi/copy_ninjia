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
import { botCanDeleteIn, botCanRestrictIn } from "../botPermissions";
import { chatIsSupergroup } from "../chatKind";

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

interface ScheduleExpelRetryParams {
  chatId: number;
  userId: number;
  state: VerificationState & { kind: "expelling" };
  dispatchVerification: VerificationDispatcher;
}

/** 为仍是当前 token 的未结算处置安排指数退避。 */
function scheduleExpelRetry({
  chatId,
  userId,
  state,
  dispatchVerification,
}: ScheduleExpelRetryParams): void {
  const key: string = verificationKey(chatId, userId);
  const entry: VerificationEntry | undefined = verificationEntries.get(key);
  if (entry?.state !== state) return;
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
  // 权限镜像是三态：只有确证没有限制成员权限时才跳过踢人请求。每轮保留一次
  // O(1) 判定并继续退避，权限恢复后下一轮自然重新执行；未知不能折算成没有权限。
  //
  // **但只短路请求，不短路诊断。** 改动前这条路照常发踢人请求、吃下 Telegram
  // 的 403/400，再发出那条唯一点名封禁权限的群内提示；把请求和提示一起省掉，
  // 管理员就再也收不到任何信号：人无限期留在群里，退避一路静默涨到
  // VERIFICATION_TERMINAL_RETRY_MAX_MS，机器人自己的验证提示也永远挂在群里。
  //
  // 因此第一次进这条分支时照常走一遍 expelMember——清机器人自己的验证消息、发出
  // 那条提示、记一行日志，只是不发成员探测和踢人请求。之后由 failureNoticeSent
  // 闩住：它随快照持久化，Worker 重生与进程重启后也不会重发，每轮重试只推进本地
  // 退避，一个请求都不发。提示自己也没发出去时不置位（见 expelMember 收尾），
  // 下一轮会重来。
  //
  // **清理还欠着账时不许短路**（cleanupSettled）。只认 failureNoticeSent 的话，
  // 一条因为网络抖动删失败过的验证公告会就此定格：此后每一轮都在这里返回，
  // 那段清理代码再也不会执行，群里于是永远挂着一条带可点击验证按钮的公告，而
  // 对应的成员根本没被踢走。cleanupSettled 为假时照常走 expelMember——那条路上
  // 踢人被 canRestrict 短路、播报被 failureNoticeSent 短路，机器人确证没有删除
  // 权限时删除也被 botCanDeleteIn 短路，因此「一个请求都不发」这条性质仍然成立，
  // 只有真的还能删、也确实该重试的那种情形才会发出请求。
  const permissionBlocked: boolean = botCanRestrictIn(chatId) === false;
  if (
    permissionBlocked &&
    expectedState.failureNoticeSent === true &&
    expectedState.cleanupSettled === true
  ) {
    expectedState.executionStarted = false;
    scheduleExpelRetry({
      chatId,
      userId,
      state: expectedState,
      dispatchVerification,
    });
    return;
  }
  if (permissionBlocked) {
    logger.error(
      `Verification expel for user ${userId} in chat ${chatId} cannot kick: the bot is confirmed to lack ` +
      "can_restrict_members there. Cleaning up the bot's own verification messages and notifying the chat once, then " +
      "backing off without further requests until the permission returns."
    );
  }
  const settled: boolean = await expelMember({
    chatId,
    userId,
    snapshot: effect.snapshot,
    reason,
    canRestrict: !permissionBlocked,
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
  scheduleExpelRetry({
    chatId,
    userId,
    state: expectedState,
    dispatchVerification,
  });
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
  /**
   * 确证没有限制成员权限时为 false：跳过成员探测与踢人请求，其余（清理机器人
   * 自己的验证消息、战报措辞、诊断名额）全部照旧，结局按「没踢动」结算。
   */
  canRestrict: boolean;
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
  // 三态原样传下去：只有确证是普通群才换 banChatMember，未知按超级群办（判定
  // 见该函数 JSDoc）。不用条件展开——那会让同一个调用点产出两种对象 shape，
  // 还要为「未知」这条最常见的分支白造一个立即丢弃的空对象。
  return await kickChatMember({
    chatId,
    userId,
    isSupergroup: chatIsSupergroup(chatId),
    api: joinVerificationApi,
  }) ? "kicked" : "failed";
}

/** 清理机器人验证痕迹并按现查结果踢出，成功播报先写入新 revision 再收尾。 */
async function expelMember({
  chatId,
  userId,
  snapshot,
  reason,
  canRestrict,
  expectedState,
  publishVerificationChange,
}: ExpelMemberParams): Promise<boolean> {
  const stillCurrent = (): boolean =>
    verificationEntries.get(verificationKey(chatId, userId))?.state === expectedState;
  // canRestrict 为假时保持初值：没发请求就是没踢动，战报走「没给本天才封禁
  // 权限」那条，与请求真的被 Telegram 403 掉时的结局一致。
  let removalOutcome: ExpelRemovalOutcome = "failed";
  if (!stillCurrent()) return false;
  if (reason === "flood" && canRestrict) {
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
  // 只在真的一条不剩时置位；欠着账就留给下一轮重试（见 ExpellingState.cleanupSettled）。
  if (cleanupCleared) expectedState.cleanupSettled = true;
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
  if (reason === "timeout" && canRestrict) {
    removalOutcome = await kickPresentMember(chatId, userId, stillCurrent);
    if (removalOutcome === "stale") return false;
  }
  // 「人已经不在群里」有两种来路，必须分开：本来就走了（照常静默结算，机器人
  // 不认领别人的处置），以及上一轮确实是本天才踢掉的、只是那条播报没发出去
  // （removalConfirmed 记着，见 ExpellingState）。后者仍要走播报那条路，否则
  // 一次探测就把唯一的说明永久吞掉。
  const kicked: boolean = removalOutcome === "kicked" ||
    (removalOutcome === "absent" && expectedState.removalConfirmed === true);
  if (removalOutcome === "absent" && !kicked) return stillCurrent();
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
  // 踢成功了、那条播报却没发出去（429 排干净、网络抖动）。**不能就这么结算**：
  // 结算等于删记录，群里看着一个人凭空消失，而唯一的说明再也不会有第二次机会。
  // 先把「人确实是本天才踢走的」记进快照再退避重试，下一轮的成员探测才不会把
  // 「不在群里」当成别人的处置（见上面 kicked 的两条来路）。
  if (kicked && shouldSendNotice) {
    if (expectedState.removalConfirmed !== true) {
      expectedState.removalConfirmed = true;
      publishVerificationChange(chatId, userId, true);
    }
    return false;
  }
  return kicked && stillCurrent();
}
