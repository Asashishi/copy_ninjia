import { JOIN_WINDOW_MS } from "../../consts/antiRaid/lockdown";
import { trimSlidingWindowArray } from "../../libs/slidingWindowRateLimit";
import type { VerificationSnapshot } from "../../types/antiRaid/verification";
import type { VerificationState } from "../../types/states/verification";
import { checkingInviterOf, expellingOf, snapshotOf } from "./shared";

/**
 * 把一份落盘验证快照重建成内存状态。纯转换：不碰 Map、不建计时器、不读墙钟
 * （`now` 由调用方传入），计时器与补投由 workers/antiRaid/verificationRuntime.ts
 * 的 adoptVerifications 在拿到结果后安排。
 *
 * 四个 phase 与新建路径共用同一组构造器（见 ./shared.ts 与 ./join.ts），两条路
 * 因此产出同一个 hidden class；`executionStarted`、`effectStarted`、
 * `cleanupSettled` 是 Worker 本地幂等门，不随快照持久化，重建时一律从初始值起。
 *
 * pending 的发言窗口必须经 trimSlidingWindowArray 而不是手写 filter：后者会漏掉
 * 时钟回拨后落在「未来」的时间戳，恢复出来的记录带着一整窗永不过期的项，接着
 * 几条发言就能把人判成 flood（与 states/verification.ts 的刷屏窗口共用同一份
 * 边界判定）。
 * @param record 落盘快照；phase 决定必填字段（见 types/antiRaid/verification.ts）。
 * @param now 本次重建的观测时刻，只用于裁剪发言窗口。
 */
export function adoptVerificationState(record: VerificationSnapshot, now: number): VerificationState {
  if (record.phase === "kickPending") {
    return {
      kind: "kickPending",
      label: record.label,
      isBot: record.isBot,
      requestedAt: record.requestedAt,
      countedJoinAt: record.countedJoinAt,
      announcementMessageId: record.announcementMessageId,
      effectStarted: false,
      executionStarted: false,
    };
  }
  if (record.phase === "checkingInviter") {
    return checkingInviterOf(record.terminalInviterId, snapshotOf(record));
  }
  if (record.phase === "expelling") {
    return expellingOf(record.expelReason, snapshotOf(record), record);
  }
  return {
    kind: "pending",
    label: record.label,
    isBot: record.isBot,
    announcementMessageId: record.announcementMessageId,
    trackedMessageTimes: trimSlidingWindowArray({
      timestamps: record.trackedMessageTimes,
      windowMs: JOIN_WINDOW_MS,
      now,
    }),
    invitedBy: record.invitedBy,
    reminderMessageId: record.reminderMessageId,
    replyReminderMessageId: record.replyReminderMessageId,
    replyReminderRequested: record.replyReminderRequested,
    welcomeAnchorMessageId: record.welcomeAnchorMessageId,
    reminderSuperseded: record.reminderSuperseded,
    joinedAt: record.joinedAt,
    expiresAt: record.expiresAt,
  };
}
