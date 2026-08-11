import { requestMainThread } from "../../libs/workerDuplex";
import type {
  AntiRaidWorkerRequest,
  VerificationAttemptPermitResult,
} from "../../types/antiRaid";

/** Worker 通过既有双工桥向主线程申请一轮进程级验证终态执行许可。 */
export function requestVerificationAttemptPermit(
  key: string,
  generation: number,
  revision: number
): Promise<VerificationAttemptPermitResult> {
  return requestMainThread<AntiRaidWorkerRequest, VerificationAttemptPermitResult>({
    operation: "verificationAttemptPermit",
    key,
    generation,
    revision,
  });
}
