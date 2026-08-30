/** Disk I/O Worker 东京午夜维护编排：逐领域执行并隔离失败。 */

import { maintainAdSampleFiles } from "./adSampleFile";
import { maintainJoinLogRetention } from "./joinLogFiles";
import { maintainLogRetention } from "./logFiles";
import { maintainLuckForDay } from "./luckFiles";
import { sweepExpiredTemporaryWhitelistActivities } from "./storageDatabase";
import {
  maintainVerificationDayForToday,
} from "./verificationWrites";
import { getTokyoDateKey } from "../../libs/time";
import type { VerificationReplySink } from "./verificationWrites";

/** 单个领域失败只写 Worker 兜底日志，后续领域继续。 */
function runDiskIOMaintenanceTasks(
  tasks: readonly (readonly [string, () => void])[]
): void {
  for (const [domain, maintain] of tasks) {
    try {
      maintain();
    } catch (error: unknown) {
      console.error(`[diskIOWorker] midnight maintenance failed for ${domain}:`, error);
    }
  }
}

/** 依次维护六个按日或保留期领域。 */
export function runDiskIOMidnightMaintenance(
  reply: VerificationReplySink,
  day: string = getTokyoDateKey()
): void {
  runDiskIOMaintenanceTasks([
    ["luck", (): void => maintainLuckForDay(day)],
    ["logs", (): void => maintainLogRetention()],
    ["join logs", (): void => maintainJoinLogRetention(day)],
    ["ad samples", (): void => maintainAdSampleFiles(day)],
    ["verifications", (): void => maintainVerificationDayForToday(reply, day)],
    ["temporary whitelist", (): void => sweepExpiredTemporaryWhitelistActivities()],
  ]);
}
