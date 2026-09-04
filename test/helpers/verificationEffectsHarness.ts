/**
 * 验证副作用解释器用例共用的替身、状态与隔离钩子。
 *
 * 单文件曾超过 1000 行（AGENTS.md 要求必须拆分）；这套 mock.module 装配、状态
 * 工厂与 beforeEach 复位两份用例都要用。
 */

import { beforeEach, mock, spyOn } from "bun:test";
import type { InlineKeyboardMarkup } from "grammy/types";
import type {
  AntiRaidWorkerEvent,
  VerificationAttemptPermitResult,
} from "../../packages/types";
import type {
  ExpelSnapshot,
  VerificationEffect,
  VerificationEvent,
  VerificationState,
} from "../../packages/types/states/verification";

/**
 * 副作用解释器里两条「踢人前先确认拉人者身份」的异步分支：管理员拉人豁免的
 * 异步核查（startAdminCheck）与超时踢人前的最终复核（recheckInviter）。两者都
 * 只在状态对象仍是同一引用时回投事件，核查失败按「非管理员」兜底而不是跳过
 * 处置——约束见 docs/cn/04-invariants.md。
 */

export const dispatched: { userId: number; event: VerificationEvent }[] = [];
export const kickedUserIds: number[] = [];
/** 每次踢人调用带上的 isSupergroup（undefined = 未观测到，走 unbanChatMember）。 */
export const kickChatKinds: (boolean | undefined)[] = [];
export const deletedMessageIds: number[] = [];
export const autoDeleted: { messageId: number; delayMs: number }[] = [];
export const sentTexts: string[] = [];
/** 与 sentTexts 同序：每次 sendMessage 带上的按钮行，没带就是 undefined。 */
export const sentKeyboards: (InlineKeyboardMarkup | undefined)[] = [];
export const warnings: string[] = [];
export const loggedErrors: string[] = [];
/** 机器人可以是「有 can_restrict_members、没有 can_delete_messages」的管理员。 */
/**
 * 清理机器人验证消息时每次 deleteMessageWithOutcome 的结局，按调用顺序消费，用尽后
 * 回落到 "deleted"。三态是有意义的：`gone`（已被别人手删）不该被
 * 折算成「删不动」，否则战报会冤枉一个权限齐全的管理员。
 */
export const traceDeleteOutcomes: string[] = [];
/**
 * 用例通过同一对象改写替身开关，满足跨文件共享可变测试状态的需要。
 */
export const testState: {
  /** sendMessage 的返回 id；undefined 表示发送失败。 */
  nextSentMessageId: number | undefined;
  kickSucceeds: boolean;
  kickTargetAbsent: boolean;
  /** 机器人可以是「有 can_restrict_members、没有 can_delete_messages」的管理员。 */
  deleteSucceeds: boolean;
  membershipPresent: boolean | undefined;
  fetchedChatType: "group" | "supergroup" | undefined;
  publishedChanges: number;
} = {
  nextSentMessageId: 900,
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
  logger: {
    log(): void {},
    info(): void {},
    warn(message: string): void { warnings.push(message); },
    error(message: string): void { loggedErrors.push(message); },
  },
}));
mock.module("../../packages/infra/telegram", () => ({
  telegramApi,
  sendMessage: async (
    message: { text: string; keyboard?: InlineKeyboardMarkup }
  ): Promise<number | undefined> => {
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
  answerCallbackQuery: async (): Promise<boolean> => true,
}));

/**
 * 被测模块与其缓存由各用例文件自行 `await import` 后注入。
 *
 * 助手模块不能自己 await import：这些模块都依赖上面 mock.module 装上的替身，
 * 而带顶层 await 的助手一旦被用例文件导入，Bun 会让它的导出停在 TDZ
 * （实测 `Cannot access 'x' before initialization`）。
 */
export interface VerificationEffectsDeps {
  readonly runVerificationEffects: (params: never) => Promise<void>;
  readonly verificationEntries: Map<string, { state: unknown; timer?: ReturnType<typeof setTimeout> }>;
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
 * 把 setTimeout 换成只记录延时的桩，返回**带 unref 的**假句柄。
 *
 * Worker 内的 timer 装完一律 unref（门禁见 scripts/conventions/workerTimers.ts）。
 * 桩既然宣称满足 `ReturnType<typeof setTimeout>`，就必须给出这个类型真正有的
 * 方法；只返回一个裸数字会让生产侧的 unref 那一行抛 TypeError。
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
    trackedMessageTimes: [],
    invitedBy: INVITER_ID,
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: 1_000,
    expiresAt: 1_000 + 90_000,
  };
}

export function snapshot(overrides: Partial<ExpelSnapshot> = {}): ExpelSnapshot {
  return {
    label: "待验证成员",
    isBot: false,
    joinedAt: 1_000,
    expiresAt: 1_000 + 90_000,
    ...overrides,
  };
}

export function checkingInviterState(expelSnapshot: ExpelSnapshot): VerificationState {
  return { kind: "checkingInviter", inviterId: INVITER_ID, snapshot: expelSnapshot };
}

export function kickPendingState(): VerificationState & { kind: "kickPending" } {
  return {
    kind: "kickPending",
    label: "待验证成员",
    isBot: false,
    requestedAt: 1_000,
    effectStarted: false,
    executionStarted: false,
  };
}

export function setState(state: VerificationState): VerificationState {
  requireDeps().verificationEntries.set(KEY, { state, timer: undefined });
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
      dispatched.push({ userId, event });
    },
    publishVerificationChange: (): void => {
      testState.publishedChanges++;
    },
    requestTerminalAttempt: async (): Promise<VerificationAttemptPermitResult> => permit,
  } as never);
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
    sentKeyboards.length = 0;
    warnings.length = 0;
    loggedErrors.length = 0;
    testState.nextSentMessageId = 900;
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
