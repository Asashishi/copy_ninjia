import { workerAtmosphere } from "./atmosphere";
import { answerVerificationCallback } from "./verificationCallbacks";
import {
  verificationEntries,
  verificationGeneration,
  verificationRevisions,
} from "../../cache/workers/antiRaid/verification";
import { VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS } from "../../consts/antiRaid/verification";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../consts/commands";
import { logger } from "../../infra/logger";
import {
  deleteMessage,
  telegramApi,
} from "../../infra/telegram";
import { runBooleanTelegramAction } from "../../infra/telegram/actions/core";
import { sendTemporaryMessageFromMain } from "../../infra/telegram/workerClient";
import type { TelegramWorkerTemporaryMessageResult } from "../../types/telegramWorker";
import { verificationKey } from "../../libs/verificationKey";
import type { VerificationDispatcher } from "../../types/antiRaid/internal";
import type {
  VerificationEffect,
  VerificationState,
} from "../../types/states/verification";
import { fetchAdminIds } from "./adminCache";
import { retractJoinWindow } from "./lockdownJoinWindow";
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
import { isTerminalVerificationPhase } from "../../states/verification/shared";
import { antiRaidDispatchAbort } from "../../cache/workers/antiRaid/tasks";

export type VerificationAttemptRequester = (
  key: string,
  generation: number,
  revision: number
) => Promise<VerificationAttemptPermitResult>;

