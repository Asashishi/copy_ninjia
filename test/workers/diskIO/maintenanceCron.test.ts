import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import {
  DISK_IO_MAINTENANCE_CRON,
  DISK_IO_MAINTENANCE_TIME_ZONE,
} from "../../../packages/consts/diskIO/maintenance";
import type { VerificationPersistedReply } from
  "../../../packages/types/diskIO";

const runDiskIOMidnightMaintenance = mock((
  _reply: (reply: VerificationPersistedReply) => void
): void => {});

mock.module("../../../packages/workers/diskIO/midnightMaintenance", () => ({
  runDiskIOMidnightMaintenance,
}));

const {
  registerDiskIOMaintenanceCron,
  stopDiskIOMaintenanceCron,
} = await import("../../../packages/workers/diskIO/maintenanceCron");
const { diskIOMaintenanceCron } = await import(
  "../../../packages/cache/workers/diskIO/maintenance"
);

const BEFORE_MIDNIGHT_MS: number =
  Date.parse("2026-08-30T23:59:59+09:00");

function reply(_value: VerificationPersistedReply): void {}

beforeEach((): void => {
  stopDiskIOMaintenanceCron();
  runDiskIOMidnightMaintenance.mockClear();
  jest.useFakeTimers({ now: BEFORE_MIDNIGHT_MS });
});

afterEach((): void => {
  stopDiskIOMaintenanceCron();
  jest.useRealTimers();
});

describe("Disk I/O Worker 统一维护 cron", (): void => {
  test("按东京零点触发同一个 Bun 原生进程内任务", (): void => {
    registerDiskIOMaintenanceCron(reply);
    const cron: Bun.CronJob | null = diskIOMaintenanceCron.current;

    expect(cron?.cron).toBe(DISK_IO_MAINTENANCE_CRON);
    expect(Bun.cron.parse(
      DISK_IO_MAINTENANCE_CRON,
      BEFORE_MIDNIGHT_MS,
      { tz: DISK_IO_MAINTENANCE_TIME_ZONE }
    )?.getTime()).toBe(BEFORE_MIDNIGHT_MS + 1_000);

    jest.advanceTimersByTime(1_050);

    expect(diskIOMaintenanceCron.current).toBe(cron);
    expect(runDiskIOMidnightMaintenance).toHaveBeenCalledTimes(1);
    expect(runDiskIOMidnightMaintenance).toHaveBeenCalledWith(reply);
  });

  test("重复注册替换旧任务，停止后不再触发", (): void => {
    registerDiskIOMaintenanceCron(reply);
    const first: Bun.CronJob | null = diskIOMaintenanceCron.current;
    registerDiskIOMaintenanceCron(reply);
    const second: Bun.CronJob | null = diskIOMaintenanceCron.current;

    expect(second).not.toBe(first);
    jest.advanceTimersByTime(1_050);
    expect(runDiskIOMidnightMaintenance).toHaveBeenCalledTimes(1);

    stopDiskIOMaintenanceCron();
    expect(diskIOMaintenanceCron.current).toBeNull();
    jest.advanceTimersByTime(24 * 60 * 60 * 1_000);
    expect(runDiskIOMidnightMaintenance).toHaveBeenCalledTimes(1);
  });
});
