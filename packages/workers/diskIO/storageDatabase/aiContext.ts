import {
  aiMemoryDeletePersistedNotifier,
  aiMemoryImmediateChats,
  aiMemoryPersistedNotifier,
} from "../../../cache/workers/diskIO/snapshots";
import { pendingAiContextWrites } from "../../../cache/workers/diskIO/storageDatabase";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import { assertTelegramChatId } from "../../../database/codec/chatState";
import { aiContextSource } from "../../../database/interact/aiContext";
import { parseAiMemorySnapshot } from "../../../libs/persistedSnapshotCodec";
import type { PendingAiContextWrite } from "../../../types/identityStorage";

/**
 * AI 上下文在共享 SQLite 事务缓冲中的写入边界：排入最终值、判定是否需要立即提交，以及
 * 事务成功后结算 AI 记忆的 durable 回执。提交由 storageDatabase/flush.ts 统一执行。
 */

/** 严格校验一群上下文快照；非法时按字段路径抛出，不触碰 SQLite。 */
export function assertAiContextSnapshot(chatId: number, snapshot: string): void {
  const source: string = aiContextSource(IDENTITY_DATABASE_PATH, chatId);
  assertTelegramChatId(chatId, source);
  parseAiMemorySnapshot(snapshot, source);
}

/**
 * 把一群上下文最终值排入共享事务缓冲；null 表示清空 `ai_context`，同群后写覆盖先写。
 * 被覆盖的尚未提交的删除转记在新项上，提交后照样回执，主线程的删除等待不会因此落空。
 */
export function queueAiContextWrite(chatId: number, snapshot: string | null, revision: number): void {
  const previous: PendingAiContextWrite | undefined = pendingAiContextWrites.get(chatId);
  const coveredDeleteRevision: number | null = previous === undefined
    ? null
    : previous.snapshot === null ? previous.revision : previous.coveredDeleteRevision;
  pendingAiContextWrites.set(chatId, { snapshot, revision, coveredDeleteRevision });
}

/** 缓冲里是否有需要立即提交的上下文：待回执的删除（含被覆盖的删除）或 purge 后首份快照。 */
export function hasUrgentAiContextWrites(): boolean {
  for (const [chatId, change] of pendingAiContextWrites) {
    if (
      change.snapshot === null ||
      change.coveredDeleteRevision !== null ||
      aiMemoryImmediateChats.has(chatId)
    ) return true;
  }
  return false;
}

/**
 * 事务成功后结算一群上下文：被覆盖的删除与本项删除发出 durable 回执，purge 后首份快照
 * 发出即时写入回执。
 */
export function settleAiContextPersisted(chatId: number, change: PendingAiContextWrite): void {
  if (change.coveredDeleteRevision !== null) {
    aiMemoryDeletePersistedNotifier.current({
      type: "aiMemoryDeletedPersisted",
      chatId,
      revision: change.coveredDeleteRevision,
    });
  }
  if (change.snapshot === null) {
    aiMemoryDeletePersistedNotifier.current({
      type: "aiMemoryDeletedPersisted",
      chatId,
      revision: change.revision,
    });
    return;
  }
  if (!aiMemoryImmediateChats.has(chatId)) return;
  aiMemoryImmediateChats.delete(chatId);
  aiMemoryPersistedNotifier.current({
    type: "aiMemoryPersisted",
    chatId,
    revision: change.revision,
  });
}
