/**
 * catch 到的 `unknown` 归一化边界。
 *
 * `catch (error: unknown)` 是全仓强制的写法（见 AGENTS.md「类型与接口」），
 * 但日志文案要的是一段字符串、Promise 的 reject 约定要的是一个 Error。这里提供
 * 三档：errorMessage 取文案，toError 以原值字符串重建 Error，toErrorOr 以调用点
 * 自己的兜底文案重建 Error 并把原值挂进 `cause`。
 */

/**
 * 把 catch 到的值压成日志和回执能直接拼接的一段文案。
 *
 * 非 Error 值走 `String()`：抛出来的可能是字符串、数字，甚至 `undefined`，
 * 读 `.message` 会再抛一次或印出 `undefined`。
 * @param error catch 到的原值。
 * @returns Error 的 message，或原值的字符串形式。
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把 catch 到的值压成 Error，供 reject、`cause` 与需要堆栈的日志使用。
 *
 * 已经是 Error 的原样返回，保住原始堆栈；其余值用 `String()` 当 message 重建。
 * 需要写明「这里抛了个非 Error」的调用点改用 toErrorOr。
 * @param error catch 到的原值。
 * @returns 原 Error，或以原值字符串形式为 message 的新 Error。
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * 把 catch 到的值压成 Error，非 Error 值换成调用点的固定兜底文案。
 *
 * 已经是 Error 的原样返回；其余值以 fallback 为 message 新建 Error，原值挂在
 * `cause` 上。fallback 是调用点写死的英文文案，不拼接原值。
 * @param error catch 到的原值。
 * @param fallback 非 Error 值时使用的 message。
 * @returns 原 Error，或 message 为 fallback、cause 为原值的新 Error。
 */
export function toErrorOr(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}
