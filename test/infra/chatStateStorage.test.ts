import { beforeEach, describe, expect, mock, test } from "bun:test";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import type { ChatState } from "../../packages/types/chatState";
import type {
  DiskBusinessMessage,
  DiskIORecoveryTransport,
  DiskIORespawnListener,
  DomainFlushOutcome,
  IdentityStoragePersistedReply,
} from "../../packages/types/diskIO";

const diskMessages: DiskBusinessMessage[] = [];
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
const respawnListeners: DiskIORespawnListener[] = [];
let acknowledgeFlush: boolean = true;
const flushDiskIODomainOutcome = mock(
  async (_domain: "chatState"): Promise<DomainFlushOutcome> => {
    if (acknowledgeFlush) {
      const latest = new Map<number, number>();
      for (const message of diskMessages) {
        if (message.type === "chatStateWrite") {
          latest.set(message.chatId, message.revision);
        }
      }
      const chatStateWrites: { chatId: number; revision: number }[] = [];
      for (const [chatId, revision] of latest) {
        chatStateWrites.push({ chatId, revision });
      }
      for (const listener of persistedListeners) {
        listener({
          type: "identityStoragePersisted",
          writes: [],
          chatStateWrites,
          chatQaWrites: [],
        });
      }
    }
    return { result: "flushed" };
  }
);

mock.module("../../packages/infra/diskIO", () => ({
  flushDiskIODomainOutcome,
  onDiskIORespawn: (
    _owner: string,
    _priority: number,
    listener: DiskIORespawnListener
  ): void => {
    respawnListeners.push(listener);
  },
  onIdentityStoragePersisted: (
    listener: (reply: IdentityStoragePersistedReply) => void
  ): void => {
    persistedListeners.push(listener);
  },
  postDiskIO: (message: DiskBusinessMessage): boolean => {
    diskMessages.push(message);
    return true;
  },
  relayLogMessage: (): boolean => true,
}));

const {
  chatStateCache,
  resetChatStateCache,
  unacknowledgedChatStateWrites,
} = await import("../../packages/cache/main/chatState");
const {
  assertChatStateCapacity,
  hydrateChatStateCache,
  persistChatState,
  queueChatStateWrite,
} = await import("../../packages/infra/chatStateStorage");

beforeEach(() => {
  diskMessages.length = 0;
  acknowledgeFlush = true;
  flushDiskIODomainOutcome.mockClear();
  resetChatStateCache();
});

describe("主线程 chat-state LRU 与 SQLite 最终一致性", () => {
  test("启动恢复建立固定 shape LRU，运行时第 26 条新增仍被拒绝", () => {
    const states = new Map<number, ChatState>();
    for (let index: number = 0; index < STATE_MANAGED_CHAT_LIMIT; index += 1) {
      states.set(-1_001 - index, { isInitEnabled: true });
    }
    hydrateChatStateCache(states);

    expect(chatStateCache.size).toBe(STATE_MANAGED_CHAT_LIMIT);
    expect(() => assertChatStateCapacity(-9_999)).toThrow(
      `must contain at most ${STATE_MANAGED_CHAT_LIMIT} chats`
    );
    expect(() => assertChatStateCapacity(-1_001)).not.toThrow();
  });

  test("启动恢复不再重复核对代理目标唯一性", () => {
    chatStateCache.set(-1001, { isInitEnabled: true, title: "existing" });
    const states = new Map<number, ChatState>([
      [-1002, { isProxySendEnabled: true }],
      [-1003, { isProxySendEnabled: true }],
    ]);

    expect(() => hydrateChatStateCache(states)).not.toThrow();
    expect(chatStateCache.size).toBe(2);
    expect(chatStateCache.has(-1001)).toBeFalse();
    expect(chatStateCache.peek(-1002)?.isProxySendEnabled).toBeTrue();
    expect(chatStateCache.peek(-1003)?.isProxySendEnabled).toBeTrue();
  });

  test("权威写等待精确事务 ACK，主线程未 ACK 元数据不复制 JSON 正文", async () => {
    chatStateCache.set(-1001, { isInitEnabled: true, title: "Test" });
    await expect(persistChatState(-1001, "test update")).resolves.toBeUndefined();

    expect(flushDiskIODomainOutcome).toHaveBeenCalledWith("chatState");
    expect(unacknowledgedChatStateWrites.has(-1001)).toBeFalse();
    const message: DiskBusinessMessage = diskMessages[0]!;
    expect(message.type).toBe("chatStateWrite");
    if (message.type !== "chatStateWrite") throw new Error("Expected chatStateWrite.");
    expect(JSON.parse(message.data!)).toEqual({ isInitEnabled: true, title: "Test" });
  });

  test("旧 ACK 不会删除同一群更新的 revision", () => {
    chatStateCache.set(-1001, { title: "first" });
    const firstRevision: number = queueChatStateWrite(-1001);
    chatStateCache.peek(-1001)!.title = "second";
    const secondRevision: number = queueChatStateWrite(-1001);

    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [],
        chatStateWrites: [{ chatId: -1001, revision: firstRevision }],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedChatStateWrites.get(-1001)?.revision).toBe(secondRevision);
  });

  test("领域 flush 缺少目标 ACK 时拒绝成功，revision 留待重建重放", async () => {
    chatStateCache.set(-1001, { isInitEnabled: true });
    acknowledgeFlush = false;

    await expect(persistChatState(-1001, "missing ACK"))
      .rejects.toThrow("did not acknowledge");
    expect(unacknowledgedChatStateWrites.has(-1001)).toBeTrue();
  });

  test("Worker 重建从当前 LRU 重编码最新 revision，删除只保留墓碑", async () => {
    chatStateCache.set(-1001, { title: "before" });
    queueChatStateWrite(-1001);
    chatStateCache.peek(-1001)!.title = "after";
    const latestRevision: number = queueChatStateWrite(-1001);
    chatStateCache.set(-1002, { isInitEnabled: false });
    const deleteRevision: number = queueChatStateWrite(-1002);
    expect(chatStateCache.has(-1002)).toBeFalse();

    const replayed: DiskBusinessMessage[] = [];
    const transport: DiskIORecoveryTransport = {
      post: (message: DiskBusinessMessage): boolean => {
        replayed.push(message);
        return true;
      },
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("unused");
      },
    };
    expect(await respawnListeners[0]!(transport)).toBeTrue();
    expect(replayed).toEqual([
      {
        type: "chatStateWrite",
        chatId: -1001,
        data: JSON.stringify({ title: "after" }),
        revision: latestRevision,
      },
      {
        type: "chatStateWrite",
        chatId: -1002,
        data: null,
        revision: deleteRevision,
      },
    ]);
  });
});
