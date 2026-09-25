import type { DiskIODomain } from "../../packages/types/diskIO/replies";
import { diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
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
import { chatStateOf } from "../helpers/chatState";

const diskMessages: DiskBusinessMessage[] = [];
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
const respawnListeners: DiskIORespawnListener[] = [];
let acknowledgeFlush: boolean = true;
let postAccepted: boolean = true;
const flushDiskIODomainOutcome = mock(
  async (_domain: DiskIODomain): Promise<DomainFlushOutcome> => {
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
          temporaryAdBypassWrites: [],
          chatStateWrites,
          chatQaWrites: [],
        });
      }
    }
    return { result: "flushed" };
  }
);

mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  flushDiskIODomainOutcome,
  onDiskIORespawn: (
    _owner: string,
    _priority: number,
    listener: DiskIORespawnListener
  ): void => {
    respawnListeners.push(listener);
  },
  onDiskIOReply: diskIOReplyStub({
    identityStoragePersisted: (listener: (reply: IdentityStoragePersistedReply) => void): void => {
      persistedListeners.push(listener);
    },
  }),
  postDiskIO: (message: DiskBusinessMessage): boolean => {
    diskMessages.push(message);
    return postAccepted;
  },
  relayLogMessage: (): boolean => true,
})));

const {
  chatStateCache,
  chatStateWriteRevision,
  resetChatStateCache,
  unacknowledgedChatStateWrites,
} = await import("../../packages/cache/main/chatState");
const { diskIORuntime } = await import("../../packages/cache/main/diskIO");
const {
  assertChatStateCapacity,
  hydrateChatStateCache,
  persistChatState,
  queueChatStateWrite,
  saveChatStateInBackground,
} = await import("../../packages/infra/chatStateStorage");

beforeEach(() => {
  diskMessages.length = 0;
  acknowledgeFlush = true;
  postAccepted = true;
  flushDiskIODomainOutcome.mockClear();
  resetChatStateCache();
});

