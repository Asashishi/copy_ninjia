import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import { openStorageDatabase } from "../../../packages/database/interact/connection";
import { chatStates } from "../../../packages/database/schema/chatState";
import { readStoredAiContexts } from "../../../packages/database/interact/aiContext";
import { readStoredChatStates } from "../../../packages/database/interact/chatState";
import { decodeStoredChatStates } from "../../../packages/database/validation/storageRows";
import {
  pendingAiContextWrites,
  resetStorageDatabaseCache,
  storageDatabaseHandle,
  storagePersistenceReplyHolder,
  storageWriteFlushTimer,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import {
  aiMemoryOperations,
  aiMemoryRevisions,
  aiMemoryDeletePersistedNotifier,
  aiMemoryPersistedNotifier,
  forgetAiMemoryChat,
  resetAiMemoryCache,
} from "../../../packages/cache/workers/diskIO/snapshots";
import {
  adoptAiMemorySnapshots,
  deleteAiMemorySnapshot,
  markAiMemorySnapshotDirty,
} from "../../../packages/workers/diskIO/aiMemoryStorage";
import { handleChatStateWrite } from "../../../packages/workers/diskIO/storageDatabase/chatState";
import {
  flushStorageDatabase,
  collectStorageDatabaseFailures,
  setStorageFlushHold,
} from "../../../packages/workers/diskIO/storageDatabase/flush";
import type { DiskIODomain } from "../../../packages/types/diskIO/replies";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
} from "../../../packages/types/diskIO";
import type { StorageDatabase } from "../../../packages/types/storageDatabase";

let database: StorageDatabase;
const chatId: number = -1001;
const snapshot: string = JSON.stringify({ version: 1, buffer: [], summaries: ["对话摘要"], pendingSummary: null, savedAt: 1 });
const persistedReplies: AiMemoryPersistedReply[] = [];
const deleteReplies: AiMemoryDeletedPersistedReply[] = [];
const noReply = (): void => {};

function storedContexts(): ReadonlyMap<number, string> {
  return readStoredAiContexts(database, IDENTITY_DATABASE_PATH);
}

beforeEach(() => {
  database = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  database.delete(chatStates).run();
  resetStorageDatabaseCache();
  resetAiMemoryCache();
  storageDatabaseHandle.current = database;
  database.insert(chatStates).values({ chatId, status: '{"isInitEnabled":true}', aiPersona: "群人设" }).run();
  storagePersistenceReplyHolder.current = noReply;
  persistedReplies.length = 0;
  deleteReplies.length = 0;
  aiMemoryPersistedNotifier.current = (reply: AiMemoryPersistedReply): void => { persistedReplies.push(reply); };
  aiMemoryDeletePersistedNotifier.current = (reply: AiMemoryDeletedPersistedReply): void => { deleteReplies.push(reply); };
});
afterEach(() => {
  resetAiMemoryCache();
  resetStorageDatabaseCache();
  database.$client.close(true);
});

test("快照先进共享事务缓冲并挂定时提交，提交时以 JSONB 写入且不覆盖状态与人设", () => {
  markAiMemorySnapshotDirty({ chatId, revision: 1, snapshot });
  expect(pendingAiContextWrites.get(chatId)).toEqual({ snapshot, revision: 1, coveredDeleteRevision: null });
  expect(storageWriteFlushTimer.current).not.toBeNull();
  expect(storedContexts().size).toBe(0);

  expect(flushStorageDatabase(noReply)).toBeTrue();
  expect(pendingAiContextWrites.size).toBe(0);
  const stored = database.$client.query("SELECT typeof(ai_context) AS kind, json(status) AS status, ai_persona AS persona FROM chat_states").get();
  expect(stored).toEqual({ kind: "blob", status: '{"isInitEnabled":true}', persona: "群人设" });
  // 普通快照不发即时回执。
  expect(persistedReplies).toEqual([]);

  handleChatStateWrite({ type: "chatStateWrite", chatId, data: '{"isInitEnabled":true,"isAIChatEnabled":true}', aiPersona: "新人设", revision: 1 }, noReply);
  expect(flushStorageDatabase(noReply)).toBeTrue();
  expect(storedContexts().get(chatId)).toBe(snapshot);
  expect(decodeStoredChatStates(readStoredChatStates(database), IDENTITY_DATABASE_PATH).get(chatId)?.aiPersona).toBe("新人设");
});

