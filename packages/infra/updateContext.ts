import { updateScopeStorage } from "../cache/perThread/updateContext";
import type { UpdateScope, UpdateTopic } from "../types/lifecycle";

/**
 * 一条 update 的取消边界、统一时刻与触发话题。app/updateRunner.ts 为每条 update
 * 填入独立 signal 与触发话题；wed/runtime.ts 与 commands/deferredCommands.ts 在任务
 * 出队时恢复接纳时的话题，并以自己的停机边界作为信号。存储实例见
 * cache/perThread/updateContext.ts，Worker isolate 不共享主线程的作用域。
 */

/**
 * 在指定取消上下文中执行 middleware 或已经接纳的异步交互。
 * @param topic 触发消息所在的论坛话题；不在话题里时省略。
 */
export function runWithUpdateAbortSignal<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
  topic?: UpdateTopic
): Promise<T> {
  return updateScopeStorage.run({ signal, now: null, topic }, run);
}

/** 当前异步调用链所属 update 的触发话题；不在 update 作用域或不在话题里时为 undefined。 */
export function currentUpdateTopic(): UpdateTopic | undefined {
  return updateScopeStorage.getStore()?.topic;
}

/**
 * 发往 chatId 的临时提示应落的论坛话题：只有与触发消息同群时才沿用触发话题，
 * 发往别的群一律不带（话题 id 只在所属群内有效）。
 */
export function updateTopicThreadIdFor(chatId: number): number | undefined {
  const topic: UpdateTopic | undefined = updateScopeStorage.getStore()?.topic;
  return topic?.chatId === chatId ? topic.threadId : undefined;
}

/** 当前异步调用链所属 update 的取消信号；非 update owner 返回 undefined。 */
export function currentUpdateAbortSignal(): AbortSignal | undefined {
  return updateScopeStorage.getStore()?.signal;
}

/**
 * 本条 update 统一的「现在」。
 *
 * 整条 update 共用同一个时刻：入群守卫的投递段（antiRaid/updateIngress.ts）与
 * 自动流水线主干（auto/message/index.ts）等调用点读到同一个值。
 *
 * 已填值时只做一次 AsyncLocalStorage 取值，不读墙钟。
 *
 * 不在 update 作用域内（Worker、启动路径、单测直调）时返回当刻墙钟，
 * 等同 `Date.now()`。
 */
export function updateNow(): number {
  const scope: UpdateScope | undefined = updateScopeStorage.getStore();
  if (scope === undefined) return Date.now();
  return scope.now ??= Date.now();
}

/**
 * 跨过一次有界等待之后重新取时刻，并让本 update 后续调用点改用新值。
 *
 * 调用点是自动流水线在频道帖自发消息 rendezvous
 * （最长 SELF_SENT_RENDEZVOUS_TIMEOUT_MS）之后恢复处理。
 */
export function refreshUpdateNow(): number {
  const scope: UpdateScope | undefined = updateScopeStorage.getStore();
  const now: number = Date.now();
  if (scope !== undefined) scope.now = now;
  return now;
}

/** 将调用方自己的取消边界与当前 update 生命周期合并。 */
export function combineWithUpdateAbortSignal(
  signal?: AbortSignal
): AbortSignal | undefined {
  const updateSignal: AbortSignal | undefined = currentUpdateAbortSignal();
  if (signal === undefined) return updateSignal;
  if (updateSignal === undefined || updateSignal === signal) return signal;
  return AbortSignal.any([signal, updateSignal]);
}

/** update 已被停机流程取消时向上解开 handler，禁止按普通业务失败继续执行。 */
export function throwIfUpdateAborted(
  signal: AbortSignal | undefined = currentUpdateAbortSignal()
): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Telegram update was aborted during shutdown.", "AbortError");
}
