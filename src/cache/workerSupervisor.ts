/**
 * 业务 Worker 监督器的进程级状态，由 src/infra/workerSupervisor.ts 管理。
 * 生命周期取得实例锁后填充 fatal handler，dispose 时清空；Worker 重建不改变
 * handler，进程重启后由新 ApplicationLifecycle 重新注册。holder 容量恒为 1。
 */

import type { BusinessWorkerFatalHandler } from "../types/workerSupervisor";

/** 当前应用生命周期的业务 Worker fatal 接收者；未启动或已 dispose 时为 null。 */
export const businessWorkerFatalHandler: { current: BusinessWorkerFatalHandler | null } = {
  current: null,
};
