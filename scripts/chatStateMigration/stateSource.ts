/** state.json 主备的严格读取、上一版权限补全草稿与一致性核对。 */

import { readFileSync } from "node:fs";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import {
  assertTelegramChatId,
  decodeChatStateData,
  encodeChatStateData,
} from "../../packages/database/codec/chatState";
import {
  createChatState,
  isEmptyChatState,
  normalizeChatState,
} from "../../packages/libs/chatState";
import { parseJsonInput } from "../../packages/libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../packages/libs/record";
import { decodeStateFile } from "../../packages/libs/stateFileCodec";
import type { ChatState, StateFileSchema } from "../../packages/types/chatState";
import type { BotChatPermissions } from "../../packages/types/telegram";
import type { StoredChatStateRow } from "../../packages/types/storageDatabase";
import { decodePreviousChatState } from "./previousState";
import type { PreviousChatState } from "./previousState";

export type MigrationStateKind = "legacy" | "current";

/** 尚未用 Telegram 当前观测替换旧 `botIsAdmin` 的规范群行。 */
export interface ChatStateMigrationDraftRow {
  readonly chatId: number;
  readonly data: string;
  readonly source: string;
  readonly botIsAdmin: boolean | undefined;
}

interface DecodedMigrationStateFile {
  readonly kind: MigrationStateKind;
  readonly globalText: string;
  readonly chatRows: readonly ChatStateMigrationDraftRow[] | null;
}

/** state 主备完成严格解析、尚待权限补全的两阶段迁移输入。 */
export interface ChatStateMigrationDraft {
  readonly globalText: string;
  readonly chatRows: readonly ChatStateMigrationDraftRow[] | null;
  readonly mainKind: MigrationStateKind;
  readonly backupKind: MigrationStateKind;
  readonly normalizationTime: number;
  readonly permissionChatIds: readonly number[];
}

export interface ChatStateMigrationSource {
  readonly globalText: string;
  readonly chatRows: readonly StoredChatStateRow[] | null;
  readonly mainKind: MigrationStateKind;
  readonly backupKind: MigrationStateKind;
  readonly normalizationTime: number;
}

