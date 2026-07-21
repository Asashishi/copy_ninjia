import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiChatWorkerEvent, AiChatWorkerMessage } from "../../../src/types/aiChat/protocol";
import type {
  AiMemoryDeleteDiskMessage,
  AiMemoryDiskMessage,
  StickerCatalogDiskMessage,
} from "../../../src/types/diskIO";

type AiDiskMessage = AiMemoryDiskMessage | AiMemoryDeleteDiskMessage | StickerCatalogDiskMessage;

const workerPosts: AiChatWorkerMessage[] = [];
const diskPosts: AiDiskMessage[] = [];
const initWorker = mock((): void => {});
const markSelfSent = mock((_chatId: number, _messageId: number): void => {});
let supervisorOptions: {
  onEvent: (event: AiChatWorkerEvent) => void;
  onRespawn: (post: (message: AiChatWorkerMessage) => void) => void;
  onGiveUp: () => void;
} | undefined;
let diskRespawn: (() => void) | undefined;

mock.module("../../../src/infra/selfSentTracker", () => ({ markSelfSent }));
mock.module("../../../src/libs/supervisedWorker", () => ({
  superviseWorker: (options: typeof supervisorOptions) => {
    supervisorOptions = options;
    return {
      init: initWorker,
      post: (message: AiChatWorkerMessage): boolean => { workerPosts.push(message); return true; },
      terminate: async (): Promise<void> => {},
    };
  },
}));
mock.module("../../../src/ai/persistence", () => ({
  postDiskIO: (message: AiDiskMessage): void => { diskPosts.push(message); },
  onDiskIORespawn: (callback: () => void): void => { diskRespawn = callback; },
}));

const aiChat = await import("../../../src/aiChat");
const {
  lastInitState,
  latestAiMemories,
  latestStickerCatalogs,
  purgedAiMemoryChats,
  aiChatWorkerState,
} = await import("../../../src/cache/aiChat");

beforeEach(() => {
  workerPosts.length = 0;
  diskPosts.length = 0;
  initWorker.mockClear();
  markSelfSent.mockClear();
  lastInitState.current = null;
  latestAiMemories.clear();
  latestStickerCatalogs.clear();
  purgedAiMemoryChats.clear();
  aiChatWorkerState.available = false;
});

describe("AI main-thread persistence mirror", () => {
  test("AI 与 Disk I/O Worker 重建时重放最新镜像，清除后的迟到快照不会复活", () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });
    aiChat.hydrateAiMemory(new Map([[-1001, "restored-memory"]]));
    aiChat.hydrateStickerCatalog(new Map([["pack_a", "restored-catalog"]]));

    supervisorOptions!.onEvent({ type: "memory", chatId: -1001, snapshot: "latest-memory" });
    supervisorOptions!.onEvent({ type: "stickerCatalog", pack: "pack_a", snapshot: "latest-catalog" });
    supervisorOptions!.onEvent({ type: "sent", chatId: -1001, messageId: 42 });

    const aiRespawnPosts: AiChatWorkerMessage[] = [];
    supervisorOptions!.onRespawn((message) => { aiRespawnPosts.push(message); });

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
      { type: "aiMemory", chatId: -1001, snapshot: "latest-memory" },
      { type: "stickerCatalog", pack: "pack_a", snapshot: "latest-catalog" },
    ]);

    aiChat.invalidateAiChat(-1001, true);
    supervisorOptions!.onEvent({ type: "memory", chatId: -1001, snapshot: "stale-memory" });

    expect(latestAiMemories.has(-1001)).toBeFalse();
    expect(purgedAiMemoryChats.has(-1001)).toBeTrue();
    expect(diskPosts.slice(-2)).toEqual([
      { type: "deleteAiMemory", chatId: -1001 },
      { type: "deleteAiMemory", chatId: -1001 },
    ]);

    supervisorOptions!.onEvent({ type: "memoryDeleted", chatId: -1001 });
    expect(purgedAiMemoryChats.has(-1001)).toBeFalse();
    expect(diskPosts.at(-1)).toEqual({ type: "deleteAiMemory", chatId: -1001 });
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

  test("Worker 放弃自愈后清空 purge tombstone，后续删除不再等待不存在的回执", () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });
    aiChat.invalidateAiChat(-1001, true);
    expect(purgedAiMemoryChats.has(-1001)).toBeTrue();

    supervisorOptions!.onGiveUp();
    expect(aiChatWorkerState.available).toBeFalse();
    expect(purgedAiMemoryChats.size).toBe(0);

    aiChat.invalidateAiChat(-1002, true);
    expect(purgedAiMemoryChats.size).toBe(0);
    expect(diskPosts.at(-1)).toEqual({ type: "deleteAiMemory", chatId: -1002 });
  });
});
