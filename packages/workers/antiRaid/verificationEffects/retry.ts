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
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    if (
      verificationEntries.get(verificationKey(chatId, userId)) !== entry ||
      entry.state !== state ||
      entry.timer !== timer
    ) return;
    entry.timer = undefined;
    dispatchVerification(chatId, userId, event);
  }, delayMs);
  entry.timer = timer;
  timer.unref();
  return true;
}

export interface ScheduleKickRetryParams {
  chatId: number;
  userId: number;
  state: VerificationState & { kind: "kickPending" };
  dispatchVerification: VerificationDispatcher;
}

/** 为仍是当前 token 的私密模式踢人动作安排指数退避重试；排上时清掉「效果已开始」标记。 */
export function scheduleKickRetry({
  chatId,
  userId,
  state,
  dispatchVerification,
}: ScheduleKickRetryParams): void {
  if (scheduleTerminalRetry({ chatId, userId, state, event: { type: "kickRetry" }, dispatchVerification })) {
    state.effectStarted = false;
  }
}

/** retryRejectedTerminal 的入参。 */
export interface RetryRejectedTerminalParams {
  chatId: number;
  userId: number;
  /** 这批终态副作用取得许可时捕获的执行 token。 */
  state: VerificationState | undefined;
  dispatchVerification: VerificationDispatcher;
}

/**
 * 已取得终态许可的副作用链意外 reject（如 Worker→主线程请求失败）后的收尾：条目仍是同一
 * 终态对象时复位 Worker 本地执行门，并按条目的退避序列排一次重试（kickPending 投递
 * kickRetry，checkingInviter 与 expelling 投递 terminalPersisted）；条目已换状态时不动。
 */
export function retryRejectedTerminal({
  chatId,
  userId,
  state,
  dispatchVerification,
}: RetryRejectedTerminalParams): void {
  if (state === undefined || verificationEntries.get(verificationKey(chatId, userId))?.state !== state) return;
  if (state.kind === "kickPending") {
    state.executionStarted = false;
    scheduleKickRetry({ chatId, userId, state, dispatchVerification });
    return;
  }
  if (state.kind !== "checkingInviter" && state.kind !== "expelling") return;
  state.executionStarted = false;
  scheduleTerminalRetry({ chatId, userId, state, event: { type: "terminalPersisted" }, dispatchVerification });
}
