import { ANTI_RAID_PER_MINUTE_LIMIT, JOIN_WINDOW_CAPACITY } from "../../../packages/consts/antiRaid/lockdown";
import { VERIFICATION_TIMEOUT_MS } from "../../../packages/consts/antiRaid/verification";
import { verificationGeneration } from "../../../packages/cache/workers/antiRaid/verification";
import { verificationSnapshot } from "../../../packages/workers/antiRaid/verificationSnapshot";
import type { PendingState } from "../../../packages/types/states/verification";
import type { VerificationSnapshot } from "../../../packages/types/antiRaid/verification";
import { BENCHMARK_CHAT_ID, BENCHMARK_EPOCH_MS, BENCHMARK_SENDER_ID } from "./fixtures";
import type { Scenario } from "./types";

/** 待验证消息窗口从空到容量边界的快照投影；可连同 structuredClone 成本一起测量。 */
export function verificationSnapshotScenario(clone: boolean): Scenario {
  const requests: readonly Parameters<typeof verificationSnapshot>[0][] = Array.from(
    { length: JOIN_WINDOW_CAPACITY },
    (_: unknown, size: number): Parameters<typeof verificationSnapshot>[0] => {
      const state: PendingState = {
        kind: "pending", label: "待验证成员", isBot: false,
        trackedMessageTimes: Array.from({ length: size }, (_: unknown, index: number): number => BENCHMARK_EPOCH_MS + index),
        replyReminderRequested: false, reminderSuperseded: false,
        joinedAt: BENCHMARK_EPOCH_MS, expiresAt: BENCHMARK_EPOCH_MS + VERIFICATION_TIMEOUT_MS,
      };
      return { chatId: BENCHMARK_CHAT_ID, userId: BENCHMARK_SENDER_ID, state, revision: 1 };
    }
  );
  const retained: (VerificationSnapshot | undefined)[] = new Array<VerificationSnapshot | undefined>(JOIN_WINDOW_CAPACITY);
  return {
    iterations: clone ? 50_000 : 500_000,
    prepare: (): void => { verificationGeneration.current = BENCHMARK_EPOCH_MS; },
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index++) {
        const slot: number = index % requests.length;
        const request: Parameters<typeof verificationSnapshot>[0] = requests[slot]!;
        request.userId = BENCHMARK_SENDER_ID + index;
        request.revision = index + 1;
        const snapshot: VerificationSnapshot = verificationSnapshot(request);
        const result: VerificationSnapshot = clone ? structuredClone(snapshot) : snapshot;
        retained[slot] = result;
        if (result.trackedMessageTimes.length > ANTI_RAID_PER_MINUTE_LIMIT || result.phase !== "pending") throw new Error("Verification snapshot fixture changed phase or capacity.");
        checksum += result.revision + result.trackedMessageTimes.length;
      }
      return checksum;
    },
    reset: (): void => { retained.fill(undefined); verificationGeneration.current = 0; },
    probes: { verificationSnapshot },
  };
}
