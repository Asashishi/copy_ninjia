/**
 * Disk I/O Worker 路由层的共用夹具：把每个领域 owner 换成 mock，并接管
 * Worker 全局的 postMessage。协议分发用例只断言「哪条消息交给了哪个 owner」，
 * 不触碰真实落盘目录；导入本模块即注册 afterAll 还原与 beforeEach 复位。
 */

import { afterAll, beforeEach, mock } from "bun:test";
import type { DiskIOMessage } from "../../packages/types/diskIO/messages";

export const handleLogMessage = mock((_message: unknown): void => {});
export const handleAdSampleMessage = mock((_message: unknown): void => {});
export const handleAiCacheUsageMessage = mock(async (_message: unknown): Promise<void> => {});
export const flushAiCacheBuffer = mock(async (): Promise<boolean> => true);
export const inspectAiCacheFile = mock(async (): Promise<{ readonly kind: "aiCache" }> => ({ kind: "aiCache" }));
export const adoptAiCacheFile = mock((_inspection: unknown): void => {});
export const maintainAiCacheFile = mock(async (): Promise<void> => {});
export const summarizeAiCache = mock(async (_day?: string): Promise<void> => {});
export const markAiMemorySnapshotDirty = mock((_input: unknown): void => {});
export const deleteAiMemorySnapshot = mock((_chatId: number, _revision: number): void => {});
export const markStickerCatalogSnapshotDirty = mock((_pack: string, _snapshot: string): void => {});
export const handleLuckDrawMessage = mock((_message: unknown): void => {});
export const handleVerificationUpsert = mock((_input: unknown): void => {});
export const handleVerificationDelete = mock((_input: unknown): void => {});
export const handleJoinLogMessage = mock((_message: unknown): void => {});
export const handleJoinLogDeleteMessage = mock((_message: unknown): void => {});
export const purgeJoinLogDeletions = mock((): boolean => true);
export const inspectLogFiles = mock((): { readonly kind: "logs" } => ({ kind: "logs" }));
export const adoptLogFiles = mock((_inspection: unknown): void => {});
export const maintainLogFiles = mock(async (_inspection: unknown): Promise<void> => {});
export const maintainLogRetention = mock((): void => {});
export const adoptAiMemorySnapshots = mock((_inspection: unknown): Map<number, string> => new Map());
export interface StickerInspection {
  readonly kind: "stickers";
}
export const inspectStickerCatalogs = mock(async (
  _packs: readonly string[]
): Promise<StickerInspection> => ({ kind: "stickers" }));
export const adoptStickerCatalogSnapshots = mock((_inspection: unknown): Map<string, string> => new Map());
export const maintainStickerCatalogFiles = mock((_inspection: unknown): void => {});
export const inspectJoinLogFiles = mock((day: string): { readonly today: string } => ({ today: day }));
export const maintainJoinLogFiles = mock((_inspection: unknown): void => {});
export const maintainJoinLogRetention = mock((_day?: string): void => {});
export const readJoinLog = mock((_message: unknown): readonly {
  userId: number;
  joinedAt: number;
}[] => [{ userId: 42, joinedAt: 1_000 }]);
interface LuckSecretRecoveryInput {
  day: string;
  confirmedResultCount: number;
}
export const recoverLuckReceiptSecret = mock((input: LuckSecretRecoveryInput): {
  version: 1;
  day: string;
  key: string;
} => ({
  version: 1,
  day: input.day,
  key: "secret",
}));
export const luckWorkerCache: {
  current: { day: string; entries: Map<string, { label: string; fortunePercent: number }> } | null;
} = { current: null };
type HydratedLuckEntries = Map<string, { label: string; fortunePercent: number }>;
/** 用例往里塞当日运势条目；每个用例前换成新的空表。 */
export const hydratedLuckEntries: { current: HydratedLuckEntries } = { current: new Map() };
export const hydrateLuckDay = mock((day: string): void => {
  luckWorkerCache.current = { day, entries: new Map(hydratedLuckEntries.current) };
});
export const inspectLuckDay = mock((day: string): {
  readonly day: string;
  readonly cache: { readonly day: string; readonly entries: HydratedLuckEntries };
} => ({ day, cache: { day, entries: new Map(hydratedLuckEntries.current) } }));
export const adoptLuckDay = mock((inspection: {
  readonly cache: { day: string; entries: HydratedLuckEntries };
}): void => { luckWorkerCache.current = inspection.cache; });
export const maintainLuckDay = mock((_day: string, _inspection: unknown): void => {});
export const maintainLuckForDay = mock((_day: string): void => {});
export const inspectLuckReceiptSecret = mock((input: LuckSecretRecoveryInput): {
  readonly day: string;
  readonly path: string;
  readonly secret: null;
} => ({ day: input.day, path: "receipt-secret.json", secret: null }));
export const adoptLuckReceiptSecret = mock((inspection: { readonly day: string }): {
  version: 1;
  day: string;
  key: string;
} => ({ version: 1, day: inspection.day, key: "secret" }));
export const inspectVerificationDay = mock((day: string): { readonly day: string } => ({ day }));
export const adoptVerificationDay = mock((_inspection: unknown): Map<string, unknown> => new Map());
export const maintainVerificationDay = mock((_inspection: unknown): void => {});
export const flushLogBuffer = mock((): boolean => true);
export const flushAiMemorySnapshots = mock((): boolean => true);
export const flushStickerCatalogs = mock((): boolean => true);
export const flushLuckAppends = mock((): boolean => true);
const configureLuckAppendStalledReply = mock((_notify: (reply: unknown) => void): void => {});
export const flushVerificationChanges = mock((_reply: (reply: unknown) => void): boolean => true);
export const maintainVerificationDayForToday = mock((
  _reply: (reply: unknown) => void,
  _day?: string
): void => {});
export const maintainAdSampleFiles = mock((_today?: string): void => {});
export const maintainTemporaryAdBypassActivities = mock((_reply: unknown, _now?: number): void => {});
export const flushBlocklistRemovalOutbox = mock((): boolean => true);
export const pendingStorageDatabaseDomains = mock((): readonly ["blocklistRemovalOutbox"] => [
  "blocklistRemovalOutbox",
]);
export const flushJoinLogDomain = mock((): boolean => true);
export const handleBlocklistRemovalsMessage = mock((_message: unknown): void => {});
export const handleIdentityPolicyWrite = mock((_message: unknown): void => {});
export const setStorageFlushHold = mock((_active: boolean, _reply: unknown): void => {});
export const handleChatStateWrite = mock((_message: unknown): void => {});
export const handleChatQaWrite = mock((_message: unknown): void => {});
export const handleTemporaryAdBypassWrite = mock((_message: unknown): void => {});
export const postMessage = mock((_reply: unknown): void => {});
export const consoleError = mock((..._args: unknown[]): void => {});
interface HydratedStorageDatabase {
  readonly blocklistEntryCount: number;
  readonly permissionEntryCount: number;
  readonly pendingBlockedRemovals: Map<number, never>;
  readonly chatStates: Map<number, never>;
  readonly chatQa: Map<number, never>;
}
export const inspectStorageDatabase = mock((): { readonly kind: "storage" } => ({ kind: "storage" }));
export const adoptStorageDatabase = mock((_inspection: unknown): HydratedStorageDatabase => ({
  blocklistEntryCount: 0,
  permissionEntryCount: 0,
  pendingBlockedRemovals: new Map<number, never>(),
  chatStates: new Map<number, never>(),
  chatQa: new Map<number, never>(),
}));

