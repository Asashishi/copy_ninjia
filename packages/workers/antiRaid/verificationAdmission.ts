import {
  canAdmitVerificationRevision,
  verificationEntries,
  verificationGeneration,
  verificationRevisionCapacityFatalState,
  verificationRuntimeCapacityFatalState,
} from "../../cache/workers/antiRaid/verification";
import { VERIFICATION_RUNTIME_CAPACITY } from "../../consts/antiRaid/verification";
import type {
  VerificationRevisionCapacityExceededEvent,
  VerificationRuntimeCapacityExceededEvent,
} from "../../types/antiRaid/events";

declare const self: Worker;

/** revision 新 key 满额时每代际只报告一次，保留已有责任与墓碑。 */
export function reportVerificationRevisionCapacity(): void {
  if (verificationRevisionCapacityFatalState.current) return;
  verificationRevisionCapacityFatalState.current = true;
  self.postMessage({
    type: "verificationRevisionCapacityExceeded",
    generation: verificationGeneration.current,
  } satisfies VerificationRevisionCapacityExceededEvent);
}

/** 运行态满额时锁住新 key，并只报告一次；恢复释放去重槽也不重新开放。 */
export function reportVerificationRuntimeCapacity(): void {
  if (verificationRuntimeCapacityFatalState.current) return;
  verificationRuntimeCapacityFatalState.current = true;
  self.postMessage({
    type: "verificationRuntimeCapacityExceeded",
    generation: verificationGeneration.current,
  } satisfies VerificationRuntimeCapacityExceededEvent);
}

/**
 * 入群前的运行态准入；必须先于 recordJoin、状态转移与效果执行。
 * 已有实例始终继续，无 revision 的去重实例也不受 revision 满额影响。
 * 新 key 满额时不建立去重、不发送欢迎或告警，也不改判为待验证。
 * 持久恢复由 verificationRuntime.ts 独立接管；约束见 docs/cn/04-invariants.md。
 */
export function admitVerificationJoin(key: string): boolean {
  if (verificationEntries.has(key)) return true;
  if (verificationRuntimeCapacityFatalState.current) return false;
  if (verificationEntries.size >= VERIFICATION_RUNTIME_CAPACITY) {
    reportVerificationRuntimeCapacity();
    return false;
  }
  if (canAdmitVerificationRevision(key)) return true;
  reportVerificationRevisionCapacity();
  return false;
}
