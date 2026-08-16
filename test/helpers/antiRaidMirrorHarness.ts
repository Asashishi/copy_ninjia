/**
 * Anti-Raid 主线程镜像与恢复用例共用的替身、缓存句柄与隔离钩子。
 *
 * 单文件曾超过 1000 行（AGENTS.md 要求必须拆分）；这套 mock.module 装配、
 * drain 推进助手与 beforeEach 复位两份用例都要用。
 */

import { afterEach, beforeEach, mock } from "bun:test";
import type {
  AntiRaidWorkerEvent,
  AntiRaidWorkerMessage,
  DiskIORespawnListener,
  VerificationDeleteDiskMessage,
  VerificationPersistedReply,
  VerificationSnapshot,
  VerificationUpsertDiskMessage,
} from "../../packages/types";

export const workerPosts: AntiRaidWorkerMessage[] = [];
export const diskPosts: (VerificationUpsertDiskMessage | VerificationDeleteDiskMessage)[] = [];
/**
 * 三个替身在 mock 安装时被回填。原先是模块级 `let`；拆成多个用例文件之后
 * ESM 的只读导入绑定不允许跨文件读写，因此收成一个 holder。
 */
export const workerHooks: {
  supervisorOptions: {
    onEvent: (event: AntiRaidWorkerEvent) => void;
    onRespawn: (post: (message: AntiRaidWorkerMessage) => boolean) => void;
    onGiveUp: () => void;
  } | undefined;
  diskRespawn: DiskIORespawnListener | undefined;
  persistedAck: ((reply: VerificationPersistedReply) => void) | undefined;
} = { supervisorOptions: undefined, diskRespawn: undefined, persistedAck: undefined };
export const chatStates = new Map<number, {
  isAntiRaidEnabled?: boolean;
  lockdown?: {
    phase?: "applying" | "active" | "reconciling" | "restoring";
    intentId?: number;
    originalPermissions: Record<string, boolean | undefined>;
    announced: boolean;
    expiresAt: number;
  };
}>();
export const saveState = mock(async (): Promise<void> => {});
export const saveStateInBackground = mock((_context: string): void => {});
export type FlushResult = "flushed" | "timedOut" | "failed";
export const flushStateToDisk = mock(async (): Promise<FlushResult> => "flushed");
export const flushDiskIO = mock(async (): Promise<FlushResult> => "flushed");
export const restoreLockdownInvitePermission = mock(async (..._args: unknown[]): Promise<void> => {});

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

