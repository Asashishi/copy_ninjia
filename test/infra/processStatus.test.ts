import { describe, expect, test } from "bun:test";
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
      rssBytes: 512 * 1_024 * 1_024,
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
      rssBytes: -1,
      constrainedMemoryBytes: 0,
      totalMemoryBytes: 4_096,
    });

    expect(status).toEqual({
      uptimeSeconds: 0,
      averageCpuPercent: 0,
      availableCpuCount: 1,
      rssBytes: 0,
      memoryLimitBytes: 4_096,
      memoryPercent: 0,
    });
  });

  test("当前 Bun 的同步采样返回有限且非负的进程指标", () => {
    const status: BotProcessStatus = readBotProcessStatus();
    for (const value of Object.values(status)) {
      expect(Number.isFinite(value)).toBeTrue();
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(status.availableCpuCount).toBeGreaterThanOrEqual(1);
    expect(status.memoryLimitBytes).toBeGreaterThan(0);
  });
});
