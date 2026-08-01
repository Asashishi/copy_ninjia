/**
 * 缺 AI_CHAT_GEMINI_API_KEY 时主线程侧代理的行为。与 mainMirrorRecovery.test.ts
 * 是同一批入口的另一种进程状态，因此必须另开一个文件：config 的 mock 整文件生效。
 *
 * 这里守的是一条会造成不可逆数据损失的边：hydrate 那条路把「本群没开 AI 闲聊」
 * 当成删除磁盘记忆的依据，而没有凭据时每个群看起来都是关的——一次临时抽掉密钥的
 * 重启就会把 memory/ 里所有群的 AI 记忆一起删光，钥匙补回来也找不回来。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiChatWorkerEvent, AiChatWorkerMessage } from "../../../packages/types/aiChat/protocol";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryDeleteDiskMessage,
  AiMemoryDiskMessage,
  AiMemoryPersistedReply,
  DiskIORespawnListener,
  StickerCatalogDiskMessage,
} from "../../../packages/types/diskIO";

type AiDiskMessage = AiMemoryDiskMessage | AiMemoryDeleteDiskMessage | StickerCatalogDiskMessage;

const workerPosts: AiChatWorkerMessage[] = [];
const diskPosts: AiDiskMessage[] = [];
const initWorker = mock((): void => {});
const loggerLog = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});
const aiEnabledChats = new Set<number>();

// 凭据缺席：mock 里不给 AI_CHAT_GEMINI_API_KEY 任何值，等价于 .env 留空。
mock.module("../../../packages/infra/config", () => ({ AI_CHAT_GEMINI_API_KEY: undefined }));
mock.module("../../../packages/infra/logger", () => ({
  logger: { log: loggerLog, error: loggerError, info: loggerLog, warn: loggerLog },
}));
mock.module("../../../packages/infra/selfSentTracker", () => ({ markSelfSent: (): void => {} }));
mock.module("../../../packages/libs/supervisedWorker", () => ({
  superviseWorker: (_options: {
    onEvent: (event: AiChatWorkerEvent) => void;
  }) => ({
    init: initWorker,
    post: (message: AiChatWorkerMessage): boolean => {
      workerPosts.push(message);
      return true;
    },
    terminate: async (): Promise<void> => {},
  }),
}));
mock.module("../../../packages/infra/diskIO", () => ({
  postDiskIO: (message: AiDiskMessage): boolean => { diskPosts.push(message); return true; },
  onAiMemoryDeletedPersisted: (_callback: (reply: AiMemoryDeletedPersistedReply) => void): void => {},
  onAiMemoryPersisted: (_callback: (reply: AiMemoryPersistedReply) => void): void => {},
  onDiskIORespawn: (_owner: string, _priority: number, _listener: DiskIORespawnListener): void => {},
  relayLogMessage: (): boolean => true,
}));
mock.module("../../../packages/infra/storage/stateStore", () => ({
  getChatState: (chatId: number) => ({ isAIChatEnabled: aiEnabledChats.has(chatId) }),
  getAllChatStates: (): Map<number, unknown> =>
    new Map([...aiEnabledChats].map((chatId: number): [number, unknown] => [chatId, {}])),
}));

const aiChat = await import("../../../packages/aiChat");
const {
  lastInitState,
  latestAiMemories,
  latestAiMemoryRevisions,
  latestStickerCatalogs,
  aiMemoryRevisionCounters,
  pendingAiMemoryDeletes,
} = await import("../../../packages/cache/main/aiChat");

beforeEach(() => {
  workerPosts.length = 0;
  diskPosts.length = 0;
  initWorker.mockClear();
  loggerLog.mockClear();
  lastInitState.current = null;
  latestAiMemories.clear();
  latestAiMemoryRevisions.clear();
  aiMemoryRevisionCounters.clear();
  pendingAiMemoryDeletes.clear();
  latestStickerCatalogs.clear();
  aiEnabledChats.clear();
});

describe("AI main-thread proxy without Gemini credentials", () => {
  test("initAiChat 不创建线程也不投递身份，只记一行诊断", () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });

    expect(initWorker).not.toHaveBeenCalled();
    expect(workerPosts).toEqual([]);
    // lastInitState 留在 null，停机路径的 flushAiMemory 据此直接结算成 flushed。
    expect(lastInitState.current).toBeNull();
    expect(loggerLog).toHaveBeenCalledTimes(1);
  });

  test("hydrate 一条都不删：磁盘上的 AI 记忆原样留到凭据补回来", () => {
    aiEnabledChats.add(-1002);
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });

    aiChat.hydrateAiMemory(new Map([
      [-1001, "disabled-memory"],
      [-1002, "enabled-memory"],
    ]));
    aiChat.hydrateStickerCatalog(new Map([["pack_a", "restored-catalog"]]));

    expect(workerPosts).toEqual([]);
    // 关键断言：没有任何 deleteAiMemory 投出去。配了凭据的那条路会为 -1001
    // 安排 durable 删除（见 mainMirrorRecovery.test.ts），这里一条都不该有。
    expect(diskPosts).toEqual([]);
    expect(pendingAiMemoryDeletes.size).toBe(0);
    expect(latestAiMemories.size).toBe(0);
    expect(latestStickerCatalogs.size).toBe(0);
  });

  test("停机 flush 直接结算成 flushed，不因线程没起而卡住预算", async () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });

    await expect(aiChat.flushAiMemory(50)).resolves.toBe("flushed");
    await expect(aiChat.terminateAiChat()).resolves.toBeUndefined();
  });
});
