import type { Api } from "grammy";

/** grammY Node 声明与 Bun 原生取消信号共用的参数类型。 */
type TelegramSignal = AbortSignal & NonNullable<Parameters<Api["getMe"]>[0]>;

/** 原样传递 Bun 取消信号，并在类型边界适配 grammY 的 abort-controller 声明。 */
export function telegramSignal(signal: AbortSignal | undefined): TelegramSignal | undefined {
  return signal as TelegramSignal | undefined;
}
