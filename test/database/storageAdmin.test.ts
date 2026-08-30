import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeChatQaData } from "../../packages/database/codec/chatQa";
import {
  clearStorageBusinessTables,
  seedStorageDatabase,
} from "../../scripts/fixtures/storageDatabase";
import { readStoredChatQa } from "../../packages/database/interact/chatQa";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../packages/database/interact/connection";
import { initializeStorageDatabase } from
  "../../packages/database/interact/initialization";
import { createStorageDatabase } from
  "../../packages/database/interact/migration";
import type { StorageDatabase } from "../../packages/types/storageDatabase";

let temporaryRoot: string | null = null;

function createFixture(): StorageDatabase {
  temporaryRoot = mkdtempSync(join(tmpdir(), "copy-ninjia-storage-admin-test-"));
  const path: string = join(temporaryRoot, "storage.sqlite");
  createStorageDatabase(path);
  return openStorageDatabase({ path });
}

afterEach((): void => {
  if (temporaryRoot === null) return;
  rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

describe("共享数据库夹具辅助函数", () => {
  test("播种和清理覆盖全部业务表", () => {
    const database: StorageDatabase = createFixture();
    try {
      initializeStorageDatabase(database);
      seedStorageDatabase(database, {
        metadata: [],
        whitelist: [],
        blocklist: [],
        removals: [],
        chatQa: [{
          chatId: -1_001,
          q: "怎么入群？",
          data: encodeChatQaData("请阅读置顶消息。", "test:chat_qa.data"),
        }],
        temporaryWhitelist: [{
          id: 7,
          tempWhite: false,
          tempWhiteAt: null,
          tempWhiteCount: 0,
          sendCount: 1,
          countedAt: Date.now(),
          qualifiedAt: null,
        }],
      });
      expect(readStoredChatQa(database)).toHaveLength(1);

      clearStorageBusinessTables(database);

      const businessTables: readonly string[] = [
        "whitelist_entries",
        "blocklist_entries",
        "pending_blocked_removals",
        "chat_states",
        "chat_qa",
        "temporary_whitelist_entries",
      ];
      for (const table of businessTables) {
        const row: { readonly count: number } | null = database.$client
          .query<{ readonly count: number }, []>(
            `SELECT COUNT(*) AS count FROM ${table};`
          )
          .get();
        expect(row?.count).toBe(0);
      }
      const metadata: { readonly count: number } | null = database.$client
        .query<{ readonly count: number }, []>(
          "SELECT COUNT(*) AS count FROM storage_metadata;"
        )
        .get();
      expect(metadata?.count).toBe(1);
    } finally {
      closeStorageDatabase(database);
    }
  });
});
