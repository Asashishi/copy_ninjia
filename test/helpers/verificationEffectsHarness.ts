import { installTemporaryMessageWorkerMock } from "./temporaryMessageWorkerMock";
installTemporaryMessageWorkerMock();
/**
 * 验证副作用解释器用例共用的替身、状态与隔离钩子：mock.module 装配、状态
 * 工厂与 beforeEach 复位。
 */

import { beforeEach, mock, spyOn } from "bun:test";
import { loggerStub } from "./loggerMock";
import { checkingInviterOf } from "../../packages/states/verification/shared";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { AntiRaidWorkerEvent } from "../../packages/types/antiRaid/events";
import type { VerificationAttemptPermitResult } from "../../packages/types/antiRaid/protocol";
import type {
  ExpelSnapshot,
  VerificationEffect,
  VerificationEvent,
  VerificationState,
  VerificationTransition,
} from "../../packages/types/states/verification";
import { transitionVerification } from "../../packages/states/verification";

/**
 * 副作用解释器里两条「踢人前先确认拉人者身份」的异步分支：管理员拉人豁免的
 * 异步核查（startAdminCheck）与超时踢人前的最终复核（recheckInviter）。两者都
 * 只在状态对象仍是同一引用时回投事件；身份未知不授权踢人，超时终核保留快照
 * 并沿终态执行预算退避。约束见 docs/cn/04-invariants.md。
 */

export const dispatched: { userId: number; event: VerificationEvent }[] = [];
export const kickedUserIds: number[] = [];
/** 每次踢人调用带上的 isSupergroup（undefined = 未观测到，走 unbanChatMember）。 */
export const kickChatKinds: (boolean | undefined)[] = [];
export const deletedMessageIds: number[] = [];
export const autoDeleted: { messageId: number; delayMs: number }[] = [];
export const sentTexts: string[] = [];
/** 验证按钮应答正文，随每个用例清空。 */
export const callbackTexts: string[] = [];
/** 与 sentTexts 同序：每次 sendMessage 带上的按钮行，没带就是 undefined。 */
export const sentKeyboards: (InlineKeyboardMarkup | undefined)[] = [];
export const warnings: string[] = [];
export const loggedErrors: string[] = [];
/**
 * 清理机器人验证消息时每次 deleteMessageWithOutcome 的结局，按调用顺序消费，
 * 用尽后回落到 "deleted"。取值为 "deleted" / "gone" / "failed"。
 */
export const traceDeleteOutcomes: string[] = [];
/**
 * 用例通过同一对象改写替身开关，满足跨文件共享可变测试状态的需要。
 */
export const testState: {
  /** sendMessage 的返回 id；undefined 表示发送失败。 */
  nextSentMessageId: number | undefined;
  /** 为 true 时 sendMessage 直接 reject，模拟 Worker→主线程请求本身失败。 */
  sendRejects: boolean;
  kickSucceeds: boolean;
  kickTargetAbsent: boolean;
  /** 模拟机器人是否具备删除验证消息的权限，可与踢人权限独立开关。 */
  deleteSucceeds: boolean;
  membershipPresent: boolean | undefined;
  fetchedChatType: "group" | "supergroup" | undefined;
  publishedChanges: number;
} = {
  nextSentMessageId: 900,
  sendRejects: false,
  kickSucceeds: true,
  kickTargetAbsent: false,
  deleteSucceeds: true,
  membershipPresent: true,
  fetchedChatType: "supergroup",
  publishedChanges: 0,
};

export const getChatAdministrators = mock(async (): Promise<{ user: { id: number }; is_anonymous: boolean }[]> => []);
export const probeChatMembership = mock(async (): Promise<boolean | undefined> => testState.membershipPresent);
export const getChat = mock(async (): Promise<{ type: "group" | "supergroup" }> => {
  if (testState.fetchedChatType === undefined) throw new Error("getChat unavailable");
  return { type: testState.fetchedChatType };
});
export const telegramApi = { getChat, getChatAdministrators };

Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage(_event: AntiRaidWorkerEvent): void {} },
});

mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({
    warn(message: string): void { warnings.push(message); },
    error(message: string): void { loggedErrors.push(message); },
  }),
}));
mock.module("../../packages/infra/telegram", () => ({
  telegramApi,
  sendMessage: async (
    message: { text: string; keyboard?: InlineKeyboardMarkup }
  ): Promise<number | undefined> => {
    if (testState.sendRejects) throw new Error("Main-thread capability request failed.");
    sentTexts.push(message.text);
    sentKeyboards.push(message.keyboard);
    return testState.nextSentMessageId;
  },
  deleteMessage: async (_chatId: number, messageId: number): Promise<boolean> => {
    deletedMessageIds.push(messageId);
    return testState.deleteSucceeds;
  },
  deleteMessageWithOutcome: async (_chatId: number, messageId: number): Promise<string> => {
    deletedMessageIds.push(messageId);
    return traceDeleteOutcomes.shift() ?? "deleted";
  },
  deleteMessageAfter(params: { messageId: number; delayMs: number }): void {
    autoDeleted.push({ messageId: params.messageId, delayMs: params.delayMs });
  },
  kickChatMember: async (params: { userId: number; isSupergroup?: boolean }): Promise<boolean> => {
    kickedUserIds.push(params.userId);
    kickChatKinds.push(params.isSupergroup);
    return testState.kickSucceeds;
  },
  kickChatMemberWithOutcome: async (
    params: { userId: number; isSupergroup?: boolean }
  ): Promise<"kicked" | "absent" | "failed"> => {
    kickedUserIds.push(params.userId);
    kickChatKinds.push(params.isSupergroup);
    if (testState.kickTargetAbsent) return "absent";
    return testState.kickSucceeds ? "kicked" : "failed";
  },
  probeChatMembership,
  answerCallbackQuery: async ({ text }: { text: string }): Promise<boolean> => { callbackTexts.push(text); return true; },
}));

/**
 * 被测模块与其缓存由各用例文件自行 `await import` 后注入；助手模块不自己 await import 依赖
 * 上面 mock.module 替身的模块。
 */
export interface VerificationEffectsDeps {
  readonly runVerificationEffects: (params: never) => Promise<void>;
  readonly verificationEntries: Map<string, { state: unknown; timer?: ReturnType<typeof setTimeout>; terminalRetries: number }>;
  readonly verificationRevisions: Map<string, { revision: number }>;
  readonly verificationGeneration: { current: number };
  readonly reminderDeliveries: Map<string, { timer?: ReturnType<typeof setTimeout> }>;
  readonly resetAdminCache: () => void;
  readonly resetWorkerBotPermissions: () => void;
  readonly resetWorkerChatKind: () => void;
}

const deps: { current: VerificationEffectsDeps | null } = { current: null };

function requireDeps(): VerificationEffectsDeps {
  if (deps.current === null) {
    throw new Error("installVerificationEffectsHooks must run before the harness helpers.");
  }
  return deps.current;
}

/**
 * 把 setTimeout 换成只记录延时的桩，返回带 unref 的假句柄。
 *
 * Worker 内的 timer 装完一律 unref（门禁见 scripts/conventions/workerTimers.ts），
 * 假句柄提供 `ReturnType<typeof setTimeout>` 所具备的 unref 方法。
 *
 * @param delays 承接每次排期延时的数组，按调用顺序追加。
 * @returns 还原 setTimeout 的函数，调用方在 finally 里执行。
 */
