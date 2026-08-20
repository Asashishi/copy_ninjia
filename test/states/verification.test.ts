import { describe, expect, test } from "bun:test";
import { joinCreatesNewRecord, transitionVerification } from "../../packages/states/verification";
import type { JoinEvent, PendingState, VerificationState } from "../../packages/types/states/verification";
import {
  ANTI_RAID_PER_MINUTE_LIMIT,
  JOIN_WINDOW_MS,
} from "../../packages/consts/antiRaid/lockdown";
import {
  VERIFICATION_REMINDER_UNDELIVERED_MAX_MS,
  VERIFICATION_TIMEOUT_MS,
} from "../../packages/consts/antiRaid/verification";

/** 造一个 join 事件，默认是「自主入群、无豁免、无锁定」，用覆盖项表达各场景。 */
function joinEvent(overrides: Partial<JoinEvent> = {}): JoinEvent {
  return {
    type: "join",
    memberId: 100,
    label: "杂鱼A",
    isBot: false,
    identityExempt: false,
    actorSyncExempt: false,
    adminCacheFresh: false,
    lockdownActive: false,
    now: 0,
    ...overrides,
  };
}

function kickedState(overrides: Partial<VerificationState & { kind: "kicked" }> = {}): VerificationState {
  return { kind: "kicked", label: "杂鱼A", isBot: false, kickedAt: 0, ...overrides };
}

function kickPendingState(
  overrides: Partial<VerificationState & { kind: "kickPending" }> = {}
): VerificationState & { kind: "kickPending" } {
  return {
    kind: "kickPending",
    label: "杂鱼A",
    isBot: false,
    requestedAt: 0,
    effectStarted: false,
    executionStarted: false,
    ...overrides,
  };
}

function pendingState(overrides: Partial<PendingState> = {}): PendingState {
  return {
    kind: "pending",
    label: "杂鱼A",
    isBot: false,
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: 0,
    expiresAt: 120_000,
    ...overrides,
    trackedMessageTimes: overrides.trackedMessageTimes ?? [],
  };
}

function effectKinds(effects: { kind: string }[]): string[] {
  return effects.map((effect) => effect.kind);
}

describe("join：ABSENT 起步", () => {
  test("普通入群验证窗口固定为三分钟", () => {
    expect(VERIFICATION_TIMEOUT_MS).toBe(3 * 60_000);
    const { next } = transitionVerification(undefined, joinEvent({ now: 7_000 }));
    expect((next as PendingState).expiresAt).toBe(7_000 + 3 * 60_000);
  });

  test("普通自主入群 → PENDING + 发原始提醒，不挂管理员核查", () => {
    const event = joinEvent({ announcementMessageId: 7 });
    expect(joinCreatesNewRecord(undefined, event)).toBe(true);
    const { next, effects } = transitionVerification(undefined, event);
    expect(next?.kind).toBe("pending");
    // 公告显式持有；成员发言不会进入任何待删除 id 列表。
    expect((next as PendingState).announcementMessageId).toBe(7);
    expect((next as PendingState).invitedBy).toBeUndefined();
    expect((next as PendingState).expiresAt).toBe(VERIFICATION_TIMEOUT_MS);
    expect(effectKinds(effects)).toEqual(["sendReminder"]);
  });

  test("被他人拉入群（缓存冷）→ PENDING 记录拉人者 + 挂异步核查 + 发提醒", () => {
    const event = joinEvent({ actorId: 999 });
    const { next, effects } = transitionVerification(undefined, event);
    expect((next as PendingState).invitedBy).toBe(999);
    expect(effectKinds(effects)).toEqual(["startAdminCheck", "sendReminder"]);
  });

  test("管理员身份入群 → EXEMPT，不计入刷群统计", () => {
    const event = joinEvent({ identityExempt: true });
    expect(joinCreatesNewRecord(undefined, event)).toBe(false);
    const { next, effects } = transitionVerification(undefined, event);
    expect(next?.kind).toBe("exempt");
    expect(effects).toEqual([]);
  });

  test("白名单/管理员缓存命中的拉人 → EXEMPT", () => {
    const { next } = transitionVerification(undefined, joinEvent({ actorId: 999, actorSyncExempt: true }));
    expect(next?.kind).toBe("exempt");
  });

  test("评论区活动先到 → EXEMPT、不计数并在对应消息下欢迎", () => {
    const event = joinEvent({ recentComment: { messageId: 55 } });
    expect(joinCreatesNewRecord(undefined, event)).toBe(false);
    const { next, effects } = transitionVerification(undefined, event);
    expect(next?.kind).toBe("exempt");
    expect(effects).toEqual([{ kind: "sendWelcome", variant: "channelComment", targetLabel: "杂鱼A", anchorMessageId: 55 }]);
  });

  test("私密模式普通入群先进入可持久化 KICK_PENDING，不在落盘前执行踢人", () => {
    const event = joinEvent({ lockdownActive: true, announcementMessageId: 7 });
    expect(joinCreatesNewRecord(undefined, event)).toBe(true); // 秒踢的入群也计入刷群统计
    const { next, effects } = transitionVerification(undefined, event);
    expect(next).toMatchObject({
      kind: "kickPending",
      announcementMessageId: 7,
    });
    expect(effects).toEqual([]);
  });

  test("私密模式期间评论或楼中楼回复触发的入群仍豁免且不计数", () => {
    const event = joinEvent({ lockdownActive: true, recentComment: { messageId: 55 } });
    expect(joinCreatesNewRecord(undefined, event)).toBe(false);
    const { next, effects } = transitionVerification(undefined, event);
    expect(next?.kind).toBe("exempt");
    expect(effectKinds(effects)).toEqual(["sendWelcome"]);
    expect(effectKinds(effects)).not.toContain("kickMember");
  });

  test("私密模式期间管理员拉人（同步缓存命中）→ 照常 EXEMPT，不踢", () => {
    const { next, effects } = transitionVerification(undefined, joinEvent({ lockdownActive: true, actorId: 999, actorSyncExempt: true }));
    expect(next?.kind).toBe("exempt");
    expect(effectKinds(effects)).not.toContain("kickMember");
  });
});