mock.module("../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../packages/infra/joinLog", () => ({
  recordJoinLog: async (): Promise<boolean> => true,
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  clearChatStateField: (chatId: number, field: "lockdown"): boolean => {
    const state = chatStates.get(chatId);
    if (!state || !(field in state)) return false;
    delete state[field];
    return true;
  },
  getChatStateCache: () => chatStates,
  // 入群守卫默认开着：本文件的用例全部考察守卫开启后的镜像与恢复语义，
  // 逐个用例再去建 chat state 只会淹没被测的东西。
  getChatState: (chatId: number) => ({ isAntiRaidEnabled: true, ...chatStates.get(chatId) }),
  getOrCreateChatState: (chatId: number) => {
    const current = chatStates.get(chatId) ?? {};
    chatStates.set(chatId, current);
    return current;
  },
  persistChatState: async (): Promise<void> => saveState(),
  flushStateToDisk,
  saveChatStateInBackground: (_chatId: number, context: string): void => { saveStateInBackground(context); },
}));
mock.module("../../packages/infra/telegram/actions", () => ({
  answerCallbackQuery: async (): Promise<boolean> => true,
  // 黑名单秒踢与新晋管理员清扫用的，本文件不触发（名单为空），但整份模块
  // 被替换掉时缺了它们会在 import 阶段就报 Export not found。
  banChatMember: async (): Promise<boolean> => true,
  banChatSenderChat: async (): Promise<boolean> => true,
  deleteMessageWithOutcome: async (): Promise<"deleted"> => "deleted",
  isChatMember: async (): Promise<boolean> => true,
  // 广告处置的群内播报用的，同理。
  sendMessage: async (): Promise<number | undefined> => undefined,
  deleteMessageAfter: (): void => {},
}));
mock.module("../../packages/infra/telegram/client", () => ({
  installTelegramApi: (): void => {},
  joinVerificationApi: { kind: "main-thread-test-api" },
}));
mock.module("../../packages/infra/telegram/lockdownPermissions", () => ({ restoreLockdownInvitePermission }));
// JOIN_WINDOW_MS 原样透出：秒踢路径的入群计数去重用它当窗口宽度
// （见 antiRaid/blocklistGuard.ts），整份模块被替换掉时缺了会在 import 阶段报错。
mock.module("../../packages/consts/antiRaid/lockdown", () => ({ RESTORE_RETRY_MS: 5, JOIN_WINDOW_MS: 60_000 }));
mock.module("../../packages/infra/botAdmin", () => ({
  resolveBotAdminStatus: async (): Promise<boolean> => true,
  markBotAdminObserved: async (): Promise<void> => {},
  botChatPermissionsIn: async (): Promise<undefined> => undefined,
  // 权限位镜像的注册与按需补齐；本文件不触发，但整份模块被替换掉时缺了
  // 会在 import 阶段就报 Export not found。
  registerBotPermissionObserver: (): void => {},
  ensureBotChatPermissions: (): void => {},
  botCanDeleteMessagesIn: (): undefined => undefined,
}));
mock.module("../../packages/infra/supervisedWorker", () => ({
  superviseWorker: (options: typeof workerHooks.supervisorOptions) => {
    workerHooks.supervisorOptions = options;
    return {
      init(): void {},
      post: (message: AntiRaidWorkerMessage): boolean => { workerPosts.push(message); return true; },
      terminate: async (): Promise<void> => {},
    };
  },
}));
mock.module("../../packages/infra/diskIO", () => ({
  flushDiskIO,
  flushDiskIODomain: async (): Promise<FlushResult> => "flushed",
  flushDiskIODomainOutcome: async (): Promise<{ result: FlushResult }> => ({ result: "flushed" }),
  postDiskIO: (message: VerificationUpsertDiskMessage | VerificationDeleteDiskMessage): void => { diskPosts.push(message); },
  postDiskIODiagnostic: (): boolean => true,
  onDiskIORespawn: (_owner: string, _priority: number, listener: DiskIORespawnListener): void => {
    workerHooks.diskRespawn = listener;
  },
  onIdentityStoragePersisted: (): void => {},
  onVerificationPersisted: (callback: (reply: VerificationPersistedReply) => void): void => { workerHooks.persistedAck = callback; },
}));

import {
  activeVerificationSnapshots,
  deferredVerificationRecords,
  pendingVerificationDeferrals,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
  terminalVerificationAttempts,
} from "../../packages/cache/main/antiRaid/verificationMirror";
import {
  inFlightAdDisposals,
} from "../../packages/cache/main/antiRaid/adDisposal";
import {
  recentBlockedJoinCounts,
} from "../../packages/cache/main/antiRaid/blocklistGuard";
import {
  emergencyLockdownRecoveries,
  emergencyLockdownRecoveryRuntime,
  pendingLockdownPersistence,
  persistedLockdownFingerprints,
  queuedLockdownPersistence,
} from "../../packages/cache/main/antiRaid/lockdownMirror";
import {
  antiRaidRuntimeState,
} from "../../packages/cache/main/antiRaid/proxy";
import {
  chatIsSupergroupById,
} from "../../packages/cache/main/antiRaid/chatKind";

export {
  activeVerificationSnapshots,
  deferredVerificationRecords,
  pendingVerificationDeferrals,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
  terminalVerificationAttempts,
} from "../../packages/cache/main/antiRaid/verificationMirror";
export { inFlightAdDisposals } from "../../packages/cache/main/antiRaid/adDisposal";
export { recentBlockedJoinCounts } from "../../packages/cache/main/antiRaid/blocklistGuard";
export {
  emergencyLockdownRecoveries,
  emergencyLockdownRecoveryRuntime,
  pendingLockdownPersistence,
  persistedLockdownFingerprints,
  queuedLockdownPersistence,
} from "../../packages/cache/main/antiRaid/lockdownMirror";
export { antiRaidRuntimeState } from "../../packages/cache/main/antiRaid/proxy";
export { chatIsSupergroupById } from "../../packages/cache/main/antiRaid/chatKind";

