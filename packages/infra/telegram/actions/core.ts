import {
  combineWithUpdateAbortSignal,
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
} from "../../updateContext";
import { logApiError } from "../client";
import { telegramErrorDetails } from "../errors";

interface RunTelegramActionParams<T, R> {
  action: string;
  execute: (signal?: AbortSignal) => Promise<T>;
  map: (result: T) => R;
  fallback: R;
  signal?: AbortSignal;
  /**
   * 第二个参数是 runTelegramAction 已算好的复合信号，直接复用。自己再调一次
   * combineWithUpdateAbortSignal 只为读一次 .aborted，却要新建一个
   * AbortSignal.any 并挂到调用方那个长生命周期 controller 上。
   */
  shouldLogError?: (
    error: unknown,
    actionSignal: AbortSignal | undefined
  ) => boolean;
}

/**
 * 把 Telegram 动作失败归一化成调用方约定的业务结果。map 也留在同一个错误
 * 边界内，保持既有语义：成功后的结果转换或本机自发消息登记失败时同样记录
 * 对应动作并返回 fallback。这里不用 grammY 的 bot.catch：它处理的是
 * update/middleware 逃逸异常，且本项目会让该错误触发 update 重投；这些主动
 * API 调用失败属于可预期的业务结果，调用方还需要得到 false/undefined。
 */
export async function runTelegramAction<T, R>({
  action,
  execute,
  map,
  fallback,
  signal,
  shouldLogError,
}: RunTelegramActionParams<T, R>): Promise<R> {
  const updateSignal: AbortSignal | undefined =
    currentUpdateAbortSignal();
  const actionSignal: AbortSignal | undefined =
    combineWithUpdateAbortSignal(signal);
  throwIfUpdateAborted(updateSignal);
  try {
    const mapped: R = map(await execute(actionSignal));
    // 远端可能在 abort 竞态中已经提交成功；先做 map 中最小的 self-sent
    // 记账，再把 update 取消向上抛出，禁止 handler 继续后续业务写入。
    throwIfUpdateAborted(updateSignal);
    return mapped;
  } catch (error: unknown) {
    if (updateSignal?.aborted === true) {
      throwIfUpdateAborted(updateSignal);
    }
    if (shouldLogError?.(error, actionSignal) !== false) {
      logApiError(action, error);
    }
    return fallback;
  }
}

/**
 * 默认的 `shouldLogError`：停机 abort 造成的失败不记 API 错误——它不是远端故障。
 *
 * 提成模块级具名函数而不是在每个调用点现写一份同样的箭头函数：口径只有一条，
 * 六个发送入口（本文件的 runBooleanTelegramAction、actions/messages.ts 与
 * actions/mediaMessages.ts 的各个 send*）必须逐字一致，抄开就会有一处慢慢
 * 长出自己的判据。`actions/core.ts` 的权限感知版本另有 claimError 副作用，
 * **不**复用本函数。
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
    shouldLogError: logUnlessAborted,
  });
}

/** 一次权限敏感动作的归一化结局；调用方再翻译成自己的领域词。 */
export type PermissionAwareOutcome =
  | "succeeded"
  /** 由 claimError 认领的领域结局（如「目标已不在群」），既非权限也非故障。 */
  | "claimed"
  | "forbidden"
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
 * mute / unmute / kick / ban / ban sender chat 共用这一权限闩锁与三元结果映射。
 * 闩锁必须覆盖整次动作，避免把永久的 403 归类为值得退避重试的偶发失败。
 *
 * 停机 abort 造成的失败不记 API 错误——它不是远端故障，口径与
 * runBooleanTelegramAction 一致。
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
      outcome = isPermissionDenied(error) ? "forbidden" : "failed";
      return actionSignal?.aborted !== true;
    },
  });
  return succeeded ? "succeeded" : outcome;
}

/**
 * 无信号时共用的空元组；调用点一律就地展开、不持有返回值，因此可以共享一份。
 *
 * 口径同 aiChat/gemini/replySession.ts 的 EMPTY_FUNCTION_CALLS：类型是只读元组，
 * 编译期就不允许写入，不需要（在 packages/ 下也不允许）运行期冻结。
 */
const NO_SIGNAL_ARGS: readonly [] = [];

/**
 * 把 AbortSignal 接到 grammY raw API 调用的最后一个位置参数上。
 *
 * grammY 每个方法都把 signal 放在 options 之后的最后一位，而那个位置的声明类型
 * 不是 `AbortSignal`，逐个调用点各写一次
 * `signal as unknown as Parameters<Api["x"]>[n]` 就是十几份带手写下标的重复。
 * @returns 没有信号时是共用空元组，有信号时是新建的单元素元组。
 */
export function signalArgs(
  signal: AbortSignal | undefined
): readonly [] | readonly [never] {
  return signal === undefined ? NO_SIGNAL_ARGS : [signal as unknown as never];
}

/** 挂回复时 Telegram 要的那一段；三个发送入口共用同一份形状。 */
export interface TelegramReplyParameters {
  readonly message_id: number;
  readonly allow_sending_without_reply: true;
}

/**
 * 把可选的「回复哪一条」译成 Bot API 的 `reply_parameters`，没有回复时给
 * `undefined`。
 *
 * `allow_sending_without_reply` 恒为 true：被回复的消息可能已被删除，那时这条
 * 仍要发出去（代价是它会降级成普通发送、掉出话题，落点因此另由
 * `message_thread_id` 兜住，见 libs/forumTopic.ts）。
 *
 * 返回 `undefined` 而不是让调用方条件展开：payload 按定形一次初始化，
 * grammY 序列化时会丢掉值为 undefined 的字段（core/payload.js 的 `str()`
 * 与 payloadToMultipartItr 各自过滤 null/undefined），产出与整个不带这个键
 * 逐字节相同的请求体。
 */
export function replyParametersFor(
  replyToMessageId: number | undefined
): TelegramReplyParameters | undefined {
  // 判真值而不是 `!== undefined`：Telegram 的 message_id 恒为正整数，0 不是
  // 合法目标，挂上去只会让整条消息被拒收。与拆出本函数之前的判据逐字一致。
  return replyToMessageId ? { message_id: replyToMessageId, allow_sending_without_reply: true } : undefined;
}

/** Telegram 是否明确拒绝了这次操作的权限，而不是偶发失败。 */
export function isPermissionDenied(error: unknown): boolean {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  if (details === undefined) return false;
  // 403 一律算：不在群、被踢出、没有权限，共同点是「这次调用永远不会成功」。
  // 400 只认点名权限的那一句：同为 400 的「用户不存在」「聊天不存在」不该
  // 被当成权限问题，那会让一个本可重试的批次被永久挂起等一个不会来的授权。
  if (details.errorCode === 403) return true;
  return (
    details.errorCode === 400 &&
    /not enough rights/i.test(details.description)
  );
}
