/**
 * 破坏性 Telegram 请求命中 429 后，重试前现查发现原前置条件已失效。
 * name 会穿过 Worker 双工错误线协议，业务动作据此把它归一化成「目标已离群」。
 */
export class TelegramRetryPreconditionChangedError extends Error {
  constructor() {
    super("Telegram destructive retry precondition changed.");
    this.name = "TelegramRetryPreconditionChangedError";
  }
}

/** 主线程原始错误与 Worker 重建错误共用的前置条件失效判定。 */
export function isTelegramRetryPreconditionChanged(error: unknown): boolean {
  return error instanceof Error &&
    error.name === "TelegramRetryPreconditionChangedError";
}

/** 主线程 GrammyError 与 Worker 双工错误共用的安全 Telegram 诊断字段。 */
export function telegramErrorDetails(
  error: unknown
): Readonly<{ errorCode: number; description: string }> | undefined {
  if (
    error instanceof Error &&
    "error_code" in error &&
    typeof error.error_code === "number" &&
    "description" in error &&
    typeof error.description === "string"
  ) {
    return { errorCode: error.error_code, description: error.description };
  }
  if (
    error instanceof Error &&
    "telegramErrorCode" in error &&
    typeof error.telegramErrorCode === "number" &&
    "telegramDescription" in error &&
    typeof error.telegramDescription === "string"
  ) {
    return {
      errorCode: error.telegramErrorCode,
      description: error.telegramDescription,
    };
  }
  return undefined;
}
