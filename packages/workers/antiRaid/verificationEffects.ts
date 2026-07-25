import { logger } from "../../infra/logger";
import {
  answerCallbackQuery,
  deleteMessage,
  deleteMessageAfter,
  joinVerificationApi,
  kickChatMember,
  sendMessage,
} from "../../infra/telegram";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../../consts/telegram";
import {
  VERIFICATION_TERMINAL_RETRY_MS,
  VERIFICATION_TIMEOUT_MS,
  WELCOME_AUTO_DELETE_MS,
} from "../../consts/antiRaid/verification";
import { verificationEntries } from "../../cache/antiRaid/verification";
import { formatMinSec } from "../../libs/time";
import { verificationKey } from "../../libs/verificationKey";
import type { VerificationDispatcher } from "../../types/antiRaid/internal";
import type {
  ExpelSnapshot,
  VerificationEffect,
  VerificationState,
  VerificationTerminalState,
} from "../../types/states/verification";
import { fetchAdminIds, freshAdminIds } from "./adminCache";
import { retractJoin } from "./lockdownRuntime";
import {
  sendReplyReminder,
  sendVerificationReminder,
} from "./verificationReminders";
import type { VerificationEntry } from "../../cache/antiRaid/verification";

type VerificationChangePublisher = (
  chatId: number,
  userId: number,
  previousWasPersisted: boolean
) => void;

export interface RunVerificationEffectsParams {
  chatId: number;
  userId: number;
  effects: VerificationEffect[];
  dispatchVerification: VerificationDispatcher;
  publishVerificationChange: VerificationChangePublisher;
}

/** 按序执行一次转移返回的副作用；同一列表内先删后踢再通知的顺序有意义。 */
export async function runVerificationEffects({
  chatId,
  userId,
  effects,
  dispatchVerification,
  publishVerificationChange,
}: RunVerificationEffectsParams): Promise<void> {
  for (const effect of effects) {
    switch (effect.kind) {
      case "deleteMessage":
        await deleteMessage(chatId, effect.messageId, joinVerificationApi);
        break;
      case "kickMember":
        await kickChatMember(chatId, userId, joinVerificationApi);
        break;
      case "deleteReminders":
        if (effect.reminderMessageId !== undefined) {
          await deleteMessage(chatId, effect.reminderMessageId, joinVerificationApi);
        }
        if (effect.replyReminderMessageId !== undefined) {
          await deleteMessage(chatId, effect.replyReminderMessageId, joinVerificationApi);
        }
        break;
      case "expel":
      case "expelFlood": {
        const expectedState: VerificationState | undefined =
          verificationEntries.get(verificationKey(chatId, userId))?.state;
        const reason: "timeout" | "flood" =
          effect.kind === "expelFlood" ? "flood" : "timeout";
        if (
          expectedState?.kind !== "expelling" ||
          expectedState.reason !== reason ||
          expectedState.snapshot !== effect.snapshot
        ) break;
        const settled: boolean = await expelMember({
          chatId,
          userId,
          snapshot: effect.snapshot,
          reason,
          expectedState,
          publishVerificationChange,
        });
        if (
          settled &&
          verificationEntries.get(verificationKey(chatId, userId))?.state === expectedState
        ) {
          dispatchVerification(chatId, userId, { type: "expelSettled" });
        } else if (
          verificationEntries.get(verificationKey(chatId, userId))?.state === expectedState &&
          expectedState.successNoticeSent !== true
        ) {
          // 只有踢人失败等可重试处置才走本地 timer。成功播报已经发送时必须
          // 原地等待对应 revision 的真实落盘回执。
          expectedState.executionStarted = false;
          const entry: VerificationEntry | undefined = verificationEntries.get(verificationKey(chatId, userId));
          if (entry !== undefined) {
            if (entry.timer !== undefined) clearTimeout(entry.timer);
            entry.timer = setTimeout(
              (): void => dispatchVerification(chatId, userId, { type: "terminalPersisted" }),
              VERIFICATION_TERMINAL_RETRY_MS
            );
          }
        }
        break;
      }
      case "recheckInviter": {
        const expectedState: VerificationState | undefined =
          verificationEntries.get(verificationKey(chatId, userId))?.state;
        if (
          expectedState?.kind !== "checkingInviter" ||
          expectedState.snapshot !== effect.snapshot
        ) break;
        await recheckInviterThenSettle({
          chatId,
          userId,
          inviterId: effect.inviterId,
          expectedState,
          dispatchVerification,
        });
        break;
      }
      case "sendReminder":
        sendVerificationReminder({
          chatId,
          userId,
          label: effect.label,
          isBot: effect.isBot,
          dispatchVerification,
        });
        break;
      case "sendReplyReminder":
        sendReplyReminder({
          chatId,
          userId,
          label: effect.label,
          targetMessageId: effect.targetMessageId,
          dispatchVerification,
        });
        break;
      case "sendWelcome": {
        const welcomeText: string =
          effect.variant === "channelComment"
            ? `哼，${effect.targetLabel} 老实巴交的在帖子底下冒个了泡，本天才大发慈悲免了你的验证，欢迎杂鱼入群~♡`
            : effect.variant === "vouchedBot"
              ? `哼，既然 ${effect.fromLabel} 大人愿意为机器人 ${effect.targetLabel} 作保，本天才就勉为其难放这个铁疙瘩进来啦~♡`
              : `哼，算你机灵，${effect.fromLabel} 通过验证啦，欢迎杂鱼入群~♡`;
        const welcomeMessageId: number | undefined = await sendMessage({
          chatId,
          text: welcomeText,
          replyToMessageId: effect.anchorMessageId,
          api: joinVerificationApi,
        });
        if (welcomeMessageId !== undefined) {
          deleteMessageAfter({
            chatId,
            messageId: welcomeMessageId,
            delayMs: WELCOME_AUTO_DELETE_MS,
            api: joinVerificationApi,
          });
        }
        break;
      }
      case "answerCallback": {
        const replyText: string | undefined =
          effect.reply === "ok"
            ? "验证通过啦～"
            : effect.reply === "invalid"
              ? "验证已经失效啦，再试试重新进群吧"
              : effect.reply === "notYourBotButton"
                ? "帮机器人作保是白名单大人的特权，杂鱼别乱点～"
                : "这不是你的验证按钮哦，杂鱼别乱点～";
        await answerCallbackQuery({
          callbackQueryId: effect.callbackQueryId,
          text: replyText,
          showAlert: effect.reply !== "ok",
          api: joinVerificationApi,
        });
        break;
      }
      case "startAdminCheck":
        startAdminCheck({
          chatId,
          userId,
          actorId: effect.actorId,
          dispatchVerification,
        });
        break;
      case "retractJoinCount":
        retractJoin(chatId, effect.joinedAt);
        break;
      case "logStaleKickedExemption":
        logger.warn(
          `Member ${effect.label} (chat ${chatId}, user ${userId}) was already kicked (anti-raid lockdown or the join-dedupe window) ` +
          `when exemption proof (admin/whitelist identity) arrived; the kick cannot be undone automatically — ` +
          "an admin may need to manually re-invite them if this was a false positive."
        );
        break;
    }
  }
}

