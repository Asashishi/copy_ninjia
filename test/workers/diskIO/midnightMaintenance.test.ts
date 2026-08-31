import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { VerificationPersistedReply } from
  "../../../packages/types/diskIO";
import type { IdentityStoragePersistedReply } from
  "../../../packages/types/diskIO";

const maintainLuckForDay = mock((_day: string): void => {});
const maintainLogRetention = mock((): void => {});
const maintainJoinLogRetention = mock((_day: string): void => {});
const maintainAdSampleFiles = mock((_day: string): void => {});
const maintainVerificationDayForToday = mock((
  _reply: (reply: VerificationPersistedReply) => void,
  _day: string
): void => {});
const maintainTemporaryWhitelistActivities = mock((
  _reply: (reply: IdentityStoragePersistedReply) => void
): void => {});

mock.module("../../../packages/workers/diskIO/luckFiles", () => ({
  maintainLuckForDay,
}));
mock.module("../../../packages/workers/diskIO/logFiles", () => ({
  maintainLogRetention,
}));
mock.module("../../../packages/workers/diskIO/joinLogFiles", () => ({
  maintainJoinLogRetention,
}));
mock.module("../../../packages/workers/diskIO/adSampleFile", () => ({
  maintainAdSampleFiles,
}));
mock.module("../../../packages/workers/diskIO/verificationWrites", () => ({
  maintainVerificationDayForToday,
}));
mock.module("../../../packages/workers/diskIO/storageDatabase", () => ({
  maintainTemporaryWhitelistActivities,
}));

const { runDiskIOMidnightMaintenance } = await import(
  "../../../packages/workers/diskIO/midnightMaintenance"
);

const DAY: string = "2026-08-31";
function reply(
  _value: VerificationPersistedReply | IdentityStoragePersistedReply
): void {}

beforeEach((): void => {
  for (const fn of [
    maintainLuckForDay,
    maintainLogRetention,
    maintainJoinLogRetention,
    maintainAdSampleFiles,
    maintainVerificationDayForToday,
    maintainTemporaryWhitelistActivities,
  ]) fn.mockClear();
  maintainLuckForDay.mockImplementation((_day: string): void => {});
});

describe("Disk I/O Worker 午夜维护编排", (): void => {
  test("同一次触发覆盖六个已登记领域", async (): Promise<void> => {
    await runDiskIOMidnightMaintenance(reply, DAY);

    expect(maintainLuckForDay).toHaveBeenCalledWith(DAY);
    expect(maintainLogRetention).toHaveBeenCalledTimes(1);
    expect(maintainJoinLogRetention).toHaveBeenCalledWith(DAY);
    expect(maintainAdSampleFiles).toHaveBeenCalledWith(DAY);
    expect(maintainVerificationDayForToday).toHaveBeenCalledWith(reply, DAY);
    expect(maintainTemporaryWhitelistActivities).toHaveBeenCalledWith(reply);
  });

  test("单领域失败不会阻断后续维护", async (): Promise<void> => {
    const errorLog = spyOn(console, "error").mockImplementation((): void => {});
    maintainLuckForDay.mockImplementationOnce((): void => {
      throw new Error("injected luck maintenance failure");
    });

    await runDiskIOMidnightMaintenance(reply, DAY);

    expect(maintainLogRetention).toHaveBeenCalledTimes(1);
    expect(maintainVerificationDayForToday).toHaveBeenCalledTimes(1);
    expect(maintainTemporaryWhitelistActivities).toHaveBeenCalledWith(reply);
    expect(errorLog).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });
});
