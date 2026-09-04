/** 踢人前的拉人者身份核查，以及同步副作用的逐条执行。 */

import { describe, expect, test } from "bun:test";

import type {
  ExpelSnapshot,
  VerificationState,
} from "../../../packages/types/states/verification";

const {
  CHAT_ID,
  INVITER_ID,
  KEY,
  USER_ID,
  autoDeleted,
  checkingInviterState,
  deletedMessageIds,
  dispatched,
  getChatAdministrators,
  kickPendingState,
  kickedUserIds,
  loggedErrors,
  pendingState,
  probeChatMembership,
  run,
  sentKeyboards,
  sentTexts,
  setState,
  snapshot,
  testState,
  warnings,
  installVerificationEffectsHooks,
  telegramApi,
  recordScheduledDelays,
} = await import("../../helpers/verificationEffectsHarness");

const { runVerificationEffects } = await import("../../../packages/workers/antiRaid/verificationEffects");

const {
  verificationEntries,
  verificationRevisions,
  verificationGeneration,
  reminderDeliveries,
} = await import("../../../packages/cache/workers/antiRaid/verification");

const {
  cacheAdminIds,
  resetAdminCache,
} = await import("../../../packages/cache/workers/antiRaid/admins");

const {
  VERIFICATION_TERMINAL_RETRY_MS,
  WELCOME_AUTO_DELETE_MS,
} = await import("../../../packages/consts/antiRaid/verification");

const {
  applyBotPermissionsChange,
  resetWorkerBotPermissions,
} = await import("../../../packages/workers/antiRaid/botPermissions");

const {
  resetWorkerChatKind,
} = await import("../../../packages/workers/antiRaid/chatKind");

installVerificationEffectsHooks({
  runVerificationEffects,
  verificationEntries,
  verificationRevisions,
  verificationGeneration,
  reminderDeliveries,
  resetAdminCache,
  resetWorkerBotPermissions,
  resetWorkerChatKind,
});