test("新增群的状态与首份上下文在同一事务里先建行再写上下文", () => {
  handleChatStateWrite({ type: "chatStateWrite", chatId: -1002, data: '{"isInitEnabled":true}', aiPersona: null, revision: 1 }, noReply);
  markAiMemorySnapshotDirty({ chatId: -1002, revision: 1, snapshot });
  expect(flushStorageDatabase(noReply)).toBeTrue();
  expect(storedContexts().get(-1002)).toBe(snapshot);
});

test("purge 后首份快照立即提交；事务失败时保留且不回执，重试成功后以最新 revision 回执", () => {
  const errors = spyOn(console, "error").mockImplementation((): void => {});
  const transaction = spyOn(database, "transaction").mockImplementationOnce((): never => {
    throw new Error("fixture transaction rejected");
  });
  try {
    markAiMemorySnapshotDirty({ chatId, revision: 1, snapshot, persistImmediately: true });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(persistedReplies).toEqual([]);
    expect(pendingAiContextWrites.get(chatId)?.revision).toBe(1);

    markAiMemorySnapshotDirty({ chatId, revision: 2, snapshot });
    transaction.mockRestore();
    expect(flushStorageDatabase(noReply)).toBeTrue();
    expect(storedContexts().get(chatId)).toBe(snapshot);
    expect(persistedReplies).toEqual([{ type: "aiMemoryPersisted", chatId, revision: 2 }]);
  } finally {
    transaction.mockRestore();
    errors.mockRestore();
  }
});

test("删除立即提交并回执，只清空上下文，人设保留", () => {
  markAiMemorySnapshotDirty({ chatId, revision: 1, snapshot });
  expect(flushStorageDatabase(noReply)).toBeTrue();

  deleteAiMemorySnapshot(chatId, 2);

  expect(storedContexts().size).toBe(0);
  expect(readStoredChatStates(database)[0]?.aiPersona).toBe("群人设");
  expect(deleteReplies).toEqual([{ type: "aiMemoryDeletedPersisted", chatId, revision: 2 }]);
  expect(pendingAiContextWrites.size).toBe(0);
});

test("迟到的旧 revision 删除只回执、不写库", () => {
  markAiMemorySnapshotDirty({ chatId, revision: 2, snapshot });
  expect(flushStorageDatabase(noReply)).toBeTrue();

  deleteAiMemorySnapshot(chatId, 1);

  expect(deleteReplies).toEqual([{ type: "aiMemoryDeletedPersisted", chatId, revision: 1 }]);
  expect(pendingAiContextWrites.size).toBe(0);
  expect(storedContexts().get(chatId)).toBe(snapshot);
});

test("同批删除的群不被迟到快照复活", () => {
  handleChatStateWrite({ type: "chatStateWrite", chatId, data: null, aiPersona: null, revision: 1 }, noReply);
  markAiMemorySnapshotDirty({ chatId, revision: 1, snapshot });
  markAiMemorySnapshotDirty({ chatId: -9999, revision: 1, snapshot });
  expect(flushStorageDatabase(noReply)).toBeTrue();
  expect(readStoredChatStates(database)).toEqual([]);
  expect(storedContexts().size).toBe(0);
});

test("非法快照就地拒收：不进共享缓冲，记 aiMemory 拒收标记供下一次领域屏障回报", () => {
  const errors = spyOn(console, "error").mockImplementation((): void => {});
  try {
    markAiMemorySnapshotDirty({ chatId, revision: 1, snapshot: JSON.stringify({ version: 2 }) });
  } finally {
    errors.mockRestore();
  }
  expect(pendingAiContextWrites.size).toBe(0);
  // 非法快照不推进水位线：同一 revision 的合法快照随后仍被接受。
  expect(aiMemoryRevisions.has(chatId)).toBeFalse();
  const failedDomains: DiskIODomain[] = [];
  collectStorageDatabaseFailures("aiMemory", failedDomains);
  collectStorageDatabaseFailures("aiMemory", failedDomains);
  expect(failedDomains).toEqual(["aiMemory"]);
  markAiMemorySnapshotDirty({ chatId, revision: 1, snapshot });
  expect(pendingAiContextWrites.get(chatId)?.revision).toBe(1);
});

