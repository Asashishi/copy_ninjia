import { businessWorkerFatalHandler } from "../cache/workerSupervisor";
import type { BusinessWorkerFatalHandler } from "../types/workerSupervisor";

/** 注册或清除当前应用生命周期的业务 Worker fatal 接收者。 */
export function setBusinessWorkerFatalHandler(handler: BusinessWorkerFatalHandler | undefined): void {
  businessWorkerFatalHandler.current = handler ?? null;
}

/** 将业务 Worker 的永久不可用状态同步交给当前应用生命周期。 */
export function signalBusinessWorkerFatal(error: Error): void {
  businessWorkerFatalHandler.current?.(error);
}
