import { AVATAR_FETCH_TIMEOUT_MS } from "../../../consts/telegram";
import type { bot } from "../mainClient";

/** 单次头像操作的结果：区分可重试故障与确定性失败。 */
export type AvatarOperationAttemptResult = "ok" | "transient-failure" | "permanent-failure";

/** 把调用方取消信号与头像请求自身的硬超时合并。 */
export function avatarFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeout: AbortSignal = AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** 在 grammY 的 API 信号边界收窄标准 AbortSignal。 */
export function telegramSignal(signal?: AbortSignal): Parameters<typeof bot.api.getChat>[1] {
  return signal as unknown as Parameters<typeof bot.api.getChat>[1];
}
