import { describe, expect, test } from "bun:test";
import { HOT_PATH_PROFILE_MEMORY_USAGE_MAX_ATTEMPTS } from "../../packages/consts/performance";
import { readInterruptibleMemory } from "../../scripts/perf/hotPaths/liveMemory";

const MEMORY_USAGE: NodeJS.MemoryUsage = {
  rss: 1,
  heapTotal: 2,
  heapUsed: 3,
  external: 4,
  arrayBuffers: 5,
};

function createMemoryUsageError(
  code: string,
  errno: number,
  message: string = "memory usage failed"
): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  error.errno = errno;
  return error;
}

describe("热路径进程内存采样", () => {
  test("EINTR 后立即重试并返回读数", () => {
    let attempts: number = 0;
    const readMemoryUsage: () => NodeJS.MemoryUsage = (): NodeJS.MemoryUsage => {
      attempts += 1;
      if (attempts === 1) throw createMemoryUsageError("EINTR", 4);
      return MEMORY_USAGE;
    };

    expect(readInterruptibleMemory(readMemoryUsage)).toEqual(MEMORY_USAGE);
    expect(attempts).toBe(2);
  });

  test("连续 EINTR 达到上限后抛出最后一次原错误", () => {
    let attempts: number = 0;
    // 每次用不同的 message：toThrow 按 message 匹配，据此区分「抛最后一次」与「抛第一个」或「现构造新的」。
    const finalError: NodeJS.ErrnoException =
      createMemoryUsageError("EINTR", 4, "final interrupted read");
    const readMemoryUsage: () => NodeJS.MemoryUsage = (): NodeJS.MemoryUsage => {
      attempts += 1;
      if (attempts === HOT_PATH_PROFILE_MEMORY_USAGE_MAX_ATTEMPTS) throw finalError;
      throw createMemoryUsageError("EINTR", 4, "earlier interrupted read");
    };

    let thrown: unknown;
    try {
      readInterruptibleMemory(readMemoryUsage);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBe(finalError);
    expect(attempts).toBe(HOT_PATH_PROFILE_MEMORY_USAGE_MAX_ATTEMPTS);
  });

  test("不是中断的错误一次都不重试", () => {
    let attempts: number = 0;
    const error: NodeJS.ErrnoException = createMemoryUsageError("ENOMEM", 12);
    const readMemoryUsage: () => NodeJS.MemoryUsage = (): NodeJS.MemoryUsage => {
      attempts += 1;
      throw error;
    };

    expect((): NodeJS.MemoryUsage => readInterruptibleMemory(readMemoryUsage)).toThrow(error);
    expect(attempts).toBe(1);
  });

  test("不带 syscall 字段的 EINTR 照样重试", () => {
    // 判据不要求 syscall === "memoryUsage"：真中断在 Node（uvException 用 uv_resident_set_memory 之类的底层名）
    // 与 Bun（未必设这个字段）上形态不同。
    let attempts: number = 0;
    const readMemoryUsage: () => NodeJS.MemoryUsage = (): NodeJS.MemoryUsage => {
      attempts += 1;
      if (attempts === 1) throw createMemoryUsageError("EINTR", -4);
      return MEMORY_USAGE;
    };

    expect(readInterruptibleMemory(readMemoryUsage)).toEqual(MEMORY_USAGE);
    expect(attempts).toBe(2);
  });

  test("同一套重试护住任意一次内存读取，不只是 process.memoryUsage", () => {
    // snapshotLiveMemory 里还有 jscMemoryUsage 与 process.resourceUsage 两次读取，被同一个信号打断时同样重试。
    let attempts: number = 0;
    const readPeak: () => number = (): number => {
      attempts += 1;
      if (attempts === 1) throw createMemoryUsageError("EINTR", 4);
      return 4_096;
    };

    expect(readInterruptibleMemory(readPeak)).toBe(4_096);
    expect(attempts).toBe(2);
  });
});
