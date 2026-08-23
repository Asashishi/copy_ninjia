import { and, eq } from "drizzle-orm";
import { chatQa } from "../schema/chatQa";
import { chatStates } from "../schema/chatState";
import { blocklistEntries, whitelistEntries } from "../schema/identityPolicy";
import { pendingBlockedRemovals } from "../schema/pendingRemoval";
import type {
  StorageDatabase,
  StorageDatabaseChange,
} from "../../types/storageDatabase";

type StorageDatabaseTransaction = Parameters<
  Parameters<StorageDatabase["transaction"]>[0]
>[0];

export interface CommitStorageDatabaseChangesOptions {
  readonly whitelist: ReadonlyMap<number, StorageDatabaseChange>;
  readonly blocklist: ReadonlyMap<number, StorageDatabaseChange>;
  readonly removals: ReadonlyMap<number, StorageDatabaseChange>;
  readonly chatStates: ReadonlyMap<number, StorageDatabaseChange>;
  /**
   * 群问答按 (chatId, q) 复合主键变更，因此外层是群、内层是问题文本。
   * 嵌套而不是拼一个 `${chatId}\u0000${q}` 复合键：拼键要为每条变更造一个字符串，
   * 而按群删除（群 teardown）也得把那个前缀再解析回来。
   */
  readonly chatQa: ReadonlyMap<number, ReadonlyMap<string, StorageDatabaseChange>>;
}

/** 共享 SQLite 各业务表的最终值在一个 Drizzle 显式事务中提交。 */
export function commitStorageDatabaseChanges(
  database: StorageDatabase,
  {
    whitelist,
    blocklist,
    removals,
    chatStates: chatStateChanges,
    chatQa: chatQaChanges,
  }: CommitStorageDatabaseChangesOptions
): void {
  database.transaction((transaction: StorageDatabaseTransaction): void => {
    for (const [id, change] of whitelist) {
      if (change.data === null) {
        transaction.delete(whitelistEntries).where(eq(whitelistEntries.id, id)).run();
      } else {
        transaction.insert(whitelistEntries).values({ id, data: change.data })
          .onConflictDoUpdate({ target: whitelistEntries.id, set: { data: change.data } })
          .run();
      }
    }
    for (const [id, change] of blocklist) {
      if (change.data === null) {
        transaction.delete(blocklistEntries).where(eq(blocklistEntries.id, id)).run();
      } else {
        transaction.insert(blocklistEntries).values({ id, data: change.data })
          .onConflictDoUpdate({ target: blocklistEntries.id, set: { data: change.data } })
          .run();
      }
    }
    for (const [removalId, change] of removals) {
      if (change.data === null) {
        transaction.delete(pendingBlockedRemovals)
          .where(eq(pendingBlockedRemovals.removalId, removalId)).run();
      } else {
        transaction.insert(pendingBlockedRemovals)
          .values({ removalId, data: change.data })
          .onConflictDoUpdate({
            target: pendingBlockedRemovals.removalId,
            set: { data: change.data },
          }).run();
      }
    }
    for (const [chatId, change] of chatStateChanges) {
      if (change.data === null) {
        transaction.delete(chatStates).where(eq(chatStates.chatId, chatId)).run();
      } else {
        transaction.insert(chatStates).values({ chatId, data: change.data })
          .onConflictDoUpdate({ target: chatStates.chatId, set: { data: change.data } })
          .run();
      }
    }
    for (const [chatId, questions] of chatQaChanges) {
      for (const [q, change] of questions) {
        if (change.data === null) {
          transaction.delete(chatQa)
            .where(and(eq(chatQa.chatId, chatId), eq(chatQa.q, q))).run();
        } else {
          transaction.insert(chatQa).values({ chatId, q, data: change.data })
            .onConflictDoUpdate({
              target: [chatQa.chatId, chatQa.q],
              set: { data: change.data },
            }).run();
        }
      }
    }
  });
}