mock.module("../../packages/workers/diskIO/logFiles", () => ({
  adoptLogFiles,
  flushLogBuffer,
  handleLogMessage,
  inspectLogFiles,
  maintainLogFiles,
  maintainLogRetention,
}));
mock.module("../../packages/workers/diskIO/luckFiles", () => ({
  adoptLuckDay,
  configureLuckAppendStalledReply,
  flushLuckAppends,
  handleLuckDrawMessage,
  hydrateLuckDay,
  maintainLuckForDay,
}));
mock.module("../../packages/workers/diskIO/luckSecretFile", () => ({
  adoptLuckReceiptSecret,
  inspectLuckReceiptSecret,
  recoverLuckReceiptSecret,
}));
mock.module("../../packages/cache/workers/diskIO/luck", () => ({ luckWorkerCache }));
mock.module("../../packages/workers/diskIO/verificationRecovery", () => ({
  adoptVerificationDay,
  inspectVerificationDay,
  maintainVerificationDay,
}));
mock.module("../../packages/workers/diskIO/verificationWrites", () => ({
  flushVerificationChanges,
  handleVerificationDelete,
  handleVerificationUpsert,
  maintainVerificationDayForToday,
}));
mock.module("../../packages/workers/diskIO/aiCacheFile", () => ({
  adoptAiCacheFile,
  flushAiCacheBuffer,
  handleAiCacheUsageMessage,
  inspectAiCacheFile,
  maintainAiCacheFile,
  summarizeAiCache,
}));
mock.module("../../packages/workers/diskIO/adSampleFile", () => ({
  handleAdSampleMessage,
  maintainAdSampleFiles,
}));
mock.module("../../packages/workers/diskIO/joinLogFiles", () => ({
  flushJoinLogDomain,
  handleJoinLogDeleteMessage,
  handleJoinLogMessage,
  purgeJoinLogDeletions,
  inspectJoinLogFiles,
  maintainJoinLogFiles,
  maintainJoinLogRetention,
  readJoinLog,
}));
mock.module("../../packages/workers/diskIO/aiMemoryStorage", () => ({
  adoptAiMemorySnapshots,
  configureAiMemoryDeletePersistedReply: (): void => {},
  configureAiMemoryPersistedReply: (): void => {},
  deleteAiMemorySnapshot,
  flushAiMemorySnapshots,

  markAiMemorySnapshotDirty,
}));
mock.module("../../packages/workers/diskIO/stickerCatalogFiles", () => ({
  adoptStickerCatalogSnapshots,
  flushStickerCatalogs,
  markStickerCatalogSnapshotDirty,
}));
mock.module("../../packages/workers/diskIO/snapshotFiles", () => ({
  inspectLuckDay,
  inspectStickerCatalogs,
  maintainLuckDay,
  maintainStickerCatalogFiles,
}));
mock.module("../../packages/workers/diskIO/storageDatabase", () => ({
  adoptStorageDatabase,
  configureStoragePersistenceReply: (): void => {},
  flushStorageDatabase: flushBlocklistRemovalOutbox,
  handleIdentityPolicyWrite,
  handleChatStateWrite,
  handleChatQaWrite,
  handleTemporaryAdBypassWrite,
  handlePendingRemovalSnapshot: handleBlocklistRemovalsMessage,
  inspectStorageDatabase,
  pendingStorageDatabaseDomains,
  maintainTemporaryAdBypassActivities,
  readBlocklistIdPage: (message: { requestId: number; afterId: number | null }): unknown => ({
    type: "blocklistIdPageRead",
    requestId: message.requestId,
    page: { ids: [], nextCursor: message.afterId, done: true },
  }),
  setStorageFlushHold,
  readIdentityPolicies: (message: { requestId: number }): unknown => ({
    type: "identityPoliciesRead",
    requestId: message.requestId,
    whitelist: [],
    blocklist: [],
    temporaryAdBypass: [],
  }),
}));
const workerGlobal = globalThis as typeof globalThis & { postMessage: (message: unknown) => void };
const originalPostMessage = workerGlobal.postMessage;
workerGlobal.postMessage = postMessage;
export const {
  handleDiskIOWorkerMessage,
  queueDiskIOWorkerMessage,
} = await import("../../packages/workers/diskIOWorker");
export const { diskIOMaintenanceCron } = await import(
  "../../packages/cache/workers/diskIO/maintenance"
);
const { stopDiskIOMaintenanceCron } = await import(
  "../../packages/workers/diskIO/maintenanceCron"
);
// 拒收标记走真实的 owner 缓存：路由层的兜底就是靠它把失败传给统一 flush。
export const { consumeJoinLogRejection } = await import("../../packages/cache/workers/diskIO/joinLog");
export const {
  rejectedStorageDomains,
} = await import("../../packages/cache/workers/diskIO/storageDatabase");
export const {
  diskIOOperationTail,
  resetDiskIOReplayWindow,
} = await import("../../packages/cache/workers/diskIO/recovery");

