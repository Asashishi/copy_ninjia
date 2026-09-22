/**
 * 落盘事务（database/interact/transaction.ts）在真实 SQLite 上的作用域：
 * 六张业务表的删除都必须只命中被点名的那一行，问答删除还要区分同一群里的
 * 其余问题。纯内存断言看不出 WHERE 写错，这里一律读回真实行验证。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import { encodeChatQaData } from "../../packages/database/codec/chatQa";
import { encodeChatStateData } from "../../packages/database/codec/chatState";
import {
  encodeBlocklistEntryData,
  encodePendingBlockedRemovalData,
  encodeWhitelistEntryData,
} from "../../packages/database/codec/identity";
import { readStoredChatQa } from "../../packages/database/interact/chatQa";
import { readStoredChatStateIds } from "../../packages/database/interact/chatState";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../packages/database/interact/connection";
import {
  readStoredBlocklistIdPage,
  readStoredIdentityPolicies,
} from "../../packages/database/interact/identityPolicy";
import { createStorageDatabase } from "../../packages/database/interact/migration";
import { readStorageDatabasePendingRemovalPage } from
  "../../packages/database/interact/inspection";
import { readStoredTemporaryAdBypassActivities } from
  "../../packages/database/interact/temporaryAdBypass";
import { commitStorageDatabaseChanges } from
  "../../packages/database/interact/transaction";
import type { CommitStorageDatabaseChangesOptions } from
  "../../packages/database/interact/transaction";
import type { StorageDatabase, StorageDatabaseChange } from
  "../../packages/types/storageDatabase";
import type { StoredTemporaryAdBypassActivity } from
  "../../packages/types/temporaryAdBypass";

const CHAT_ID: number = -1_001;
const OTHER_CHAT_ID: number = -1_002;
/** 每次提交都从「六张表都没有变更」出发，只铺开被点名的那一张。 */
const NO_CHANGES: CommitStorageDatabaseChangesOptions = {
  whitelist: new Map(), blocklist: new Map(), temporaryAdBypass: new Map(),
  removals: new Map(), chatStates: new Map(), chatQa: new Map(),
};

let temporaryRoot: string | null = null;
let database: StorageDatabase;

function bypassActivity(id: number): StoredTemporaryAdBypassActivity {
  return {
    id, adBypass: true, adBypassGrantedAt: 1_000,
    qualifiedDays: 1, sendCount: 8, countedAt: 3_000, qualifiedAt: 2_000,
  };
}

function qaChange(
  entries: readonly (readonly [number, string, string | null])[]
): ReadonlyMap<number, ReadonlyMap<string, StorageDatabaseChange>> {
  const byChat = new Map<number, Map<string, StorageDatabaseChange>>();
  for (const [chatId, question, answer] of entries) {
    let questions: Map<string, StorageDatabaseChange> | undefined = byChat.get(chatId);
    if (questions === undefined) {
      questions = new Map<string, StorageDatabaseChange>();
      byChat.set(chatId, questions);
    }
    questions.set(question, { data: answer === null ? null : encodeChatQaData(answer, "test:chat_qa.data") });
  }
  return byChat;
}

beforeEach((): void => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "copy-ninjia-storage-transaction-"));
  const path: string = join(temporaryRoot, "storage.sqlite");
  createStorageDatabase(path);
  database = openStorageDatabase({ path });
  commitStorageDatabaseChanges(database, {
    ...NO_CHANGES,
    whitelist: new Map([
      [7, { data: encodeWhitelistEntryData({ permissions: DEFAULT_WHITELIST_PERMISSIONS, meta: { firstName: "甲", lastName: "", username: "jia" } }) }],
      [8, { data: encodeWhitelistEntryData({ permissions: DEFAULT_WHITELIST_PERMISSIONS, meta: { firstName: "乙", lastName: "", username: "yi" } }) }],
    ]),
    blocklist: new Map([
      [11, { data: encodeBlocklistEntryData({ meta: { firstName: "丙", lastName: "", username: "bing" }, blockedAt: "2026/01/01 00:00:00" }) }],
      [12, { data: encodeBlocklistEntryData({ meta: { firstName: "丁", lastName: "", username: "ding" }, blockedAt: "2026/01/02 00:00:00" }) }],
    ]),
    temporaryAdBypass: new Map([
      [21, { activity: bypassActivity(21), revision: 1 }],
      [22, { activity: bypassActivity(22), revision: 1 }],
    ]),
    removals: new Map([
      [31, { data: encodePendingBlockedRemovalData({ params: { chatId: CHAT_ID, probeMembership: true, removalId: 31 }, createdAt: 1, attempts: 0, lastFailure: null }).text }],
      [32, { data: encodePendingBlockedRemovalData({ params: { chatId: CHAT_ID, probeMembership: true, removalId: 32 }, createdAt: 1, attempts: 0, lastFailure: null }).text }],
    ]),
    chatStates: new Map([
      [CHAT_ID, { data: encodeChatStateData({ isAIChatEnabled: true }), aiPersona: null }],
      [OTHER_CHAT_ID, { data: encodeChatStateData({ isAIChatEnabled: true }), aiPersona: null }],
    ]),
    chatQa: qaChange([
      [CHAT_ID, "怎么入群？", "看置顶"],
      [CHAT_ID, "怎么退群？", "点退出"],
      [OTHER_CHAT_ID, "怎么入群？", "别的群的答案"],
    ]),
  });
});

