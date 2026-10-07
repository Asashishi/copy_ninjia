import {
  combineWithUpdateAbortSignal,
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
} from "../../updateContext";
import { beginSelfSentSend, endSelfSentSend } from "../../selfSentTracker";
import { isAbortError } from "../../../libs/abortSignal";
import { logApiError } from "../client";
import { telegramErrorDetails } from "../errors";

interface RunTelegramActionParams<T, R> {
  action: string;
  execute: (signal?: AbortSignal) => Promise<T>;
  map: (result: T) => R;
  fallback: R;
  signal?: AbortSignal;
  /**
   * 是否把这次失败记成 API 错误；第二个参数是 runTelegramAction 已算好的复合信号，直接复用。
   * 缺省为 logUnlessAborted（调用方 signal 已中止时不记）。
   */
  shouldLogError?: (
    error: unknown,
    actionSignal: AbortSignal | undefined
  ) => boolean;
  /**
   * map 会对这个 chat 调用 `markSelfSent` 时传入：请求发出前登记在途发送，
   * map 之后的同一同步段结算（见 infra/selfSentTracker.ts）。
   */
  selfSentChatId?: number;
}

/**
 * 把 Telegram 动作失败归一化成调用方约定的业务结果。map 也在同一个错误
 * 边界内：成功后的结果转换或本机自发消息登记失败时同样记录
 * 对应动作并返回 fallback。主动 API 调用失败按业务结果返回 fallback，
 * 不经 grammY 的 bot.catch（它处理 update/middleware 逃逸异常）。
 *
 * 失败本身是取消（isAbortError，例如 Worker 停机 drain 撤销的双工请求）时不记
 * API 错误；`shouldLogError` 仍会被调用，供调用方完成结局分类。
 */
export async function runTelegramAction<T, R>({
  action,
  execute,
  map,
  fallback,
  signal,
  shouldLogError = logUnlessAborted,
  selfSentChatId,
}: RunTelegramActionParams<T, R>): Promise<R> {
  const updateSignal: AbortSignal | undefined =
    currentUpdateAbortSignal();
  const actionSignal: AbortSignal | undefined =
    combineWithUpdateAbortSignal(signal);
  throwIfUpdateAborted(updateSignal);
  if (selfSentChatId !== undefined) beginSelfSentSend(selfSentChatId);
  try {
    const mapped: R = map(await execute(actionSignal));
    // 先完成 map 中的 self-sent 记账，再把 update 取消向上抛出，
    // handler 不再继续后续业务写入。
    throwIfUpdateAborted(updateSignal);
    return mapped;
  } catch (error: unknown) {
    if (updateSignal?.aborted === true) {
      throwIfUpdateAborted(updateSignal);
    }
    if (shouldLogError(error, actionSignal) && !isAbortError(error)) {
      logApiError(action, error);
    }
    return fallback;
  } finally {
    if (selfSentChatId !== undefined) endSelfSentSend(selfSentChatId);
  }
}

/**
 * runTelegramAction 缺省的 `shouldLogError`：调用方 signal 已中止时的失败不记 API 错误。
 *
 * 只对带调用方 signal 的动作有意义（update 取消在判据之前已由统一边界上抛，
 * 取消形状的失败由 runTelegramAction 统一不记）。各 Telegram 动作入口共用；
 * runPermissionAwareTelegramAction 在分类后同样经过本函数。
 */
export function logUnlessAborted(
  _error: unknown,
  actionSignal: AbortSignal | undefined
): boolean {
  return actionSignal?.aborted !== true;
}

