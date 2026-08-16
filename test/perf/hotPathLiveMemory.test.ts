import { describe, expect, test } from "bun:test";
import { HOT_PATH_PROFILE_MEMORY_USAGE_MAX_ATTEMPTS } from "../../packages/consts/performance";
import { readInterruptibleMemory, readProcessMemoryUsage } from "../../scripts/perf/hotPaths/liveMemory";

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

    expect(readProcessMemoryUsage(readMemoryUsage)).toEqual(MEMORY_USAGE);
    expect(attempts).toBe(2);
  });

  test("连续 EINTR 达到上限后抛出最后一次原错误", () => {
    let attempts: number = 0;
    // 每次都用同一句 message 的话，toThrow 按 message 匹配，抛第一个、抛最后
    // 一个、甚至现构造一个新的都会通过——恰恰验不到用例名声称要钉的性质。
    const finalError: NodeJS.ErrnoException =
      createMemoryUsageError("EINTR", 4, "final interrupted read");
    const readMemoryUsage: () => NodeJS.MemoryUsage = (): NodeJS.MemoryUsage => {
      attempts += 1;
      if (attempts === HOT_PATH_PROFILE_MEMORY_USAGE_MAX_ATTEMPTS) throw finalError;
      throw createMemoryUsageError("EINTR", 4, "earlier interrupted read");
    };

    let thrown: unknown;
    try {
      readProcessMemoryUsage(readMemoryUsage);
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

    expect((): NodeJS.MemoryUsage => readProcessMemoryUsage(readMemoryUsage)).toThrow(error);
    expect(attempts).toBe(1);
  });

  test("不带 syscall 字段的 EINTR 照样重试", () => {
    // 判据一旦要求 syscall === "memoryUsage"，真中断在 Node（uvException 用
    // uv_resident_set_memory 之类的底层名）与 Bun（未必设这个字段）上都匹配不
    // 上，重试形同虚设，而唯一能通过的就是测试自己捏出来的形状。
    let attempts: number = 0;
    const readMemoryUsage: () => NodeJS.MemoryUsage = (): NodeJS.MemoryUsage => {
      attempts += 1;
      if (attempts === 1) throw createMemoryUsageError("EINTR", -4);
      return MEMORY_USAGE;
    };

    expect(readProcessMemoryUsage(readMemoryUsage)).toEqual(MEMORY_USAGE);
    expect(attempts).toBe(2);
  });

  test("同一套重试护住任意一次内存读取，不只是 process.memoryUsage", () => {
    // snapshotLiveMemory 里还有 jscMemoryUsage 与 process.resourceUsage 两次读取，
    // 它们被同一个信号打断的后果完全一样：整轮 profile 白跑。
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
