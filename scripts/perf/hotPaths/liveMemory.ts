import { HOT_PATH_PROFILE_MEMORY_USAGE_MAX_ATTEMPTS } from "../../../packages/consts/performance";

interface MemoryUsageSystemError extends Error {
  readonly code?: unknown;
  readonly errno?: unknown;
}

/**
 * 采样进程内存时只重试被信号中断（EINTR）的那一次读取；其他错误以及连续中断
 * 都保留原异常交给性能门禁失败。
 *
 * 判定只看 EINTR 本身（`code === "EINTR"` 或 `errno` 为 4/-4），不要求特定的
 * `syscall` 字段值。
 */
export function readInterruptibleMemory<T>(read: () => T): T {
  let failedAttempts: number = 0;
  while (true) {
    try {
      return read();
    } catch (error: unknown) {
      failedAttempts += 1;
      if (
        !isInterruptedMemoryError(error) ||
        failedAttempts >= HOT_PATH_PROFILE_MEMORY_USAGE_MAX_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
}

/** process.memoryUsage() 的具名入口；语义同 readInterruptibleMemory。 */
export function readProcessMemoryUsage(
  readMemoryUsage: () => NodeJS.MemoryUsage = process.memoryUsage
): NodeJS.MemoryUsage {
  return readInterruptibleMemory(readMemoryUsage);
}

function isInterruptedMemoryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const systemError: MemoryUsageSystemError = error;
  return systemError.code === "EINTR" ||
    systemError.errno === 4 ||
    systemError.errno === -4;
}