export function recordScheduledDelays(delays: number[]): () => void {
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
    ((_handler: () => void, delayMs?: number): ReturnType<typeof setTimeout> => {
      delays.push(delayMs ?? 0);
      const handle: { unref: () => unknown; ref: () => unknown } = {
        unref: (): unknown => handle,
        ref: (): unknown => handle,
      };
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as typeof globalThis.setTimeout
  );
  return (): void => { timeoutSpy.mockRestore(); };
}

export const CHAT_ID: number = -1001;
export const USER_ID: number = 42;
export const INVITER_ID: number = 77;
export const KEY: string = `${CHAT_ID}:${USER_ID}`;

export function pendingState(): VerificationState {
  return {
    kind: "pending",
    label: "待验证成员",
    isBot: false,
    announcementMessageId: undefined,
    trackedMessageTimes: [],
    invitedBy: INVITER_ID,
    reminderMessageId: undefined,
    replyReminderMessageId: undefined,
    replyReminderRequested: false,
    welcomeAnchorMessageId: undefined,
    reminderSuperseded: false,
    joinedAt: 1_000,
    expiresAt: 1_000 + 90_000,
  };
}

export function snapshot(overrides: Partial<ExpelSnapshot> = {}): ExpelSnapshot {
  return {
    label: "待验证成员",
    isBot: false,
    announcementMessageId: undefined,
    reminderMessageId: undefined,
    replyReminderMessageId: undefined,
    joinedAt: 1_000,
    expiresAt: 1_000 + 90_000,
    ...overrides,
  };
}

export function checkingInviterState(expelSnapshot: ExpelSnapshot): VerificationState {
  return checkingInviterOf(INVITER_ID, expelSnapshot);
}

export function kickPendingState(): VerificationState & { kind: "kickPending" } {
  return {
    kind: "kickPending",
    label: "待验证成员",
    isBot: false,
    requestedAt: 1_000,
    countedJoinAt: undefined,
    announcementMessageId: undefined,
    effectStarted: false,
    executionStarted: false,
  };
}

export function setState(state: VerificationState): VerificationState {
  requireDeps().verificationEntries.set(KEY, { state, timer: undefined, terminalRetries: 0 });
  return state;
}

export function run(
  effects: VerificationEffect[],
  permit: VerificationAttemptPermitResult = {
    status: "granted",
    attempt: 1,
  }
): Promise<void> {
  const injected: VerificationEffectsDeps = requireDeps();
  injected.verificationGeneration.current = 1;
  if (!injected.verificationRevisions.has(KEY)) {
    injected.verificationRevisions.set(KEY, { revision: 1 });
  }
  return injected.runVerificationEffects({
    chatId: CHAT_ID,
    userId: USER_ID,
    effects,
    dispatchVerification: (_chatId: number, userId: number, event: VerificationEvent): void => {
      if (!applyFlagEvent(event, (): void => { testState.publishedChanges++; })) dispatched.push({ userId, event });
    },
    requestTerminalAttempt: async (): Promise<VerificationAttemptPermitResult> => permit,
  } as never);
}

/**
 * 驱逐播报标记的两个事件（expelNoticeSent、removalConfirmed）按生产状态机真实转移当前条目，快照有变化时调用
 * onPublished（对应生产 dispatchVerification 发布新 revision）；它们不记入 dispatched。
 * @returns event 是否属于这两个事件。
 */
export function applyFlagEvent(event: VerificationEvent, onPublished: () => void): boolean {
  if (event.type !== "expelNoticeSent" && event.type !== "removalConfirmed") return false;
  const entry: { state: unknown } | undefined = requireDeps().verificationEntries.get(KEY);
  const { snapshotChanged = false }: VerificationTransition =
    transitionVerification(entry?.state as VerificationState | undefined, event);
  if (snapshotChanged) onPublished();
  return true;
}

/** 两个验证副作用用例文件共用的隔离钩子；每份都要登记一次。 */
export function installVerificationEffectsHooks(injected: VerificationEffectsDeps): void {
  deps.current = injected;
  beforeEach(() => {
    for (const entry of injected.verificationEntries.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
    }
    for (const delivery of injected.reminderDeliveries.values()) {
      if (delivery.timer !== undefined) clearTimeout(delivery.timer);
    }
    injected.verificationEntries.clear();
    injected.verificationRevisions.clear();
    injected.verificationGeneration.current = 0;
    injected.reminderDeliveries.clear();
    injected.resetAdminCache();
    injected.resetWorkerBotPermissions();
    injected.resetWorkerChatKind();
    dispatched.length = 0;
    kickedUserIds.length = 0;
    kickChatKinds.length = 0;
    deletedMessageIds.length = 0;
    autoDeleted.length = 0;
    sentTexts.length = 0;
    callbackTexts.length = 0;
    sentKeyboards.length = 0;
    warnings.length = 0;
    loggedErrors.length = 0;
    testState.nextSentMessageId = 900;
    testState.sendRejects = false;
    testState.kickSucceeds = true;
    testState.kickTargetAbsent = false;
    testState.deleteSucceeds = true;
    traceDeleteOutcomes.length = 0;
    testState.membershipPresent = true;
    testState.fetchedChatType = "supergroup";
    testState.publishedChanges = 0;
    probeChatMembership.mockClear();
    getChat.mockClear();
    getChatAdministrators.mockClear();
    getChatAdministrators.mockResolvedValue([]);
  });
}
