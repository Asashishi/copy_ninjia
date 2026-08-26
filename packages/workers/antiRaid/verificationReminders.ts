import { logger } from "../../infra/logger";
import {
  deleteMessage,
  sendMessage,
  telegramApi,
} from "../../infra/telegram";
import {
  VERIFICATION_BUTTON_TEXT,
  VERIFICATION_REMINDER_RETRY_INITIAL_MS,
  VERIFICATION_REMINDER_RETRY_MAX_MS,
  VERIFICATION_TIMEOUT_MS,
  VERIFY_CALLBACK_PREFIX,
} from "../../consts/antiRaid/verification";
import { reminderDeliveries, verificationEntries } from "../../cache/workers/antiRaid/verification";
import { formatMinSec } from "../../libs/time";
import { verificationKey } from "../../libs/verificationKey";
import type {
  ReminderDelivery,
  ReminderKind,
  VerificationDispatcher,
} from "../../types/antiRaid/internal";
import type { PendingState, VerificationState } from "../../types/states/verification";
import { trackAntiRaidTask } from "./taskTracker";
import type { InlineKeyboardMarkup } from "@grammyjs/types";

/**
 * 待验证提醒的唯一投递 owner：发送失败时在验证期限内退避重试，状态换代
 * 后取消旧 owner，并删除已经迟到落地的 Telegram 消息。
 */

export function cancelReminderDelivery(key: string): void {
  const delivery: ReminderDelivery | undefined = reminderDeliveries.get(key);
  if (!delivery) return;
  if (delivery.timer !== undefined) clearTimeout(delivery.timer);
  reminderDeliveries.delete(key);
}

export function clearReminderDeliveries(): void {
  for (const delivery of reminderDeliveries.values()) {
    if (delivery.timer !== undefined) clearTimeout(delivery.timer);
  }
  reminderDeliveries.clear();
}

function scheduleReminderRetry(
  delivery: ReminderDelivery,
  dispatchVerification: VerificationDispatcher
): void {
  if (reminderDeliveries.get(delivery.key) !== delivery) return;
  if (verificationEntries.get(delivery.key)?.state !== delivery.expectedState) {
    cancelReminderDelivery(delivery.key);
    return;
  }
  const remainingMs: number = delivery.expectedState.expiresAt - Date.now();
  if (remainingMs <= 0) return; // verifyTimeout 会延长期限并重新唤醒这个 owner。
  const backoffMs: number = Math.min(
    VERIFICATION_REMINDER_RETRY_INITIAL_MS * (2 ** delivery.attempts),
    VERIFICATION_REMINDER_RETRY_MAX_MS
  );
  delivery.attempts += 1;
  delivery.timer = setTimeout(
    (): void => {
      delivery.timer = undefined;
      attemptReminderDelivery(delivery, dispatchVerification);
    },
    Math.max(1, Math.min(backoffMs, remainingMs))
  );
  delivery.timer.unref();
}

function attemptReminderDelivery(
  delivery: ReminderDelivery,
  dispatchVerification: VerificationDispatcher
): void {
  if (reminderDeliveries.get(delivery.key) !== delivery || delivery.inFlight) return;
  if (verificationEntries.get(delivery.key)?.state !== delivery.expectedState) {
    cancelReminderDelivery(delivery.key);
    return;
  }

  delivery.inFlight = true;
  const verifyKeyboard: InlineKeyboardMarkup = {
    inline_keyboard: [[{
      text: VERIFICATION_BUTTON_TEXT,
      callback_data: `${VERIFY_CALLBACK_PREFIX}${delivery.userId}`,
    }]],
  };
  const task: Promise<void> = (async (): Promise<void> => {
    let reminderMessageId: number | undefined;
    try {
      reminderMessageId = await sendMessage({
        chatId: delivery.chatId,
        text: delivery.text,
        replyToMessageId: delivery.replyToMessageId,
        api: telegramApi,
        keyboard: verifyKeyboard,
      });
    } catch (error: unknown) {
      logger.error(`Error sending ${delivery.kind} join verification reminder:`, error);
    }
    delivery.inFlight = false;

    // 回复式提醒已取代原 owner，或状态已通过/离群/重建：成功落地的迟到消息
    // 必须自删，失败结果则不能为旧 owner 再安排重试。
    if (
      reminderDeliveries.get(delivery.key) !== delivery ||
      verificationEntries.get(delivery.key)?.state !== delivery.expectedState
    ) {
      if (reminderMessageId !== undefined) {
        void trackAntiRaidTask({
          task: deleteMessage(delivery.chatId, reminderMessageId, telegramApi),
        });
      }
      return;
    }

    if (reminderMessageId === undefined) {
      scheduleReminderRetry(delivery, dispatchVerification);
      return;
    }

    reminderDeliveries.delete(delivery.key);
    dispatchVerification(delivery.chatId, delivery.userId, {
      type: "reminderLanded",
      reminderKind: delivery.kind,
      messageId: reminderMessageId,
      now: Date.now(),
    });
  })();
  void trackAntiRaidTask({ task });
}

