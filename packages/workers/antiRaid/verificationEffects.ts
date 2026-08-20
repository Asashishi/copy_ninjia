import {
  verificationEntries,
  verificationGeneration,
  verificationRevisions,
} from "../../cache/workers/antiRaid/verification";
import {
  VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS,
  WELCOME_AUTO_DELETE_MS,
} from "../../consts/antiRaid/verification";
import { logger } from "../../infra/logger";
import {
  answerCallbackQuery,
  deleteMessage,
  deleteMessageAfter,
  sendMessage,
  joinVerificationApi,
} from "../../infra/telegram";
import { verificationKey } from "../../libs/verificationKey";
import type { VerificationDispatcher } from "../../types/antiRaid/internal";
import type {
  VerificationEffect,
  VerificationState,
} from "../../types/states/verification";
import { fetchAdminIds } from "./adminCache";
import { retractJoin } from "./lockdownRuntime";
import { runKickMemberEffect } from "./verificationEffects/kick";
import {
  runExpelEffect,
  runRecheckInviterEffect,
} from "./verificationEffects/terminal";
import type { VerificationChangePublisher } from "./verificationEffects/terminal";
import {
  sendReplyReminder,
  sendVerificationReminder,
} from "./verificationReminders";
import { trackAntiRaidTask } from "./taskTracker";
import { requestVerificationAttemptPermit } from "./verificationAttemptPermit";
import type { VerificationAttemptPermitResult } from
  "../../types/antiRaid/protocol";

export type VerificationAttemptRequester = (
  key: string,
  generation: number,
  revision: number
) => Promise<VerificationAttemptPermitResult>;

export interface RunVerificationEffectsParams {
  chatId: number;
  userId: number;
  effects: VerificationEffect[];
  dispatchVerification: VerificationDispatcher;
  publishVerificationChange: VerificationChangePublisher;
  requestTerminalAttempt?: VerificationAttemptRequester;
}

function includesTerminalAttempt(effects: readonly VerificationEffect[]): boolean {
  for (const effect of effects) {
    if (
      effect.kind === "kickMember" ||
      effect.kind === "recheckInviter" ||
      effect.kind === "expel" ||
      effect.kind === "expelFlood"
    ) {
      return true;
    }
  }
  return false;
}

function isTerminalState(state: VerificationState | undefined): boolean {
  return state?.kind === "kickPending" ||
    state?.kind === "checkingInviter" ||
    state?.kind === "expelling";
}

/** 按序执行一次转移返回的副作用；同一列表内先删后踢再通知的顺序有意义。 */
export async function runVerificationEffects({
  chatId,
  userId,
  effects,
  dispatchVerification,
  publishVerificationChange,
  requestTerminalAttempt = requestVerificationAttemptPermit,
}: RunVerificationEffectsParams): Promise<void> {
  const key: string = verificationKey(chatId, userId);
  // 整批 effect 共享同一个执行 token；前置 await 后不得捕获替换后的新状态。
  const transitionState: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  let grantedAttempt: number = 0;
  if (includesTerminalAttempt(effects)) {
    const generation: number = verificationGeneration.current;
    const revision: number | undefined = verificationRevisions.get(key)?.revision;
    if (generation <= 0 || revision === undefined) return;
    const permit: VerificationAttemptPermitResult = await requestTerminalAttempt(
      key,
      generation,
      revision
    );
    if (verificationEntries.get(key)?.state !== transitionState) return;
    if (permit.status !== "granted") {
      if (permit.status === "exhausted") {
        dispatchVerification(chatId, userId, {
          type: "terminalAttemptBudgetExhausted",
        });
      }
      return;
    }
    grantedAttempt = permit.attempt;
  }
  for (const effect of effects) {
    switch (effect.kind) {
      case "deleteMessage":
        await deleteMessage(chatId, effect.messageId, joinVerificationApi);
        break;
      case "kickMember":
        await runKickMemberEffect({
          chatId,
          userId,
          transitionState,
          dispatchVerification,
        });
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
      case "expelFlood":
        await runExpelEffect({
          chatId,
          userId,
          effect,
          dispatchVerification,
          publishVerificationChange,
        });
        break;
      case "recheckInviter":
        await runRecheckInviterEffect({
          chatId,
          userId,
          effect,
          dispatchVerification,
        });
        break;
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
        const replyText: string =
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
      case "logUncancelableKickExemption":
        // Worker 只向主线程中继 error 日志；这是误踢后唯一可供人工纠正的线索。
        logger.error(
          `The kick request for member ${effect.label} (chat ${chatId}, user ${userId}) had already been sent or completed ` +
          "when exemption proof (admin/whitelist identity) arrived; it cannot be undone automatically — " +
          "an admin may need to manually re-invite them if this was a false positive."
        );
        break;
    }
  }
  if (
    grantedAttempt >= VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS &&
    isTerminalState(verificationEntries.get(key)?.state)
  ) {
    dispatchVerification(chatId, userId, {
      type: "terminalAttemptBudgetExhausted",
    });
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
  void trackAntiRaidTask({
    task: fetchAdminIds(chatId)
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
      }),
  });
}
