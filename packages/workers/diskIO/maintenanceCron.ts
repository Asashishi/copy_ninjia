/** Disk I/O Worker 每日维护 cron 的注册、替换与停止边界。 */

import { diskIOMaintenanceCron } from
  "../../cache/workers/diskIO/maintenance";
import {
  DISK_IO_MAINTENANCE_CRON,
  DISK_IO_MAINTENANCE_TIME_ZONE,
} from "../../consts/diskIO/maintenance";
import { runDiskIOMidnightMaintenance } from "./midnightMaintenance";
import { enqueueDiskIOOperation } from "./operationQueue";
import type { DiskIOMaintenanceReplySink } from "./midnightMaintenance";

/** 停止并清空当前维护 cron；未注册时幂等。 */
export function stopDiskIOMaintenanceCron(): void {
  if (diskIOMaintenanceCron.current === null) return;
  diskIOMaintenanceCron.current.stop();
  diskIOMaintenanceCron.current = null;
}

/** 启动恢复成功后注册唯一、不会阻止 Worker 退出的东京午夜维护 cron。 */
export function registerDiskIOMaintenanceCron(
  reply: DiskIOMaintenanceReplySink
): void {
  stopDiskIOMaintenanceCron();
  diskIOMaintenanceCron.current = Bun.cron(
    DISK_IO_MAINTENANCE_CRON,
    (): void => {
      void enqueueDiskIOOperation(
        async (): Promise<void> => runDiskIOMidnightMaintenance(reply)
      );
    },
    { tz: DISK_IO_MAINTENANCE_TIME_ZONE }
  ).unref();
}