test("重放区间内未提交的删除被新快照覆盖时，提交后仍回执那次删除", () => {
  markAiMemorySnapshotDirty({ chatId, revision: 1, snapshot });
  expect(flushStorageDatabase(noReply)).toBeTrue();

  setStorageFlushHold(true, noReply);
  deleteAiMemorySnapshot(chatId, 2);
  markAiMemorySnapshotDirty({ chatId, revision: 3, snapshot, persistImmediately: true });
  expect(pendingAiContextWrites.get(chatId)).toEqual({ snapshot, revision: 3, coveredDeleteRevision: 2 });
  expect(deleteReplies).toEqual([]);

  setStorageFlushHold(false, noReply);
  expect(deleteReplies).toEqual([{ type: "aiMemoryDeletedPersisted", chatId, revision: 2 }]);
  expect(persistedReplies).toEqual([{ type: "aiMemoryPersisted", chatId, revision: 3 }]);
  expect(storedContexts().get(chatId)).toBe(snapshot);
});

test("事务失败后的退避期内，删除与即时快照只排队，不额外消耗连续失败预算", () => {
  const errors = spyOn(console, "error").mockImplementation((): void => {});
  const transaction = spyOn(database, "transaction").mockImplementationOnce((): never => {
    throw new Error("fixture transaction rejected");
  });
  try {
    markAiMemorySnapshotDirty({ chatId, revision: 1, snapshot });
    expect(flushStorageDatabase(noReply)).toBeFalse();
    expect(transaction).toHaveBeenCalledTimes(1);

    deleteAiMemorySnapshot(chatId, 2);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deleteReplies).toEqual([]);

    transaction.mockRestore();
    expect(flushStorageDatabase(noReply)).toBeTrue();
    expect(deleteReplies).toEqual([{ type: "aiMemoryDeletedPersisted", chatId, revision: 2 }]);
    expect(storedContexts().size).toBe(0);
  } finally {
    transaction.mockRestore();
    errors.mockRestore();
  }
});

test("镜像重放区间内的删除只排队，关区间时立即提交并回执", () => {
  markAiMemorySnapshotDirty({ chatId, revision: 1, snapshot });
  expect(flushStorageDatabase(noReply)).toBeTrue();

  setStorageFlushHold(true, noReply);
  deleteAiMemorySnapshot(chatId, 2);
  expect(storedContexts().get(chatId)).toBe(snapshot);
  expect(deleteReplies).toEqual([]);

  setStorageFlushHold(false, noReply);
  expect(storedContexts().size).toBe(0);
  expect(deleteReplies).toEqual([{ type: "aiMemoryDeletedPersisted", chatId, revision: 2 }]);
});

test("启动 adopt 按磁盘快照重建水位线并交出恢复结果", () => {
  const recovered: Map<number, string> = adoptAiMemorySnapshots(new Map([[chatId, snapshot]]));
  expect(recovered).toEqual(new Map([[chatId, snapshot]]));
  expect(aiMemoryRevisions.get(chatId)).toBe(0);
  expect(aiMemoryOperations.get(chatId)).toBe("upsert");
});

test("回归：teardown 后 forgetAiMemoryChat 让重新启用的 revision 1 不再被当成迟到消息", () => {
  for (let revision: number = 1; revision <= 13; revision++) {
    markAiMemorySnapshotDirty({ chatId, revision, snapshot });
  }
  deleteAiMemorySnapshot(chatId, 14);
  expect(aiMemoryRevisions.get(chatId)).toBe(14);

  // 主线程 teardown 把自己的计数器归零，Worker 侧必须同一时刻丢掉水位线。
  forgetAiMemoryChat(chatId);
  expect(aiMemoryRevisions.has(chatId)).toBeFalse();

  markAiMemorySnapshotDirty({ chatId, revision: 1, snapshot });
  expect(pendingAiContextWrites.get(chatId)).toEqual({ snapshot, revision: 1, coveredDeleteRevision: null });
});

test.each([
  { version: 2, buffer: [], summaries: [], pendingSummary: null, savedAt: 1 },
  { version: 1, buffer: [], summaries: [], pendingSummary: null, savedAt: -1 },
  { version: 1, buffer: [], summaries: [1], pendingSummary: null, savedAt: 1 },
])("启动严格拒绝非法上下文且保留原值 %#", (value) => {
  database.update(chatStates).set({ aiContext: JSON.stringify(value) }).where(eq(chatStates.chatId, chatId)).run();
  expect(() => readStoredAiContexts(database, IDENTITY_DATABASE_PATH)).toThrow("ai_context");
});
