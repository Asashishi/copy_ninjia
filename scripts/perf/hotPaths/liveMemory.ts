import { HOT_PATH_PROFILE_MEMORY_USAGE_MAX_ATTEMPTS } from "../../../packages/consts/performance";

interface MemoryUsageSystemError extends Error {
  readonly code?: unknown;
  readonly errno?: unknown;
}

/**
 * 采样进程内存时只重试被信号中断（EINTR）的那一次读取；其他错误以及连续中断
 * 都保留原异常交给性能门禁失败。
 *
 * **只按 EINTR 本身判，不再要求 `syscall === "memoryUsage"`**：那个字段的取值
 * 跨运行时并不一致（Node 把 process.memoryUsage 的失败包成 uvException，syscall
 * 是 `uv_resident_set_memory` 之类的底层名；Bun 的原生实现未必设这个字段），
 * 拿它当必要条件的结果是真中断来的时候一次都匹配不上，整个重试形同虚设，而
 * 唯一还能通过的就是测试自己捏出来的那个形状。这几个调用点本来就只读内存，
 * 不会有第二种 syscall 混进来，EINTR 这个信号本身已经足够窄。
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