interface SendReminderMessageParams {
  chatId: number;
  userId: number;
  reminderKind: ReminderKind;
  text: string;
  replyToMessageId: number | undefined;
  dispatchVerification: VerificationDispatcher;
}

function sendReminderMessage({
  chatId,
  userId,
  reminderKind,
  text,
  replyToMessageId,
  dispatchVerification,
}: SendReminderMessageParams): void {
  const key: string = verificationKey(chatId, userId);
  const captured: VerificationState | undefined = verificationEntries.get(key)?.state;
  if (captured?.kind !== "pending") return;
  const existing: ReminderDelivery | undefined = reminderDeliveries.get(key);
  if (existing?.expectedState === captured && existing.kind === reminderKind) {
    if (!existing.inFlight && existing.timer === undefined) {
      attemptReminderDelivery(existing, dispatchVerification);
    }
    return;
  }
  cancelReminderDelivery(key);
  const delivery: ReminderDelivery = {
    key,
    chatId,
    userId,
    kind: reminderKind,
    text,
    replyToMessageId,
    expectedState: captured,
    attempts: 0,
    timer: undefined,
    inFlight: false,
  };
  reminderDeliveries.set(key, delivery);
  attemptReminderDelivery(delivery, dispatchVerification);
}

interface SendVerificationReminderParams {
  chatId: number;
  userId: number;
  label: string;
  isBot: boolean;
  dispatchVerification: VerificationDispatcher;
}

/** 发送原始独立提醒；机器人由白名单用户代点按钮作保。 */
export function sendVerificationReminder({
  chatId,
  userId,
  label,
  isBot,
  dispatchVerification,
}: SendVerificationReminderParams): void {
  const reminderText: string = isBot
    ? `哦？谁把 ${label} 这个机器人拎进来的？铁疙瘩自己可点不了按钮——` +
      `${formatMinSec(VERIFICATION_TIMEOUT_MS)}内得有白名单大人帮它点下面的按钮作保，` +
      `不然本天才就把这个来路不明的铁皮杂鱼扔出去哦♡`
    : `喂，${label}，新来的杂鱼给本天才听好了，` +
      `${formatMinSec(VERIFICATION_TIMEOUT_MS)}内点下面的按钮证明你不是机器人，` +
      // 只承诺踢人：处置路径只清理机器人自己制造的验证痕迹，成员发言一概不动
      // （见 verificationEffects/terminal.ts 的 expelMember）。承诺删发言而实际
      // 不删，是群成员一眼就能证伪的假话。
      `不然本天才就一脚把你踢出去哦♡`;
  sendReminderMessage({
    chatId,
    userId,
    reminderKind: "original",
    text: reminderText,
    replyToMessageId: undefined,
    dispatchVerification,
  });
}

interface SendReplyReminderParams {
  chatId: number;
  userId: number;
  label: string;
  targetMessageId: number;
  dispatchVerification: VerificationDispatcher;
}

/** 把提醒回复到待验证成员刚发出的普通群消息，确保 TA 收到通知。 */
export function sendReplyReminder({
  chatId,
  userId,
  label,
  targetMessageId,
  dispatchVerification,
}: SendReplyReminderParams): void {
  const reminderText: string = `喂，${label}，话都说上了，${formatMinSec(VERIFICATION_TIMEOUT_MS)}内把下面的验证按钮点一下啊杂鱼。` +
    // 同上：不承诺删发言，只承诺请人出去。
    `再装看不见的话，本天才可要直接把你请出去咯♡`;
  sendReminderMessage({
    chatId,
    userId,
    reminderKind: "reply",
    text: reminderText,
    replyToMessageId: targetMessageId,
    dispatchVerification,
  });
}

interface EnsurePendingReminderParams {
  chatId: number;
  userId: number;
  state: PendingState;
  dispatchVerification: VerificationDispatcher;
}

/** 恢复快照或 timeout 续窗时，按当前状态选择唯一有效的提醒形态。 */
export function ensurePendingReminder({
  chatId,
  userId,
  state,
  dispatchVerification,
}: EnsurePendingReminderParams): void {
  if (
    state.reminderMessageId !== undefined ||
    state.replyReminderMessageId !== undefined
  ) return;
  if (state.replyReminderRequested && state.welcomeAnchorMessageId !== undefined) {
    sendReplyReminder({
      chatId,
      userId,
      label: state.label,
      targetMessageId: state.welcomeAnchorMessageId,
      dispatchVerification,
    });
  } else {
    sendVerificationReminder({
      chatId,
      userId,
      label: state.label,
      isBot: state.isBot,
      dispatchVerification,
    });
  }
}
