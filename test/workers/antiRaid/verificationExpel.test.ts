/** 踢人失败的权限告警与验证终态的进程级尝试预算。 */

import { describe, expect, spyOn, test } from "bun:test";

import type {
  ExpelSnapshot,
  VerificationEvent,
  VerificationState,
} from "../../../packages/types/states/verification";

const {
  CHAT_ID,
  KEY,
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
  joinVerificationApi,
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
    return {
      kind: "expelling",
      reason: "timeout",
      snapshot: snapshot(snapshotOverrides),
    };
  }

  test("已有镜像直接使用；冷启动未知时 getChat 确证普通群或超级群", async () => {
    // 「只踢不封」在两类群里是两个方法：unbanChatMember 按官方文档只认超级群/
    // 频道，普通群要用 banChatMember（那里它不产生持久封禁）。三态里只有确证的
    // false 会改道。镜像未知时不再猜测，而是先用 getChat 补齐。
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

    expect(probeChatMembership).toHaveBeenCalledWith(CHAT_ID, USER_ID, joinVerificationApi);
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

  test("确证没有限制成员权限时不发踢人请求，但照常清痕迹并把原因说给群里，之后每轮只退避", async () => {
    const delays: number[] = [];
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      ((_handler: () => void, delayMs?: number): ReturnType<typeof setTimeout> => {
        delays.push(delayMs ?? 0);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof globalThis.setTimeout
    );
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

      // 踢人相关的请求一个不发……
      expect(probeChatMembership).not.toHaveBeenCalled();
      expect(kickedUserIds).toEqual([]);
      // ……但痕迹照清，群里也必须收到那条唯一点名封禁权限的提示，否则管理员
      // 拿不到任何信号，人就无限期留在群里。
      expect(deletedMessageIds).toEqual([20, 21, 22]);
      expect(sentTexts).toHaveLength(1);
      expect(sentTexts[0]).toContain("封禁权限");
      expect(state.failureNoticeSent).toBeTrue();
      expect(loggedErrors.some((line: string): boolean => line.includes("can_restrict_members"))).toBeTrue();
      expect(state.executionStarted).toBeFalse();
      expect(verificationEntries.get(KEY)?.terminalRetries).toBe(1);
      expect(delays).toEqual([VERIFICATION_TERMINAL_RETRY_MS]);

      // 第二轮：诊断已经闩住，只推进退避，一个请求都不再发。
      deletedMessageIds.length = 0;
      sentTexts.length = 0;
      await run([{ kind: "expel", snapshot: state.snapshot }]);

      expect(probeChatMembership).not.toHaveBeenCalled();
      expect(kickedUserIds).toEqual([]);
      expect(deletedMessageIds).toEqual([]);
      expect(sentTexts).toEqual([]);
      expect(verificationEntries.get(KEY)?.terminalRetries).toBe(2);

      applyBotPermissionsChange(CHAT_ID, {
        canRestrictMembers: true,
        canDeleteMessages: true,
      });
      await run([{ kind: "expel", snapshot: state.snapshot }]);

      expect(probeChatMembership).toHaveBeenCalledTimes(1);
      expect(kickedUserIds).toEqual([USER_ID]);
      expect(deletedMessageIds).toEqual([20, 21, 22]);
    } finally {
      timeoutSpy.mockRestore();
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

    expect(sentTexts[0]).toContain("没给本天才封禁权限");
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
    // 主线程对「现查失败」（撞一次 429 就退避几分钟）发的也是「删掉条目」，
    // 把它折算成没权限，那几分钟里的验证提醒就全留在群里了。
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
    // 权限配错要留下可诊断的线索，否则运维永远查不到 can_delete_messages。
    expect(loggedErrors.some((line: string): boolean => line.includes("can_delete_messages"))).toBeTrue();
  });

  test("回归用例：验证消息早就不在了不算删不动——管理员更快手删不该被公开指责", async () => {
    // 「message to delete not found」收敛成 gone：那批消息确实不在群里了。
    // 折算成失败的话，一个权限齐全的
    // 机器人会把管理员送去排查一个配置完全正确的 can_delete_messages。
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
    // 一次瞬时网络错误：三条里删掉两条。旧实现是全有全无布尔，任一条失败即翻，
    // 文案照样声称一条都删不动，并把管理员送去查权限。
    traceDeleteOutcomes.push("deleted", "failed", "deleted");
    const state = expellingState({
      announcementMessageId: 20,
      reminderMessageId: 21,
      replyReminderMessageId: 22,
    });
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(sentTexts[0]).toContain("还有 1 条没清掉");
    expect(sentTexts[0]).not.toContain("删消息的权限");
    // 线索仍要留，但不能指向一个没被证伪的权限。
    expect(loggedErrors.some((line: string): boolean => line.includes("1 of 3"))).toBeTrue();
    expect(loggedErrors.some((line: string): boolean => line.includes("can_delete_messages"))).toBeFalse();
  });

  test("告警自己也没发出去时不置位：否则这条诊断永远不再尝试", async () => {
    // sendMessage 失败返回 undefined（错误被 infra/telegram/actions.ts 吞掉）。
    // 机器人同时被禁言、或 429 退避后仍失败时就是这个组合。照样置位的话，
    // 终态重试再跑 expelMember 时 shouldSendNotice 已是 false，「本天才没有封禁
    // 权限」这条唯一的诊断就永远不再尝试——未验证成员留在群里，管理员什么都
    // 不知道。
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
    // 战报发不出去（429 退避后仍失败 / 网络抖动）时照样结算的话，记录当场
    // 被删，群里看着一个成员凭空消失，而唯一的说明再也没有第二次机会。
    testState.nextSentMessageId = undefined;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(kickedUserIds).toEqual([USER_ID]);
    expect(state.removalConfirmed).toBeTrue();
    expect(state.successNoticeSent).toBeUndefined();
    expect(testState.publishedChanges).toBe(1);
    expect(dispatched).not.toContainEqual({ userId: USER_ID, event: { type: "expelSettled" } });

    // 下一轮探测只会答「人已经不在群里」——没有 removalConfirmed 的话这里会被
    // 当成「别人处置的」而静默结算。有它就认得出那是本天才踢的，战报照样补发。
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

  test("确证没有封禁权限时，清理还欠着账就不闩住：下一轮仍然重试删除", async () => {
    // 只认 failureNoticeSent 的话，一条因为网络抖动删失败过的验证公告会就此
    // 定格：此后每轮都在短路处返回，那条带可点击按钮的公告永远挂在群里，而
    // 对应的成员根本没被踢走。
    applyBotPermissionsChange(CHAT_ID, { canRestrictMembers: false, canDeleteMessages: true });
    traceDeleteOutcomes.push("failed");
    const state = expellingState({ announcementMessageId: 20 });
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(deletedMessageIds).toEqual([20]);
    expect(state.failureNoticeSent).toBeTrue();
    expect(state.cleanupSettled).toBeUndefined();

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
    // 机器人是管理员却没有封禁权限、或目标本人就是这个群的管理员时，这条重试
    // 永远不会成功。记录按设计不能删（删了就等于把没处置的成员当成已完成），
    // 因此能收敛的只有节奏：固定 30 秒一轮的话，一次刷群留下的每个未验证成员
    // 都会永久占住一个 30 秒循环，各自不停打 deleteMessage + kickChatMember
    // 并往 logs/ 刷同一行报错，Worker 重建后还照单重新武装。
    const delays: number[] = [];
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      ((_handler: () => void, delayMs?: number): ReturnType<typeof setTimeout> => {
        delays.push(delayMs ?? 0);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof globalThis.setTimeout
    );
    try {
      testState.kickSucceeds = false;
      const state = expellingState();
      setState(state);

      for (let attempt: number = 0; attempt < 3; attempt++) {
        await run([{ kind: "expel", snapshot: state.snapshot }]);
      }

      expect(delays).toEqual([30_000, 60_000, 120_000]);
      expect(verificationEntries.get(KEY)?.terminalRetries).toBe(3);
      // 退避不是放弃：记录必须留着，权限修好之后还要继续处置。
      expect(verificationEntries.has(KEY)).toBeTrue();
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
describe("验证终态进程级尝试预算", () => {
  test("主线程拒绝超额许可时不执行 Telegram API，只回投延后事件", async () => {
    setState(kickPendingState());

    await run([{ kind: "kickMember" }], {
      status: "exhausted",
      attempt: 15,
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
      attempt: 15,
    });

    expect(kickedUserIds).toEqual([USER_ID]);
    expect(dispatched.some(
      ({ event }: { event: VerificationEvent }): boolean =>
        event.type === "terminalAttemptBudgetExhausted"
    )).toBeTrue();
  });
});
