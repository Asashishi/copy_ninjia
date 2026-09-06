/** Disk I/O Worker 东京午夜维护编排：逐领域执行并隔离失败。 */

import { maintainAdSampleFiles } from "./adSampleFile";
import { maintainJoinLogRetention } from "./joinLogFiles";
import { maintainLogRetention } from "./logFiles";
import { maintainLuckForDay } from "./luckFiles";
import { maintainTemporaryWhitelistActivities } from "./storageDatabase";
import {
  maintainVerificationDayForToday,
} from "./verificationWrites";
import { getTokyoDateKey } from "../../libs/time";
import type {
  IdentityStoragePersistedReply,
  MidnightMaintenanceReply,
  VerificationPersistedReply,
} from
  "../../types/diskIO/replies";

/** 午夜维护共用的 Worker 回执出口。 */
export type DiskIOMaintenanceReplySink = (
  reply: IdentityStoragePersistedReply | VerificationPersistedReply | MidnightMaintenanceReply
) => void;

/** 逐领域串行维护；单个领域失败只写 Worker 兜底日志，后续领域继续。 */
async function runTasksSequentially(
  tasks: readonly (readonly [string, () => void | Promise<void>])[]
): Promise<void> {
  for (const [domain, maintain] of tasks) {
    try {
      await maintain();
    } catch (error: unknown) {
      console.error(`[diskIOWorker] midnight maintenance failed for ${domain}:`, error);
    }
  }
}

/** 先通知主线程接纳日级任务，再依次维护六个磁盘领域；不等待主线程复核。 */
export function runDiskIOMidnightMaintenance(
  reply: DiskIOMaintenanceReplySink,
  day: string = getTokyoDateKey()
): Promise<void> {
  return runTasksSequentially([
    ["main thread", (): void => reply({ type: "midnightMaintenance", day })],
    ["luck", async (): Promise<void> => maintainLuckForDay(day)],
    ["logs", async (): Promise<void> => maintainLogRetention()],
    ["join logs", async (): Promise<void> => maintainJoinLogRetention(day)],
    ["ad samples", (): Promise<void> => maintainAdSampleFiles(day)],
    ["verifications", (): Promise<void> => maintainVerificationDayForToday(reply, day)],
    ["temporary whitelist", (): void => maintainTemporaryWhitelistActivities(reply)],
  ]);
}
