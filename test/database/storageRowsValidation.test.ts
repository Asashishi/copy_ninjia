import { describe, expect, test } from "bun:test";
import { IDENTITY_DATABASE_SCHEMA_KEY, IDENTITY_DATABASE_SCHEMA_VERSION } from
  "../../packages/consts/identityStorage";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import {
  encodeBlocklistEntryData,
  encodeWhitelistEntryData,
} from "../../packages/database/codec/identity";
import { encodeChatStateData } from "../../packages/database/codec/chatState";
import {
  assertPendingRemovalBlocklistReferences,
  decodeStoredChatStates,
  readStorageSchemaVersion,
  validateStoredIdentityPolicies,
} from "../../packages/database/validation/storageRows";
import type { PendingBlockedRemoval } from "../../packages/types/blocklist";
import type { ChatState } from "../../packages/types/chatState";
import type {
  StorageDatabaseBaseRows,
  StoredChatStateRow,
  StoredStorageMetadataRow,
} from "../../packages/types/storageDatabase";

/**
 * 共享 SQLite 业务行的**启动期严格校验**。
 *
 * 这四个导出此前一条用例都没有（`storageRows.test.ts` 只测了 outbox 解码），
 * 而它们正是 `AGENTS.md`「不为用户行为兜底」要求 fail closed 的那一层：手工改库、
 * 从别处恢复的备份、跨表写歪的名单，都得在建立外部连接之前以非零码停住，而不是
 * 静默丢条目继续跑。每条拒绝路径都要有用例证明它真的抛，否则「校验存在」只是
 * 代码读起来像有。
 *
 * 错误文案也一起钉住：必须写明来源路径与字段路径，且**不得回显行内容**。
 */

const SOURCE: string = "database/storage.sqlite";
const CHAT_ID: number = -1_001;

function metadataRows(data: string): Pick<StorageDatabaseBaseRows, "metadata"> {
  const metadata: readonly StoredStorageMetadataRow[] = [
    { key: IDENTITY_DATABASE_SCHEMA_KEY, data },
  ];
  return { metadata };
}

function identityMeta(): { firstName: string; lastName: string; username: string } {
  return { firstName: "Test", lastName: "", username: "test" };
}

function whitelistData(): string {
  return encodeWhitelistEntryData({
    permissions: DEFAULT_WHITELIST_PERMISSIONS,
    meta: identityMeta(),
  });
}

function blocklistData(): string {
  return encodeBlocklistEntryData({
    blockedAt: "2026/08/23 12:00:00",
    meta: identityMeta(),
  });
}

function baseRows(
  whitelistIds: readonly number[],
  blocklistIds: readonly number[]
): StorageDatabaseBaseRows {
  return {
    whitelist: whitelistIds.map((id: number) => ({ id, data: whitelistData() })),
    blocklist: blocklistIds.map((id: number) => ({ id, data: blocklistData() })),
    removals: [],
    metadata: [{
      key: IDENTITY_DATABASE_SCHEMA_KEY,
      data: JSON.stringify({ version: IDENTITY_DATABASE_SCHEMA_VERSION }),
    }],
  };
}

function chatStateRow(chatId: number, state: Readonly<ChatState>): StoredChatStateRow {
  return { chatId, data: encodeChatStateData(state) };
}

function sweepRemoval(removalId: number): PendingBlockedRemoval {
  return {
    params: { chatId: CHAT_ID, probeMembership: true, removalId },
    createdAt: 1_000,
    attempts: 0,
    lastFailure: null,
  };
}

function frozenRemoval(removalId: number, userIds: number[]): PendingBlockedRemoval {
  return {
    params: { chatId: CHAT_ID, probeMembership: false, userIds, removalId },
    createdAt: 1_000,
    attempts: 0,
    lastFailure: null,
  };
}

