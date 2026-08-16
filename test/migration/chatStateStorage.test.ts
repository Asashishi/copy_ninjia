import { afterEach, describe, expect, test } from "bun:test";
import type { ChatMemberAdministrator } from "@grammyjs/types";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_KEY,
  IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_HASH,
} from "../../packages/consts/identityStorage";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { decodeChatStateData } from "../../packages/database/codec/chatState";
import { seedStorageDatabase } from "../../packages/database/interact/admin";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../packages/database/interact/connection";
import { createStorageDatabase } from "../../packages/database/interact/migration";
import type { StorageDatabase } from "../../packages/types/storageDatabase";
import {
  applyChatStateDatabaseMigration,
  assertChatStateMigrationReady,
  inspectChatStateDatabase,
  loadChatStateMigrationDraft,
  loadChatStateMigrationSource,
  resolveChatStateMigrationDraft,
} from "../../scripts/chatStateMigration/core";
import type {
  ChatStateMigrationDraft,
  ChatStateMigrationSource,
} from "../../scripts/chatStateMigration/core";
import { collectPreviousBotPermissions } from
  "../../scripts/chatStateMigration/telegram";
import type { ChatState } from "../../packages/types/chatState";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { botPermissions } from "../helpers/botPermissions";

let temporaryRoot: string | null = null;

function stateGlobal(): Readonly<Record<string, unknown>> {
  return {
    copy: { copiedUser: null, lastCopyTime: 1_786_290_376_032 },
    assets: {
      fortuneThumbnailUrl: "https://cdn.example/fortune",
      probabilityThumbnailUrl: "https://cdn.example/probability",
      gagThumbnailUrl: "https://cdn.example/gag",
      botDefaultAvatarUrl: "https://cdn.example/avatar",
    },
  };
}

function legacyState(chatCount: number = 2): string {
  const chats: Record<string, unknown> = {};
  for (let index: number = 0; index < chatCount; index++) {
    chats[String(-1_000 - index)] = {
      isInitEnabled: true,
      title: `chat-${index}`,
    };
  }
  return `${JSON.stringify({ chats, global: stateGlobal() }, null, 2)}\n`;
}

function currentState(): string {
  return `${JSON.stringify({ global: stateGlobal() }, null, 2)}\n`;
}

function previousState(botIsAdmin: boolean): string {
  return `${JSON.stringify({
    chats: {
      "-1000": {
        quietUntil: 1_800_000_030_000,
        lockdown: {
          phase: "active",
          intentId: 1,
          originalPermissions: { can_send_messages: false },
          announced: true,
          expiresAt: 1_800_000_030_000,
        },
        isAIChatEnabled: true,
        isJATranslationEnabled: true,
        isAdDetectEnabled: true,
        isFloodControlEnabled: true,
        isAntiRaidEnabled: true,
        isInitEnabled: true,
        title: "previous-release-chat",
        isProxySendEnabled: true,
        botIsAdmin,
      },
    },
    global: stateGlobal(),
  }, null, 2)}\n`;
}

function currentAdministrator(): ChatMemberAdministrator {
  return {
    status: "administrator",
    user: { id: 99, is_bot: true, first_name: "Bot" },
    can_be_edited: false,
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: true,
    can_manage_video_chats: false,
    can_restrict_members: true,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: false,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false,
  };
}

interface Fixture {
  readonly databasePath: string;
  readonly statePath: string;
  readonly backupPath: string;
}

function fixture(): Fixture {
  temporaryRoot = mkdtempSync(join(tmpdir(), "copy-ninjia-chat-migration-test-"));
  const databasePath: string = join(temporaryRoot, "storage.sqlite");
  const statePath: string = join(temporaryRoot, "state.json");
  const backupPath: string = `${statePath}.bak`;
  createStorageDatabase(databasePath);
  const database: StorageDatabase = openStorageDatabase({ path: databasePath });
  try {
    seedStorageDatabase(database, {
      metadata: [{ key: IDENTITY_DATABASE_SCHEMA_KEY, data: IDENTITY_DATABASE_SCHEMA_DATA }],
      whitelist: [],
      blocklist: [],
      removals: [],
    });
    database.$client.run("DROP TABLE chat_states;");
    database.$client.run(
      "UPDATE storage_metadata SET data = jsonb('{\"version\":3}') " +
      "WHERE key = 'schema-version';"
    );
    database.$client.run(
      "DELETE FROM __drizzle_migrations WHERE created_at = 20260813000000;"
    );
  } finally {
    closeStorageDatabase(database);
  }
  writeFileSync(statePath, legacyState());
  writeFileSync(backupPath, legacyState());
  return { databasePath, statePath, backupPath };
}

function loadSource(value: Fixture): ChatStateMigrationSource {
  return loadChatStateMigrationSource({
    statePath: value.statePath,
    backupPath: value.backupPath,
    normalizationTime: 1_800_000_000_000,
  });
}

