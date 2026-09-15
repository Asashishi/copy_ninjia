import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import { openStorageDatabase } from "../../../packages/database/interact/connection";
import { chatStates } from "../../../packages/database/schema/chatState";
import { readStoredAiContexts } from "../../../packages/database/interact/aiContext";
import { readStoredChatStates } from "../../../packages/database/interact/chatState";
import { decodeStoredChatStates } from "../../../packages/database/validation/storageRows";
import { storageDatabaseHandle, resetStorageDatabaseCache } from "../../../packages/cache/workers/diskIO/storageDatabase";
import { resetAiMemoryCache, dirtyChats, deletedAiMemoryChats } from "../../../packages/cache/workers/diskIO/snapshots";
import { writeAiContext, deleteAiContext } from "../../../packages/workers/diskIO/storageDatabase/aiContext";
import { markAiMemorySnapshotDirty, deleteAiMemorySnapshot, flushAiMemorySnapshots, configureAiMemoryPersistedReply, configureAiMemoryDeletePersistedReply } from "../../../packages/workers/diskIO/aiMemoryStorage";
import { handleChatStateWrite } from "../../../packages/workers/diskIO/storageDatabase/chatState";
import { configureStoragePersistenceReply, flushStorageDatabase } from "../../../packages/workers/diskIO/storageDatabase/flush";
import type { StorageDatabase } from "../../../packages/types/storageDatabase";

let database: StorageDatabase;
const chatId: number = -1001;
const snapshot: string = JSON.stringify({ version: 1, buffer: [], summaries: ["对话摘要"], pendingSummary: null, savedAt: 1 });
beforeEach(() => {
  database = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  database.delete(chatStates).run();
  resetStorageDatabaseCache();
  resetAiMemoryCache();
  storageDatabaseHandle.current = database;
  database.insert(chatStates).values({ chatId, status: '{"isInitEnabled":true}', aiPersona: "群人设" }).run();
  configureStoragePersistenceReply((): void => {});
});
afterEach(() => {
  resetAiMemoryCache();
  resetStorageDatabaseCache();
  database.$client.close(true);
});

test("上下文只以 JSONB 保存，状态与人设互不覆盖", () => {
  writeAiContext(chatId, snapshot);
  const stored = database.$client.query("SELECT typeof(ai_context) AS kind, json(status) AS status, ai_persona AS persona FROM chat_states").get();
  expect(stored).toEqual({ kind: "blob", status: '{"isInitEnabled":true}', persona: "群人设" });
  handleChatStateWrite({ type: "chatStateWrite", chatId, data: '{"isInitEnabled":true,"isAIChatEnabled":true}', aiPersona: "新人设", revision: 1 }, (): void => {});
  expect(flushStorageDatabase((): void => {})).toBeTrue();
  expect(readStoredAiContexts(database, IDENTITY_DATABASE_PATH).get(chatId)).toBe(snapshot);
  expect(decodeStoredChatStates(readStoredChatStates(database), IDENTITY_DATABASE_PATH).get(chatId)?.aiPersona).toBe("新人设");
  deleteAiContext(chatId);
  expect(readStoredAiContexts(database, IDENTITY_DATABASE_PATH).size).toBe(0);
  expect(readStoredChatStates(database)[0]?.aiPersona).toBe("新人设");
});

test("新增群的在途状态先 durable，首份上下文不会丢失", () => {
  handleChatStateWrite({ type: "chatStateWrite", chatId: -1002, data: '{"isInitEnabled":true}', aiPersona: null, revision: 1 }, (): void => {});
  writeAiContext(-1002, snapshot);
  expect(readStoredAiContexts(database, IDENTITY_DATABASE_PATH).get(-1002)).toBe(snapshot);
});