describe("主线程 chat-state LRU 与 SQLite 最终一致性", () => {
  test("启动恢复建立固定 shape LRU，运行时第 26 条新增仍被拒绝", () => {
    const states = new Map<number, ChatState>();
    for (let index: number = 0; index < STATE_MANAGED_CHAT_LIMIT; index += 1) {
      states.set(-1_001 - index, chatStateOf({ isInitEnabled: true }));
    }
    hydrateChatStateCache(states);

    expect(chatStateCache.size).toBe(STATE_MANAGED_CHAT_LIMIT);
    expect(() => assertChatStateCapacity(-9_999)).toThrow(
      `must contain at most ${STATE_MANAGED_CHAT_LIMIT} chats`
    );
    expect(() => assertChatStateCapacity(-1_001)).not.toThrow();
  });

  test("启动恢复不再重复核对代理目标唯一性", () => {
    chatStateCache.set(-1001, chatStateOf({ isInitEnabled: true, title: "existing" }));
    const states = new Map<number, ChatState>([
      [-1002, chatStateOf({ isProxySendEnabled: true })],
      [-1003, chatStateOf({ isProxySendEnabled: true })],
    ]);

    expect(() => hydrateChatStateCache(states)).not.toThrow();
    expect(chatStateCache.size).toBe(2);
    expect(chatStateCache.has(-1001)).toBeFalse();
    expect(chatStateCache.get(-1002)?.isProxySendEnabled).toBeTrue();
    expect(chatStateCache.get(-1003)?.isProxySendEnabled).toBeTrue();
  });

  test("权威写等待精确事务 ACK，主线程未 ACK 元数据不复制 JSON 正文", async () => {
    chatStateCache.set(-1001, chatStateOf({ isInitEnabled: true, title: "Test" }));
    await expect(persistChatState(-1001, "test update")).resolves.toBeUndefined();

    expect(flushDiskIODomainOutcome).toHaveBeenCalledWith("chatState");
    expect(unacknowledgedChatStateWrites.has(-1001)).toBeFalse();
    const message: DiskBusinessMessage = diskMessages[0]!;
    expect(message.type).toBe("chatStateWrite");
    if (message.type !== "chatStateWrite") throw new Error("Expected chatStateWrite.");
    expect(JSON.parse(message.data!)).toEqual({ isInitEnabled: true, title: "Test" });
  });

  test("空状态只在准入通过后才摘出 LRU；闸拒绝时缓存与未 ACK 记账保持原样", () => {
    chatStateCache.set(-1001, chatStateOf());
    diskIORuntime.fatalSignaled = true;
    try {
      expect(() => queueChatStateWrite(-1001)).toThrow("Disk I/O refused chat state publication.");
    } finally {
      diskIORuntime.fatalSignaled = false;
    }
    expect(chatStateCache.has(-1001)).toBeTrue();
    expect(unacknowledgedChatStateWrites.has(-1001)).toBeFalse();
    expect(diskMessages).toHaveLength(0);

    queueChatStateWrite(-1001);
    expect(chatStateCache.has(-1001)).toBeFalse();
    expect(unacknowledgedChatStateWrites.get(-1001)).toMatchObject({ deleted: true });
    expect(diskMessages[0]).toMatchObject({ type: "chatStateWrite", chatId: -1001, data: null });
  });

  test("旧 ACK 不会删除同一群更新的 revision", () => {
    chatStateCache.set(-1001, chatStateOf({ title: "first" }));
    const firstRevision: number = queueChatStateWrite(-1001);
    chatStateCache.get(-1001)!.title = "second";
    const secondRevision: number = queueChatStateWrite(-1001);

    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [],
        temporaryAdBypassWrites: [],
        chatStateWrites: [{ chatId: -1001, revision: firstRevision }],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedChatStateWrites.get(-1001)?.revision).toBe(secondRevision);
  });

  test("领域 flush 缺少目标 ACK 时拒绝成功，revision 留待重建重放", async () => {
    chatStateCache.set(-1001, chatStateOf({ isInitEnabled: true }));
    acknowledgeFlush = false;

    await expect(persistChatState(-1001, "missing ACK"))
      .rejects.toThrow("did not acknowledge");
    expect(unacknowledgedChatStateWrites.has(-1001)).toBeTrue();
  });

  test("领域 flush 失败时报错逐字点名结局、revision 与失败领域；无回执时如实说明", async () => {
    chatStateCache.set(-1001, chatStateOf({ isInitEnabled: true }));
    flushDiskIODomainOutcome.mockImplementationOnce(
      async (): Promise<DomainFlushOutcome> => ({ result: "failed", failedDomains: ["chatState", "luck"] })
    );
    const first: Error = await persistChatState(-1001, "ctx").then(
      (): never => { throw new Error("expected rejection"); },
      (error: unknown): Error => error as Error
    );
    const firstRevision: number = unacknowledgedChatStateWrites.get(-1001)!.revision;
    expect(first.message).toBe(
      `Failed to persist chat state update (ctx): flush failed for chat -1001 revision ${firstRevision}; failed domains: chatState, luck.`
    );

    flushDiskIODomainOutcome.mockImplementationOnce(
      async (): Promise<DomainFlushOutcome> => ({ result: "timedOut" })
    );
    const second: Error = await persistChatState(-1001, "ctx").then(
      (): never => { throw new Error("expected rejection"); },
      (error: unknown): Error => error as Error
    );
    const secondRevision: number = unacknowledgedChatStateWrites.get(-1001)!.revision;
    expect(second.message).toBe(
      `Failed to persist chat state update (ctx): flush timedOut for chat -1001 revision ${secondRevision}; no per-domain reply.`
    );
  });

  test("Worker 重建从当前 LRU 重编码最新 revision，删除只保留墓碑", async () => {
    chatStateCache.set(-1001, chatStateOf({ title: "before" }));
    queueChatStateWrite(-1001);
    chatStateCache.get(-1001)!.title = "after";
    const latestRevision: number = queueChatStateWrite(-1001);
    chatStateCache.set(-1002, chatStateOf({ isInitEnabled: false }));
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
      { aiPersona: null,
        type: "chatStateWrite",
        chatId: -1001,
        data: JSON.stringify({ title: "after" }),
        revision: latestRevision,
      },
      { aiPersona: null,
        type: "chatStateWrite",
        chatId: -1002,
        data: null,
        revision: deleteRevision,
      },
    ]);
  });

  test("revision 空间耗尽时拒绝写入，热读副本与未 ACK 记账保持原样", () => {
    chatStateCache.set(-1001, chatStateOf({ title: "keep" }));
    chatStateWriteRevision.current = Number.MAX_SAFE_INTEGER;
    expect(() => queueChatStateWrite(-1001)).toThrow("Chat-state revision space is exhausted.");
    expect(unacknowledgedChatStateWrites.size).toBe(0);
    expect(diskMessages).toHaveLength(0);
    expect(chatStateCache.get(-1001)?.title).toBe("keep");
    // 后台保存只记日志，不向调用方抛错。
    expect(() => saveChatStateInBackground(-1001, "background")).not.toThrow();
    expect(unacknowledgedChatStateWrites.size).toBe(0);
  });

  test("投递被拒时仍推进 revision 并保留未 ACK 记账，Worker 重建时重放", async () => {
    chatStateCache.set(-1001, chatStateOf({ title: "queued" }));
    postAccepted = false;
    const revision: number = queueChatStateWrite(-1001);
    expect(unacknowledgedChatStateWrites.get(-1001)).toEqual({ revision, deleted: false });

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
    expect(replayed).toEqual([expect.objectContaining({ chatId: -1001, revision })]);
  });

  test("重放时条目已从热读副本消失：按删除墓碑重放并更新未 ACK 记账", async () => {
    chatStateCache.set(-1001, chatStateOf({ title: "was here" }));
    const revision: number = queueChatStateWrite(-1001);
    chatStateCache.delete(-1001);

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
    expect(replayed).toEqual([{
      type: "chatStateWrite",
      chatId: -1001,
      data: null,
      aiPersona: null,
      revision,
    }]);
    expect(unacknowledgedChatStateWrites.get(-1001)).toEqual({ revision, deleted: true });
  });

  test("重放投递失败时报告失败", async () => {
    chatStateCache.set(-1001, chatStateOf({ title: "a" }));
    queueChatStateWrite(-1001);
    const transport: DiskIORecoveryTransport = {
      post: (): boolean => false,
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("unused");
      },
    };
    expect(await respawnListeners[0]!(transport)).toBeFalse();
  });
});