function canonicalChatId(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 比较两组规范群状态行，不依赖 SQLite 返回顺序。 */
export function sameChatRows(
  left: readonly StoredChatStateRow[],
  right: readonly StoredChatStateRow[]
): boolean {
  if (left.length !== right.length) return false;
  const expected: Map<number, string> = new Map<number, string>();
  for (const row of left) expected.set(row.chatId, row.data);
  for (const row of right) {
    if (expected.get(row.chatId) !== row.data) return false;
    expected.delete(row.chatId);
  }
  return expected.size === 0;
}

function decodeLegacyChatRows(
  rawChats: unknown,
  source: string,
  normalizationTime: number
): readonly ChatStateMigrationDraftRow[] {
  if (!isPlainRecord(rawChats)) {
    throw new Error(`${source}: $.chats must be an object keyed by chat IDs.`);
  }
  const entries: readonly [string, unknown][] = Object.entries(rawChats);
  if (entries.length > STATE_MANAGED_CHAT_LIMIT) {
    throw new Error(
      `${source}: $.chats must contain at most ${STATE_MANAGED_CHAT_LIMIT} chats; ` +
      "delete chats that are no longer managed before migrating."
    );
  }
  const rows: ChatStateMigrationDraftRow[] = [];
  let proxyTargetChatId: number | undefined;
  for (const [chatIdText, rawState] of entries) {
    const chatId: number = Number(chatIdText);
    if (String(chatId) !== chatIdText) {
      throw new Error(
        `${source}: $.chats.${chatIdText} must use a canonical chat ID key.`
      );
    }
    const rowSource: string = `${source}:$.chats.${chatIdText}`;
    assertTelegramChatId(chatId, rowSource);
    const previous: PreviousChatState = decodePreviousChatState(
      rawState,
      rowSource
    );
    const state: ChatState = previous.state;
    normalizeChatState(state, normalizationTime);
    if (isEmptyChatState(state) && previous.botIsAdmin === undefined) continue;
    if (state.isProxySendEnabled === true) {
      if (proxyTargetChatId !== undefined) {
        throw new Error(
          `${source}: $.chats must contain at most one active proxy send target.`
        );
      }
      proxyTargetChatId = chatId;
    }
    rows.push({
      chatId,
      data: isEmptyChatState(state)
        ? "{}"
        : encodeChatStateData(state, rowSource),
      source: rowSource,
      botIsAdmin: previous.botIsAdmin,
    });
  }
  rows.sort((
    left: ChatStateMigrationDraftRow,
    right: ChatStateMigrationDraftRow
  ): number => canonicalChatId(left.chatId, right.chatId));
  return rows;
}

function sameDraftRows(
  left: readonly ChatStateMigrationDraftRow[],
  right: readonly ChatStateMigrationDraftRow[]
): boolean {
  if (left.length !== right.length) return false;
  const expected: Map<number, ChatStateMigrationDraftRow> = new Map();
  for (const row of left) expected.set(row.chatId, row);
  for (const row of right) {
    const previous: ChatStateMigrationDraftRow | undefined =
      expected.get(row.chatId);
    if (
      previous?.data !== row.data ||
      previous?.botIsAdmin !== row.botIsAdmin
    ) return false;
    expected.delete(row.chatId);
  }
  return expected.size === 0;
}

function decodeMigrationStateFile(
  text: string,
  source: string,
  normalizationTime: number
): DecodedMigrationStateFile {
  const value: unknown = parseJsonInput(text, source);
  if (!isPlainRecord(value)) throw new Error(`${source}: $ must be an object.`);
  const current: boolean = hasExactKeys(value, ["global"]);
  const legacy: boolean = hasExactKeys(value, ["chats", "global"]);
  if (!current && !legacy) {
    throw new Error(
      `${source}: $ must be either the previous chats/global shape or current global-only shape.`
    );
  }
  let decoded: StateFileSchema;
  try {
    decoded = decodeStateFile({ global: value.global });
  } catch (error: unknown) {
    const reason: string = error instanceof Error ? error.message : String(error);
    throw new Error(`${source}: ${reason}`, { cause: error });
  }
  const globalText: string =
    `${JSON.stringify({ global: decoded.global }, null, 2)}\n`;
  return {
    kind: legacy ? "legacy" : "current",
    globalText,
    chatRows: legacy
      ? decodeLegacyChatRows(value.chats, source, normalizationTime)
      : null,
  };
}

export interface LoadChatStateMigrationSourceOptions {
  readonly statePath: string;
  readonly backupPath: string;
  readonly normalizationTime?: number;
}

/** 严格读取 state 主备；旧权限布尔值留给 Telegram 查询阶段补全。 */
export function loadChatStateMigrationDraft({
  statePath,
  backupPath,
  normalizationTime = Date.now(),
}: LoadChatStateMigrationSourceOptions): ChatStateMigrationDraft {
  if (!Number.isSafeInteger(normalizationTime) || normalizationTime < 0) {
    throw new Error(
      "Chat-state migration normalization time must be a non-negative safe integer."
    );
  }
  const main: DecodedMigrationStateFile = decodeMigrationStateFile(
    readFileSync(statePath, "utf8"),
    statePath,
    normalizationTime
  );
  const backup: DecodedMigrationStateFile = decodeMigrationStateFile(
    readFileSync(backupPath, "utf8"),
    backupPath,
    normalizationTime
  );
  if (main.globalText !== backup.globalText) {
    throw new Error(
      `${statePath} and ${backupPath}: global state values must match before migration.`
    );
  }
  let chatRows: readonly ChatStateMigrationDraftRow[] | null =
    main.chatRows ?? backup.chatRows;
  if (
    main.chatRows !== null &&
    backup.chatRows !== null &&
    !sameDraftRows(main.chatRows, backup.chatRows)
  ) {
    throw new Error(
      `${statePath} and ${backupPath}: previous chats values must match before migration.`
    );
  }
  if (chatRows !== null) chatRows = [...chatRows];
  const permissionChatIds: number[] = [];
  if (chatRows !== null) {
    for (const row of chatRows) {
      if (row.botIsAdmin !== undefined) permissionChatIds.push(row.chatId);
    }
  }
  return {
    globalText: main.globalText,
    chatRows,
    mainKind: main.kind,
    backupKind: backup.kind,
    normalizationTime,
    permissionChatIds,
  };
}

/**
 * 用 Telegram 当前观测替换 8.1.1 的 `botIsAdmin`，生成可写入 v4 的完整群行。
 * 缺任一查询结果都致命失败，不拿旧布尔值猜测具体权限。
 */
export function resolveChatStateMigrationDraft(
  draft: ChatStateMigrationDraft,
  permissions: ReadonlyMap<number, Readonly<BotChatPermissions>>
): ChatStateMigrationSource {
  let chatRows: readonly StoredChatStateRow[] | null = null;
  if (draft.chatRows !== null) {
    const resolved: StoredChatStateRow[] = [];
    for (const row of draft.chatRows) {
      const state: ChatState = row.data === "{}"
        ? createChatState()
        : decodeChatStateData(row.data, row.source);
      if (row.botIsAdmin !== undefined) {
        const current: Readonly<BotChatPermissions> | undefined =
          permissions.get(row.chatId);
        if (current === undefined) {
          throw new Error(
            `${row.source}: $.botIsAdmin must resolve to the bot's complete current Telegram permissions.`
          );
        }
        state.botPermissions = { ...current };
      }
      normalizeChatState(state, draft.normalizationTime);
      if (isEmptyChatState(state)) continue;
      resolved.push({
        chatId: row.chatId,
        data: encodeChatStateData(state, row.source),
      });
    }
    chatRows = resolved;
  }
  return {
    globalText: draft.globalText,
    chatRows,
    mainKind: draft.mainKind,
    backupKind: draft.backupKind,
    normalizationTime: draft.normalizationTime,
  };
}

/** 无旧权限字段的测试/续跑入口；8.1.1 原始数据必须走两阶段补全。 */
export function loadChatStateMigrationSource(
  options: LoadChatStateMigrationSourceOptions
): ChatStateMigrationSource {
  return resolveChatStateMigrationDraft(
    loadChatStateMigrationDraft(options),
    new Map<number, Readonly<BotChatPermissions>>()
  );
}