interface StartAdminCheckParams {
  chatId: number;
  userId: number;
  actorId: number;
  dispatchVerification: VerificationDispatcher;
}

/** 异步核查拉人者管理员身份；只向仍是同一对象的 pending 状态回投结果。 */
function startAdminCheck({
  chatId,
  userId,
  actorId,
  dispatchVerification,
}: StartAdminCheckParams): void {
  const key: string = verificationKey(chatId, userId);
  const captured: VerificationState | undefined = verificationEntries.get(key)?.state;
  if (captured?.kind !== "pending") return;
  void fetchAdminIds(chatId)
    .then((adminIds: Set<number>): void => {
      if (!adminIds.has(actorId)) return;
      if (verificationEntries.get(key)?.state === captured) {
        dispatchVerification(chatId, userId, { type: "adminCheckResolved" });
      }
    })
    .catch((error: unknown): void => {
      logger.error(
        `Error fetching chat admins for admin-invite exemption in chat ${chatId}:`,
        error
      );
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
  expectedState: VerificationTerminalState & { kind: "expelling" };
  publishVerificationChange: VerificationChangePublisher;
}

/** 清理超时/刷屏成员的消息并踢出，成功播报先写入新 revision 再收尾。 */
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
  let kicked: boolean = false;
  if (!stillCurrent()) return false;
  if (reason === "flood") {
    kicked = await kickChatMember(chatId, userId, joinVerificationApi);
  }
  for (const messageId of snapshot.messageIds) {
    if (!stillCurrent()) return false;
    await deleteMessage(chatId, messageId, joinVerificationApi);
  }
  if (!stillCurrent()) return false;
  if (reason === "timeout") {
    kicked = await kickChatMember(chatId, userId, joinVerificationApi);
  }
  const noticeText: string = !kicked
    ? reason === "flood"
      ? `啧，${snapshot.label} 没完成验证还在刷屏，本天才想把 TA 踢出去却没踢动……管理员快检查本天才的封禁权限！`
      : `啧，${snapshot.label} 超时没验证，本天才本想把 TA 踢出去，结果居然没踢动……肯定是哪个杂鱼管理员没给本天才封禁权限！快去检查，不然只能你们自己动手请 TA 出去咯♡`
    : reason === "flood"
      ? `啧，${snapshot.label} 验证都没过就开始刷屏，本天才已经先把 TA 踢出去、再把痕迹清干净啦♡`
      : snapshot.isBot
        ? `啧，${formatMinSec(VERIFICATION_TIMEOUT_MS)} 过去了都没有白名单大人愿意为机器人 ${snapshot.label} 作保，本天才把这个来路不明的铁疙瘩连痕迹一起清出去啦♡`
        : `啧，${snapshot.label} 磨磨蹭蹭 ${formatMinSec(VERIFICATION_TIMEOUT_MS)} 都点不出验证按钮，本天才把 TA 的痕迹清干净、顺手踢出去啦，杂鱼动作太慢咯♡`;
  if (!stillCurrent()) return false;
  const shouldSendNotice: boolean = kicked
    ? expectedState.successNoticeSent !== true
    : expectedState.failureNoticeSent !== true;
  const noticeMessageId: number | undefined = shouldSendNotice
    ? await sendMessage({
      chatId,
      text: noticeText,
      api: joinVerificationApi,
    })
    : undefined;
  if (!kicked) expectedState.failureNoticeSent = true;
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
