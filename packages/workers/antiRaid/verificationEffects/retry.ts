import { verificationEntries } from "../../../cache/workers/antiRaid/verification";
import {
  VERIFICATION_TERMINAL_RETRY_MAX_MS,
  VERIFICATION_TERMINAL_RETRY_MS,
} from "../../../consts/antiRaid/verification";
import { cappedExponentialMs } from "../../../libs/backoff";
import { verificationKey } from "../../../libs/verificationKey";
import type { VerificationDispatcher, VerificationEntry } from "../../../types/antiRaid/internal";
import type { VerificationEvent, VerificationState } from "../../../types/states/verification";

export interface ScheduleTerminalRetryParams {
  chatId: number;
  userId: number;
  /** 发起这次动作时的状态；条目已换成别的状态时不排程。 */
  state: VerificationState;
  /** 到点投递的事件：踢人重试为 kickRetry，处置重试为 terminalPersisted。 */
  event: Extract<VerificationEvent, { type: "kickRetry" | "terminalPersisted" }>;
  dispatchVerification: VerificationDispatcher;
}

/**
 * 为仍是当前 token 的终态动作（私密模式踢人、处置）安排有上限的指数退避重试：清掉条目上
 * 的旧计时器，按 terminalRetries 算出第几次退避并加一，到点投递 event。
 * @returns 条目仍是这个状态、已排程时为 true。
 */
export function scheduleTerminalRetry({
  chatId,
  userId,
  state,
  event,
  dispatchVerification,
}: ScheduleTerminalRetryParams): boolean {
  const entry: VerificationEntry | undefined = verificationEntries.get(verificationKey(chatId, userId));
  if (entry?.state !== state) return false;
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  const delayMs: number = cappedExponentialMs(
    VERIFICATION_TERMINAL_RETRY_MS,
    entry.terminalRetries,
    VERIFICATION_TERMINAL_RETRY_MAX_MS
  );
  entry.terminalRetries += 1;
  entry.timer = setTimeout((): void => dispatchVerification(chatId, userId, event), delayMs);
  entry.timer.unref();
  return true;
}