/**
 * 被测的 packages/antiRaid 由各用例文件自行 `await import` 后注入。
 *
 * 助手模块不能自己 await import 依赖替身的模块：Bun 会让它的导出停在 TDZ
 * （实测 `Cannot access 'x' before initialization`）。上面那些 cache/main/antiRaid
 * 纯状态模块不依赖任何替身，静态导入即可。
 */
export interface AntiRaidMirrorDeps {
  readonly initAntiRaid: () => void;
  readonly terminateAntiRaid: () => Promise<unknown>;
}

const deps: { current: AntiRaidMirrorDeps | null } = { current: null };

export async function resetAntiRaidTestState(): Promise<void> {
  await deps.current!.terminateAntiRaid();
  workerPosts.length = 0;
  diskPosts.length = 0;
  chatStates.clear();
  activeVerificationSnapshots.clear();
  deferredVerificationRecords.clear();
  pendingVerificationDeferrals.clear();
  pendingVerificationDeletes.clear();
  persistedVerificationRevisions.clear();
  terminalVerificationAttempts.clear();
  inFlightAdDisposals.clear();
  recentBlockedJoinCounts.clear();
  chatIsSupergroupById.clear();
  persistedLockdownFingerprints.clear();
  pendingLockdownPersistence.clear();
  queuedLockdownPersistence.clear();
  emergencyLockdownRecoveries.clear();
  emergencyLockdownRecoveryRuntime.stopped = true;
  antiRaidRuntimeState.generation = 0;
  antiRaidRuntimeState.initialized = false;
  antiRaidRuntimeState.persistenceVersion = 0;

  saveState.mockReset();
  saveState.mockImplementation(async (): Promise<void> => {});
  saveStateInBackground.mockReset();
  saveStateInBackground.mockImplementation((_context: string): void => {});
  flushStateToDisk.mockReset();
  flushStateToDisk.mockImplementation(async (): Promise<FlushResult> => "flushed");
  flushDiskIO.mockReset();
  flushDiskIO.mockImplementation(async (): Promise<FlushResult> => "flushed");
  restoreLockdownInvitePermission.mockReset();
  restoreLockdownInvitePermission.mockImplementation(async (..._args: unknown[]): Promise<void> => {});
}

/** 两个 Anti-Raid 镜像用例文件共用的隔离钩子；每份都要登记一次。 */
export function installAntiRaidMirrorHooks(injected: AntiRaidMirrorDeps): void {
  deps.current = injected;
  beforeEach(async () => {
    await resetAntiRaidTestState();
    deps.current!.initAntiRaid();
    workerPosts.length = 0;
    diskPosts.length = 0;
  });

  afterEach(async () => {
    await deps.current!.terminateAntiRaid();
  });
}

export function record(generation: number, revision: number): VerificationSnapshot {
  return {
    chatId: -1001,
    userId: 42,
    generation,
    revision,
    phase: "pending",
    label: "待验证成员",
    isBot: false,
    trackedMessageTimes: [],
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: 1_000,
    expiresAt: 121_000,
  };
}

export function terminalRecord(generation: number, revision: number): VerificationSnapshot {
  return {
    chatId: -1001,
    userId: 42,
    generation,
    revision,
    phase: "expelling",
    label: "待验证成员",
    isBot: false,
    trackedMessageTimes: [],
    replyReminderRequested: false,
    reminderSuperseded: true,
    joinedAt: 1_000,
    expiresAt: 121_000,
    expelReason: "timeout",
  };
}

export async function settleAntiRaidDrain(
  result: Promise<FlushResult>,
  firstBoundaryIndex: number,
  onDrain?: () => void
): Promise<FlushResult> {
  let cursor: number = firstBoundaryIndex;
  let settled: boolean = false;
  void result.finally((): void => { settled = true; });
  for (let turn: number = 0; turn < 20; turn++) {
    await Bun.sleep(0);
    while (cursor < workerPosts.length) {
      const message: AntiRaidWorkerMessage = workerPosts[cursor++]!;
      if (message.type === "barrier") {
        workerHooks.supervisorOptions!.onEvent({
          type: "barrierComplete",
          barrierId: message.barrierId,
        });
      } else if (message.type === "drain") {
        onDrain?.();
        workerHooks.supervisorOptions!.onEvent({
          type: "drainComplete",
          drainId: message.drainId,
        });
      }
    }
    if (settled) return result;
  }
  throw new Error("Anti-Raid drain test helper did not observe completion.");
}
