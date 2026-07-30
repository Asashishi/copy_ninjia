import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AntiRaidWorkerEvent } from "../../../packages/types";
import type {
  ExpelSnapshot,
  VerificationEffect,
  VerificationEvent,
  VerificationState,
} from "../../../packages/types/states/verification";

/**
 * 副作用解释器里两条「踢人前先确认拉人者身份」的异步分支：管理员拉人豁免的
 * 异步核查（startAdminCheck）与超时踢人前的最终复核（recheckInviter）。两者都
 * 只在状态对象仍是同一引用时回投事件，核查失败按「非管理员」兜底而不是跳过
 * 处置——约束见 docs/04-invariants.md。
 */

const dispatched: { userId: number; event: VerificationEvent }[] = [];
const kickedUserIds: number[] = [];
const deletedMessageIds: number[] = [];
const autoDeleted: { messageId: number; delayMs: number }[] = [];
const sentTexts: string[] = [];
const warnings: string[] = [];
const loggedErrors: string[] = [];
let nextSentMessageId: number | undefined = 900;
let kickSucceeds: boolean = true;
/** 机器人可以是「有 can_restrict_members、没有 can_delete_messages」的管理员。 */
let deleteSucceeds: boolean = true;
/**
 * 清痕迹那条路上每次 deleteMessageWithOutcome 的结局，按调用顺序消费，用尽后
 * 回落到 "deleted"。三态是有意义的：`gone`（已被别人手删/超过 48 小时）不该被
 * 折算成「删不动」，否则战报会冤枉一个权限齐全的管理员。
 */
const traceDeleteOutcomes: string[] = [];
let membershipPresent: boolean | undefined = true;
const getChatAdministrators = mock(async (): Promise<{ user: { id: number }; is_anonymous: boolean }[]> => []);
const probeChatMembership = mock(async (): Promise<boolean | undefined> => membershipPresent);
const joinVerificationApi = { getChatAdministrators };

Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage(_event: AntiRaidWorkerEvent): void {} },
});

mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(message: string): void { warnings.push(message); },
    error(message: string): void { loggedErrors.push(message); },
  },
}));
mock.module("../../../packages/infra/telegram", () => ({
  joinVerificationApi,
  sendMessage: async (message: { text: string }): Promise<number | undefined> => {
    sentTexts.push(message.text);
    return nextSentMessageId;
  },
  deleteMessage: async (_chatId: number, messageId: number): Promise<boolean> => {
    deletedMessageIds.push(messageId);
    return deleteSucceeds;
  },
  deleteMessageWithOutcome: async (_chatId: number, messageId: number): Promise<string> => {
    deletedMessageIds.push(messageId);
    return traceDeleteOutcomes.shift() ?? "deleted";
  },
  deleteMessageAfter(params: { messageId: number; delayMs: number }): void {
    autoDeleted.push({ messageId: params.messageId, delayMs: params.delayMs });
  },
  kickChatMember: async (_chatId: number, userId: number): Promise<boolean> => {
    kickedUserIds.push(userId);
    return kickSucceeds;
  },
  kickChatMemberWithOutcome: async (
    _chatId: number,
    userId: number
  ): Promise<"kicked" | "failed"> => {
    kickedUserIds.push(userId);
    return kickSucceeds ? "kicked" : "failed";
  },
  probeChatMembership,
  answerCallbackQuery: async (): Promise<boolean> => true,
}));

const { runVerificationEffects } = await import("../../../packages/workers/antiRaid/verificationEffects");
const { verificationEntries } = await import("../../../packages/cache/workers/antiRaid/verification");
const { cacheAdminIds, resetAdminCache } = await import("../../../packages/cache/workers/antiRaid/admins");
const {
  VERIFICATION_TERMINAL_RETRY_MS,
  WELCOME_AUTO_DELETE_MS,
} = await import("../../../packages/consts/antiRaid/verification");
const {
  applyBotPermissionsChange,
  resetWorkerBotPermissions,
} = await import("../../../packages/workers/antiRaid/botPermissions");

const CHAT_ID: number = -1001;
const USER_ID: number = 42;
const INVITER_ID: number = 77;
const KEY: string = `${CHAT_ID}:${USER_ID}`;

function pendingState(): VerificationState {
  return {
    kind: "pending",
    label: "待验证成员",
    isBot: false,
    messageIds: [],
    trackedMessageTimes: [],
    invitedBy: INVITER_ID,
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: 1_000,
    expiresAt: 1_000 + 90_000,
  };
}

function snapshot(): ExpelSnapshot {
  return {
    label: "待验证成员",
    isBot: false,
    messageIds: [],
    joinedAt: 1_000,
    expiresAt: 1_000 + 90_000,
  };
}

