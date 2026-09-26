import {
  verificationCallbackChecks,
  verificationCallbackOverloadLogged,
  verificationCallbackReplies,
} from "../../cache/workers/antiRaid/verificationCallbacks";
import { verificationEntries, verificationGeneration } from "../../cache/workers/antiRaid/verification";
import { VERIFICATION_CALLBACK_CHECK_MAX, VERIFICATION_CALLBACK_REPLY_MAX } from "../../consts/antiRaid/verification";
import { logger } from "../../infra/logger";
import { answerCallbackQuery, telegramApi } from "../../infra/telegram";
import { verificationKey } from "../../libs/verificationKey";
import { formatUserLabel } from "../../users/userLabel";
import type { VerificationDispatcher, VerificationEntry } from "../../types/antiRaid/internal";
import type { VerifyCallbackMessage } from "../../types/antiRaid/protocol";
import type { VerificationEffect } from "../../types/states/verification";
import type { AtmosphereTexts } from "../../types/atmosphere";
import { workerAtmosphere } from "./atmosphere";
import { isChatAdmin } from "./adminCache";
import { trackAntiRaidTask } from "./taskTracker";

export interface AnswerVerificationCallbackOptions {
  readonly callbackQueryId: string;
  readonly chatId?: number;
  readonly reply?: Extract<VerificationEffect, { kind: "answerCallback" }>["reply"];
}

/**
 * 验证按钮的唯一回执边界；文案沿用状态机结果，发送和过载回执共用在途硬顶。
 * 满载时不创建请求或等待者；已受理的请求保持排空责任，遵循 docs/cn/04-invariants.md。
 */
export function answerVerificationCallback({
  callbackQueryId,
  chatId,
  reply,
}: AnswerVerificationCallbackOptions): Promise<void> | undefined {
  if (verificationCallbackReplies.current >= VERIFICATION_CALLBACK_REPLY_MAX) {
    if (!verificationCallbackOverloadLogged.current) {
      verificationCallbackOverloadLogged.current = true;
      logger.warn("Join verification callback replies reached their in-flight limit.");
    }
    return undefined;
  }
  const atmosphere: AtmosphereTexts = workerAtmosphere(chatId ?? 0);
  const text: string | undefined = reply === undefined
    ? undefined
    : reply === "ok"
      ? atmosphere.NOTICE_TEXTS.verificationCallbackPassed
      : reply === "invalid"
        ? atmosphere.NOTICE_TEXTS.verificationCallbackExpired
        : reply === "useSelfButton"
          ? atmosphere.NOTICE_TEXTS.verificationUseSelfButton(atmosphere.VERIFICATION_SELF_BUTTON_TEXT, atmosphere.VERIFICATION_APPROVE_BUTTON_TEXT)
          : reply === "notApprover"
            ? atmosphere.NOTICE_TEXTS.verificationAdminOnly
            : reply === "approverUnknown"
              ? atmosphere.NOTICE_TEXTS.verificationAdminUnknown
              : atmosphere.NOTICE_TEXTS.verificationOtherUser;
  verificationCallbackReplies.current++;
  return answerCallbackQuery({
    callbackQueryId,
    text,
    showAlert: reply !== undefined && reply !== "ok",
    api: telegramApi,
  }).catch((error: unknown): void => {
    logger.error("Error answering join verification callback:", error);
  }).finally((): void => { verificationCallbackReplies.current--; });
}

export interface HandleVerificationCallbackEventParams {
  readonly message: VerifyCallbackMessage;
  readonly dispatchVerification: VerificationDispatcher;
}

/**
 * 本人点击同步转移；代点查询有界受理，回投前同时核验 Worker 代际与验证实例。
 * 普通 pending 字段原地更新保持实例有效；leave/rejoin、adopt、停管或 stop 使旧结果失效。
 */
export function handleVerificationCallbackEvent({
  message,
  dispatchVerification,
}: HandleVerificationCallbackEventParams): void {
  const chatId: number | undefined = message.chatId;
  if (chatId === undefined) {
    const task: Promise<void> | undefined = answerVerificationCallback({ callbackQueryId: message.callbackQueryId });
    if (task !== undefined) void trackAntiRaidTask({ task });
    return;
  }
  const targetUserId: number = message.targetUserId;
  const key: string = verificationKey(chatId, targetUserId);
  const expectedEntry: VerificationEntry | undefined = verificationEntries.get(key);
  const generation: number = verificationGeneration.current;
  const isSelf: boolean = message.from.id === targetUserId;
  const needsAdminCheck: boolean = message.action === "approve" && !isSelf && expectedEntry?.state.kind === "pending";
  if (needsAdminCheck && verificationCallbackChecks.current >= VERIFICATION_CALLBACK_CHECK_MAX) {
    const task: Promise<void> | undefined = answerVerificationCallback({
      chatId, callbackQueryId: message.callbackQueryId, reply: "approverUnknown",
    });
    if (task !== undefined) void trackAntiRaidTask({ task });
    return;
  }
  const fromLabel: string = formatUserLabel({
    id: message.from.id,
    username: message.from.username,
    first_name: message.from.first_name,
  }, workerAtmosphere(chatId));
  if (!needsAdminCheck) {
    dispatchVerification(chatId, targetUserId, {
      type: "callback", callbackQueryId: message.callbackQueryId,
      action: message.action, isSelf, fromCanApprove: false, fromLabel,
    });
    return;
  }
  verificationCallbackChecks.current++;
  void trackAntiRaidTask({
    task: isChatAdmin(chatId, message.from.id, "verification approver")
      .then((isAdmin: boolean | undefined): void | Promise<void> => {
        if (generation !== verificationGeneration.current || verificationEntries.get(key) !== expectedEntry) {
          return answerVerificationCallback({ chatId, callbackQueryId: message.callbackQueryId, reply: "invalid" });
        }
        dispatchVerification(chatId, targetUserId, {
          type: "callback", callbackQueryId: message.callbackQueryId,
          action: "approve", isSelf: false, fromCanApprove: isAdmin, fromLabel,
        });
      })
      .finally((): void => { verificationCallbackChecks.current--; }),
  });
}