afterAll(() => {
  stopDiskIOMaintenanceCron();
  workerGlobal.postMessage = originalPostMessage;
});

beforeEach(() => {
  for (const fn of [
    handleLogMessage,
    handleAdSampleMessage,
    handleAiCacheUsageMessage,
    flushAiCacheBuffer,
    inspectAiCacheFile,
    adoptAiCacheFile,
    maintainAiCacheFile,
    summarizeAiCache,
    markAiMemorySnapshotDirty,
    deleteAiMemorySnapshot,
    markStickerCatalogSnapshotDirty,
    handleLuckDrawMessage,
    handleVerificationUpsert,
    handleVerificationDelete,
    handleJoinLogMessage,
    inspectLogFiles,
    adoptLogFiles,
    maintainLogFiles,
    maintainLogRetention,

    adoptAiMemorySnapshots,

    inspectStickerCatalogs,
    adoptStickerCatalogSnapshots,
    maintainStickerCatalogFiles,
    inspectJoinLogFiles,
    maintainJoinLogFiles,
    maintainJoinLogRetention,
    readJoinLog,
    flushLogBuffer,
    flushAiMemorySnapshots,
    flushStickerCatalogs,
    flushLuckAppends,
    flushVerificationChanges,
    maintainVerificationDayForToday,
    maintainAdSampleFiles,
    maintainTemporaryAdBypassActivities,
    flushBlocklistRemovalOutbox,
    pendingStorageDatabaseDomains,
    flushJoinLogDomain,
    handleBlocklistRemovalsMessage,
    handleIdentityPolicyWrite,
    handleChatStateWrite,
    handleChatQaWrite,
    handleTemporaryAdBypassWrite,
    postMessage,
    hydrateLuckDay,
    inspectLuckDay,
    adoptLuckDay,
    maintainLuckDay,
    maintainLuckForDay,
    inspectLuckReceiptSecret,
    adoptLuckReceiptSecret,
    inspectVerificationDay,
    adoptVerificationDay,
    maintainVerificationDay,
    consoleError,
    inspectStorageDatabase,
    adoptStorageDatabase,
  ]) fn.mockClear();
  // 重放窗口是 Worker 独占的模块级状态：某个用例遗留的 true 会让后面每一次
  // 写失败都误报成停机回执。
  resetDiskIOReplayWindow();
  diskIOOperationTail.current = Promise.resolve();
  luckWorkerCache.current = null;
  hydratedLuckEntries.current = new Map();
  recoverLuckReceiptSecret.mockReset();
  recoverLuckReceiptSecret.mockImplementation((input) => ({ version: 1, day: input.day, key: "secret" }));
  adoptStorageDatabase.mockImplementation((): HydratedStorageDatabase => ({
    blocklistEntryCount: 0,
    permissionEntryCount: 0,
    pendingBlockedRemovals: new Map<number, never>(),
    chatStates: new Map<number, never>(),
    chatQa: new Map<number, never>(),
  }));
  flushLogBuffer.mockReturnValue(true);
  flushAiMemorySnapshots.mockReturnValue(true);
  flushStickerCatalogs.mockReturnValue(true);
  flushLuckAppends.mockReturnValue(true);
  flushVerificationChanges.mockReturnValue(true);
  flushBlocklistRemovalOutbox.mockReturnValue(true);
  flushJoinLogDomain.mockReturnValue(true);
  readJoinLog.mockImplementation(() => [{ userId: 42, joinedAt: 1_000 }]);
});

/** 单条消息走一次真实路由。 */
export async function route(message: DiskIOMessage): Promise<void> {
  await handleDiskIOWorkerMessage(message);
}