function checkingInviterState(expelSnapshot: ExpelSnapshot): VerificationState {
  return { kind: "checkingInviter", inviterId: INVITER_ID, snapshot: expelSnapshot };
}

function kickPendingState(): VerificationState & { kind: "kickPending" } {
  return {
    kind: "kickPending",
    label: "待验证成员",
    isBot: false,
    requestedAt: 1_000,
  };
}

function setState(state: VerificationState): VerificationState {
  verificationEntries.set(KEY, { state, timer: undefined });
  return state;
}

function run(effects: VerificationEffect[]): Promise<void> {
  return runVerificationEffects({
    chatId: CHAT_ID,
    userId: USER_ID,
    effects,
    dispatchVerification: (_chatId: number, userId: number, event: VerificationEvent): void => {
      dispatched.push({ userId, event });
    },
    publishVerificationChange: (): void => {},
  });
}

beforeEach(() => {
  for (const entry of verificationEntries.values()) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
  }
  verificationEntries.clear();
  resetAdminCache();
  dispatched.length = 0;
  kickedUserIds.length = 0;
  deletedMessageIds.length = 0;
  autoDeleted.length = 0;
  sentTexts.length = 0;
  warnings.length = 0;
  loggedErrors.length = 0;
  nextSentMessageId = 900;
  kickSucceeds = true;
  deleteSucceeds = true;
  traceDeleteOutcomes.length = 0;
  membershipPresent = true;
  probeChatMembership.mockClear();
  getChatAdministrators.mockClear();
  getChatAdministrators.mockResolvedValue([]);
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
    nextSentMessageId = undefined;

    await run([
      { kind: "deleteReminders", reminderMessageId: 11 },
      { kind: "sendWelcome", variant: "channelComment", targetLabel: "杂鱼" },
    ]);

    expect(deletedMessageIds).toEqual([11]);
    expect(autoDeleted).toEqual([]);
  });

  test("私密模式踢人失败且成员仍在群时保留 KICK_PENDING 并退避重试", async () => {
    const delays: number[] = [];
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      ((...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> => {
        delays.push(args[1] ?? 0);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout
    );
    kickSucceeds = false;
    membershipPresent = true;
    const state = kickPendingState();
    setState(state);

    await run([{ kind: "kickMember" }]);

    expect(dispatched.some(({ event }) => event.type === "kickSettled")).toBeFalse();
    expect(verificationEntries.get(KEY)?.state).toBe(state);
    expect(state.executionStarted).toBeFalse();
    expect(verificationEntries.get(KEY)?.terminalRetries).toBe(1);
    expect(delays).toEqual([VERIFICATION_TERMINAL_RETRY_MS]);
    timeoutSpy.mockRestore();
  });

  test("私密模式踢人请求失败但成员已离群时允许结算", async () => {
    kickSucceeds = false;
    membershipPresent = false;
    setState(kickPendingState());

    await run([{ kind: "kickMember" }]);

    expect(dispatched).toContainEqual({
      userId: USER_ID,
      event: { type: "kickSettled", now: expect.any(Number) },
    });
  });

  test("私密模式失败后的成员探测期间 token 被替换时丢弃迟到结果", async () => {
    kickSucceeds = false;
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

describe("踢人失败时的权限告警", () => {
  function expellingState(): VerificationState & { kind: "expelling" } {
    return { kind: "expelling", reason: "timeout", snapshot: snapshot() };
  }

  test("终态踢人前现查成员；确认已离群就直接收尾且不发错误战报", async () => {
    membershipPresent = false;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(probeChatMembership).toHaveBeenCalledWith(CHAT_ID, USER_ID, joinVerificationApi);
    expect(kickedUserIds).toEqual([]);
    expect(sentTexts).toEqual([]);
    expect(dispatched).toContainEqual({ userId: USER_ID, event: { type: "expelSettled" } });
  });

  test("成员查询失败时不贸然踢人，保留终态进入既有退避重试", async () => {
    membershipPresent = undefined;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(kickedUserIds).toEqual([]);
    expect(sentTexts[0]).toContain("没能确认");
    expect(dispatched).not.toContainEqual({ userId: USER_ID, event: { type: "expelSettled" } });
    expect(verificationEntries.has(KEY)).toBeTrue();
    const timer: ReturnType<typeof setTimeout> | undefined = verificationEntries.get(KEY)?.timer;
    expect(timer).toBeDefined();
    if (timer !== undefined) clearTimeout(timer);
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
    kickSucceeds = false;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(sentTexts[0]).toContain("没给本天才封禁权限");
    expect(state.failureNoticeSent).toBeTrue();
  });

  test("回归用例：确证没有 can_delete_messages 时一条删除请求都不发——" +
    "它们与踢人共用同一条限流队列，几十个注定 400 的往返会把真正的踢人顶到验证窗口之后", async () => {
    // 主线程镜像过来的是「是管理员、能限制成员、不能删消息」这一档配置。
    applyBotPermissionsChange(CHAT_ID, { canRestrictMembers: true, canDeleteMessages: false });
    const state = expellingState();
    state.snapshot.messageIds = [21, 22];
    state.snapshot.announcementMessageId = 20;
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(deletedMessageIds).toEqual([]);
    expect(kickedUserIds).toEqual([USER_ID]);
    expect(sentTexts[0]).toContain("删不动");
    resetWorkerBotPermissions();
  });

  test("镜像里「没观测到」不当成没权限：照常发删除请求，由 Telegram 当裁判", async () => {
    // 主线程对「现查失败」（撞一次 429 就退避几分钟）发的也是「删掉条目」，
    // 把它折算成没权限，那几分钟里的痕迹就全留在群里了。
    const state = expellingState();
    state.snapshot.messageIds = [21];
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(deletedMessageIds).toEqual([21]);
  });

  test("回归用例：消息一条都删不掉时，成功战报不能再断言「痕迹清干净」——" +
    "群里还挂着的正是文案声称已经清掉的那批垃圾", async () => {
    // 有 can_restrict_members、没有 can_delete_messages 的管理员配置：人踢走了，
    // 入群公告和他拖延期间发的每条消息都还在。
    traceDeleteOutcomes.push("forbidden", "forbidden", "forbidden");
    const state = expellingState();
    // 这个人拖延期间发过消息，还有一条机器人自己发的入群公告：正是文案声称
    // 已经清掉的那批。删不掉时它们全都还挂在群里。
    state.snapshot.messageIds = [21, 22];
    state.snapshot.announcementMessageId = 20;
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(kickedUserIds).toEqual([USER_ID]);
    expect(sentTexts[0]).not.toContain("痕迹清干净");
    expect(sentTexts[0]).toContain("删不动");
    // 权限配错要留下可诊断的线索，否则运维永远查不到 can_delete_messages。
    expect(loggedErrors.some((line: string): boolean => line.includes("can_delete_messages"))).toBeTrue();
  });

  test("回归用例：消息早就不在了不算删不动——管理员比超时更快手删，不该被公开指责没给权限", async () => {
    // 「message to delete not found」与超过 48 小时的旧消息都收敛成 gone：那批
    // 消息确实不在群里了，痕迹就是清干净的。折算成失败的话，一个权限齐全的
    // 机器人会把管理员送去排查一个配置完全正确的 can_delete_messages。
    traceDeleteOutcomes.push("gone", "gone", "gone");
    const state = expellingState();
    state.snapshot.messageIds = [21, 22];
    state.snapshot.announcementMessageId = 20;
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(sentTexts[0]).toContain("痕迹清干净");
    expect(sentTexts[0]).not.toContain("删不动");
    expect(loggedErrors.some((line: string): boolean => line.includes("can_delete_messages"))).toBeFalse();
  });

  test("回归用例：几条里只失败一条时不说「一条都删不动」，非权限失败也不点管理员", async () => {
    // 一次瞬时网络错误：三条里删掉两条。旧实现是全有全无布尔，任一条失败即翻，
    // 文案照样声称一条都删不动，并把管理员送去查权限。
    traceDeleteOutcomes.push("deleted", "failed", "deleted");
    const state = expellingState();
    state.snapshot.messageIds = [21, 22];
    state.snapshot.announcementMessageId = 20;
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(sentTexts[0]).toContain("只有 1 条没清掉");
    expect(sentTexts[0]).not.toContain("删消息的权限");
    // 线索仍要留，但不能指向一个没被证伪的权限。
    expect(loggedErrors.some((line: string): boolean => line.includes("1 of 3"))).toBeTrue();
    expect(loggedErrors.some((line: string): boolean => line.includes("can_delete_messages"))).toBeFalse();
  });

  test("告警自己也没发出去时不置位：否则这条诊断永远不再尝试", async () => {
    // sendMessage 失败返回 undefined（错误被 infra/telegram/actions.ts 吞掉）。
    // 机器人同时被禁言、或 429 熬过了 autoRetry 时就是这个组合。照样置位的话，
    // 终态重试再跑 expelMember 时 shouldSendNotice 已是 false，「本天才没有封禁
    // 权限」这条唯一的诊断就永远不再尝试——未验证成员留在群里，管理员什么都
    // 不知道。
    kickSucceeds = false;
    nextSentMessageId = undefined;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(sentTexts).toHaveLength(1);
    expect(state.failureNoticeSent).toBeUndefined();
  });

  test("本来就已发过时保持不变，不重复打扰", async () => {
    kickSucceeds = false;
    const state = expellingState();
    state.failureNoticeSent = true;
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(sentTexts).toHaveLength(0);
    expect(state.failureNoticeSent).toBeTrue();
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
      kickSucceeds = false;
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