afterEach((): void => {
  closeStorageDatabase(database);
  if (temporaryRoot !== null) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

test("单题删除只命中 (群, 问题) 这一行", () => {
  commitStorageDatabaseChanges(database, {
    ...NO_CHANGES,
    chatQa: qaChange([[CHAT_ID, "怎么入群？", null]]),
  });

  expect(readStoredChatQa(database).map((row: { chatId: number; q: string }): string => `${row.chatId}:${row.q}`).sort())
    .toEqual([`${OTHER_CHAT_ID}:怎么入群？`, `${CHAT_ID}:怎么退群？`].sort());
});

test("同一批里既有删除又有写入时互不干扰", () => {
  commitStorageDatabaseChanges(database, {
    ...NO_CHANGES,
    chatQa: qaChange([
      [CHAT_ID, "怎么入群？", null],
      [CHAT_ID, "怎么退群？", "改过的答案"],
      [CHAT_ID, "新问题", "新答案"],
    ]),
  });

  const rows: readonly { chatId: number; q: string; data: string }[] = readStoredChatQa(database)
    .filter((row: { chatId: number }): boolean => row.chatId === CHAT_ID);
  expect(rows.map((row: { q: string }): string => row.q).sort()).toEqual(["怎么退群？", "新问题"].sort());
  expect(rows.find((row: { q: string }): boolean => row.q === "怎么退群？")?.data).toContain("改过的答案");
});

test("白名单删除只命中该 id，黑名单不受影响", () => {
  commitStorageDatabaseChanges(database, {
    ...NO_CHANGES,
    whitelist: new Map([[7, { data: null }]]),
  });

  expect(readStoredIdentityPolicies(database, "whitelist", [7, 8]).map((row: { id: number }): number => row.id)).toEqual([8]);
  expect(readStoredBlocklistIdPage(database, null, 10)).toEqual([11, 12]);
});

test("黑名单删除只命中该 id，白名单不受影响", () => {
  commitStorageDatabaseChanges(database, {
    ...NO_CHANGES,
    blocklist: new Map([[11, { data: null }]]),
  });

  expect(readStoredBlocklistIdPage(database, null, 10)).toEqual([12]);
  expect(readStoredIdentityPolicies(database, "whitelist", [7, 8]).map((row: { id: number }): number => row.id)).toEqual([7, 8]);
});

test("待踢 outbox、临时免检与群状态的删除各自只命中一行", () => {
  commitStorageDatabaseChanges(database, {
    ...NO_CHANGES,
    removals: new Map([[31, { data: null }]]),
    temporaryAdBypass: new Map([[21, { activity: null, revision: 2 }]]),
    chatStates: new Map([[CHAT_ID, { data: null, aiPersona: null }]]),
  });

  expect(readStorageDatabasePendingRemovalPage(database, null).map((row: { removalId: number }): number => row.removalId)).toEqual([32]);
  expect(readStoredTemporaryAdBypassActivities(database, [21, 22]).map((row: { id: number }): number => row.id)).toEqual([22]);
  expect(readStoredChatStateIds(database).map((row: { chatId: number }): number => row.chatId)).toEqual([OTHER_CHAT_ID]);
});
