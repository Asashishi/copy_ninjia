/**
 * Disk I/O Worker 的逐领域维护编排：启动（diskIO/startup.ts）与配置时区的午夜维护共用
 * runDiskIOMaintenanceTasks，逐领域执行并隔离失败。
 */

import { maintainAdSampleFiles } from "./adSampleFile";
import { summarizeAiCache } from "./aiCacheFile";
import { maintainJoinLogRetention } from "./joinLogFiles";
import { maintainLogRetention } from "./logFiles";
import { maintainLuckForDay } from "./luckFiles";
import { maintainTemporaryAdBypassActivities } from "./storageDatabase";
import {
  maintainVerificationDayForToday,
} from "./verificationWrites";
import { getDateKey } from "../../libs/time";
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

/** 一个领域的维护步骤：日志里的领域名与维护函数。 */
type DiskIOMaintenanceTask = readonly [string, () => void | Promise<void>];

/**
 * 逐领域串行维护，启动与午夜维护共用；单个领域失败只写 Worker 兜底日志，后续领域继续。
 * @param phase 日志里的维护阶段名（`startup` 或 `midnight`）。
 */
export async function runDiskIOMaintenanceTasks(
  phase: "startup" | "midnight",
  tasks: readonly DiskIOMaintenanceTask[]
): Promise<void> {
  for (const [domain, maintain] of tasks) {
    try {
      await maintain();
    } catch (error: unknown) {
      console.error(`[diskIOWorker] ${phase} maintenance failed for ${domain}:`, error);
    }
  }
}

/** 先通知主线程接纳日级任务，再依次维护七个磁盘领域；不等待主线程复核。 */
export function runDiskIOMidnightMaintenance(
  reply: DiskIOMaintenanceReplySink,
  day: string = getDateKey()
): Promise<void> {
  return runDiskIOMaintenanceTasks("midnight", [
    ["main thread", (): void => reply({ type: "midnightMaintenance", day })],
    ["luck", async (): Promise<void> => maintainLuckForDay(day)],
    ["logs", async (): Promise<void> => maintainLogRetention()],
    ["ai cache", (): Promise<void> => summarizeAiCache(day)],
    ["join logs", async (): Promise<void> => maintainJoinLogRetention(day)],
    ["ad samples", (): Promise<void> => maintainAdSampleFiles(day)],
    ["verifications", (): Promise<void> => maintainVerificationDayForToday(reply, day)],
    ["temporary ad bypass", (): void => maintainTemporaryAdBypassActivities(reply)],
  ]);
}