export interface RunVerificationEffectsParams {
  chatId: number;
  userId: number;
  effects: readonly VerificationEffect[];
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

/** 发起许可申请那一刻的执行 token。 */
interface TerminalAttemptToken {
  readonly transitionState: VerificationState | undefined;
  readonly generation: number;
  readonly revision: number;
}

/** 申请许可时的执行 token 在 await 之后是否仍是当前这一份：状态对象、代际、revision 都没换，也没在停机。 */
function isSameTransition(key: string, token: TerminalAttemptToken): boolean {
  return verificationEntries.get(key)?.state === token.transitionState &&
    verificationGeneration.current === token.generation &&
    verificationRevisions.get(key)?.revision === token.revision &&
    antiRaidDispatchAbort.current?.signal.aborted !== true;
}

/** acquireTerminalAttempt 的入参。 */
interface AcquireTerminalAttemptParams {
  readonly chatId: number;
  readonly userId: number;
  readonly key: string;
  readonly transitionState: VerificationState | undefined;
  readonly dispatchVerification: VerificationDispatcher;
  readonly requestTerminalAttempt: VerificationAttemptRequester;
}

/** 一次已取得的终态许可：第几次尝试与申请时的 revision。 */
interface GrantedTerminalAttempt {
  readonly attempt: number;
  readonly revision: number;
}

/**
 * 为本批终态副作用向主线程申请一次许可。token 已换代、申请抛错或未获批时返回 null，本批副作用
 * 一律不执行；抛错与未获批在 token 仍精确匹配时判耗尽，交给延后闩锁。
 */
async function acquireTerminalAttempt({
  chatId,
  userId,
  key,
  transitionState,
  dispatchVerification,
  requestTerminalAttempt,
}: AcquireTerminalAttemptParams): Promise<GrantedTerminalAttempt | null> {
  const generation: number = verificationGeneration.current;
  const revision: number | undefined = verificationRevisions.get(key)?.revision;
  if (generation <= 0 || revision === undefined) return null;
  const token: TerminalAttemptToken = { transitionState, generation, revision };
  let permit: VerificationAttemptPermitResult;
  try {
    permit = await requestTerminalAttempt(key, generation, revision);
  } catch (error: unknown) {
    if (!isSameTransition(key, token)) return null;
    logger.error(`Failed to acquire verification terminal attempt permit for ${key}:`, error);
    // 当前许可无法确认时卸载运行态，沿既有延后边界保留磁盘快照；
    // 主线程接管延后闩锁，完整进程重启后再恢复，不消耗本地 Telegram 重试计数。
    dispatchVerification(chatId, userId, { type: "terminalAttemptBudgetExhausted" });
    return null;
  }
  if (!isSameTransition(key, token)) return null;
  if (permit.status !== "granted") {
    // stale 只对仍精确匹配的当前 token 收口，不能触碰已经换代或更新的记录。
    dispatchVerification(chatId, userId, { type: "terminalAttemptBudgetExhausted" });
    return null;
  }
  return { attempt: permit.attempt, revision };
}

/** 欢迎语按变体取本进程风格的文案。 */
function welcomeTextFor(effect: Extract<VerificationEffect, { kind: "sendWelcome" }>): string {
  const texts: ReturnType<typeof workerAtmosphere>["NOTICE_TEXTS"] = workerAtmosphere().NOTICE_TEXTS;
  if (effect.variant === "channelComment") return texts.verificationCommentExempt(effect.targetLabel);
  if (effect.variant === "vouchedBot") return texts.verificationBotApproved(effect.fromLabel, effect.targetLabel);
  if (effect.variant === "approved") return texts.verificationMemberApproved(effect.fromLabel, effect.targetLabel);
  return texts.verificationSelfPassed(effect.fromLabel);
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
  let granted: GrantedTerminalAttempt | null = null;
  if (includesTerminalAttempt(effects)) {
    granted = await acquireTerminalAttempt({
      chatId,
      userId,
      key,
      transitionState,
      dispatchVerification,
      requestTerminalAttempt,
    });
    if (granted === null) return;
  }
  for (const effect of effects) {
    switch (effect.kind) {
      case "deleteMessage":
        await deleteMessage(chatId, effect.messageId, telegramApi);
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
          await deleteMessage(chatId, effect.reminderMessageId, telegramApi);
        }
        if (effect.replyReminderMessageId !== undefined) {
          await deleteMessage(chatId, effect.replyReminderMessageId, telegramApi);
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
        const welcomeText: string = welcomeTextFor(effect);
        await runBooleanTelegramAction(
          "send message",
          (signal?: AbortSignal): Promise<TelegramWorkerTemporaryMessageResult | undefined> => sendTemporaryMessageFromMain({
            purpose: "notice",
            chatId,
            text: welcomeText,
            replyToMessageId: effect.anchorMessageId,
            deleteAfterMs: COMMAND_MESSAGE_AUTO_DELETE_MS,
            signal,
          })
        );
        break;
      }
      case "answerCallback":
        await answerVerificationCallback({ callbackQueryId: effect.callbackQueryId, reply: effect.reply });
        break;
      case "startAdminCheck":
        startAdminCheck({
          chatId,
          userId,
          actorId: effect.actorId,
          dispatchVerification,
        });
        break;
      case "retractJoinCount":
        retractJoinWindow(chatId, effect.joinedAt);
        break;
      case "logUncancelableKickExemption":
        // Worker 只向主线程中继 error 日志；这是误踢后唯一可供人工纠正的线索。
        logger.error(
          `The kick request for member ${effect.label} (chat ${chatId}, user ${userId}) had already been sent or completed ` +
          "when exemption proof (admin identity) arrived; it cannot be undone automatically — " +
          "an admin may need to manually re-invite them if this was a false positive."
        );
        break;
    }
  }
  // 本进程最后一次许可用完仍停在终态时，只有本轮没有发布新 revision 才就地判耗尽。
  // 本轮已发布新 revision（置位 successNoticeSent、removalConfirmed 等持久化标志，或
  // 终态换代）时，由该 revision 的落盘回执继续驱动：成功战报据此结算，仍需执行的
  // 终态再次申请许可时由主线程判 exhausted。
  if (
    granted !== null &&
    granted.attempt >= VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS &&
    verificationRevisions.get(key)?.revision === granted.revision &&
    isTerminalVerificationPhase(verificationEntries.get(key)?.state?.kind)
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
