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
const getChatAdministrators = mock(async (): Promise<{ user: { id: number }; is_anonymous: boolean }[]> => []);

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
  joinVerificationApi: { getChatAdministrators },
  sendMessage: async (message: { text: string }): Promise<number | undefined> => {
    sentTexts.push(message.text);
    return nextSentMessageId;
  },
  deleteMessage: async (_chatId: number, messageId: number): Promise<boolean> => {
    deletedMessageIds.push(messageId);
    return true;
  },
  deleteMessageAfter(params: { messageId: number; delayMs: number }): void {
    autoDeleted.push({ messageId: params.messageId, delayMs: params.delayMs });
  },
  kickChatMember: async (_chatId: number, userId: number): Promise<boolean> => {
    kickedUserIds.push(userId);
    return kickSucceeds;
  },
  answerCallbackQuery: async (): Promise<boolean> => true,
}));

const { runVerificationEffects } = await import("../../../packages/workers/antiRaid/verificationEffects");
const { verificationEntries } = await import("../../../packages/cache/antiRaid/verification");
const { cacheAdminIds, resetAdminCache } = await import("../../../packages/cache/antiRaid/admins");
const { WELCOME_AUTO_DELETE_MS } = await import("../../../packages/consts/antiRaid/verification");

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
    setState(pendingState());

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
      { kind: "logStaleKickedExemption", label: "Alice" },
    ]);

    expect(deletedMessageIds).toEqual([11, 12]);
    expect(kickedUserIds).toEqual([USER_ID]);
    expect(sentTexts[0]).toContain("Alice 通过验证啦");
    expect(autoDeleted).toEqual([{ messageId: 900, delayMs: WELCOME_AUTO_DELETE_MS }]);
    expect(warnings[0]).toContain("was already kicked");
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
});

describe("踢人失败时的权限告警", () => {
  function expellingState(): VerificationState & { kind: "expelling" } {
    return { kind: "expelling", reason: "timeout", snapshot: snapshot() };
  }

  test("告警发出去了才置位 failureNoticeSent", async () => {
    kickSucceeds = false;
    const state = expellingState();
    setState(state);

    await run([{ kind: "expel", snapshot: state.snapshot }]);

    expect(sentTexts[0]).toContain("没给本天才封禁权限");
    expect(state.failureNoticeSent).toBeTrue();
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
