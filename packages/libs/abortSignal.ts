/**
 * AbortSignal 的组合工具。
 *
 * 与 libs/withTimeout.ts 分开：那边是给一个**已经在途、无法取消**的 Promise 加
 * 等待上限（超时只结束等待，底层任务照跑）；这边产出的是一个真能把下游 fetch
 * 掐断的 signal。两者名字相近但职责不同，不要合并。
 */

/**
 * 把调用方的 invalidate signal 与一份**独立**的超时预算合成一个 signal。
 *
 * 每次调用现取一个 `AbortSignal.timeout`，因此同一次下载里的两步不会共享同一个
 * deadline——传入一个共享 signal 的话，第一步用掉的时间会从第二步的预算里扣。
 *
 * @param signal 调用方的取消源；缺省表示只受超时约束。
 * @param timeoutMs 本次调用独占的超时预算。
 */
export function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout: AbortSignal = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
