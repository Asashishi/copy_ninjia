import { verificationEntries } from "../../../cache/workers/antiRaid/verification";
import {
  VERIFICATION_TERMINAL_RETRY_MAX_MS,
  VERIFICATION_TERMINAL_RETRY_MS,
} from "../../../consts/antiRaid/verification";
import { logger } from "../../../infra/logger";
import {
  joinVerificationApi,
  kickChatMemberWithOutcome,
  probeChatMembership,
} from "../../../infra/telegram";
import { verificationKey } from "../../../libs/verificationKey";
import type {
  VerificationDispatcher,
  VerificationEntry,
} from "../../../types/antiRaid/internal";
import type { VerificationState } from "../../../types/states/verification";
import type { KickChatMemberOutcome } from "../../../infra/telegram";

interface ScheduleKickRetryParams {
  chatId: number;
  userId: number;
  state: VerificationState & { kind: "kickPending" };
  dispatchVerification: VerificationDispatcher;
}

/** 为仍是当前 token 的私密模式踢人动作安排指数退避重试。 */
function scheduleKickRetry({
  chatId,
  userId,
  state,
  dispatchVerification,
}: ScheduleKickRetryParams): void {
  const key: string = verificationKey(chatId, userId);
  const entry: VerificationEntry | undefined = verificationEntries.get(key);
  if (entry?.state !== state) return;
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  const retries: number = entry.terminalRetries ?? 0;
  entry.terminalRetries = retries + 1;
  entry.timer = setTimeout(
    (): void => dispatchVerification(chatId, userId, { type: "kickRetry" }),
    Math.min(
      VERIFICATION_TERMINAL_RETRY_MS * (2 ** retries),
      VERIFICATION_TERMINAL_RETRY_MAX_MS
    )
  );
}

interface RunKickMemberEffectParams {
  chatId: number;
  userId: number;
  transitionState: VerificationState | undefined;
  dispatchVerification: VerificationDispatcher;
}

/**
 * 执行私密模式踢人。transitionState 是整批 effect 捕获的执行 token，任何豁免、
 * 停管或新一代记录都会让不可逆调用在同步复核处失效。
 */
export async function runKickMemberEffect({
  chatId,
  userId,
  transitionState,
  dispatchVerification,
}: RunKickMemberEffectParams): Promise<void> {
  const key: string = verificationKey(chatId, userId);
  if (
    transitionState?.kind !== "kickPending" ||
    verificationEntries.get(key)?.state !== transitionState
  ) return;
  transitionState.executionStarted = true;
  const outcome: KickChatMemberOutcome = await kickChatMemberWithOutcome(
    chatId,
    userId,
    joinVerificationApi
  );
  if (verificationEntries.get(key)?.state !== transitionState) return;
  if (outcome === "kicked") {
    dispatchVerification(chatId, userId, {
      type: "kickSettled",
      now: Date.now(),
    });
    return;
  }

  // 请求失败后重新允许权威豁免替换 token，再用成员探测消除响应丢失的不确定性。
  transitionState.executionStarted = false;
  const memberPresent: boolean | undefined =
    await probeChatMembership(chatId, userId, joinVerificationApi);
  if (verificationEntries.get(key)?.state !== transitionState) return;
  if (memberPresent === false) {
    dispatchVerification(chatId, userId, {
      type: "kickSettled",
      now: Date.now(),
    });
    return;
  }
  logger.error(
    outcome === "forbidden"
      ? `Lockdown kick for user ${userId} in chat ${chatId} was forbidden by Telegram permissions or member status; retaining the pending action for retry.`
      : `Lockdown kick for user ${userId} in chat ${chatId} did not settle; retaining the pending action for retry.`
  );
  scheduleKickRetry({
    chatId,
    userId,
    state: transitionState,
    dispatchVerification,
  });
}
