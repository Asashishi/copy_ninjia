/**
 * mock 运行时数据根的 fixture：SQLite 业务表、AI 记忆快照与入群日志。
 *
 * 全部经仓库唯一的当前 schema 夹具入口写出：SQLite 走 `seedStorageDatabase`，
 * `memory/` 下的文件走真实 Disk I/O Worker。**不手写任何落盘格式**——手写一份
 * 就等于在基准里养一份会和生产悄悄分叉的第二实现，等它分叉的那天，冷启动量
 * 到的是一条生产根本不会走的解析分支。
 *
 * 本文件只在子进程里 import：它会拉起整张生产模块图。
 */

import { chmodSync, mkdirSync } from "node:fs";
import {
  COLD_START_AI_MEMORY_CHATS,
  COLD_START_AI_MEMORY_MESSAGES,
  COLD_START_AI_MEMORY_SUMMARIES,
  COLD_START_CHAT_QA_ROWS,
  COLD_START_CHAT_STATE_ROWS,
  COLD_START_IDENTITY_ROWS,
  COLD_START_JOIN_LOG_EVENTS,
  COLD_START_REMOVAL_ROWS,
} from "./constants";
import {
  IDENTITY_DATABASE_DIRECTORY_MODE,
  IDENTITY_DATABASE_FILE_MODE,
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_KEY,
} from "../../../packages/consts/identityStorage";
import {
  DATABASE_DIR,
  IDENTITY_DATABASE_PATH,
} from "../../../packages/consts/paths";
import { seedStorageDatabase } from
  "../../fixtures/storageDatabase";