afterEach((): void => {
  if (temporaryRoot === null) return;
  rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

describe("chat state v3→v4 冷迁移", () => {
  test("上一版 botIsAdmin 由 Telegram 当前完整权限替换后写入 v4", async () => {
    const value: Fixture = fixture();
    const oldText: string = previousState(false);
    writeFileSync(value.statePath, oldText);
    writeFileSync(value.backupPath, oldText);

    expect(() => loadSource(value)).toThrow(
      "botIsAdmin must resolve to the bot's complete current Telegram permissions"
    );
    const draft: ChatStateMigrationDraft = loadChatStateMigrationDraft({
      statePath: value.statePath,
      backupPath: value.backupPath,
      normalizationTime: 1_800_000_000_000,
    });
    expect(draft.permissionChatIds).toEqual([-1_000]);
    const queriedChatIds: number[] = [];
    const permissions: ReadonlyMap<number, Readonly<BotChatPermissions>> =
      await collectPreviousBotPermissions(
        draft.permissionChatIds,
        async (chatId: number): Promise<ChatMemberAdministrator> => {
          queriedChatIds.push(chatId);
          return currentAdministrator();
        }
      );
    expect(queriedChatIds).toEqual([-1_000]);

    const source: ChatStateMigrationSource = resolveChatStateMigrationDraft(
      draft,
      permissions
    );
    if (source.chatRows === null) throw new Error("Expected previous chat rows.");
    const expectedRows: NonNullable<ChatStateMigrationSource["chatRows"]> =
      source.chatRows;
    const rowData: string | undefined = expectedRows[0]?.data;
    expect(rowData).toBeDefined();
    const state: ChatState = decodeChatStateData(rowData as string, "test-row");
    expect(state.botPermissions).toEqual(botPermissions({
      canDeleteMessages: true,
      canRestrictMembers: true,
    }));
    expect(rowData).not.toContain("botIsAdmin");

    const database: StorageDatabase = openStorageDatabase({ path: value.databasePath });
    try {
      expect(applyChatStateDatabaseMigration(database, source, value.databasePath))
        .toBeTrue();
      expect(inspectChatStateDatabase(database, value.databasePath).chatRows)
        .toEqual(expectedRows);
    } finally {
      closeStorageDatabase(database);
    }
  });

  test("上一版权限主备分歧或 Telegram 无法确证时拒绝迁移", async () => {
    const value: Fixture = fixture();
    writeFileSync(value.statePath, previousState(true));
    writeFileSync(value.backupPath, previousState(false));
    expect(() => loadChatStateMigrationDraft({
      statePath: value.statePath,
      backupPath: value.backupPath,
    })).toThrow("previous chats values must match");

    await expect(collectPreviousBotPermissions(
      [-1_000],
      async (): Promise<ChatMemberAdministrator> => {
        throw new Error("sensitive Telegram failure");
      }
    )).rejects.toThrow(
      "botIsAdmin must resolve to the bot's complete current Telegram permissions"
    );
  });

  test("已补齐 botPermissions 的迁移准备态直接保留且不重复查询", () => {
    const value: Fixture = fixture();
    const expected: BotChatPermissions = botPermissions({
      canDeleteMessages: true,
      canManageTopics: true,
    });
    const prepared: string = `${JSON.stringify({
      chats: {
        "-1000": {
          isInitEnabled: true,
          title: "prepared-chat",
          botPermissions: expected,
        },
      },
      global: stateGlobal(),
    }, null, 2)}\n`;
    writeFileSync(value.statePath, prepared);
    writeFileSync(value.backupPath, prepared);

    const draft: ChatStateMigrationDraft = loadChatStateMigrationDraft({
      statePath: value.statePath,
      backupPath: value.backupPath,
    });
    expect(draft.permissionChatIds).toEqual([]);
    const source: ChatStateMigrationSource = resolveChatStateMigrationDraft(
      draft,
      new Map<number, Readonly<BotChatPermissions>>()
    );
    const rowData: string | undefined = source.chatRows?.[0]?.data;
    expect(rowData).toBeDefined();
    expect(decodeChatStateData(rowData as string, "prepared-row").botPermissions)
      .toEqual(expected);
  });

  test("v3 schema 与旧 state 主备严格迁移，SQLite 重跑幂等", () => {
    const value: Fixture = fixture();
    const source: ChatStateMigrationSource = loadSource(value);
    expect(source.mainKind).toBe("legacy");
    expect(source.backupKind).toBe("legacy");
    expect(source.chatRows).toHaveLength(2);

    const database: StorageDatabase = openStorageDatabase({ path: value.databasePath });
    try {
      expect(assertChatStateMigrationReady(database, source, value.databasePath))
        .toBe("pending");
      expect(applyChatStateDatabaseMigration(database, source, value.databasePath))
        .toBeTrue();
      const migrated = inspectChatStateDatabase(database, value.databasePath);
      expect(migrated.version).toBe(4);
      expect(migrated.chatRows.map((row) => row.chatId).sort((left: number, right: number): number => left - right)).toEqual([-1_001, -1_000]);
      expect(applyChatStateDatabaseMigration(database, source, value.databasePath))
        .toBeFalse();
    } finally {
      closeStorageDatabase(database);
    }
  });

  test("数据库已提交但 state 主备一新一旧时可验证续跑", () => {
    const value: Fixture = fixture();
    const original: ChatStateMigrationSource = loadSource(value);
    const database: StorageDatabase = openStorageDatabase({ path: value.databasePath });
    try {
      applyChatStateDatabaseMigration(database, original, value.databasePath);
      writeFileSync(value.statePath, currentState());
      const mixed: ChatStateMigrationSource = loadSource(value);
      expect(mixed.mainKind).toBe("current");
      expect(mixed.backupKind).toBe("legacy");
      expect(mixed.chatRows).toHaveLength(2);
      expect(assertChatStateMigrationReady(database, mixed, value.databasePath))
        .toBe("pending");
      expect(applyChatStateDatabaseMigration(database, mixed, value.databasePath))
        .toBeFalse();

      writeFileSync(value.backupPath, currentState());
      const complete: ChatStateMigrationSource = loadSource(value);
      expect(assertChatStateMigrationReady(database, complete, value.databasePath))
        .toBe("alreadyMigrated");
    } finally {
      closeStorageDatabase(database);
    }
  });

  test("主备与二次校验固定同一规范化时间点", () => {
    const value: Fixture = fixture();
    const expiringState: string = `${JSON.stringify({
      chats: { "-1000": { quietUntil: 10_001 } },
      global: stateGlobal(),
    }, null, 2)}\n`;
    writeFileSync(value.statePath, expiringState);
    writeFileSync(value.backupPath, expiringState);

    const beforeExpiry: ChatStateMigrationSource = loadChatStateMigrationSource({
      statePath: value.statePath,
      backupPath: value.backupPath,
      normalizationTime: 10_000,
    });
    const stable: ChatStateMigrationSource = loadChatStateMigrationSource({
      statePath: value.statePath,
      backupPath: value.backupPath,
      normalizationTime: beforeExpiry.normalizationTime,
    });
    expect(stable.chatRows).toEqual(beforeExpiry.chatRows);
    expect(stable.chatRows).toHaveLength(1);

    const afterExpiry: ChatStateMigrationSource = loadChatStateMigrationSource({
      statePath: value.statePath,
      backupPath: value.backupPath,
      normalizationTime: 10_001,
    });
    expect(afterExpiry.chatRows).toEqual([]);
  });
  test("旧 state 超过 25 条、主备 chats 分歧和数据库冲突均拒绝", () => {
    const value: Fixture = fixture();
    writeFileSync(value.statePath, legacyState(STATE_MANAGED_CHAT_LIMIT + 1));
    writeFileSync(value.backupPath, legacyState(STATE_MANAGED_CHAT_LIMIT + 1));
    expect(() => loadSource(value)).toThrow("delete chats that are no longer managed");

    writeFileSync(value.statePath, legacyState(2));
    writeFileSync(value.backupPath, legacyState(1));
    expect(() => loadSource(value)).toThrow("previous chats values must match");

    writeFileSync(value.backupPath, legacyState(2));
    const source: ChatStateMigrationSource = loadSource(value);
    const database: StorageDatabase = openStorageDatabase({ path: value.databasePath });
    try {
      applyChatStateDatabaseMigration(database, source, value.databasePath);
      database.$client.run(
        "UPDATE chat_states SET data = jsonb('{\"isInitEnabled\":false}') " +
        "WHERE chat_id = -1000;"
      );
      expect(() => assertChatStateMigrationReady(database, source, value.databasePath))
        .toThrow("does not match the legacy state source");
    } finally {
      closeStorageDatabase(database);
    }
  });

  test("已部署文本→JSONB→白名单权限的三项 v3 谱系同样被接受", () => {
    const value: Fixture = fixture();
    const database: StorageDatabase = openStorageDatabase({ path: value.databasePath });
    try {
      database.$client.run("DELETE FROM __drizzle_migrations;");
      const insert = database.$client.prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?1, ?2);"
      );
      insert.run(
        IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
        IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT
      );
      insert.run(
        IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
        IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT
      );
      insert.run(
        IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_HASH,
        IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_CREATED_AT
      );
      expect(inspectChatStateDatabase(database, value.databasePath).version).toBe(3);
    } finally {
      closeStorageDatabase(database);
    }
  });
});
