/** 踢人前的拉人者身份核查，以及同步副作用的逐条执行。 */

import { beforeEach, describe, expect, test } from "bun:test";
import { atmosphereState } from "../../../packages/cache/workers/antiRaid/atmosphere";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../../packages/consts/commands";
import { ATMOSPHERE_TEXTS } from "../../../packages/consts/atmosphere";
import { formatMinSec } from "../../../packages/libs/time";

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
  callbackTexts,
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
  VERIFICATION_TIMEOUT_MS,
  VERIFY_APPROVE_CALLBACK_PREFIX,
  VERIFY_SELF_CALLBACK_PREFIX,
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
beforeEach(() => { atmosphereState.current = null; });

test("验证按钮应答按注入的本进程风格指向实际按钮", async () => {
  setState(pendingState());
  atmosphereState.current = "plain";
  await run([{ kind: "answerCallback", callbackQueryId: "callback", reply: "useSelfButton" }]);
  expect(callbackTexts[0]).toBe(ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS.verificationUseSelfButton(
    ATMOSPHERE_TEXTS.plain.VERIFICATION_SELF_BUTTON_TEXT,
    ATMOSPHERE_TEXTS.plain.VERIFICATION_APPROVE_BUTTON_TEXT
  ));
  atmosphereState.current = "teasing";
  await run([{ kind: "answerCallback", callbackQueryId: "callback", reply: "useSelfButton" }]);
  expect(callbackTexts[1]).toBe(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.verificationUseSelfButton(
    ATMOSPHERE_TEXTS.teasing.VERIFICATION_SELF_BUTTON_TEXT,
    ATMOSPHERE_TEXTS.teasing.VERIFICATION_APPROVE_BUTTON_TEXT
  ));
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

  test("复核身份未知时保留终态并退避，不把请求失败当作非管理员", async (): Promise<void> => {
    const expelSnapshot: ExpelSnapshot = snapshot();
    const state: VerificationState = setState(checkingInviterState(expelSnapshot));
    getChatAdministrators.mockRejectedValueOnce(new Error("getChatAdministrators failed"));
    const delays: number[] = [];
    const restore: () => void = recordScheduledDelays(delays);

    try {
      await run([{ kind: "recheckInviter", inviterId: INVITER_ID, snapshot: expelSnapshot }]);

      expect(dispatched).toEqual([]);
      expect(kickedUserIds).toEqual([]);
      expect(verificationEntries.get(KEY)?.state).toBe(state);
      expect(state).toMatchObject({ kind: "checkingInviter", executionStarted: false });
      expect(delays).toEqual([VERIFICATION_TERMINAL_RETRY_MS]);
      expect(loggedErrors[0]).toContain("Failed to check admin exemption for verification inviter");

      getChatAdministrators.mockResolvedValueOnce([{ user: { id: INVITER_ID }, is_anonymous: false }]);
      await run([{ kind: "recheckInviter", inviterId: INVITER_ID, snapshot: expelSnapshot }]);
      expect(dispatched).toEqual([
        { userId: USER_ID, event: { type: "timeoutInviterVerdict", inviterIsAdmin: true } },
      ]);
      expect(kickedUserIds).toEqual([]);
    } finally {
      restore();
    }
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
  test("验证提醒重试采用当前群风格，按钮与正文一致且保留目标昵称", async () => {
    const state: VerificationState = pendingState();
    setState(state);
    testState.nextSentMessageId = undefined;
    const timeout: string = formatMinSec(VERIFICATION_TIMEOUT_MS);
    await run([{ kind: "sendReminder", label: "用户😀♡", isBot: false }]);
    await Bun.sleep(0);
    expect(sentTexts[0]).toBe(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.verificationMemberReminder({
      label: "用户😀♡",
      timeout,
      selfButton: ATMOSPHERE_TEXTS.teasing.VERIFICATION_SELF_BUTTON_TEXT,
      approveButton: ATMOSPHERE_TEXTS.teasing.VERIFICATION_APPROVE_BUTTON_TEXT,
    }));
    atmosphereState.current = "plain";
    testState.nextSentMessageId = 900;
    await run([{ kind: "sendReminder", label: "用户😀♡", isBot: false }]);
    await Bun.sleep(0);
    expect(sentTexts[1]).toBe(ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS.verificationMemberReminder({
      label: "用户😀♡",
      timeout,
      selfButton: ATMOSPHERE_TEXTS.plain.VERIFICATION_SELF_BUTTON_TEXT,
      approveButton: ATMOSPHERE_TEXTS.plain.VERIFICATION_APPROVE_BUTTON_TEXT,
    }));
    expect(sentKeyboards[1]?.inline_keyboard[0]?.[0]).toEqual({
      text: ATMOSPHERE_TEXTS.plain.VERIFICATION_SELF_BUTTON_TEXT,
      callback_data: `${VERIFY_SELF_CALLBACK_PREFIX}${USER_ID}`,
    });
    expect(reminderDeliveries.size).toBe(0);
  });
  test("真人、机器人和回复式验证提醒都明确给出三分钟", async () => {
    setState(pendingState());
    await run([
      { kind: "sendReminder", label: "真人杂鱼", isBot: false },
    ]);
    expect(sentTexts[0]).toContain(`${formatMinSec(VERIFICATION_TIMEOUT_MS)}内`);

    setState(pendingState());
    await run([
      { kind: "sendReminder", label: "铁皮杂鱼", isBot: true },
    ]);
    expect(sentTexts[1]).toContain(`${formatMinSec(VERIFICATION_TIMEOUT_MS)}内`);

    setState(pendingState());
    await run([{
      kind: "sendReplyReminder",
      label: "话多杂鱼",
      targetMessageId: 7,
    }]);
    expect(sentTexts[2]).toContain(`${formatMinSec(VERIFICATION_TIMEOUT_MS)}内`);
  });

  test("真人提醒带「我是良民」与「通过」两颗按钮，机器人提醒只留「通过」", async () => {
    setState(pendingState());
    await run([{ kind: "sendReminder", label: "真人杂鱼", isBot: false }]);
    expect(sentKeyboards[0]?.inline_keyboard).toEqual([[
      { text: ATMOSPHERE_TEXTS.teasing.VERIFICATION_SELF_BUTTON_TEXT, callback_data: `${VERIFY_SELF_CALLBACK_PREFIX}${USER_ID}` },
      { text: ATMOSPHERE_TEXTS.teasing.VERIFICATION_APPROVE_BUTTON_TEXT, callback_data: `${VERIFY_APPROVE_CALLBACK_PREFIX}${USER_ID}` },
    ]]);

    const botState: VerificationState = pendingState();
    if (botState.kind === "pending") botState.isBot = true;
    setState(botState);
    await run([{ kind: "sendReminder", label: "铁皮杂鱼", isBot: true }]);
    expect(sentKeyboards[1]?.inline_keyboard).toEqual([[
      { text: ATMOSPHERE_TEXTS.teasing.VERIFICATION_APPROVE_BUTTON_TEXT, callback_data: `${VERIFY_APPROVE_CALLBACK_PREFIX}${USER_ID}` },
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
    expect(autoDeleted).toEqual([{ messageId: 900, delayMs: COMMAND_MESSAGE_AUTO_DELETE_MS }]);
    // 记在 error 上：Worker 只向主线程中继 error，不记 warn；该行是「合法成员被误踢」的线索。
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

  test("私密模式确证没有限制成员权限时本轮只探测成员、不发踢人请求，权限恢复后下一轮继续踢人", async () => {
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
      expect(probeChatMembership).toHaveBeenCalledTimes(1);
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

  test("私密模式确证没有限制成员权限、成员已离群时直接结算，不退避", async () => {
    applyBotPermissionsChange(CHAT_ID, {
      canRestrictMembers: false,
      canDeleteMessages: true,
    });
    testState.membershipPresent = false;
    setState(kickPendingState());

    await run([{ kind: "kickMember" }]);

    expect(kickedUserIds).toEqual([]);
    expect(dispatched).toEqual([{
      userId: USER_ID,
      event: { type: "kickSettled", now: expect.any(Number) },
    }]);
    expect(verificationEntries.get(KEY)?.terminalRetries).toBe(0);
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

  test("踢人请求失败后的复探发现人已离群：结算，不再退避重试", async () => {
    // 与上一条的区别在哪一次探测说人不在：这里首发前的探测说在场，请求发出去后失败，随后的复探才发现人已不在；这条路结算。
    testState.kickSucceeds = false;
    testState.membershipPresent = true;
    probeChatMembership.mockImplementationOnce(async (): Promise<boolean> => true);
    probeChatMembership.mockImplementationOnce(async (): Promise<boolean> => false);
    const state = kickPendingState();
    setState(state);

    await run([{ kind: "kickMember" }]);

    expect(kickedUserIds).toEqual([USER_ID]);
    expect(probeChatMembership).toHaveBeenCalledTimes(2);
    expect(state.executionStarted).toBeFalse();
    expect(dispatched).toContainEqual({
      userId: USER_ID,
      event: { type: "kickSettled", now: expect.any(Number) },
    });
    // 结算掉的记录不排重试，也不记那行「踢不动」诊断。
    expect(verificationEntries.get(KEY)?.terminalRetries).toBe(0);
    expect(loggedErrors.some((line: string): boolean => line.includes("Lockdown kick"))).toBeFalse();
  });

  test("判不出群还是超级群时零踢人请求，保留待处置并退避", async () => {
    // 超级群走 unbanChatMember、普通群走 banChatMember + unban，两者不可互换；群类型查不出来时零请求。
    const delays: number[] = [];
    const restoreTimeouts: () => void = recordScheduledDelays(delays);
    try {
      testState.fetchedChatType = undefined;
      const state = kickPendingState();
      setState(state);

      await run([{ kind: "kickMember" }]);

      expect(kickedUserIds).toEqual([]);
      // 群类型判不出来时不探测成员。
      expect(probeChatMembership).not.toHaveBeenCalled();
      expect(state.executionStarted).toBeFalse();
      expect(dispatched.some(({ event }) => event.type === "kickSettled")).toBeFalse();
      expect(verificationEntries.get(KEY)?.terminalRetries).toBe(1);
      expect(delays).toEqual([VERIFICATION_TERMINAL_RETRY_MS]);
      // 这条分支不发 Telegram 请求，由它自己记诊断。
      expect(loggedErrors.some((line: string): boolean =>
        line.includes("could not resolve whether the chat is a group or supergroup")
      )).toBeTrue();
    } finally {
      restoreTimeouts();
    }
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
    // join update 只证明目标在场，不替代封禁状态查询；私密模式首发也先探测，
    // 超级群的「只踢不封」映射到不带 only_if_banned 的 unbanChatMember。
    setState(kickPendingState());

    await run([{ kind: "kickMember" }]);

    expect(probeChatMembership).toHaveBeenCalledWith(CHAT_ID, USER_ID, telegramApi);
    expect(kickedUserIds).toEqual([USER_ID]);
  });

  test("首发时人已经被管理员封掉：直接结算，绝不发那个会解封的请求", async () => {
    // getChatMember 报 kicked 时 isPresentMember 为 false：移除目的已达成，不再碰那条封禁。
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
    // 超级群的「只踢不封」映射到 unbanChatMember，不带 only_if_banned 时会解除已有封禁；
    // 重试同样先探测，人已不在群里就直接结算。
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
    // 查询失败不等于不在群：不发可能解掉别人封禁的请求。
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
    expect(verificationEntries.get(KEY)?.terminalRetries).toBe(0);
  });
});
