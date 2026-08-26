import { describe, expect, test } from "bun:test";
import { IDENTITY_DATABASE_SCHEMA_KEY, IDENTITY_DATABASE_SCHEMA_VERSION } from
  "../../packages/consts/identityStorage";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { encodeChatStateData } from "../../packages/database/codec/chatState";
import {
  decodeStoredChatStates,
  readStorageSchemaVersion,
} from "../../packages/database/validation/storageRows";
import type { ChatState } from "../../packages/types/chatState";
import type {
  StoredChatStateRow,
  StoredStorageMetadataRow,
} from "../../packages/types/storageDatabase";

/**
 * 共享 SQLite 业务行的**启动期严格校验**。
 *
 * schema 版本与群状态是 `AGENTS.md`「不为用户行为兜底」要求 fail closed 的边界；
 * 身份表、outbox 与 migration 谱系由 storageDatabaseSchemaGate 的真实 SQLite
 * 启动检查覆盖。
 *
 * 错误文案也一起钉住：必须写明来源路径与字段路径，且**不得回显行内容**。
 */

const SOURCE: string = "database/storage.sqlite";
const CHAT_ID: number = -1_001;

function metadataRows(data: string): { readonly metadata: readonly StoredStorageMetadataRow[] } {
  const metadata: readonly StoredStorageMetadataRow[] = [
    { key: IDENTITY_DATABASE_SCHEMA_KEY, data },
  ];
  return { metadata };
}

function chatStateRow(chatId: number, state: Readonly<ChatState>): StoredChatStateRow {
  return { chatId, data: encodeChatStateData(state) };
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
