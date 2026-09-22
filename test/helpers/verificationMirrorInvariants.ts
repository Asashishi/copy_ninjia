/**
 * 主线程验证镜像（cache/main/antiRaid/verificationMirror.ts）五张表之间的不变量断言
 * （非测试文件，bun test 不会执行它）。任一条不成立即抛错，报出违例的 key。
 *
 * - 活动快照、延后索引与待确认墓碑两两互斥：一个 key 同一时刻只处在一种形态。
 * - 等待落盘的延后请求始终仍在活动快照里（DiskIO 重建要靠它重放完整快照）。
 * - 精确落盘水位线只属于仍在活动快照里的 key；同代际时水位不超过活动快照的 revision。
 * - 终态执行预算只属于活动快照或延后索引里的 key。
 */

import {
  activeVerificationSnapshots,
  deferredVerificationRecords,
  pendingVerificationDeferrals,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
  terminalVerificationAttempts,
} from "../../packages/cache/main/antiRaid/verificationMirror";
import type { VerificationSnapshot } from "../../packages/types/antiRaid/verification";

export function assertVerificationMirrorInvariants(): void {
  const violations: string[] = [];
  for (const key of activeVerificationSnapshots.keys()) {
    if (deferredVerificationRecords.has(key)) violations.push(`${key}: active and deferred`);
    if (pendingVerificationDeletes.has(key)) violations.push(`${key}: active and pending delete`);
  }
  for (const key of deferredVerificationRecords.keys()) {
    if (pendingVerificationDeletes.has(key)) violations.push(`${key}: deferred and pending delete`);
  }
  for (const key of pendingVerificationDeferrals.keys()) {
    if (!activeVerificationSnapshots.has(key)) violations.push(`${key}: pending deferral without active snapshot`);
  }
  for (const [key, persisted] of persistedVerificationRevisions) {
    const active: VerificationSnapshot | undefined = activeVerificationSnapshots.get(key);
    if (active === undefined) {
      violations.push(`${key}: persisted revision without active snapshot`);
    } else if (persisted.generation === active.generation && persisted.revision > active.revision) {
      violations.push(`${key}: persisted revision ${persisted.revision} ahead of active ${active.revision}`);
    }
  }
  for (const key of terminalVerificationAttempts.keys()) {
    if (!activeVerificationSnapshots.has(key) && !deferredVerificationRecords.has(key)) {
      violations.push(`${key}: terminal attempts without active or deferred record`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`Verification mirror invariants violated: ${violations.join("; ")}`);
  }
}
