import * as diskIO from "../diskIO";
import type { DiskBusinessMessage, DiskIORecoveryTransport } from "../../types/diskIO/messages";
import type { DomainFlushOutcome } from "../../types/diskIO/replies";

/**
 * 主线程领域 owner 投递一条业务写：平时走 infra/diskIO.ts 的 postDiskIO；Worker
 * 重建期间的恢复镜像必须改走本代恢复 transport，不得回退到 postDiskIO（见
 * types/diskIO/messages.ts 的 DiskIORecoveryTransport）。
 * @returns 投递是否被接受。
 */
export function postWithTransport(
  message: DiskBusinessMessage,
  transport?: DiskIORecoveryTransport
): boolean {
  return transport === undefined
    ? diskIO.postDiskIO(message) === true
    : transport.post(message);
}

/**
 * 领域 flush 未成功时附在报错里的领域说明：有回执时逐个点名失败领域，超时或
 * Worker 崩溃没有回执时如实说明。
 */
export function describeFlushFailure(outcome: DomainFlushOutcome): string {
  return outcome.failedDomains === undefined
    ? "no per-domain reply"
    : `failed domains: ${outcome.failedDomains.join(", ")}`;
}
