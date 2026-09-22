import { describe, expect, test } from "bun:test";
import { adoptVerificationState } from "../../packages/states/verification";
import { JOIN_WINDOW_MS } from "../../packages/consts/antiRaid/lockdown";
import type { VerificationSnapshot } from "../../packages/types/antiRaid/verification";
import type { VerificationState } from "../../packages/types/states/verification";

const NOW: number = 10_000_000;

/** 四个 phase 共用的快照底座；各用例只覆盖自己关心的字段。 */
function snapshot(overrides: Partial<VerificationSnapshot> = {}): VerificationSnapshot {
  return {
    phase: "pending",
    chatId: -1001,
    userId: 7,
    generation: 3,
    revision: 11,
    label: "杂鱼A",
    isBot: false,
    announcementMessageId: 501,
    trackedMessageTimes: [],
    invitedBy: undefined,
    reminderMessageId: 502,
    replyReminderMessageId: 503,
    replyReminderRequested: true,
    welcomeAnchorMessageId: 504,
    reminderSuperseded: true,
    joinedAt: NOW - 60_000,
    expiresAt: NOW + 120_000,
    ...overrides,
  } as VerificationSnapshot;
}

describe("adoptVerificationState：落盘快照重建成内存状态", () => {
  test("pending 逐字带回全部持久字段", () => {
    const state: VerificationState = adoptVerificationState(snapshot({ invitedBy: 42 }), NOW);

    expect(state).toEqual({
      kind: "pending",
      label: "杂鱼A",
      isBot: false,
      announcementMessageId: 501,
      trackedMessageTimes: [],
      invitedBy: 42,
      reminderMessageId: 502,
      replyReminderMessageId: 503,
      replyReminderRequested: true,
      welcomeAnchorMessageId: 504,
      reminderSuperseded: true,
      joinedAt: NOW - 60_000,
      expiresAt: NOW + 120_000,
    });
  });

  test("pending 的发言窗口按 (now - JOIN_WINDOW_MS, now] 裁剪，同时丢掉回拨后落在未来的项", () => {
    // 手写 filter 只裁过期队首：时钟往回跳之后留下的「未来」时间戳会带着
    // 一整窗永不过期的项回来，接着几条发言就能把人判成 flood。
    const state: VerificationState = adoptVerificationState(
      snapshot({
        trackedMessageTimes: [
          NOW - JOIN_WINDOW_MS - 1,
          NOW - JOIN_WINDOW_MS,
          NOW - JOIN_WINDOW_MS + 1,
          NOW,
          NOW + 1,
        ],
      }),
      NOW
    );

    expect(state.kind).toBe("pending");
    expect(state.kind === "pending" ? state.trackedMessageTimes : undefined)
      .toEqual([NOW - JOIN_WINDOW_MS + 1, NOW]);
  });

  test("kickPending 带回请求时刻与计数标记，两个本地幂等门从 false 起", () => {
    const state: VerificationState = adoptVerificationState(
      snapshot({ phase: "kickPending", requestedAt: NOW - 500, countedJoinAt: NOW - 600 }),
      NOW
    );

    expect(state).toEqual({
      kind: "kickPending",
      label: "杂鱼A",
      isBot: false,
      requestedAt: NOW - 500,
      countedJoinAt: NOW - 600,
      announcementMessageId: 501,
      effectStarted: false,
      executionStarted: false,
    });
  });

  test("未计入刷群窗口的重进补踢：countedJoinAt 缺省原样保持 undefined", () => {
    const state: VerificationState = adoptVerificationState(
      snapshot({ phase: "kickPending", requestedAt: NOW - 500 }),
      NOW
    );

    expect(state.kind === "kickPending" ? state.countedJoinAt : "missing").toBeUndefined();
  });

  test("checkingInviter 带回最终核查对象与处置快照，executionStarted 不随快照恢复、从 false 起", () => {
    const state: VerificationState = adoptVerificationState(
      snapshot({ phase: "checkingInviter", terminalInviterId: 99 }),
      NOW
    );

    expect(state).toEqual({
      kind: "checkingInviter",
      inviterId: 99,
      snapshot: {
        label: "杂鱼A",
        isBot: false,
        announcementMessageId: 501,
        reminderMessageId: 502,
        replyReminderMessageId: 503,
        joinedAt: NOW - 60_000,
        expiresAt: NOW + 120_000,
      },
      executionStarted: false,
    });
  });

  test("expelling 带回处置原因与四项播报记账，两个本地幂等门从初始值起", () => {
    const state: VerificationState = adoptVerificationState(
      snapshot({
        phase: "expelling",
        expelReason: "flood",
        successNoticeSent: true,
        failureNoticeSent: false,
        unconfirmedNoticeSent: true,
        removalConfirmed: true,
      }),
      NOW
    );

    expect(state).toEqual({
      kind: "expelling",
      reason: "flood",
      snapshot: {
        label: "杂鱼A",
        isBot: false,
        announcementMessageId: 501,
        reminderMessageId: 502,
        replyReminderMessageId: 503,
        joinedAt: NOW - 60_000,
        expiresAt: NOW + 120_000,
      },
      executionStarted: false,
      failureNoticeSent: false,
      unconfirmedNoticeSent: true,
      successNoticeSent: true,
      removalConfirmed: true,
      cleanupSettled: undefined,
    });
  });

  test("没有播报记账的 expelling 快照重建出四项 undefined，而不是 false", () => {
    // 「还没播报过」与「播报过但结果是 false」是两回事：后者会让收尾路径
    // 以为告警已经发过，管理员再也收不到那一条。
    const state: VerificationState = adoptVerificationState(
      snapshot({ phase: "expelling", expelReason: "timeout" }),
      NOW
    );

    expect(state.kind === "expelling" ? state.failureNoticeSent : "missing").toBeUndefined();
    expect(state.kind === "expelling" ? state.successNoticeSent : "missing").toBeUndefined();
    expect(state.kind === "expelling" ? state.unconfirmedNoticeSent : "missing").toBeUndefined();
    expect(state.kind === "expelling" ? state.removalConfirmed : "missing").toBeUndefined();
  });

  test("同一 phase 的两次重建产出同一份键顺序：解释器整轮终态结算反复读它", () => {
    const first: VerificationState = adoptVerificationState(snapshot(), NOW);
    const second: VerificationState = adoptVerificationState(
      snapshot({ label: "杂鱼B", announcementMessageId: undefined }),
      NOW + 1
    );

    expect(Object.keys(first)).toEqual(Object.keys(second));
  });
});