test("建群事务失败时保留首份上下文且不回执，恢复后按状态到上下文的顺序重试", () => {
  const replies: unknown[] = [];
  configureAiMemoryPersistedReply((reply): void => { replies.push(reply); });
  const errors = spyOn(console, "error").mockImplementation((): void => {});
  const transaction = spyOn(database, "transaction").mockImplementationOnce((): never => {
    throw new Error("fixture transaction rejected");
  });
  try {
    handleChatStateWrite({ type: "chatStateWrite", chatId: -1002, data: '{"isInitEnabled":true}', aiPersona: "新群人设", revision: 1 }, (): void => {});
    markAiMemorySnapshotDirty({ chatId: -1002, snapshot, revision: 1, persistImmediately: true });
    expect(dirtyChats.has(-1002)).toBeTrue();
    expect(replies).toEqual([]);
    expect(readStoredChatStates(database).some((row): boolean => row.chatId === -1002)).toBeFalse();
    transaction.mockRestore();
    expect(flushAiMemorySnapshots()).toBeTrue();
    expect(readStoredAiContexts(database, IDENTITY_DATABASE_PATH).get(-1002)).toBe(snapshot);
    expect(readStoredChatStates(database).find((row): boolean => row.chatId === -1002)?.aiPersona).toBe("新群人设");
    expect(replies).toEqual([{ type: "aiMemoryPersisted", chatId: -1002, revision: 1 }]);
  } finally {
    transaction.mockRestore();
    errors.mockRestore();
  }
});

test("删除群状态同时删除上下文，人设和迟到快照都不复活群", () => {
  writeAiContext(chatId, snapshot);
  handleChatStateWrite({ type: "chatStateWrite", chatId, data: null, aiPersona: null, revision: 1 }, (): void => {});
  writeAiContext(chatId, snapshot);
  writeAiContext(-9999, snapshot);
  deleteAiContext(chatId);
  expect(readStoredChatStates(database)).toEqual([]);
  expect(readStoredAiContexts(database, IDENTITY_DATABASE_PATH).size).toBe(0);
});

test.each([
  { version: 2, buffer: [], summaries: [], pendingSummary: null, savedAt: 1 },
  { version: 1, buffer: [], summaries: [], pendingSummary: null, savedAt: -1 },
  { version: 1, buffer: [], summaries: [1], pendingSummary: null, savedAt: 1 },
])("启动严格拒绝非法上下文且保留原值 %#", (value) => {
  database.update(chatStates).set({ aiContext: JSON.stringify(value) }).where(eq(chatStates.chatId, chatId)).run();
  expect(() => readStoredAiContexts(database, IDENTITY_DATABASE_PATH)).toThrow("ai_context");
  expect(() => writeAiContext(chatId, JSON.stringify(value))).toThrow("ai_context");
});

test("写入失败保留 dirty，恢复后才发送 durable 回执", () => {
  const replies: unknown[] = [];
  configureAiMemoryPersistedReply((reply): void => { replies.push(reply); });
  const errors = spyOn(console, "error").mockImplementation((): void => {});
  try {
    storageDatabaseHandle.current = null;
    markAiMemorySnapshotDirty({ chatId, snapshot, revision: 1, persistImmediately: true });
    expect(dirtyChats.has(chatId)).toBeTrue();
    expect(replies).toEqual([]);
    storageDatabaseHandle.current = database;
    expect(flushAiMemorySnapshots()).toBeTrue();
    expect(replies).toEqual([{ type: "aiMemoryPersisted", chatId, revision: 1 }]);
    expect(readStoredAiContexts(database, IDENTITY_DATABASE_PATH).get(chatId)).toBe(snapshot);
  } finally { errors.mockRestore(); }
});

test("删除失败保留墓碑，重试只清除 ai_context", () => {
  writeAiContext(chatId, snapshot);
  const replies: unknown[] = [];
  configureAiMemoryDeletePersistedReply((reply): void => { replies.push(reply); });
  const errors = spyOn(console, "error").mockImplementation((): void => {});
  try {
    storageDatabaseHandle.current = null;
    deleteAiMemorySnapshot(chatId, 2);
    expect(deletedAiMemoryChats.has(chatId)).toBeTrue();
    expect(replies).toEqual([]);
    storageDatabaseHandle.current = database;
    expect(flushAiMemorySnapshots()).toBeTrue();
    expect(replies).toEqual([{ type: "aiMemoryDeletedPersisted", chatId, revision: 2 }]);
    expect(readStoredChatStates(database)[0]?.aiPersona).toBe("群人设");
  } finally { errors.mockRestore(); }
});
