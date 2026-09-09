import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 一条 update 的取消边界，以及它统一的「现在」。
 *
 * `now` 惰性填充：第一次有人问「现在几点」时取一次墙钟，此后同一条 update 的
 * 全部调用点复用它（见 updateNow）。不在进入作用域时就取，是因为
 * callback_query、inline_query、chat_member 这些 update 一次都不问，预先取一次
 * 就是白付一次时钟读取。
 */
interface UpdateScope {
  readonly signal: AbortSignal;
  /** `null` 表示本条 update 还没有任何调用点问过时刻，不表示时刻为零。 */
  now: number | null;
}

/**
 * 主线程异步取消上下文。app/updateRunner.ts 为每条 update 填入独立 signal；
 * wed/runtime.ts 在交互出队时恢复接纳时的信号并合入自己的停机边界。
 * run 返回后退出调用方上下文，异步子任务继续持有各自的 signal；Worker isolate 不共享本存储。
 */
const updateScopeStorage: AsyncLocalStorage<UpdateScope> =
  new AsyncLocalStorage<UpdateScope>();

/** 在指定取消上下文中执行 middleware 或已经接纳的异步交互。 */
export function runWithUpdateAbortSignal<T>(
  signal: AbortSignal,
  run: () => Promise<T>
): Promise<T> {
  return updateScopeStorage.run({ signal, now: null }, run);
}

/** 当前异步调用链所属 update 的取消信号；非 update owner 返回 undefined。 */
export function currentUpdateAbortSignal(): AbortSignal | undefined {
  return updateScopeStorage.getStore()?.signal;
}

/**
 * 本条 update 统一的「现在」。
 *
 * 同一条群消息会在两条 middleware 上各要一次时刻：入群守卫的广告判定上下文
 * （antiRaid/updateIngress.ts）与自动流水线主干（auto/message/index.ts）。两处
 * 各读一次墙钟，同一条消息的判定就可能横跨毫秒边界——这正是主干内部早已用
 * 单个 `now` 防住的那件事，本函数只是把同一条不变量扩到整条 update。
 *
 * 顺带的代价差别很大：时钟读取在部署机上不一定走 vDSO 快路径，实测可达
 * 微秒量级，而本函数命中已填值只是一次 AsyncLocalStorage 取值。
 *
 * 不在 update 作用域内（Worker、启动路径、单测直调）时如实返回当刻墙钟，
 * 语义与直接调用 `Date.now()` 完全一致。
 */
export function updateNow(): number {
  const scope: UpdateScope | undefined = updateScopeStorage.getStore();
  if (scope === undefined) return Date.now();
  return scope.now ??= Date.now();
}

/**
 * 跨过一次有界等待之后重新取时刻，并让本 update 后续调用点改用新值。
 *
 * 只有一个调用点：自动流水线在频道帖自发消息 rendezvous
 * （最长 SELF_SENT_RENDEZVOUS_TIMEOUT_MS）之后恢复处理。等待前的时刻不得带过
 * 这条边界，理由与那里「恢复处理必须读取当时现值」的状态复读完全相同。
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
