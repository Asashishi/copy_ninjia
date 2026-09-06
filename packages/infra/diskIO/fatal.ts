import { diskIORuntime } from "../../cache/main/diskIO";
import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";

/** 每代宿主只通知一次致命存储故障；已接收事实保留到生命周期最终 flush。 */
export function signalDiskIOFatal(error: Error): void {
  if (diskIORuntime.fatalSignaled) return;
  diskIORuntime.fatalSignaled = true;
  if (diskIORuntime.fatalHandler !== undefined) diskIORuntime.fatalHandler(error);
  else writeDiskIODiagnostic("[diskIO] fatal persistence failure requires process restart:", error.message);
}
