import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiChatWorkerEvent, AiChatWorkerMessage } from "../../../src/types/aiChat/protocol";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryDeleteDiskMessage,
  AiMemoryDiskMessage,
  StickerCatalogDiskMessage,
} from "../../../src/types/diskIO";

type AiDiskMessage = AiMemoryDiskMessage | AiMemoryDeleteDiskMessage | StickerCatalogDiskMessage;

const workerPosts: AiChatWorkerMessage[] = [];
const diskPosts: AiDiskMessage[] = [];
const initWorker = mock((): void => {});
const markSelfSent = mock((_chatId: number, _messageId: number): void => {});
let workerPostAccepted: boolean = true;
let supervisorOptions: {
  onEvent: (event: AiChatWorkerEvent) => void;
  onRespawn: (post: (message: AiChatWorkerMessage) => boolean) => void;
  onGiveUp: () => void;
} | undefined;
let diskRespawn: (() => void) | undefined;
let diskDeletePersisted: ((reply: AiMemoryDeletedPersistedReply) => void) | undefined;
const aiEnabledChats = new Set<number>();

mock.module("../../../src/infra/selfSentTracker", () => ({ markSelfSent }));
mock.module("../../../src/libs/supervisedWorker", () => ({
  superviseWorker: (options: typeof supervisorOptions) => {
    supervisorOptions = options;
    return {
      init: initWorker,
      post: (message: AiChatWorkerMessage): boolean => {
        workerPosts.push(message);
        return workerPostAccepted;
      },
      terminate: async (): Promise<void> => {},
    };
  },
}));
mock.module("../../../src/ai/persistence", () => ({
  postDiskIO: (message: AiDiskMessage): boolean => { diskPosts.push(message); return true; },
  onAiMemoryDeletedPersisted: (callback: (reply: AiMemoryDeletedPersistedReply) => void): void => {
    diskDeletePersisted = callback;
  },
  onDiskIORespawn: (callback: () => void): void => { diskRespawn = callback; },
}));
mock.module("../../../src/infra/storage/stateStore", () => ({
  getChatState: (chatId: number) => ({ isAIChatEnabled: aiEnabledChats.has(chatId) }),
}));

const aiChat = await import("../../../src/aiChat");
const {
  lastInitState,
  latestAiMemories,
  latestStickerCatalogs,
  purgedAiMemoryChats,
  aiChatWorkerState,
  aiMemoryDeleteWaiters,
  aiMemoryRevisionCounters,
  latestAiMemoryRevisions,
  pendingAiMemoryDeletes,
} = await import("../../../src/cache/aiChat");

beforeEach(() => {
  workerPosts.length = 0;
  diskPosts.length = 0;
  initWorker.mockClear();
  markSelfSent.mockClear();
  lastInitState.current = null;
  latestAiMemories.clear();
  latestAiMemoryRevisions.clear();
  aiMemoryRevisionCounters.clear();
  pendingAiMemoryDeletes.clear();
  for (const waiters of aiMemoryDeleteWaiters.values()) {
    for (const waiter of waiters) clearTimeout(waiter.timer);
  }
  aiMemoryDeleteWaiters.clear();
  latestStickerCatalogs.clear();
  purgedAiMemoryChats.clear();
  aiChatWorkerState.available = false;
  aiEnabledChats.clear();
  workerPostAccepted = true;
});

