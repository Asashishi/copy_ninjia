import type { DiskIOMessage } from "../../types/diskIO/messages";
import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";

/**
 * Worker.postMessage 可能在本地 owner 仍判定 Worker 可写之后同步抛出；把这个
 * 竞态统一挡在这里，不让它扩散到每一个业务、诊断与请求类调用方。
 * @returns 投递是否被 Worker 接受。
 */
export function safePostDiskIO(worker: Worker, message: DiskIOMessage, context: string): boolean {
  try {
    worker.postMessage(message);
    return true;
  } catch (error: unknown) {
    writeDiskIODiagnostic(`[diskIO] persistence Worker rejected ${context}:`, error);
    return false;
  }
}