describe("join：重复投递（chat_member 与服务消息各到一次）", () => {
  test("PENDING 上的迟到公告 → 记进独立字段，不重发提醒", () => {
    const state = pendingState();
    const result = transitionVerification(state, joinEvent({ announcementMessageId: 9 }));
    const { next, effects } = result;
    expect(next).toBe(state);
    expect(state.announcementMessageId).toBe(9);
    expect(effects).toEqual([]);
    expect(result.snapshotChanged).toBeTrue();
  });

  test("PENDING 上出现第二条入群公告 → 立即删掉多余服务消息", () => {
    const state = pendingState({ announcementMessageId: 8 });
    const { effects } = transitionVerification(state, joinEvent({ announcementMessageId: 9 }));
    expect(state.announcementMessageId).toBe(8);
    expect(effects).toEqual([{ kind: "deleteMessage", messageId: 9 }]);
  });

  test("PENDING + 本路带拉人者且缓存冷 → 补挂核查并记录 invitedBy", () => {
    const state = pendingState();
    const result = transitionVerification(state, joinEvent({ actorId: 999, adminCacheFresh: false }));
    expect(state.invitedBy).toBe(999);
    expect(effectKinds(result.effects)).toEqual(["startAdminCheck"]);
    expect(result.snapshotChanged).toBeTrue();
  });

  test("PENDING + 缓存热（同步快路径已判过非管理员）→ 不再挂核查", () => {
    const { effects } = transitionVerification(pendingState(), joinEvent({ actorId: 999, adminCacheFresh: true }));
    expect(effects).toEqual([]);
  });

  test("KICK_PENDING 上的迟到公告（去重宽限期内）→ 顺手删除，不重复踢", () => {
    const state = kickPendingState({ requestedAt: 0 });
    const { next, effects } = transitionVerification(state, joinEvent({ announcementMessageId: 9, now: 1000 }));
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "deleteMessage", messageId: 9 }]);
  });

  test("KICKED 占位遇到真的重新入群 → 换成待落盘状态，不提前补踢", () => {
    const state = kickedState({ kickedAt: 0 });
    const { next, effects } = transitionVerification(state, joinEvent({ now: 10_000 }));
    expect(next).not.toBe(state);
    expect(next).toMatchObject({
      kind: "kickPending",
      label: "杂鱼A",
      isBot: false,
      requestedAt: 10_000,
    });
    expect(effects).toEqual([]);
  });

  test("豁免入群撞上已开的验证窗口 → 撤销并删提醒，且按精确时刻撤销此前记的那次刷群计数", () => {
    const state = pendingState({ reminderMessageId: 30, replyReminderMessageId: 31, joinedAt: 12_345 });
    const { next, effects } = transitionVerification(state, joinEvent({ identityExempt: true }));
    expect(next?.kind).toBe("exempt");
    expect(effects).toEqual([
      { kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: 31 },
      { kind: "retractJoinCount", joinedAt: 12_345 },
    ]);
  });

  test("豁免入群在踢人请求发出前到达 → 失效旧动作并撤销刷群计数", () => {
    const state = kickPendingState({ requestedAt: 12_345, countedJoinAt: 12_345 });
    const { next, effects } = transitionVerification(state, joinEvent({ identityExempt: true }));
    expect(next).toEqual({ kind: "exempt", label: "杂鱼A", isBot: false });
    expect(effects).toEqual([{ kind: "retractJoinCount", joinedAt: 12_345 }]);
  });

  test("重进补踢建出的占位没计过数 → 晚到的豁免一格都不撤", () => {
    // 这一路 joinCreatesNewRecord 为 false（状态已存在），调用方没有 recordJoin。
    // 凭 requestedAt 去撤，删掉的会是同一 tick 里另一名合法计数成员那一格——
    // 刷群窗口因此差一个而不触发私密模式，正是这个计数要挡的事。
    const state = kickPendingState({ requestedAt: 12_345 });
    const { next, effects } = transitionVerification(state, joinEvent({ identityExempt: true }));
    expect(next).toEqual({ kind: "exempt", label: "杂鱼A", isBot: false });
    expect(effects).toEqual([]);
  });

  test("豁免入群在踢人请求已发出后到达 → 保持占位并记录不可撤销诊断", () => {
    const state = kickPendingState({ executionStarted: true });
    const { next, effects } = transitionVerification(state, joinEvent({ identityExempt: true }));
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "logUncancelableKickExemption", label: "杂鱼A" }]);
  });

  test("豁免入群撞上已有 KICKED 占位 → 保持占位不动，只留一条日志方便人工纠正", () => {
    const state = kickedState();
    const { next, effects } = transitionVerification(state, joinEvent({ identityExempt: true }));
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "logUncancelableKickExemption", label: "杂鱼A" }]);
  });

  test("豁免入群撞上已有 EXEMPT 占位 → 保持占位不动，无需额外日志（本就已经豁免，没有被误踢）", () => {
    const state: VerificationState = { kind: "exempt", label: "杂鱼A", isBot: false };
    const { next, effects } = transitionVerification(state, joinEvent({ identityExempt: true }));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

describe("trackedMessage", () => {
  test("时钟回拨后落在未来的时间戳照样驱逐，没刷屏的人不会被判成 flood", () => {
    // 手写的 filter(ts > now - 60_000) 只砍「太旧」的一侧：NTP 往回跳一次之后，
    // 此前记下的时间戳全部落在「未来」，永远满足这个条件、再也不会被驱逐。攒了
    // 40 条的人再慢慢发几条就能越过 45 条/分钟的阈值——消息全删、人被踢出，而
    // 他根本没刷过屏。同一个阈值的另一半（lockdownRuntime 的入群窗口）本来就
    // 走共享的窗口判定，两边不能对回拨给出两种语义。
    const now: number = 1_000_000;
    const state = pendingState({
      // 全部「来自未来」：时钟往回跳超过一个窗口之后就是这个形态。
      trackedMessageTimes: Array.from(
        { length: ANTI_RAID_PER_MINUTE_LIMIT },
        (_unused: unknown, index: number): number => now + JOIN_WINDOW_MS + index
      ),
    });

    const { next } = transitionVerification(state, { type: "trackedMessage", messageId: 41, inCommentThread: false, now });

    expect(next?.kind).toBe("pending");
    // 只剩本次这一条：越界的全被驱逐，没有凭空多出来的配额消耗。
    expect((next as PendingState).trackedMessageTimes).toEqual([now]);
  });

  test("待验证成员的普通发言 → 只计数并改提醒锚点，不登记删除 id", () => {
    const state = pendingState({ reminderMessageId: 30 });
    const result = transitionVerification(state, { type: "trackedMessage", messageId: 40, inCommentThread: false, now: 1_000 });
    const { effects } = result;
    expect("messageIds" in state).toBeFalse();
    expect(state.trackedMessageTimes).toEqual([1_000]);
    expect(state.reminderMessageId).toBeUndefined();
    expect(state.reminderSuperseded).toBe(true);
    expect(state.welcomeAnchorMessageId).toBe(40);
    // 补发提醒排在删旧提醒之前：解释器会 await deleteMessage；若顺序反过来，
    // 删除等待期间状态可能被其它投递替换，导致过期提醒回填到新记录。
    expect(effects).toEqual([
      { kind: "sendReplyReminder", label: "杂鱼A", targetMessageId: 40 },
      { kind: "deleteMessage", messageId: 30 },
    ]);
    expect(result.snapshotChanged).toBeTrue();
  });

  test("入群更新先到、楼中楼回复后到 → 转 EXEMPT 并撤销此前入群计数", () => {
    const state = pendingState({ reminderMessageId: 30, joinedAt: 999 });
    const { next, effects } = transitionVerification(state, {
      type: "trackedMessage",
      messageId: 40,
      inCommentThread: true,
      now: 1_000,
    });
    expect(next?.kind).toBe("exempt");
    expect(effects).toEqual([
      { kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: undefined },
      { kind: "retractJoinCount", joinedAt: 999 },
      { kind: "sendWelcome", variant: "channelComment", targetLabel: "杂鱼A", anchorMessageId: 40 },
    ]);
  });

  test("连发多条只补发一次回复式提醒", () => {
    const state = pendingState({ replyReminderRequested: true });
    const result = transitionVerification(state, { type: "trackedMessage", messageId: 41, inCommentThread: false, now: 1_000 });
    expect(state.trackedMessageTimes).toEqual([1_000]);
    expect(result.effects).toEqual([]);
    expect(result.snapshotChanged).toBeTrue();
  });

  test("评论区活动 → 转 EXEMPT + 欢迎，且撤销此前记的那次刷群计数", () => {
    const state = pendingState({ reminderMessageId: 30, trackedMessageTimes: Array(ANTI_RAID_PER_MINUTE_LIMIT).fill(1_000) });
    const { next, effects } = transitionVerification(state, { type: "trackedMessage", messageId: 42, inCommentThread: true, now: 1_000 });
    expect(next?.kind).toBe("exempt");
    expect(effectKinds(effects)).toEqual(["deleteReminders", "retractJoinCount", "sendWelcome"]);
    expect(state.trackedMessageTimes).toHaveLength(ANTI_RAID_PER_MINUTE_LIMIT);
  });

  test("同一分钟第 45 条继续追踪，第 46 条同步终结并进入刷屏提前踢出", () => {
    const state = pendingState({ replyReminderRequested: true });
    for (let count = 1; count <= ANTI_RAID_PER_MINUTE_LIMIT; count++) {
      const result = transitionVerification(state, {
        type: "trackedMessage",
        messageId: count,
        inCommentThread: false,
        now: 10_000,
      });
      expect(result.next).toBe(state);
      expect(effectKinds(result.effects)).not.toContain("expelFlood");
    }

    const overflow = transitionVerification(state, {
      type: "trackedMessage",
      messageId: ANTI_RAID_PER_MINUTE_LIMIT + 1,
      inCommentThread: false,
      now: 10_000,
    });
    expect(overflow.next).toMatchObject({
      kind: "expelling",
      reason: "flood",
    });
    if (overflow.next?.kind !== "expelling") throw new Error("Expected expelling state");
    expect("messageIds" in overflow.next.snapshot).toBeFalse();
    expect(overflow.effects).toEqual([]);
    const persisted = transitionVerification(overflow.next, { type: "terminalPersisted" });
    expect(effectKinds(persisted.effects)).toEqual(["expelFlood"]);
  });

  test("冷缓存确认可撤回由同一消息触发、但尚未开始执行的 flood 终态", () => {
    const state = pendingState({
      reminderMessageId: 30,
      trackedMessageTimes: Array(ANTI_RAID_PER_MINUTE_LIMIT).fill(10_000),
    });
    const overflow = transitionVerification(state, {
      type: "trackedMessage",
      messageId: 46,
      inCommentThread: false,
      now: 10_000,
    });
    expect(overflow.next?.kind).toBe("expelling");

    const confirmed = transitionVerification(overflow.next, {
      type: "confirmedThreadComment",
      messageId: 46,
      now: 10_000,
      allowFloodTerminalExemption: true,
    });
    expect(confirmed.next).toEqual({
      kind: "exempt",
      label: "杂鱼A",
      isBot: false,
    });
    expect(confirmed.effects).toEqual([
      {
        kind: "deleteReminders",
        reminderMessageId: 30,
        replyReminderMessageId: undefined,
      },
      { kind: "retractJoinCount", joinedAt: 0 },
      {
        kind: "sendWelcome",
        variant: "channelComment",
        targetLabel: "杂鱼A",
        anchorMessageId: 46,
      },
    ]);
  });

  test("冷缓存确认不能撤回已开始执行或不属于该 owner 的 flood 终态", () => {
    const terminal = transitionVerification(
      pendingState({
        trackedMessageTimes:
          Array(ANTI_RAID_PER_MINUTE_LIMIT).fill(10_000),
      }),
      {
        type: "trackedMessage",
        messageId: 46,
        inCommentThread: false,
        now: 10_000,
      }
    ).next;
    expect(terminal?.kind).toBe("expelling");
    if (terminal?.kind !== "expelling") throw new Error("expected expelling");

    expect(
      transitionVerification(terminal, {
        type: "confirmedThreadComment",
        messageId: 46,
        now: 10_000,
        allowFloodTerminalExemption: false,
      }).next
    ).toBe(terminal);
    terminal.executionStarted = true;
    expect(
      transitionVerification(terminal, {
        type: "confirmedThreadComment",
        messageId: 46,
        now: 10_000,
        allowFloodTerminalExemption: true,
      }).next
    ).toBe(terminal);
  });

  test("窗口修剪一分钟外的旧消息，且不同成员/群各自持有独立计数", () => {
    const first = pendingState({ replyReminderRequested: true, trackedMessageTimes: [0, 1_000] });
    transitionVerification(first, {
      type: "trackedMessage",
      messageId: 90,
      inCommentThread: false,
      now: JOIN_WINDOW_MS,
    });
    expect(first.trackedMessageTimes).toEqual([1_000, JOIN_WINDOW_MS]);

    const otherMember = pendingState({ replyReminderRequested: true });
    const otherChat = pendingState({ replyReminderRequested: true });
    transitionVerification(otherMember, { type: "trackedMessage", messageId: 91, inCommentThread: false, now: JOIN_WINDOW_MS });
    transitionVerification(otherChat, { type: "trackedMessage", messageId: 92, inCommentThread: false, now: JOIN_WINDOW_MS });
    expect(otherMember.trackedMessageTimes).toEqual([JOIN_WINDOW_MS]);
    expect(otherChat.trackedMessageTimes).toEqual([JOIN_WINDOW_MS]);
    expect(first.trackedMessageTimes).toHaveLength(2);
  });

  test("占位记录（kicked/exempt）不追踪消息", () => {
    const state: VerificationState = { kind: "exempt", label: "杂鱼A", isBot: false };
    const { next, effects } = transitionVerification(state, { type: "trackedMessage", messageId: 43, inCommentThread: false, now: 1_000 });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

describe("私密模式踢人结算", () => {
  test("KICK_PENDING 只有收到精确落盘回执后才按删公告、踢人的顺序执行", () => {
    const state = kickPendingState({ announcementMessageId: 7 });
    expect(transitionVerification(state, { type: "terminalPersisted" })).toEqual({
      next: state,
      effects: [
        { kind: "deleteMessage", messageId: 7 },
        { kind: "kickMember" },
      ],
    });
    expect(state.effectStarted).toBeTrue();
    expect(transitionVerification(state, { type: "terminalPersisted" }).effects).toEqual([]);
  });

  test("只有当前 KICK_PENDING 才转为 KICKED 并从结算时刻开始去重", () => {
    const state = kickPendingState();
    const settled = transitionVerification(state, { type: "kickSettled", now: 5_000 });
    expect(settled.next).toEqual({
      kind: "kicked",
      label: "杂鱼A",
      isBot: false,
      kickedAt: 5_000,
    });
    expect(settled.effects).toEqual([]);

    const replacement = pendingState();
    expect(
      transitionVerification(replacement, { type: "kickSettled", now: 6_000 }).next
    ).toBe(replacement);
  });

  test("kickRetry 只为尚未执行的 KICK_PENDING 重新产生踢人效果", () => {
    const state = kickPendingState();
    expect(transitionVerification(state, { type: "kickRetry" })).toEqual({
      next: state,
      effects: [{ kind: "kickMember" }],
    });
    expect(state.effectStarted).toBeTrue();

    state.effectStarted = false;
    state.executionStarted = true;
    expect(transitionVerification(state, { type: "kickRetry" })).toEqual({
      next: state,
      effects: [],
    });
    expect(
      transitionVerification(pendingState(), { type: "kickRetry" }).effects
    ).toEqual([]);
  });
});

describe("callback", () => {
  const cb = (overrides: Partial<{ isSelf: boolean; fromIsPrivileged: boolean }> = {}) =>
    ({ type: "callback", callbackQueryId: "q1", isSelf: true, fromIsPrivileged: false, fromLabel: "点击者", ...overrides }) as const;

  test("本人点击 → 通过：清记录 + 应答 + 删提醒 + 欢迎", () => {
    const state = pendingState({ reminderMessageId: 30, welcomeAnchorMessageId: 40 });
    const { next, effects } = transitionVerification(state, cb());
    expect(next).toBeUndefined();
    expect(effects).toEqual([
      { kind: "answerCallback", callbackQueryId: "q1", reply: "ok" },
      { kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: undefined },
      { kind: "sendWelcome", variant: "verified", targetLabel: "杂鱼A", fromLabel: "点击者", anchorMessageId: 40 },
    ]);
  });

  test("别人乱点 → 驳回，状态不动", () => {
    const state = pendingState();
    const { next, effects } = transitionVerification(state, cb({ isSelf: false }));
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "answerCallback", callbackQueryId: "q1", reply: "notYourButton" }]);
  });

  test("白名单也不能为真人代点", () => {
    const state = pendingState();
    const { next, effects } = transitionVerification(
      state,
      cb({ isSelf: false, fromIsPrivileged: true })
    );
    expect(next).toBe(state);
    expect(effects).toEqual([
      {
        kind: "answerCallback",
        callbackQueryId: "q1",
        reply: "notYourButton",
      },
    ]);
  });

  test("白名单为机器人代点 → 以作保通过", () => {
    const state = pendingState({ isBot: true });
    const { next, effects } = transitionVerification(state, cb({ isSelf: false, fromIsPrivileged: true }));
    expect(next).toBeUndefined();
    expect(effects[2]).toMatchObject({ kind: "sendWelcome", variant: "vouchedBot" });
  });

  test("非白名单给机器人乱点 → 驳回（机器人专用文案）", () => {
    const { effects } = transitionVerification(pendingState({ isBot: true }), cb({ isSelf: false }));
    expect(effects).toEqual([{ kind: "answerCallback", callbackQueryId: "q1", reply: "notYourBotButton" }]);
  });

  test("记录已不在（已通过/已踢/已豁免）→ 已失效", () => {
    for (const state of [undefined, { kind: "exempt", label: "杂鱼A", isBot: false } as VerificationState]) {
      const { effects } = transitionVerification(state, cb());
      expect(effects).toEqual([{ kind: "answerCallback", callbackQueryId: "q1", reply: "invalid" }]);
    }
  });
});

describe("超时与拉人者终核", () => {
  test("提醒从未成功落地时不踢人，延长完整窗口并重发原始提醒", () => {
    const state = pendingState({ expiresAt: 1_000 });
    const result = transitionVerification(state, { type: "verifyTimeout", now: 2_000 });

    expect(result.next).toBe(state);
    expect(state.expiresAt).toBe(2_000 + VERIFICATION_TIMEOUT_MS);
    expect(result.effects).toEqual([{ kind: "sendReminder", label: "杂鱼A", isBot: false }]);
    expect(result.snapshotChanged).toBeTrue();
    expect(result.rescheduleTimer).toBeTrue();
  });

  test("已请求回复式提醒但未落地时，续窗后仍只补发回复式提醒", () => {
    const state = pendingState({
      replyReminderRequested: true,
      reminderSuperseded: true,
      welcomeAnchorMessageId: 88,
    });
    const result = transitionVerification(state, { type: "verifyTimeout", now: 2_000 });

    expect(result.next).toBe(state);
    expect(result.effects).toEqual([{ kind: "sendReplyReminder", label: "杂鱼A", targetMessageId: 88 }]);
    expect(state.expiresAt).toBe(2_000 + VERIFICATION_TIMEOUT_MS);
  });

  test("提醒一直发不出去时续期有尽头，超过总时长按普通超时结算", () => {
    // 某群 sendMessage 持续失败（论坛 General 话题被关、机器人被禁言却仍能限制
    // 成员）时，无限续期会让每个入群者留下一条不朽记录：常驻待验证表、常驻主
    // 线程镜像并持续刷新日文件。
    const state = pendingState({ joinedAt: 1_000 });
    const late: number = 1_000 + VERIFICATION_REMINDER_UNDELIVERED_MAX_MS;

    const { next, effects } = transitionVerification(state, { type: "verifyTimeout", now: late });
    expect(next).toMatchObject({ kind: "expelling", reason: "timeout" });
    expect(effects).toEqual([]);

    // 上限之内照常续期。
    const fresh = pendingState({ joinedAt: 1_000 });
    expect(transitionVerification(fresh, { type: "verifyTimeout", now: late - 1 }).next).toBe(fresh);
  });

  test("超时且非被拉入群 → 先持久化 expelling，再收尾踢人", () => {
    const state = pendingState({ reminderMessageId: 2 });
    const { next, effects } = transitionVerification(state, { type: "verifyTimeout", now: 120_000 });
    expect(next).toMatchObject({ kind: "expelling", reason: "timeout", snapshot: { reminderMessageId: 2 } });
    expect(effects).toEqual([]);
    expect(effectKinds(transitionVerification(next, { type: "terminalPersisted" }).effects)).toEqual(["expel"]);
    expect(transitionVerification(next, { type: "terminalPersisted" }).effects).toEqual([]);
  });

  test("超时且被拉入群 → 先持久化 checkingInviter，再做终核", () => {
    const state = pendingState({ invitedBy: 999, reminderMessageId: 30 });
    const { next, effects } = transitionVerification(state, { type: "verifyTimeout", now: 120_000 });
    expect(next).toMatchObject({ kind: "checkingInviter", inviterId: 999 });
    expect(effects).toEqual([]);
    expect(transitionVerification(next, { type: "terminalPersisted" }).effects[0]).toMatchObject({ kind: "recheckInviter", inviterId: 999 });
    expect(transitionVerification(next, { type: "terminalPersisted" }).effects).toEqual([]);
  });

  test("终核：拉人者确是管理员 → 补豁免占位，只删提醒不踢人，且按精确时刻撤销此前记的那次刷群计数", () => {
    const snapshot = { label: "杂鱼A", isBot: false, reminderMessageId: 30, replyReminderMessageId: undefined, joinedAt: 54_321, expiresAt: 120_000 };
    const checking: VerificationState = { kind: "checkingInviter", inviterId: 999, snapshot };
    const { next, effects } = transitionVerification(checking, { type: "timeoutInviterVerdict", inviterIsAdmin: true });
    expect(next?.kind).toBe("exempt");
    expect(effects).toEqual([
      { kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: undefined },
      { kind: "retractJoinCount", joinedAt: 54_321 },
    ]);
  });

  test("终核：等待期间已有新记录 → 不覆盖它", () => {
    const fresh = pendingState({ label: "重新进群的同一人" });
    const { next } = transitionVerification(fresh, { type: "timeoutInviterVerdict", inviterIsAdmin: true });
    expect(next).toBe(fresh);
  });

  test("终核：拉人者不是管理员 → 先持久化 expelling，再收尾踢人", () => {
    const snapshot = { label: "杂鱼A", isBot: false, reminderMessageId: undefined, replyReminderMessageId: undefined, joinedAt: 0, expiresAt: 120_000 };
    const checking: VerificationState = { kind: "checkingInviter", inviterId: 999, snapshot };
    const { next, effects } = transitionVerification(checking, { type: "timeoutInviterVerdict", inviterIsAdmin: false });
    expect(next).toMatchObject({ kind: "expelling", reason: "timeout", snapshot });
    expect(effects).toEqual([]);
  });

  test("终核：拉人者不是管理员，但等待期间已有新记录 → 不踢、不覆盖它", () => {
    const fresh = pendingState({ label: "重新进群的同一人" });
    const { next, effects } = transitionVerification(fresh, { type: "timeoutInviterVerdict", inviterIsAdmin: false });
    expect(next).toBe(fresh);
    expect(effectKinds(effects)).not.toContain("expel");
    expect(effects).toEqual([]);
  });
});

describe("异步核查通过 / 离群 / 提醒回填 / 去重到期", () => {
  test("adminCheckResolved → 转 EXEMPT + 删提醒 + 按精确时刻撤销此前记的那次刷群计数", () => {
    const state = pendingState({ reminderMessageId: 30, joinedAt: 99_999 });
    const { next, effects } = transitionVerification(state, { type: "adminCheckResolved" });
    expect(next?.kind).toBe("exempt");
    expect(effects).toEqual([
      { kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: undefined },
      { kind: "retractJoinCount", joinedAt: 99_999 },
    ]);
  });

  test("待验证中途离群 → 删记录 + 只删提醒（公告/发言不动）", () => {
    const state = pendingState({ reminderMessageId: 30 });
    const { next, effects } = transitionVerification(state, { type: "left" });
    expect(next).toBeUndefined();
    expect(effects).toEqual([{ kind: "deleteReminders", reminderMessageId: 30, replyReminderMessageId: undefined }]);
  });

  test("占位记录离群 → 删记录，无可删提醒", () => {
    const { next, effects } = transitionVerification(kickedState(), { type: "left" });
    expect(next).toBeUndefined();
    expect(effects).toEqual([]);
  });

  test("原始提醒落地回填", () => {
    const state = pendingState();
    const result = transitionVerification(state, { type: "reminderLanded", reminderKind: "original", messageId: 30, now: 1_000 });
    expect(state.reminderMessageId).toBe(30);
    expect(state.expiresAt).toBe(1_000 + VERIFICATION_TIMEOUT_MS);
    expect(result.snapshotChanged).toBeTrue();
    expect(result.rescheduleTimer).toBeTrue();
  });

  test("原始提醒落地时已被取代 → 落地即自删", () => {
    const state = pendingState({ reminderSuperseded: true });
    const { effects } = transitionVerification(state, { type: "reminderLanded", reminderKind: "original", messageId: 30, now: 1_000 });
    expect(effects).toEqual([{ kind: "deleteMessage", messageId: 30 }]);
    expect(state.reminderMessageId).toBeUndefined();
  });

  test("回复式提醒落地回填不受取代标记影响", () => {
    const state = pendingState({ reminderSuperseded: true });
    const result = transitionVerification(state, { type: "reminderLanded", reminderKind: "reply", messageId: 31, now: 1_000 });
    expect(state.replyReminderMessageId).toBe(31);
    expect(result.snapshotChanged).toBeTrue();
    expect(result.rescheduleTimer).toBeTrue();
  });

  test("original/reply 提醒只回填各自显式 id，不创建混合消息列表", () => {
    for (const reminderKind of ["original", "reply"] as const) {
      const state = pendingState();

      transitionVerification(state, {
        type: "reminderLanded",
        reminderKind,
        messageId: 9_999,
        now: 1_000,
      });

      expect("messageIds" in state).toBeFalse();
      expect(
        reminderKind === "original"
          ? state.reminderMessageId
          : state.replyReminderMessageId
      ).toBe(9_999);
    }
  });

  test("guardDisabled：PENDING 停止触发，并清理已经失效的验证按钮", () => {
    // 主动关闭后按钮不再有有效 owner，必须由这条状态机路径删除；入群公告和
    // 成员自己的消息不在 effect 里，关闭功能不会扩大成清理群成员内容。
    const state = pendingState({ reminderMessageId: 11, replyReminderMessageId: 12 });

    const { next, effects } = transitionVerification(state, { type: "guardDisabled" });

    expect(next).toBeUndefined();
    expect(effects).toEqual([{
      kind: "deleteReminders",
      reminderMessageId: 11,
      replyReminderMessageId: 12,
    }]);
  });

  test("guardDisabled：两个已落盘终态一并作废，不再踢人", () => {
    // 终态是「已经决定要踢、正等落盘回执」；开关关掉之后还把人踢出去，是管理员
    // 最不可能预期的结果。返回 undefined 让解释器发 tombstone，重启也不会复活。
    const snapshot = {
      label: "杂鱼A",
      isBot: false,
      reminderMessageId: 21,
      replyReminderMessageId: 22,
      joinedAt: 0,
      expiresAt: 120_000,
    };

    for (const state of [
      { kind: "checkingInviter", inviterId: 7, snapshot },
      { kind: "expelling", reason: "timeout", snapshot },
    ] as const) {
      const { next, effects } = transitionVerification(state, { type: "guardDisabled" });

      expect(next).toBeUndefined();
      expect(effects).toEqual([{
        kind: "deleteReminders",
        reminderMessageId: 21,
        replyReminderMessageId: 22,
      }]);
    }
  });

  test("回归：新入群取代终态记录时，先删掉旧记录留下的验证提醒", () => {
    // 旧记录被替换后，它的 expel 收尾会因对象同一性复核不过而整段跳过——那条
    // 收尾正是负责删提醒的人。提醒带按钮，不能挂固定 30 秒删除，漏发这条 effect
    // 就等于在群里永久留一个指向已不存在记录的「验证」按钮。
    const snapshot = {
      label: "杂鱼A",
      isBot: false,
      reminderMessageId: 21,
      replyReminderMessageId: 22,
      joinedAt: 0,
      expiresAt: 120_000,
    };

    for (const state of [
      { kind: "checkingInviter", inviterId: 7, snapshot },
      { kind: "expelling", reason: "timeout", snapshot },
    ] as const) {
      const { next, effects } = transitionVerification(state, joinEvent({ now: 500_000 }));

      expect(next?.kind).toBe("pending");
      expect(effects[0]).toEqual({
        kind: "deleteReminders",
        reminderMessageId: 21,
        replyReminderMessageId: 22,
      });
    }
  });

  test("guardDisabled：内存态与 ABSENT 都直接清空，不产生副作用", () => {
    for (const state of [
      undefined,
      { kind: "exempt", label: "杂鱼A", isBot: false } as const,
      kickedState(),
      kickPendingState(),
    ]) {
      const { next, effects } = transitionVerification(state, { type: "guardDisabled" });

      expect(next).toBeUndefined();
      expect(effects).toEqual([]);
    }
  });

  test("去重窗口到期 → 占位清除；PENDING 不受影响", () => {
    expect(transitionVerification({ kind: "exempt", label: "杂鱼A", isBot: false }, { type: "dedupeExpired" }).next).toBeUndefined();
    const state = pendingState();
    expect(transitionVerification(state, { type: "dedupeExpired" }).next).toBe(state);
  });
});
