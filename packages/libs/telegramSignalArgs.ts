import { NO_SIGNAL_ARGS } from "../consts/telegram";

/**
 * 把 AbortSignal 接到 grammY raw API 调用的最后一个位置参数上。
 *
 * grammY 每个方法都把 signal 放在 options 之后的最后一位，而那个位置的声明类型
 * 不是 `AbortSignal`，逐个调用点各写一次
 * `signal as unknown as Parameters<Api["x"]>[n]` 就是十几份带手写下标的重复。
 *
 * **没有信号时返回空元组，即整个省略该参数，不传 `undefined`。** grammY 一律
 * 把这一位原样转发进 `this.raw.x(payload, signal)`，两种写法产出同一次请求；
 * 省略是本仓库统一的调用形态，测试断言按这个形态写。
 *
 * 放在 libs 而不是 infra/telegram/actions/：它只依赖一个常量，却被 app、commands
 * 与 infra 下十几个模块调用。留在 actions/core.ts 里会让每个调用方连带 import
 * 整个 Telegram 动作层与 `infra/telegram/client`，把一个两行纯函数变成重依赖。
 * @returns 没有信号时是共用空元组，有信号时是新建的单元素元组。
 */
export function signalArgs(
  signal: AbortSignal | undefined
): readonly [] | readonly [never] {
  return signal === undefined ? NO_SIGNAL_ARGS : [signal as unknown as never];
}
