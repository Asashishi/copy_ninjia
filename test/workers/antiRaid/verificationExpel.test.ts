/** 踢人失败的权限告警与验证终态的进程级尝试预算。 */

import { describe, expect, test } from "bun:test";
import { expellingOf } from "../../../packages/states/verification/shared";

import type {
  ExpelSnapshot,
  VerificationEffect,
  VerificationEvent,
  VerificationState,
} from "../../../packages/types/states/verification";
import type { VerificationAttemptPermitResult } from "../../../packages/types/antiRaid/protocol";
import { ATMOSPHERE_TEXTS } from "../../../packages/consts/atmosphere";
import { expectTemplateRendered, longestTemplatePart } from "../../helpers/templateText";

const {
  CHAT_ID,
  KEY,
  applyFlagEvent,
  USER_ID,
  autoDeleted,
  deletedMessageIds,
  dispatched,
  getChat,
  kickChatKinds,
  kickPendingState,
  kickedUserIds,
  loggedErrors,
  pendingState,
  probeChatMembership,
  run,
  sentTexts,
  setState,
  snapshot,
  testState,
  traceDeleteOutcomes,
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
  resetAdminCache,
} = await import("../../../packages/cache/workers/antiRaid/admins");

const {
  VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS,
  VERIFICATION_TERMINAL_RETRY_MAX_MS,
  VERIFICATION_TERMINAL_RETRY_MS,
} = await import("../../../packages/consts/antiRaid/verification");

const {
  applyBotPermissionsChange,
  resetWorkerBotPermissions,
} = await import("../../../packages/workers/antiRaid/botPermissions");

