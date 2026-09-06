import { describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import {
  calculateBotProcessStatus,
  readBotProcessStatus,
} from "../../packages/infra/processStatus";
import type { BotProcessStatus } from "../../packages/types/botStatus";

describe("Bot 本机进程状态", () => {
  test("CPU 按可用逻辑核归一，内存优先使用容器约束", () => {
    const status: BotProcessStatus = calculateBotProcessStatus({
      uptimeSeconds: 3_600,
      cpuUserMicroseconds: 3_000_000_000,
      cpuSystemMicroseconds: 600_000_000,
      availableCpuCount: 4,
      memoryFootprintBytes: 512 * 1_024 * 1_024,
      constrainedMemoryBytes: 8 * 1_024 * 1_024 * 1_024,
      totalMemoryBytes: 16 * 1_024 * 1_024 * 1_024,
    });

    expect(status.averageCpuPercent).toBe(25);
    expect(status.memoryLimitBytes).toBe(8 * 1_024 * 1_024 * 1_024);
    expect(status.memoryPercent).toBe(6.25);
  });

  test("没有容器约束时回退物理内存，异常采样不产生 NaN 或零核", () => {
    const status: BotProcessStatus = calculateBotProcessStatus({
      uptimeSeconds: Number.NaN,
      cpuUserMicroseconds: Number.POSITIVE_INFINITY,
      cpuSystemMicroseconds: -1,
      availableCpuCount: 0,
      memoryFootprintBytes: -1,
      constrainedMemoryBytes: 0,
      totalMemoryBytes: 4_096,
    });

    expect(status).toEqual({
      uptimeSeconds: 0,
      averageCpuPercent: 0,
      availableCpuCount: 1,
      memoryFootprintBytes: null,
      memoryLimitBytes: 4_096,
      memoryPercent: 0,
    });
  });

  test("当前 Bun 的同步采样返回有限且非负的进程指标", () => {
    const status: BotProcessStatus = readBotProcessStatus();
    for (const value of Object.values(status)) {
      if (value === null) continue;
      expect(Number.isFinite(value)).toBeTrue();
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(status.availableCpuCount).toBeGreaterThanOrEqual(1);
    expect(status.memoryLimitBytes).toBeGreaterThan(0);
  });

  test("每次读取 Bun 当前进程占用，后续采样可以下降", () => {
    const memory: Mock<typeof Bun.unsafe.memoryFootprint> = spyOn(Bun.unsafe, "memoryFootprint")
      .mockReturnValueOnce(8_192).mockReturnValueOnce(4_096);
    const rss: Mock<typeof process.memoryUsage.rss> = spyOn(process.memoryUsage, "rss").mockImplementation((): never => {
      throw new Error("RSS must not be queried for bot status.");
    });
    try {
      expect(readBotProcessStatus().memoryFootprintBytes).toBe(8_192);
      expect(readBotProcessStatus().memoryFootprintBytes).toBe(4_096);
      expect(memory).toHaveBeenCalledTimes(2);
      expect(rss).not.toHaveBeenCalled();
    } finally {
      memory.mockRestore();
      rss.mockRestore();
    }
  });

  test("原生占用不可用时返回 null，不转换成零或读取 RSS", () => {
    const memory: Mock<typeof Bun.unsafe.memoryFootprint> = spyOn(Bun.unsafe, "memoryFootprint").mockReturnValue(undefined);
    const rss: Mock<typeof process.memoryUsage.rss> = spyOn(process.memoryUsage, "rss").mockImplementation((): never => {
      throw new Error("RSS fallback must not be queried for bot status.");
    });
    try {
      const status: BotProcessStatus = readBotProcessStatus();
      expect(status.memoryFootprintBytes).toBeNull();
      expect(status.memoryPercent).toBe(0);
      expect(rss).not.toHaveBeenCalled();
    } finally {
      memory.mockRestore();
      rss.mockRestore();
    }
  });
});