describe("管理员拉人豁免的异步核查", () => {
  test("确认拉人者是非匿名管理员后回投 adminCheckResolved", async () => {
    setState(pendingState());
    getChatAdministrators.mockResolvedValueOnce([{ user: { id: INVITER_ID }, is_anonymous: false }]);

    await run([{ kind: "startAdminCheck", actorId: INVITER_ID }]);
    await Bun.sleep(0);

    expect(dispatched).toEqual([{ userId: USER_ID, event: { type: "adminCheckResolved" } }]);
  });

  test("拉人者不在管理员名单、只是匿名管理员时都不豁免", async () => {
    setState(pendingState());
    getChatAdministrators.mockResolvedValueOnce([{ user: { id: 999 }, is_anonymous: false }]);

    await run([{ kind: "startAdminCheck", actorId: INVITER_ID }]);
    await Bun.sleep(0);
    expect(dispatched).toEqual([]);

    resetAdminCache();
    setState(pendingState());
    getChatAdministrators.mockResolvedValueOnce([{ user: { id: INVITER_ID }, is_anonymous: true }]);

    await run([{ kind: "startAdminCheck", actorId: INVITER_ID }]);
    await Bun.sleep(0);
    expect(dispatched).toEqual([]);
  });

  test("核查期间状态被换掉时丢弃迟到结果", async () => {
    setState(pendingState());
    getChatAdministrators.mockImplementationOnce(async () => {
      setState(pendingState());
      return [{ user: { id: INVITER_ID }, is_anonymous: false }];
    });

    await run([{ kind: "startAdminCheck", actorId: INVITER_ID }]);
    await Bun.sleep(0);

    expect(dispatched).toEqual([]);
  });

  test("拉取管理员失败只记日志，不回投也不吞掉后续副作用", async () => {
    setState(pendingState());
    getChatAdministrators.mockRejectedValueOnce(new Error("getChatAdministrators failed"));

    await run([{ kind: "startAdminCheck", actorId: INVITER_ID }, { kind: "deleteMessage", messageId: 11 }]);
    await Bun.sleep(0);

    expect(dispatched).toEqual([]);
    expect(deletedMessageIds).toEqual([11]);
    expect(loggedErrors[0]).toContain(`Error fetching chat admins for admin-invite exemption in chat ${CHAT_ID}`);
  });

  test("已经离开 pending 的成员不再发起核查", async () => {
    setState(checkingInviterState(snapshot()));

    await run([{ kind: "startAdminCheck", actorId: INVITER_ID }]);
    await Bun.sleep(0);

    expect(getChatAdministrators).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
  });
});
describe("超时踢人前的拉人者最终复核", () => {
  test("命中未过期缓存时直接判定，不再打 Telegram", async () => {
    const expelSnapshot: ExpelSnapshot = snapshot();
    setState(checkingInviterState(expelSnapshot));
    cacheAdminIds(CHAT_ID, new Set([INVITER_ID]));

    await run([{ kind: "recheckInviter", inviterId: INVITER_ID, snapshot: expelSnapshot }]);

    expect(getChatAdministrators).not.toHaveBeenCalled();
    expect(dispatched).toEqual([
      { userId: USER_ID, event: { type: "timeoutInviterVerdict", inviterIsAdmin: true } },
    ]);
  });

  test("缓存缺失时现查，管理员身份已撤销则继续超时处置", async () => {
    const expelSnapshot: ExpelSnapshot = snapshot();
    setState(checkingInviterState(expelSnapshot));

    await run([{ kind: "recheckInviter", inviterId: INVITER_ID, snapshot: expelSnapshot }]);

    expect(getChatAdministrators).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([
      { userId: USER_ID, event: { type: "timeoutInviterVerdict", inviterIsAdmin: false } },
    ]);
  });

  test("复核请求失败按非管理员兜底，绝不把成员永久挂在终态里", async () => {
    const expelSnapshot: ExpelSnapshot = snapshot();
    setState(checkingInviterState(expelSnapshot));
    getChatAdministrators.mockRejectedValueOnce(new Error("getChatAdministrators failed"));

    await run([{ kind: "recheckInviter", inviterId: INVITER_ID, snapshot: expelSnapshot }]);

    expect(dispatched).toEqual([
      { userId: USER_ID, event: { type: "timeoutInviterVerdict", inviterIsAdmin: false } },
    ]);
    expect(loggedErrors[0]).toContain(
      `Error rechecking admin-invite exemption before expiring verification in chat ${CHAT_ID}`
    );
  });

  test("复核期间状态被换掉时不回投判定", async () => {
    const expelSnapshot: ExpelSnapshot = snapshot();
    setState(checkingInviterState(expelSnapshot));
    getChatAdministrators.mockImplementationOnce(async () => {
      setState(checkingInviterState(expelSnapshot));
      return [{ user: { id: INVITER_ID }, is_anonymous: false }];
    });

    await run([{ kind: "recheckInviter", inviterId: INVITER_ID, snapshot: expelSnapshot }]);

    expect(dispatched).toEqual([]);
  });

  test("阶段或快照与副作用不匹配时整条跳过", async () => {
    setState(pendingState());
    await run([{ kind: "recheckInviter", inviterId: INVITER_ID, snapshot: snapshot() }]);

    setState(checkingInviterState(snapshot()));
    await run([{ kind: "recheckInviter", inviterId: INVITER_ID, snapshot: snapshot() }]);

    expect(getChatAdministrators).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
  });
});
describe("同步副作用的逐条执行", () => {
  test("真人、机器人和回复式验证提醒都明确给出三分钟", async () => {
    setState(pendingState());
    await run([
      { kind: "sendReminder", label: "真人杂鱼", isBot: false },
    ]);
    expect(sentTexts[0]).toContain("3分钟内");

    setState(pendingState());
    await run([
      { kind: "sendReminder", label: "铁皮杂鱼", isBot: true },
    ]);
    expect(sentTexts[1]).toContain("3分钟内");

    setState(pendingState());
    await run([{
      kind: "sendReplyReminder",
      label: "话多杂鱼",
      targetMessageId: 7,
    }]);
    expect(sentTexts[2]).toContain("3分钟内");
  });

  test("真人提醒带「我是良民」与「通过」两颗按钮，机器人提醒只留「通过」", async () => {
    setState(pendingState());
    await run([{ kind: "sendReminder", label: "真人杂鱼", isBot: false }]);
    expect(sentKeyboards[0]?.inline_keyboard).toEqual([[
      { text: "我是良民", callback_data: `verify:${USER_ID}` },
      { text: "通过", callback_data: `approve:${USER_ID}` },
    ]]);

    const botState: VerificationState = pendingState();
    if (botState.kind === "pending") botState.isBot = true;
    setState(botState);
    await run([{ kind: "sendReminder", label: "铁皮杂鱼", isBot: true }]);
    expect(sentKeyboards[1]?.inline_keyboard).toEqual([[
      { text: "通过", callback_data: `approve:${USER_ID}` },
    ]]);
    expect(sentTexts[1]).toContain("管理员");
    expect(sentTexts[1]).not.toContain("白名单");
  });

  test("先删两条提醒再踢人，欢迎语落地后安排自动删除", async () => {
    setState(kickPendingState());

    await run([
      { kind: "deleteReminders", reminderMessageId: 11, replyReminderMessageId: 12 },
      { kind: "kickMember" },
      {
        kind: "sendWelcome",
        variant: "verified",
        targetLabel: "杂鱼",
        fromLabel: "Alice",
        anchorMessageId: 5,
      },
      { kind: "logUncancelableKickExemption", label: "Alice" },
    ]);

    expect(deletedMessageIds).toEqual([11, 12]);
    expect(kickedUserIds).toEqual([USER_ID]);
    expect(dispatched.some(({ event }) => event.type === "kickSettled")).toBeTrue();
    expect(sentTexts[0]).toContain("Alice 通过验证啦");
    expect(autoDeleted).toEqual([{ messageId: 900, delayMs: WELCOME_AUTO_DELETE_MS }]);
    // 必须落在 error 上：Worker 只向主线程中继 error，warn 到不了 logs/，
    // 而这条正是「合法成员被误踢了、请人工拉回来」的唯一线索。
    expect(warnings).toEqual([]);
    expect(loggedErrors.some((line) => line.includes("had already been sent or completed"))).toBeTrue();
  });

  test("欢迎语没发出去时不安排删除，缺失的提醒 ID 也不误删", async () => {
    setState(pendingState());
    testState.nextSentMessageId = undefined;

    await run([
      { kind: "deleteReminders", reminderMessageId: 11 },
      { kind: "sendWelcome", variant: "channelComment", targetLabel: "杂鱼" },
    ]);

    expect(deletedMessageIds).toEqual([11]);
    expect(autoDeleted).toEqual([]);
  });

  test("私密模式踢人失败且成员仍在群时保留 KICK_PENDING 并退避重试", async () => {
    const delays: number[] = [];
    const restoreTimeouts: () => void = recordScheduledDelays(delays);
    testState.kickSucceeds = false;
    testState.membershipPresent = true;
    const state = kickPendingState();
    setState(state);

    await run([{ kind: "kickMember" }]);

    expect(dispatched.some(({ event }) => event.type === "kickSettled")).toBeFalse();
    expect(verificationEntries.get(KEY)?.state).toBe(state);
    expect(state.executionStarted).toBeFalse();
    expect(verificationEntries.get(KEY)?.terminalRetries).toBe(1);
    expect(delays).toEqual([VERIFICATION_TERMINAL_RETRY_MS]);
    restoreTimeouts();
  });

  test("私密模式确证没有限制成员权限时本轮零请求，权限恢复后下一轮继续踢人", async () => {
    const delays: number[] = [];
    const restoreTimeouts: () => void = recordScheduledDelays(delays);
    try {
      applyBotPermissionsChange(CHAT_ID, {
        canRestrictMembers: false,
        canDeleteMessages: true,
      });
      const state = kickPendingState();
      setState(state);

      await run([{ kind: "kickMember" }]);

      expect(kickedUserIds).toEqual([]);
      expect(probeChatMembership).not.toHaveBeenCalled();
      expect(state.executionStarted).toBeFalse();
      expect(verificationEntries.get(KEY)?.terminalRetries).toBe(1);
      expect(delays).toEqual([VERIFICATION_TERMINAL_RETRY_MS]);

      applyBotPermissionsChange(CHAT_ID, {
        canRestrictMembers: true,
        canDeleteMessages: true,
      });
      await run([{ kind: "kickMember" }]);

      expect(kickedUserIds).toEqual([USER_ID]);
      expect(dispatched.some(({ event }) => event.type === "kickSettled")).toBeTrue();
    } finally {
      restoreTimeouts();
    }
  });

  test("私密模式踢人请求失败但成员已离群时允许结算", async () => {
    testState.kickSucceeds = false;
    testState.membershipPresent = false;
    setState(kickPendingState());

    await run([{ kind: "kickMember" }]);

    expect(dispatched).toContainEqual({
      userId: USER_ID,
      event: { type: "kickSettled", now: expect.any(Number) },
    });
  });

  test("私密模式纯踢出在 429 重放前发现目标已离群时直接结算", async () => {
    testState.kickTargetAbsent = true;
    setState(kickPendingState());

    await run([{ kind: "kickMember" }]);

    expect(probeChatMembership).toHaveBeenCalledTimes(1);
    expect(kickedUserIds).toEqual([USER_ID]);
    expect(dispatched).toContainEqual({
      userId: USER_ID,
      event: { type: "kickSettled", now: expect.any(Number) },
    });
  });

  test("私密模式首发也先探测：join update 证明的是在场，不是没被封", async () => {
    // join update 只证明目标在场，不能替代封禁状态查询。锁群下的调用若命中 429
    // 会排进 kick 类独立退避车道；等待期间人工管理员完全可能
    // 在客户端直接封禁这个人，而超级群的「只踢不封」映射到不带 only_if_banned
    // 的 unbanChatMember——排到的那一发会把管理员的封禁解开。
    setState(kickPendingState());

    await run([{ kind: "kickMember" }]);

    expect(probeChatMembership).toHaveBeenCalledWith(CHAT_ID, USER_ID, telegramApi);
    expect(kickedUserIds).toEqual([USER_ID]);
  });

  test("首发时人已经被管理员封掉：直接结算，绝不发那个会解封的请求", async () => {
    // getChatMember 报 kicked 时 isPresentMember 为 false，人已经出去了，
    // 移除的目的已经达成，不能再去碰那条封禁。
    testState.membershipPresent = false;
    setState(kickPendingState());

    await run([{ kind: "kickMember" }]);

    expect(kickedUserIds).toEqual([]);
    expect(dispatched).toContainEqual({
      userId: USER_ID,
      event: { type: "kickSettled", now: expect.any(Number) },
    });
  });

  test("私密模式重试同样先探测：人已经不在群里就直接结算，不发那个会解封的请求", async () => {
    // 超级群的「只踢不封」映射到 unbanChatMember，而它不带 only_if_banned 时
    // 会**解除已有封禁**：首发瞬时失败、退避期间超管刚 /block 掉这个人的话，
    // 重试这一发就把刚落的封禁解开了，人凭任意邀请链接就能回来。
    testState.membershipPresent = false;
    const state = kickPendingState();
    setState(state);
    verificationEntries.set(KEY, { state, timer: undefined, terminalRetries: 1 });

    await run([{ kind: "kickMember" }]);

    expect(probeChatMembership).toHaveBeenCalledWith(CHAT_ID, USER_ID, telegramApi);
    expect(kickedUserIds).toEqual([]);
    expect(dispatched).toContainEqual({
      userId: USER_ID,
      event: { type: "kickSettled", now: expect.any(Number) },
    });
  });

  test("私密模式重试时探测不出成员在不在群里，同样不发那个请求", async () => {
    // 查询失败不等于不在群，也不足以授权一个可能解掉别人封禁的调用。
    testState.membershipPresent = undefined;
    const state = kickPendingState();
    setState(state);
    verificationEntries.set(KEY, { state, timer: undefined, terminalRetries: 1 });

    await run([{ kind: "kickMember" }]);

    expect(kickedUserIds).toEqual([]);
    expect(state.executionStarted).toBeFalse();
    expect(dispatched.some(({ event }) => event.type === "kickSettled")).toBeFalse();
    expect(verificationEntries.get(KEY)?.terminalRetries).toBe(2);
    const timer: ReturnType<typeof setTimeout> | undefined = verificationEntries.get(KEY)?.timer;
    if (timer !== undefined) clearTimeout(timer);
  });

  test("私密模式失败后的成员探测期间 token 被替换时丢弃迟到结果", async () => {
    testState.kickSucceeds = false;
    const state = kickPendingState();
    setState(state);
    probeChatMembership.mockImplementationOnce(async (): Promise<boolean> => {
      setState(pendingState());
      return true;
    });

    await run([{ kind: "kickMember" }]);

    expect(verificationEntries.get(KEY)?.state.kind).toBe("pending");
    expect(dispatched.some(({ event }) => event.type === "kickSettled")).toBeFalse();
    expect(verificationEntries.get(KEY)?.terminalRetries).toBeUndefined();
  });
});