const {
  applyChatKindChange,
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

describe("踢人失败时的权限告警", () => {
  function expellingState(
    snapshotOverrides: Partial<ExpelSnapshot> = {}
  ): VerificationState & { kind: "expelling" } {
    return expellingOf("timeout", snapshot(snapshotOverrides));
  }

  test("已有镜像直接使用；冷启动未知时 getChat 确证普通群或超级群", async () => {
    // 「只踢不封」在超级群/频道与普通群里是两个方法：超级群用 unbanChatMember，普通群用 banChatMember。
    // 镜像未知时先用 getChat 补齐，不猜测。
    for (const [kind, fetched, expected] of [
      [undefined, "supergroup", true],
      [undefined, "group", false],
      [true, "group", true],
      [false, "supergroup", false],
    ] as const) {
      resetWorkerChatKind();
      if (kind !== undefined) applyChatKindChange(CHAT_ID, kind);
      testState.fetchedChatType = fetched;
      kickedUserIds.length = 0;
      kickChatKinds.length = 0;
      getChat.mockClear();
      const state = expellingState();
      setState(state);

      await run([{ kind: "expel", snapshot: state.snapshot }]);

      expect(kickedUserIds).toEqual([USER_ID]);
      expect(kickChatKinds).toEqual([expected]);
      expect(getChat).toHaveBeenCalledTimes(kind === undefined ? 1 : 0);
    }
  });

  test("冷启动群类型查询失败时不猜踢人 API，终态保留并退避", async () => {
    testState.fetchedChatType = undefined;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(kickedUserIds).toBeEmpty();
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(verificationEntries.get(KEY)?.terminalRetries).toBe(1);
    expect(loggedErrors.some(
      (line: string): boolean => line.includes("Failed to resolve chat kind")
    )).toBeTrue();
    const timer: ReturnType<typeof setTimeout> | undefined =
      verificationEntries.get(KEY)?.timer;
    if (timer !== undefined) clearTimeout(timer);
  });

  test("终态踢人前现查成员；确认已离群就直接收尾且不发错误战报", async () => {
    testState.membershipPresent = false;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(probeChatMembership).toHaveBeenCalledWith(CHAT_ID, USER_ID, telegramApi);
    expect(kickedUserIds).toEqual([]);
    expect(sentTexts).toEqual([]);
    expect(dispatched).toContainEqual({ userId: USER_ID, event: { type: "expelSettled" } });
  });

  test("终态纯踢出在 429 重放前发现目标已离群时静默收尾", async () => {
    testState.kickTargetAbsent = true;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(probeChatMembership).toHaveBeenCalledTimes(1);
    expect(kickedUserIds).toEqual([USER_ID]);
    expect(sentTexts).toEqual([]);
    expect(dispatched).toContainEqual({ userId: USER_ID, event: { type: "expelSettled" } });
  });

  test("真人和机器人验证超时成功战报都明确报告三分钟", async () => {
    const humanState = expellingState();
    setState(humanState);

    await run([{ kind: "expel", snapshot: humanState.snapshot }]);
    expect(sentTexts[0]).toContain("3分钟");

    const botState = expellingState({
      label: "待验证机器人",
      isBot: true,
    });
    setState(botState);
    await run([{ kind: "expel", snapshot: botState.snapshot }]);
    expect(sentTexts[1]).toContain("3分钟");
  });

  test("成员查询失败时不贸然踢人，保留终态进入既有退避重试", async () => {
    testState.membershipPresent = undefined;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(kickedUserIds).toEqual([]);
    expect(sentTexts[0]).toContain("没能确认");
    expect(state.unconfirmedNoticeSent).toBeTrue();
    expect(testState.publishedChanges).toBe(1);
    expect(dispatched).not.toContainEqual({ userId: USER_ID, event: { type: "expelSettled" } });
    expect(verificationEntries.has(KEY)).toBeTrue();
    const timer: ReturnType<typeof setTimeout> | undefined = verificationEntries.get(KEY)?.timer;
    expect(timer).toBeDefined();
    if (timer !== undefined) clearTimeout(timer);
  });

  test("确证没有限制成员权限时不发踢人请求，但照常探测成员、清痕迹并把原因说给群里，之后每轮只探测并退避", async () => {
    const delays: number[] = [];
    const restoreTimeouts: () => void = recordScheduledDelays(delays);
    try {
      applyBotPermissionsChange(CHAT_ID, {
        canRestrictMembers: false,
        canDeleteMessages: true,
      });
      const state = expellingState({
        announcementMessageId: 20,
        reminderMessageId: 21,
        replyReminderMessageId: 22,
      });
      setState(state);

      await run([{ kind: "expel", snapshot: state.snapshot }]);

      // 踢人请求不发，只探测成员是否还在……
      expect(probeChatMembership).toHaveBeenCalledTimes(1);
      expect(kickedUserIds).toEqual([]);
      // ……但痕迹照清，群里收到那条唯一点名封禁权限的提示。
      expect(deletedMessageIds).toEqual([20, 21, 22]);
      expect(sentTexts).toHaveLength(1);
      expect(sentTexts[0]).toContain("封禁权限");
      expect(state.failureNoticeSent).toBeTrue();
      expect(loggedErrors.some((line: string): boolean => line.includes("can_restrict_members"))).toBeTrue();
      expect(state.executionStarted).toBeFalse();
      expect(verificationEntries.get(KEY)?.terminalRetries).toBe(1);
      expect(delays).toEqual([VERIFICATION_TERMINAL_RETRY_MS]);

      // 第二轮：诊断已经闩住，只发一次成员探测并推进退避。
      deletedMessageIds.length = 0;
      sentTexts.length = 0;
      probeChatMembership.mockClear();
      await run([{ kind: "expel", snapshot: state.snapshot }]);

      expect(probeChatMembership).toHaveBeenCalledTimes(1);
      expect(kickedUserIds).toEqual([]);
      expect(deletedMessageIds).toEqual([]);
      expect(sentTexts).toEqual([]);
      expect(verificationEntries.get(KEY)?.terminalRetries).toBe(2);

      probeChatMembership.mockClear();

      applyBotPermissionsChange(CHAT_ID, {
        canRestrictMembers: true,
        canDeleteMessages: true,
      });
      await run([{ kind: "expel", snapshot: state.snapshot }]);

      expect(probeChatMembership).toHaveBeenCalledTimes(1);
      expect(kickedUserIds).toEqual([USER_ID]);
      expect(deletedMessageIds).toEqual([20, 21, 22]);
    } finally {
      restoreTimeouts();
    }
  });

  test("确证没有限制成员权限时，已离群成员首轮即静默结算，不发告警", async () => {
    applyBotPermissionsChange(CHAT_ID, { canRestrictMembers: false, canDeleteMessages: true });
    testState.membershipPresent = false;
    const state = expellingState({ announcementMessageId: 20 });
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(kickedUserIds).toEqual([]);
    expect(deletedMessageIds).toEqual([20]);
    expect(sentTexts).toEqual([]);
    expect(dispatched).toEqual([{ userId: USER_ID, event: { type: "expelSettled" } }]);
  });

  test("确证没有限制成员权限、告警已闩住时，成员之后离群由下一轮探测结算", async () => {
    const delays: number[] = [];
    const restoreTimeouts: () => void = recordScheduledDelays(delays);
    try {
      applyBotPermissionsChange(CHAT_ID, { canRestrictMembers: false, canDeleteMessages: true });
      const state = expellingState();
      state.failureNoticeSent = true;
      state.cleanupSettled = true;
      setState(state);

      await run([{ kind: "expel", snapshot: state.snapshot }]);
      expect(probeChatMembership).toHaveBeenCalledTimes(1);
      expect(dispatched).toEqual([]);
      expect(verificationEntries.get(KEY)?.terminalRetries).toBe(1);

      testState.membershipPresent = false;
      loggedErrors.length = 0;
      await run([{ kind: "expel", snapshot: state.snapshot }]);

      // 离群那一轮只发这一次探测：不再清理已清完的验证消息，也不记缺权限诊断。
      expect(probeChatMembership).toHaveBeenCalledTimes(2);
      expect(deletedMessageIds).toEqual([]);
      expect(loggedErrors).toEqual([]);
      expect(kickedUserIds).toEqual([]);
      expect(sentTexts).toEqual([]);
      expect(dispatched).toEqual([{ userId: USER_ID, event: { type: "expelSettled" } }]);
      expect(delays).toEqual([VERIFICATION_TERMINAL_RETRY_MS]);
    } finally {
      restoreTimeouts();
    }
  });

  test("成员查询期间终态被替换时丢弃迟到结果，不再踢人或发战报", async () => {
    const state = expellingState();
    setState(state);
    probeChatMembership.mockImplementationOnce(async (): Promise<boolean> => {
      setState(pendingState());
      return true;
    });

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(kickedUserIds).toEqual([]);
    expect(sentTexts).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(verificationEntries.get(KEY)?.state.kind).toBe("pending");
  });

  test("告警发出去了才置位 failureNoticeSent", async () => {
    testState.kickSucceeds = false;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expectTemplateRendered(sentTexts[0]!, ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.verificationTimeoutKickFailed);
    expect(state.failureNoticeSent).toBeTrue();
    expect(testState.publishedChanges).toBe(1);
  });

  test("回归用例：确证没有 can_delete_messages 时一条删除请求都不发——" +
    "删除与踢人虽已分开退避，几十个注定 400 的往返仍只会制造无效负载与错误日志", async () => {
    // 主线程镜像过来的是「是管理员、能限制成员、不能删消息」这一档配置。
    applyBotPermissionsChange(CHAT_ID, { canRestrictMembers: true, canDeleteMessages: false });
    const state = expellingState({
      announcementMessageId: 20,
      reminderMessageId: 21,
      replyReminderMessageId: 22,
    });
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(deletedMessageIds).toEqual([]);
    expect(kickedUserIds).toEqual([USER_ID]);
    expect(sentTexts[0]).toContain("删不动");
    resetWorkerBotPermissions();
  });

  test("镜像里「没观测到」不当成没权限：照常发删除请求，由 Telegram 当裁判", async () => {
    // 主线程对「现查失败」发的也是「删掉条目」；镜像里没观测到不折算成没权限。
    const state = expellingState({ reminderMessageId: 21 });
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(deletedMessageIds).toEqual([21]);
  });

  test("回归用例：机器人验证消息删不掉时，成功战报必须独立说明", async () => {
    // 有 can_restrict_members、没有 can_delete_messages 的管理员配置：人踢走了，
    // 入群公告和两条机器人提醒都还在；成员发言从未进入删除列表。
    traceDeleteOutcomes.push("forbidden", "forbidden", "forbidden");
    const state = expellingState({
      announcementMessageId: 20,
      reminderMessageId: 21,
      replyReminderMessageId: 22,
    });
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(kickedUserIds).toEqual([USER_ID]);
    expect(deletedMessageIds).toEqual([20, 21, 22]);
    expect(sentTexts[0]).toContain("删不动");
    // 权限配错留下可诊断的线索。
    expect(loggedErrors.some((line: string): boolean => line.includes("can_delete_messages"))).toBeTrue();
  });

  test("回归用例：验证消息早就不在了不算删不动——管理员更快手删不该被公开指责", async () => {
    // 「message to delete not found」收敛成 gone：那批消息确实不在群里，不算删不动，也不提示 can_delete_messages。
    traceDeleteOutcomes.push("gone", "gone", "gone");
    const state = expellingState({
      announcementMessageId: 20,
      reminderMessageId: 21,
      replyReminderMessageId: 22,
    });
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(sentTexts[0]).not.toContain("删不动");
    expect(loggedErrors.some((line: string): boolean => line.includes("can_delete_messages"))).toBeFalse();
  });

  test("回归用例：几条里只失败一条时不说「一条都删不动」，非权限失败也不点管理员", async () => {
    // 一次瞬时网络错误：三条里删掉两条。文案必须按逐条结果计数，且只有权限失败
    // 才提示管理员检查权限。
    traceDeleteOutcomes.push("deleted", "failed", "deleted");
    const state = expellingState({
      announcementMessageId: 20,
      reminderMessageId: 21,
      replyReminderMessageId: 22,
    });
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expectTemplateRendered(sentTexts[0]!, (label: string): string => ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.verificationCleanupFailed(label, 1));
    expect(sentTexts[0]).not.toContain(
      longestTemplatePart((label: string): string => ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.verificationCleanupForbidden(label, 3, 1))
    );
    // 线索仍留，但不指向 can_delete_messages。
    expect(loggedErrors.some((line: string): boolean => line.includes("1 of 3"))).toBeTrue();
    expect(loggedErrors.some((line: string): boolean => line.includes("can_delete_messages"))).toBeFalse();
  });

  test("告警自己也没发出去时不置位：否则这条诊断永远不再尝试", async () => {
    // sendMessage 失败返回 undefined（错误被 infra/telegram/actions.ts 吞掉）：
    // 告警没发出去时不置位 failureNoticeSent，终态重试再跑 expelMember 时仍会尝试发诊断。
    testState.kickSucceeds = false;
    testState.nextSentMessageId = undefined;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(sentTexts).toHaveLength(1);
    expect(state.failureNoticeSent).toBeUndefined();
    expect(testState.publishedChanges).toBe(0);
  });

  test("踢成功但战报没发出去时不结算，下一轮凭 removalConfirmed 补发", async () => {
    // 战报发不出去时不结算：记录保留，removalConfirmed 置位。
    testState.nextSentMessageId = undefined;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(kickedUserIds).toEqual([USER_ID]);
    expect(state.removalConfirmed).toBeTrue();
    expect(state.successNoticeSent).toBeUndefined();
    expect(testState.publishedChanges).toBe(1);
    expect(dispatched).not.toContainEqual({ userId: USER_ID, event: { type: "expelSettled" } });

    // 下一轮探测答「人已经不在群里」：有 removalConfirmed 即认定是本 bot 踢的，战报照样补发。
    testState.membershipPresent = false;
    testState.nextSentMessageId = 901;
    sentTexts.length = 0;
    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(kickedUserIds).toEqual([USER_ID]);
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]).toContain("踢出去啦");
    expect(state.successNoticeSent).toBeTrue();
    expect(autoDeleted.at(-1)?.messageId).toBe(901);
    expect(testState.publishedChanges).toBe(2);

    const timer: ReturnType<typeof setTimeout> | undefined = verificationEntries.get(KEY)?.timer;
    if (timer !== undefined) clearTimeout(timer);
  });

  test("战报请求本身 reject 时按没发出去处理：记 removalConfirmed 并退避，执行门复位", async () => {
    const delays: number[] = [];
    const restoreTimeouts: () => void = recordScheduledDelays(delays);
    try {
      testState.sendRejects = true;
      const state = expellingState();
      setState(state);
      state.executionStarted = true;

      await run([{ kind: "expel", snapshot: state.snapshot }]);

      expect(kickedUserIds).toEqual([USER_ID]);
      expect(state.removalConfirmed).toBeTrue();
      expect(state.successNoticeSent).toBeUndefined();
      expect(state.executionStarted).toBeFalse();
      expect(delays).toEqual([VERIFICATION_TERMINAL_RETRY_MS]);
      expect(verificationEntries.get(KEY)?.terminalRetries).toBe(1);
      expect(dispatched).toEqual([]);
    } finally {
      restoreTimeouts();
    }
  });

  test("终态副作用链意外 reject 时复位执行门并按退避重试，不停在无计时器的终态", async () => {
    const delays: number[] = [];
    const restoreTimeouts: () => void = recordScheduledDelays(delays);
    try {
      const expelling = expellingState();
      setState(expelling);
      expelling.executionStarted = true;
      probeChatMembership.mockImplementationOnce(async (): Promise<boolean | undefined> => {
        throw new Error("Main-thread capability request failed.");
      });
      await expect(run([{ kind: "expel", snapshot: expelling.snapshot }])).rejects.toThrow("Main-thread capability request failed.");
      expect(verificationEntries.get(KEY)?.state).toBe(expelling);
      expect(expelling.executionStarted).toBeFalse();
      expect(verificationEntries.get(KEY)?.terminalRetries).toBe(1);

      const kickPending = kickPendingState();
      setState(kickPending);
      kickPending.effectStarted = true;
      probeChatMembership.mockImplementationOnce(async (): Promise<boolean | undefined> => {
        throw new Error("Main-thread capability request failed.");
      });
      await expect(run([{ kind: "kickMember" }])).rejects.toThrow("Main-thread capability request failed.");
      expect(kickPending.effectStarted).toBeFalse();
      expect(kickPending.executionStarted).toBeFalse();
      expect(verificationEntries.get(KEY)?.terminalRetries).toBe(1);
      expect(delays).toEqual([VERIFICATION_TERMINAL_RETRY_MS, VERIFICATION_TERMINAL_RETRY_MS]);
      expect(kickedUserIds).toEqual([]);
    } finally {
      restoreTimeouts();
    }
  });

  test("确证没有封禁权限时，清理还欠着账就不闩住：下一轮仍然重试删除", async () => {
    // 确证没有封禁权限时，闩住条件除 failureNoticeSent 外还要清理已结算（cleanupSettled）。
    applyBotPermissionsChange(CHAT_ID, { canRestrictMembers: false, canDeleteMessages: true });
    traceDeleteOutcomes.push("failed");
    const state = expellingState({ announcementMessageId: 20 });
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(deletedMessageIds).toEqual([20]);
    expect(state.failureNoticeSent).toBeTrue();
    expect(state.cleanupSettled).toBeFalse();

    // 第二轮：告警闩住了不再重发，公告仍然要重试删除。
    deletedMessageIds.length = 0;
    sentTexts.length = 0;
    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(deletedMessageIds).toEqual([20]);
    expect(sentTexts).toEqual([]);
    expect(state.cleanupSettled).toBeTrue();

    // 第三轮：清干净之后才真正闩住，一个请求都不发。
    deletedMessageIds.length = 0;
    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(deletedMessageIds).toEqual([]);
    expect(kickedUserIds).toEqual([]);

    const timer: ReturnType<typeof setTimeout> | undefined = verificationEntries.get(KEY)?.timer;
    if (timer !== undefined) clearTimeout(timer);
  });

  test("本来就已发过时保持不变，不重复打扰", async () => {
    testState.kickSucceeds = false;
    const state = expellingState();
    state.failureNoticeSent = true;
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(sentTexts).toHaveLength(0);
    expect(state.failureNoticeSent).toBeTrue();
    expect(testState.publishedChanges).toBe(0);
  });

  test("连续失败按指数退避拉长重试间隔，记录仍然保留", async () => {
    // 重试永远不会成功时，退避拉长重试节奏；记录不删，删记录等于把没处置的成员当成已完成。
    const delays: number[] = [];
    const restoreTimeouts: () => void = recordScheduledDelays(delays);
    try {
      testState.kickSucceeds = false;
      const state = expellingState();
      setState(state);

      const expectedDelays: number[] = [];
      for (let attempt: number = 0; attempt < 3; attempt++) {
        await run([{ kind: "expel", snapshot: state.snapshot }]);
        expectedDelays.push(Math.min(VERIFICATION_TERMINAL_RETRY_MS * 2 ** attempt, VERIFICATION_TERMINAL_RETRY_MAX_MS));
      }

      expect(delays).toEqual(expectedDelays);
      expect(verificationEntries.get(KEY)?.terminalRetries).toBe(3);
      // 退避不是放弃：记录保留，权限修好之后继续处置。
      expect(verificationEntries.has(KEY)).toBeTrue();
    } finally {
      restoreTimeouts();
    }
  });
});
describe("验证终态进程级尝试预算", () => {
  test("主线程拒绝超额许可时不执行 Telegram API，只回投延后事件", async () => {
    setState(kickPendingState());

    await run([{ kind: "kickMember" }], {
      status: "exhausted",
      attempt: VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS,
    });

    expect(kickedUserIds).toEqual([]);
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(dispatched).toEqual([{
      userId: USER_ID,
      event: { type: "terminalAttemptBudgetExhausted" },
    }]);
  });

  test("第 15 次取得许可但仍未结算时立即延后，不等待第 16 次 timer", async () => {
    setState(kickPendingState());
    applyChatKindChange(CHAT_ID, true);
    testState.kickSucceeds = false;

    await run([{ kind: "kickMember" }], {
      status: "granted",
      attempt: VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS,
    });

    expect(kickedUserIds).toEqual([USER_ID]);
    expect(dispatched.some(
      ({ event }: { event: VerificationEvent }): boolean =>
        event.type === "terminalAttemptBudgetExhausted"
    )).toBeTrue();
  });

  /** 驱逐播报标记事件与生产 dispatchVerification 一样，快照变化时把本 key 的 revision 推进一格。 */
  function runPublishingRevisions(
    effects: VerificationEffect[],
    permit: VerificationAttemptPermitResult
  ): Promise<void> {
    verificationGeneration.current = 1;
    if (!verificationRevisions.has(KEY)) verificationRevisions.set(KEY, { revision: 1 });
    return runVerificationEffects({
      chatId: CHAT_ID,
      userId: USER_ID,
      effects,
      dispatchVerification: (_chatId: number, userId: number, event: VerificationEvent): void => {
        const isFlagEvent: boolean = applyFlagEvent(event, (): void => {
          testState.publishedChanges++;
          verificationRevisions.set(KEY, {
            revision: (verificationRevisions.get(KEY)?.revision ?? 0) + 1,
          });
        });
        if (!isFlagEvent) dispatched.push({ userId, event });
      },
      requestTerminalAttempt: async (): Promise<VerificationAttemptPermitResult> => permit,
    });
  }

  function budgetExhaustedDispatched(): boolean {
    return dispatched.some(
      ({ event }: { event: VerificationEvent }): boolean =>
        event.type === "terminalAttemptBudgetExhausted"
    );
  }

  test("第 15 次许可内踢出并发出成功战报、正在等落盘回执时不判耗尽", async () => {
    // 等落盘回执期间不判耗尽，记录保留到回执到达。
    const state = expellingOf("timeout", snapshot());
    setState(state);

    await runPublishingRevisions([{ kind: "expel", snapshot: state.snapshot }], {
      status: "granted",
      attempt: VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS,
    });

    expect(kickedUserIds).toEqual([USER_ID]);
    expect(state.successNoticeSent).toBeTrue();
    expect(testState.publishedChanges).toBe(1);
    expect(budgetExhaustedDispatched()).toBeFalse();
    expect(verificationEntries.get(KEY)?.state).toBe(state);
  });

  test("第 15 次许可内踢出成功但战报没发出、已落账 removalConfirmed 时同样不就地判耗尽", async () => {
    testState.nextSentMessageId = undefined;
    const state = expellingOf("timeout", snapshot());
    setState(state);

    await runPublishingRevisions([{ kind: "expel", snapshot: state.snapshot }], {
      status: "granted",
      attempt: VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS,
    });

    expect(state.removalConfirmed).toBeTrue();
    expect(testState.publishedChanges).toBe(1);
    // 该 revision 的落盘回执会再申请许可，届时由主线程按预算判 exhausted。
    expect(budgetExhaustedDispatched()).toBeFalse();
    const timer: ReturnType<typeof setTimeout> | undefined = verificationEntries.get(KEY)?.timer;
    if (timer !== undefined) clearTimeout(timer);
  });

  test("第 15 次许可内没有任何新落账的处置失败仍立即判耗尽", async () => {
    testState.kickSucceeds = false;
    const state = expellingOf("timeout", snapshot());
    // 权限告警在更早的轮次已经发过：本轮只剩一次失败的踢人，没有新 revision。
    state.failureNoticeSent = true;
    setState(state);

    await runPublishingRevisions([{ kind: "expel", snapshot: state.snapshot }], {
      status: "granted",
      attempt: VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS,
    });

    expect(kickedUserIds).toEqual([USER_ID]);
    expect(testState.publishedChanges).toBe(0);
    expect(budgetExhaustedDispatched()).toBeTrue();
    const timer: ReturnType<typeof setTimeout> | undefined = verificationEntries.get(KEY)?.timer;
    if (timer !== undefined) clearTimeout(timer);
  });
});