import {
  closeStorageDatabase,
  enableStorageDatabaseWal,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import { createStorageDatabase } from
  "../../../packages/database/interact/migration";
import { encodeChatStateData } from
  "../../../packages/database/codec/chatState";
import { encodeChatQaData } from
  "../../../packages/database/codec/chatQa";
import { encodePendingBlockedRemovalData } from
  "../../../packages/database/codec/identity";
import { CHAT_QA_MAX_PER_CHAT } from "../../../packages/consts/qa";
import { createChatState } from "../../../packages/libs/chatState";
import { getTokyoDateKey } from "../../../packages/libs/time";
import { BLACK_DATA, WHITE_DATA } from "../identityDatabase/fixtures";
import type { ChatState } from "../../../packages/types/chatState";
import type { PendingBlockedRemoval } from
  "../../../packages/types/blocklist";
import type { JoinLogDiskMessage } from
  "../../../packages/types/diskIO";
import type { SeedStorageDatabaseOptions } from
  "../../fixtures/storageDatabase";
import type {
  StorageDatabase,
  StoredChatQaRow,
  StoredChatStateRow,
  StoredIdentityPolicyRow,
  StoredPendingRemovalRow,
  StoredStorageMetadataRow,
} from "../../../packages/types/storageDatabase";
import type {
  AiMemorySnapshot,
  BufferedMessage,
} from "../../../packages/types/aiChat/memory";

/** fixture 实际写出的行数与文件数；冷启动报告用它证明这一轮真的读到了数据。 */
export interface SeededFixtureCounts {
  readonly whitelistEntries: number;
  readonly blocklistEntries: number;
  readonly chatStates: number;
  readonly chatQaEntries: number;
  readonly pendingRemovals: number;
  readonly aiMemoryChats: number;
  readonly joinLogEvents: number;
}

/** 基准群 id 的起点；负安全整数即合法 Telegram 群/频道 id。 */
const BENCHMARK_CHAT_ID_BASE: number = -1_002_000_000_000;

/** 基准成员 id 的起点；与群 id 分开，避免主键在两张表之间意外重叠。 */
const BENCHMARK_USER_ID_BASE: number = 700_000_000;

/** 黑名单 fixture 的主键起点；待踢 outbox 只能冻结这段范围内的身份。 */
const BENCHMARK_BLOCKLIST_ID_BASE: number = COLD_START_IDENTITY_ROWS + 1;

/** fixture 时间戳起点，取 2026-01-01T00:00:00Z；固定值保证各轮输入完全一致。 */
const FIXTURE_EPOCH_MS: number = 1_767_225_600_000;

/** 第 index 个基准群的 id。 */
export function benchmarkChatId(index: number): number {
  return BENCHMARK_CHAT_ID_BASE - index;
}

/** 第 index 个基准成员的 id。 */
export function benchmarkUserId(index: number): number {
  return BENCHMARK_USER_ID_BASE + index;
}

function buildChatState(index: number): ChatState {
  const state: ChatState = createChatState();
  state.isInitEnabled = true;
  state.isAntiRaidEnabled = (index & 1) === 0;
  state.isAIChatEnabled = (index % 3) === 0;
  state.isAdDetectEnabled = (index % 4) === 0;
  state.isFloodControlEnabled = true;
  state.title = `Performance fixture chat ${index}`;
  return state;
}

/** 一份撑满生产恢复上限的 AI 记忆快照；正文长度随下标变化，避免整表同形。 */
export function buildAiMemorySnapshot(chatIndex: number): string {
  const buffer: BufferedMessage[] = new Array<BufferedMessage>(
    COLD_START_AI_MEMORY_MESSAGES
  );
  for (let index: number = 0; index < COLD_START_AI_MEMORY_MESSAGES; index += 1) {
    buffer[index] = {
      id: benchmarkUserId(index % 64),
      firstName: `Member${index % 64}`,
      lastName: "Fixture",
      username: (index & 1) === 0 ? `member_${index % 64}` : undefined,
      messageId: index + 1,
      text: `性能基准逐字上下文第 ${index} 条，用于把快照撑到生产恢复上限。`.repeat(
        1 + index % 3
      ),
      replyTo: undefined,
      forwardedFrom: undefined,
      at: "2026-01-01 09:00:00",
    };
  }
  const summaries: string[] = new Array<string>(COLD_START_AI_MEMORY_SUMMARIES);
  for (let index: number = 0; index < COLD_START_AI_MEMORY_SUMMARIES; index += 1) {
    summaries[index] = `第 ${index} 轮压缩摘要（群 ${chatIndex}）。`.repeat(24);
  }
  const snapshot: AiMemorySnapshot = {
    version: 1,
    buffer,
    summaries,
    pendingSummary: null,
    savedAt: FIXTURE_EPOCH_MS,
  };
  return JSON.stringify(snapshot);
}

function identityRows(
  data: string,
  firstId: number
): readonly StoredIdentityPolicyRow[] {
  const rows: StoredIdentityPolicyRow[] = new Array<StoredIdentityPolicyRow>(
    COLD_START_IDENTITY_ROWS
  );
  for (let index: number = 0; index < COLD_START_IDENTITY_ROWS; index += 1) {
    rows[index] = { id: firstId + index, data };
  }
  return rows;
}

function chatStateRows(): readonly StoredChatStateRow[] {
  const rows: StoredChatStateRow[] = new Array<StoredChatStateRow>(
    COLD_START_CHAT_STATE_ROWS
  );
  for (let index: number = 0; index < COLD_START_CHAT_STATE_ROWS; index += 1) {
    rows[index] = {
      chatId: benchmarkChatId(index),
      data: encodeChatStateData(buildChatState(index)),
    };
  }
  return rows;
}

function chatQaRows(): readonly StoredChatQaRow[] {
  const rows: StoredChatQaRow[] = new Array<StoredChatQaRow>(
    COLD_START_CHAT_QA_ROWS
  );
  for (let index: number = 0; index < COLD_START_CHAT_QA_ROWS; index += 1) {
    const chatIndex: number = Math.floor(index / CHAT_QA_MAX_PER_CHAT);
    const questionIndex: number = index % CHAT_QA_MAX_PER_CHAT;
    rows[index] = {
      chatId: benchmarkChatId(chatIndex),
      q: `性能基准问题 ${questionIndex}`,
      data: encodeChatQaData(
        `群 ${chatIndex} 的性能基准答案 ${questionIndex}。`,
        `performance fixture:chat_qa[${chatIndex}:${questionIndex}].data`
      ),
    };
  }
  return rows;
}

function removalRows(): readonly StoredPendingRemovalRow[] {
  const rows: StoredPendingRemovalRow[] = new Array<StoredPendingRemovalRow>(
    COLD_START_REMOVAL_ROWS
  );
  for (let index: number = 0; index < COLD_START_REMOVAL_ROWS; index += 1) {
    const removalId: number = index + 1;
    const firstBlockedId: number = BENCHMARK_BLOCKLIST_ID_BASE + index;
    const pending: PendingBlockedRemoval = {
      params: {
        chatId: benchmarkChatId(index % COLD_START_CHAT_STATE_ROWS),
        probeMembership: false,
        userIds: [firstBlockedId, firstBlockedId + 1],
        removalId,
      },
      createdAt: FIXTURE_EPOCH_MS + removalId,
      attempts: 0,
      lastFailure: null,
    };
    rows[index] = {
      removalId,
      data: encodePendingBlockedRemovalData(pending).text,
    };
  }
  return rows;
}

/** schema 版本元数据行；两种建库方式都要写，缺它启动恢复会拒绝加载。 */
const SCHEMA_METADATA_ROW: Readonly<StoredStorageMetadataRow> = {
  key: IDENTITY_DATABASE_SCHEMA_KEY,
  data: IDENTITY_DATABASE_SCHEMA_DATA,
};

/**
 * 在当前进程的运行时数据根下建库并写入给定业务行。
 *
 * 目录与文件权限照 `packages/consts/identityStorage.ts` 的生产口径设置：数据根
 * 预检对 `database/` 有独立的权限判据，mock 根建宽了，冷启动那一段就绕过了
 * 生产真的会执行的检查。
 */
function createDatabase(rows: SeedStorageDatabaseOptions): void {
  mkdirSync(DATABASE_DIR, {
    recursive: true,
    mode: IDENTITY_DATABASE_DIRECTORY_MODE,
  });
  chmodSync(DATABASE_DIR, IDENTITY_DATABASE_DIRECTORY_MODE);
  createStorageDatabase(IDENTITY_DATABASE_PATH);
  enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
  const database: StorageDatabase = openStorageDatabase({
    path: IDENTITY_DATABASE_PATH,
  });
  try {
    seedStorageDatabase(database, rows);
  } finally {
    closeStorageDatabase(database);
  }
  chmodSync(IDENTITY_DATABASE_PATH, IDENTITY_DATABASE_FILE_MODE);
}

/** 满库：冷启动分区要量的是「读到一份生产量级的部署数据」的成本。 */
export function createBenchmarkDatabase(): void {
  createDatabase({
    metadata: [SCHEMA_METADATA_ROW],
    whitelist: identityRows(WHITE_DATA, 1),
    blocklist: identityRows(BLACK_DATA, BENCHMARK_BLOCKLIST_ID_BASE),
    removals: removalRows(),
    chatStates: chatStateRows(),
    chatQa: chatQaRows(),
  });
}

/** 空库，只带 schema 元数据；链路分区从零开始写，不受 fixture 体量干扰。 */
export function createEmptyBenchmarkDatabase(): void {
  createDatabase({
    metadata: [SCHEMA_METADATA_ROW],
    whitelist: [],
    blocklist: [],
    removals: [],
  });
}

/**
 * 一条入群日志事件，直接给出生产 wire 形态。
 *
 * 返回 `JoinLogDiskMessage` 而不是它的字段子集：调用点因此可以原样 post，
 * 不必再展开一次同构对象，类型也由生产协议本身钉住。
 */
export function joinLogEvent(index: number): JoinLogDiskMessage {
  const joinedAt: number = Date.now();
  return {
    type: "joinLog",
    chatId: benchmarkChatId(index % COLD_START_CHAT_STATE_ROWS),
    userId: benchmarkUserId(index),
    joinedAt,
    day: getTokyoDateKey(new Date(joinedAt)),
  };
}

/** fixture 的规模摘要；随冷启动读数一并回传，方便读者判断这批数是什么量级。 */
export function fixtureCounts(): SeededFixtureCounts {
  return {
    whitelistEntries: COLD_START_IDENTITY_ROWS,
    blocklistEntries: COLD_START_IDENTITY_ROWS,
    chatStates: COLD_START_CHAT_STATE_ROWS,
    chatQaEntries: COLD_START_CHAT_QA_ROWS,
    pendingRemovals: COLD_START_REMOVAL_ROWS,
    aiMemoryChats: COLD_START_AI_MEMORY_CHATS,
    joinLogEvents: COLD_START_JOIN_LOG_EVENTS,
  };
}