describe("AI main-thread persistence mirror", () => {
  test("AI 与 Disk I/O Worker 重建时重放最新镜像，清除后的迟到快照不会复活", async () => {
    aiEnabledChats.add(-1001);
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });
    aiChat.hydrateAiMemory(new Map([[-1001, "restored-memory"]]));
    aiChat.hydrateStickerCatalog(new Map([["pack_a", "restored-catalog"]]));

    supervisorOptions!.onEvent({ type: "memory", chatId: -1001, snapshot: "latest-memory" });
    supervisorOptions!.onEvent({ type: "stickerCatalog", pack: "pack_a", snapshot: "latest-catalog" });
    supervisorOptions!.onEvent({ type: "sent", chatId: -1001, messageId: 42 });

    const aiRespawnPosts: AiChatWorkerMessage[] = [];
    supervisorOptions!.onRespawn((message) => {
      aiRespawnPosts.push(message);
      return true;
    });

    expect(initWorker).toHaveBeenCalledTimes(1);
    expect(markSelfSent).toHaveBeenCalledWith(-1001, 42);
    expect(aiRespawnPosts).toEqual([
      { type: "init", botInfo: { id: 99, username: "ninja_bot", first_name: "Ninja" } },
      { type: "hydrate", memories: new Map([[-1001, "latest-memory"]]) },
      { type: "hydrateStickerCatalog", catalogs: new Map([["pack_a", "latest-catalog"]]) },
    ]);

    diskPosts.length = 0;
    diskRespawn!();
    expect(diskPosts).toEqual([
      { type: "aiMemory", chatId: -1001, revision: 1, snapshot: "latest-memory" },
      { type: "stickerCatalog", pack: "pack_a", snapshot: "latest-catalog" },
    ]);

    const invalidated = aiChat.invalidateAiChat(-1001, true);
    supervisorOptions!.onEvent({ type: "memory", chatId: -1001, snapshot: "stale-memory" });

    expect(latestAiMemories.has(-1001)).toBeFalse();
    expect(purgedAiMemoryChats.has(-1001)).toBeTrue();
    expect(diskPosts.slice(-2)).toEqual([
      { type: "deleteAiMemory", chatId: -1001, revision: 2 },
      { type: "deleteAiMemory", chatId: -1001, revision: 2 },
    ]);

    supervisorOptions!.onEvent({ type: "memoryDeleted", chatId: -1001 });
    expect(purgedAiMemoryChats.has(-1001)).toBeFalse();
    expect(diskPosts.at(-1)).toEqual({ type: "deleteAiMemory", chatId: -1001, revision: 2 });
    diskDeletePersisted!({ type: "aiMemoryDeletedPersisted", chatId: -1001, revision: 2 });
    await invalidated;
  });

  test("启动恢复不会 hydrate 已关闭群，并为磁盘残留安排 durable 删除", () => {
    aiEnabledChats.add(-1002);
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });

    aiChat.hydrateAiMemory(new Map([
      [-1001, "disabled-memory"],
      [-1002, "enabled-memory"],
    ]));

    expect(workerPosts.at(-1)).toEqual({
      type: "hydrate",
      memories: new Map([[-1002, "enabled-memory"]]),
    });
    expect(latestAiMemories).toEqual(new Map([[-1002, "enabled-memory"]]));
    expect(pendingAiMemoryDeletes.get(-1001)).toBe(1);
    expect(diskPosts.at(-1)).toEqual({ type: "deleteAiMemory", chatId: -1001, revision: 1 });
  });

  test("启动 init 投递被拒绝时不发布可用状态或可重放身份", () => {
    workerPostAccepted = false;

    expect(() => aiChat.initAiChat({
      id: 99,
      username: "ninja_bot",
      first_name: "Ninja",
    })).toThrow("AI Worker is unavailable");

    expect(aiChatWorkerState.available).toBeFalse();
    expect(lastInitState.current).toBeNull();
  });

  test("记忆 flush 在 Worker 确认或超时后都会结算并清理等待项", async () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });

    const acknowledged = aiChat.flushAiMemory(1_000);
    const acknowledgedRequest = workerPosts.at(-1);
    if (acknowledgedRequest?.type !== "flushMemory") throw new Error("Expected a flushMemory request");

    supervisorOptions!.onEvent({ type: "memoryFlushed", flushId: acknowledgedRequest.flushId });
    await expect(acknowledged).resolves.toBe("flushed");

    const timedOut = aiChat.flushAiMemory(1);
    const timedOutRequest = workerPosts.at(-1);
    if (timedOutRequest?.type !== "flushMemory") throw new Error("Expected a flushMemory request");
    await expect(timedOut).resolves.toBe("timedOut");
    supervisorOptions!.onEvent({ type: "memoryFlushed", flushId: timedOutRequest.flushId });
  });

  test("Worker 放弃自愈只清 Worker purge guard，不丢未确认的 durable tombstone", async () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });
    const firstDelete = aiChat.invalidateAiChat(-1001, true);
    expect(purgedAiMemoryChats.has(-1001)).toBeTrue();

    supervisorOptions!.onGiveUp();
    expect(aiChatWorkerState.available).toBeFalse();
    expect(purgedAiMemoryChats.size).toBe(0);
    expect(pendingAiMemoryDeletes.get(-1001)).toBe(1);

    const secondDelete = aiChat.invalidateAiChat(-1002, true);
    expect(purgedAiMemoryChats.size).toBe(0);
    expect(diskPosts.at(-1)).toEqual({ type: "deleteAiMemory", chatId: -1002, revision: 1 });
    diskDeletePersisted!({ type: "aiMemoryDeletedPersisted", chatId: -1001, revision: 1 });
    diskDeletePersisted!({ type: "aiMemoryDeletedPersisted", chatId: -1002, revision: 1 });
    await firstDelete;
    await secondDelete;
  });
});