/** 执行只关心是否成功的 Telegram 动作。 */
export async function runBooleanTelegramAction(
  action: string,
  execute: (signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal
): Promise<boolean> {
  return runTelegramAction({
    action,
    execute,
    map: (): boolean => true,
    fallback: false,
    signal,
  });
}

/** 一次权限敏感动作的归一化结局；调用方再翻译成自己的领域词。 */
export type PermissionAwareOutcome =
  | "succeeded"
  /** 由 claimError 认领的领域结局（如「目标已不在群」），既非权限也非故障。 */
  | "claimed"
  | "forbidden"
  /** Telegram 以 PARTICIPANT_ID_INVALID 拒绝目标用户 ID；照常记 API 错误。 */
  | "participantInvalid"
  | "failed";

export interface RunPermissionAwareTelegramActionParams {
  action: string;
  execute: (signal?: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal;
  /**
   * 领域先认领这次错误：返回 true 表示已经归类完毕，本函数不再按权限解释、
   * 也不记 API 错误日志。`/batch_kick` 的「目标本来就不在群」就是这种结局。
   */
  claimError?: (error: unknown) => boolean;
}

/**
 * 执行一次需要区分「权限拒绝」与「偶发失败」的 Telegram 动作。
 *
 * mute / unmute / kick / ban / ban sender chat 共用这一权限闩锁与结果映射；
 * 不关心 `participantInvalid` 的调用方把它归入 `failed`。
 * 权限拒绝（见 isPermissionDenied）归为 `forbidden`，不归入偶发的 `failed`。
 *
 * 取消造成的失败不记 API 错误，口径与 runBooleanTelegramAction 一致。
 */
export async function runPermissionAwareTelegramAction({
  action,
  execute,
  signal,
  claimError,
}: RunPermissionAwareTelegramActionParams): Promise<PermissionAwareOutcome> {
  let outcome: PermissionAwareOutcome = "failed";
  const succeeded: boolean = await runTelegramAction({
    action,
    execute,
    map: (): boolean => true,
    fallback: false,
    signal,
    shouldLogError: (
      error: unknown,
      actionSignal: AbortSignal | undefined
    ): boolean => {
      if (claimError?.(error) === true) {
        outcome = "claimed";
        return false;
      }
      outcome = isPermissionDenied(error)
        ? "forbidden"
        : isParticipantIdInvalid(error) ? "participantInvalid" : "failed";
      return logUnlessAborted(error, actionSignal);
    },
  });
  return succeeded ? "succeeded" : outcome;
}

/** 挂回复时 Telegram 要的那一段；各发送入口共用同一份形状。 */
export interface TelegramReplyParameters {
  readonly message_id: number;
  readonly allow_sending_without_reply: true;
}

/**
 * 把可选的「回复哪一条」译成 Bot API 的 `reply_parameters`，没有回复时给
 * `undefined`。
 *
 * `allow_sending_without_reply` 恒为 true：被回复的消息已被删除时这条仍发出
 * （降级成普通发送、掉出话题，落点由 `message_thread_id` 保证，见 libs/forumTopic.ts）。
 *
 * 返回 `undefined` 而不是让调用方条件展开：payload 按定形一次初始化，
 * grammY 序列化时丢掉值为 undefined 的字段（core/payload.js 的 `str()`
 * 与 payloadToMultipartItr 各自过滤 null/undefined），请求体与不带这个键
 * 逐字节相同。
 */
export function replyParametersFor(
  replyToMessageId: number | undefined
): TelegramReplyParameters | undefined {
  // 判真值：message_id 为 0 时不挂回复。
  return replyToMessageId ? { message_id: replyToMessageId, allow_sending_without_reply: true } : undefined;
}

/** Telegram 是否明确拒绝了这次操作的权限，而不是偶发失败。 */
export function isPermissionDenied(error: unknown): boolean {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  if (details === undefined) return false;
  // 403 一律算权限拒绝；400 只认描述含 `not enough rights` 的一类，
  // 其余 400（如用户不存在、聊天不存在）不算。
  if (details.errorCode === 403) return true;
  return (
    details.errorCode === 400 &&
    /not enough rights/i.test(details.description)
  );
}

/**
 * Telegram 是否拒绝了本群的成员查询本身，而不是针对目标用户：403（机器人不在群、
 * 被踢出），或 400 `CHAT_ADMIN_REQUIRED`（本群只允许管理员查询他人成员身份）。
 */
export function isChatMemberQueryDenied(error: unknown): boolean {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  if (details === undefined) return false;
  if (details.errorCode === 403) return true;
  return details.errorCode === 400 && /\bCHAT_ADMIN_REQUIRED\b/.test(details.description);
}

/**
 * Telegram 是否以 PARTICIPANT_ID_INVALID 拒绝了目标用户 ID。
 * 已销号账号的 getChatMember 与 banChatMember 都返回这一句 400。
 */
export function isParticipantIdInvalid(error: unknown): boolean {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  return details?.errorCode === 400 &&
    /\bPARTICIPANT_ID_INVALID\b/.test(details.description);
}