describe("schema 版本行", () => {
  test("唯一合法行返回版本号", () => {
    expect(readStorageSchemaVersion(
      metadataRows(JSON.stringify({ version: IDENTITY_DATABASE_SCHEMA_VERSION })),
      SOURCE
    )).toBe(IDENTITY_DATABASE_SCHEMA_VERSION);
  });

  test("元数据不是恰好一行时拒绝", () => {
    expect(() => readStorageSchemaVersion({ metadata: [] }, SOURCE))
      .toThrow(/exactly one schema-version row/);
    expect(() => readStorageSchemaVersion({
      metadata: [
        { key: IDENTITY_DATABASE_SCHEMA_KEY, data: JSON.stringify({ version: 5 }) },
        { key: IDENTITY_DATABASE_SCHEMA_KEY, data: JSON.stringify({ version: 5 }) },
      ],
    }, SOURCE)).toThrow(/exactly one schema-version row/);
  });

  test("键名不对时拒绝，不去猜它想表达哪一行", () => {
    expect(() => readStorageSchemaVersion({
      metadata: [{ key: "schema", data: JSON.stringify({ version: 5 }) }],
    }, SOURCE)).toThrow(/exactly one schema-version row/);
  });

  test("多余键、缺键或非安全整数版本一律拒绝", () => {
    expect(() => readStorageSchemaVersion(
      metadataRows(JSON.stringify({ version: 5, extra: 1 })),
      SOURCE
    )).toThrow(/one safe integer version/);
    expect(() => readStorageSchemaVersion(metadataRows(JSON.stringify({})), SOURCE))
      .toThrow(/one safe integer version/);
    expect(() => readStorageSchemaVersion(
      metadataRows(JSON.stringify({ version: 1.5 })),
      SOURCE
    )).toThrow(/one safe integer version/);
    expect(() => readStorageSchemaVersion(
      metadataRows(JSON.stringify({ version: "5" })),
      SOURCE
    )).toThrow(/one safe integer version/);
  });

  test("拒绝文案带来源与字段路径，且不回显行内容", () => {
    const secret: string = "s3cret-value";
    let message: string = "";
    try {
      readStorageSchemaVersion(metadataRows(JSON.stringify({ version: secret })), SOURCE);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(SOURCE);
    expect(message).not.toContain(secret);
  });
});

describe("黑白名单严格解码", () => {
  test("合法两表返回各自主键集合", () => {
    const validated = validateStoredIdentityPolicies(baseRows([11, 12], [21]), SOURCE);
    expect([...validated.whitelistIds]).toEqual([11, 12]);
    expect([...validated.blocklistIds]).toEqual([21]);
  });

  test("同一身份同时出现在两表时拒绝启动", () => {
    expect(() => validateStoredIdentityPolicies(baseRows([11], [11]), SOURCE))
      .toThrow(/exists in both whitelist_entries and blocklist_entries/);
  });

  test("主键不是合法 Telegram 身份 id 时拒绝", () => {
    const rows: StorageDatabaseBaseRows = baseRows([], []);
    expect(() => validateStoredIdentityPolicies({
      ...rows,
      whitelist: [{ id: 0, data: whitelistData() }],
    }, SOURCE)).toThrow();
  });

  test("data 列不是当前格式时拒绝，不丢弃该条继续跑", () => {
    const rows: StorageDatabaseBaseRows = baseRows([], []);
    expect(() => validateStoredIdentityPolicies({
      ...rows,
      blocklist: [{ id: 21, data: JSON.stringify({ blockedAt: "2026/08/23 12:00:00" }) }],
    }, SOURCE)).toThrow();
  });
});

describe("待踢 outbox 的跨表引用", () => {
  test("补扫批次要求黑名单至少有一条", () => {
    const removals: ReadonlyMap<number, PendingBlockedRemoval> =
      new Map([[1, sweepRemoval(1)]]);
    expect(() => assertPendingRemovalBlocklistReferences(removals, new Set(), SOURCE))
      .toThrow(/sweep requires at least one blocklist entry/);
    expect(() => assertPendingRemovalBlocklistReferences(removals, new Set([21]), SOURCE))
      .not.toThrow();
  });

  test("冻结名单里的 id 必须都还在黑名单里", () => {
    const removals: ReadonlyMap<number, PendingBlockedRemoval> =
      new Map([[2, frozenRemoval(2, [21, 22])]]);
    expect(() => assertPendingRemovalBlocklistReferences(
      removals,
      new Set([21]),
      SOURCE
    )).toThrow(/frozen userIds must all exist in blocklist_entries/);
    expect(() => assertPendingRemovalBlocklistReferences(
      removals,
      new Set([21, 22]),
      SOURCE
    )).not.toThrow();
  });

  test("拒绝文案定位到具体那一行的字段路径", () => {
    let message: string = "";
    try {
      assertPendingRemovalBlocklistReferences(
        new Map([[7, frozenRemoval(7, [99])]]),
        new Set([21]),
        SOURCE
      );
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`${SOURCE}:pending_blocked_removals[7].data`);
  });
});

describe("群状态严格解码", () => {
  test("合法行按群 id 解出状态", () => {
    const states: Map<number, ChatState> = decodeStoredChatStates(
      [chatStateRow(CHAT_ID, { isInitEnabled: true })],
      SOURCE
    );
    expect(states.get(CHAT_ID)?.isInitEnabled).toBe(true);
  });

  test("超过 25 群硬顶时拒绝启动，并点名要先删掉不再管的群", () => {
    const rows: StoredChatStateRow[] = Array.from(
      { length: STATE_MANAGED_CHAT_LIMIT + 1 },
      (_value: unknown, index: number): StoredChatStateRow =>
        chatStateRow(-1_000 - index, { isInitEnabled: true })
    );
    expect(() => decodeStoredChatStates(rows, SOURCE))
      .toThrow(new RegExp(`at most ${STATE_MANAGED_CHAT_LIMIT} chats`));
  });

  test("正好 25 群不拒绝", () => {
    const rows: StoredChatStateRow[] = Array.from(
      { length: STATE_MANAGED_CHAT_LIMIT },
      (_value: unknown, index: number): StoredChatStateRow =>
        chatStateRow(-1_000 - index, { isInitEnabled: true })
    );
    expect(decodeStoredChatStates(rows, SOURCE).size).toBe(STATE_MANAGED_CHAT_LIMIT);
  });

  test("同一群出现两行时拒绝，不让后一行静默覆盖前一行", () => {
    expect(() => decodeStoredChatStates([
      chatStateRow(CHAT_ID, { isInitEnabled: true }),
      chatStateRow(CHAT_ID, { isInitEnabled: false }),
    ], SOURCE)).toThrow(/duplicate chat primary key/);
  });

  test("同时有两个代发目标时拒绝：代发入口全局只能有一个", () => {
    expect(() => decodeStoredChatStates([
      chatStateRow(CHAT_ID, { isProxySendEnabled: true }),
      chatStateRow(CHAT_ID - 1, { isProxySendEnabled: true }),
    ], SOURCE)).toThrow(/at most one active proxy send target/);
  });

  test("只有一个代发目标时正常解出", () => {
    expect(() => decodeStoredChatStates([
      chatStateRow(CHAT_ID, { isProxySendEnabled: true }),
      chatStateRow(CHAT_ID - 1, { isInitEnabled: true }),
    ], SOURCE)).not.toThrow();
  });

  test("主键不是合法群 id 时拒绝", () => {
    expect(() => decodeStoredChatStates(
      [chatStateRow(1_001, { isInitEnabled: true })],
      SOURCE
    )).toThrow();
  });
});
