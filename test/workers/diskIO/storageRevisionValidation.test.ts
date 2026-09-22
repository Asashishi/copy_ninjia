import { beforeEach, describe, expect, test } from "bun:test";
import { clearStorageBusinessTables } from
  "../../../scripts/fixtures/storageDatabase";
import { resetStorageDatabaseCache } from
  "../../../packages/cache/workers/diskIO/storageDatabase";
import { hydrateStorageDatabase } from "../../helpers/storageDatabaseHydration";
import { handleChatQaWrite } from
  "../../../packages/workers/diskIO/storageDatabase/chatQa";
import { handleChatStateWrite } from
  "../../../packages/workers/diskIO/storageDatabase/chatState";
import { handleIdentityPolicyWrite } from
  "../../../packages/workers/diskIO/storageDatabase/identityPolicy";
import { handleTemporaryAdBypassWrite } from
  "../../../packages/workers/diskIO/storageDatabase/temporaryAdBypass";
import { requireStorageDatabase, storageSource } from
  "../../../packages/workers/diskIO/storageDatabase/context";

const INVALID_REVISIONS: readonly number[] = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2];
const noReply: () => void = (): void => {};

beforeEach((): void => {
  resetStorageDatabaseCache();
  hydrateStorageDatabase();
  clearStorageBusinessTables(requireStorageDatabase());
});

describe("Disk I/O Worker 写消息的 revision 闸", () => {
  test("四个身份 SQLite 领域都以行来源路径拒绝非正安全整数 revision", () => {
    for (const revision of INVALID_REVISIONS) {
      expect(() => handleChatStateWrite({
        type: "chatStateWrite", chatId: -1001, aiPersona: null, data: null, revision,
      }, noReply)).toThrow(`${storageSource("chat_states", -1001)}: revision must be a positive safe integer.`);
      expect(() => handleChatQaWrite({
        type: "chatQaWrite", chatId: -1001, q: "怎么入群？", data: null, revision,
      }, noReply)).toThrow(`${storageSource("chat_qa", -1001)}: revision must be a positive safe integer.`);
      expect(() => handleIdentityPolicyWrite({
        type: "identityPolicyWrite", table: "whitelist", id: 7, data: null, revision,
      }, noReply)).toThrow(`${storageSource("whitelist_entries", 7)}: revision must be a positive safe integer.`);
      expect(() => handleTemporaryAdBypassWrite({
        type: "temporaryAdBypassWrite", id: 7, activity: null, revision,
      }, noReply)).toThrow(`${storageSource("temporary_ad_bypass_entries", 7)}: revision must be a positive safe integer.`);
    }
  });
});
