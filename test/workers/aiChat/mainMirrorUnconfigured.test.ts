import { diskIOStub } from "../../helpers/diskIOMock";
/**
 * AI agent 核心配置不可用时主线程侧代理的行为。与 mainMirrorRecovery.test.ts
 * 是同一批入口的另一种进程状态，因此必须另开一个文件：readiness mock 整文件生效。
 *
 * 这里守的是一条会造成不可逆数据损失的边：hydrate 那条路把「本群没开 AI 闲聊」
 * 当成删除磁盘记忆的依据，而配置不可用时每个群看起来都是关的——一次配置失误后的
 * 重启就会把 memory/ 里所有群的 AI 记忆一起删光，修好配置也找不回来。配置不可用
 * 时记忆只进镜像；热重载补齐前提后 resumeAiChat 才按群开关投递或删除。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { adoptStickerConfig } from "../../../packages/config/stickers";
import type { AiChatWorkerEvent, AiChatWorkerMessage } from "../../../packages/types/aiChat/protocol";
import type {
  DiskIORespawnListener,
  DiskBusinessMessage,
} from "../../../packages/types/diskIO";

const workerPosts: AiChatWorkerMessage[] = [];
const diskPosts: DiskBusinessMessage[] = [];
const initWorker = mock((): void => {});
const loggerLog = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});
const aiEnabledChats = new Set<number>();

mock.module("../../../packages/config/readiness", () => ({
  aiChatConfigReadiness: () => ({
    ok: false,
    failure: { file: "config/agent.json", reason: "missing agent.media" },
  }),
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ log: loggerLog, error: loggerError, info: loggerLog, warn: loggerLog }),
}));
mock.module("../../../packages/infra/selfSentTracker", () => ({ markSelfSent: (): void => {} }));
mock.module("../../../packages/infra/supervisedWorker", () => ({
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
mock.module("../../../packages/infra/diskIO", () => (diskIOStub({
  postDiskIO: (message: DiskBusinessMessage): boolean => { diskPosts.push(message); return true; },
  onDiskIORespawn: (_owner: string, _priority: number, _listener: DiskIORespawnListener): void => {},
  onDiskIOGiveUp: (_callback: () => void): void => {},
  relayLogMessage: (): boolean => true,
})));
mock.module("../../../packages/infra/storage/stateStore", () => ({
  getChatState: (chatId: number) => ({ isAIChatEnabled: aiEnabledChats.has(chatId) }),
  getChatStateCache: (): Map<number, unknown> =>
    new Map([...aiEnabledChats].map((chatId: number): [number, unknown] => [chatId, {}])),
}));

const aiChat = await import("../../../packages/aiChat");
const {
  aiChatBotInfo,
  aiChatWorkerState,
  lastInitState,
  latestAiMemories,
  latestAiMemoryRevisions,
  latestStickerCatalogs,
  aiMemoryRevisionCounters,
  pendingAiMemoryDeletes,
} = await import("../../../packages/cache/main/aiChat");

beforeEach(() => {
  adoptStickerConfig({ packs: ["pack_a"] });
  workerPosts.length = 0;
  diskPosts.length = 0;
  initWorker.mockClear();
  loggerLog.mockClear();
  lastInitState.current = null;
  aiChatBotInfo.current = null;
  aiChatWorkerState.available = false;
  latestAiMemories.clear();
  latestAiMemoryRevisions.clear();
  aiMemoryRevisionCounters.clear();
  pendingAiMemoryDeletes.clear();
  latestStickerCatalogs.clear();
  aiEnabledChats.clear();
});

describe("AI main-thread proxy with unavailable agent config", () => {
  test("initAiChat 不创建线程也不投递身份，只记一行诊断", () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });

    expect(initWorker).not.toHaveBeenCalled();
    expect(workerPosts).toEqual([]);
    // lastInitState 留在 null，停机路径的 flushAiMemory 据此直接结算成 flushed。
    expect(lastInitState.current).toBeNull();
    expect(loggerLog).toHaveBeenCalledTimes(1);
  });

  test("hydrate 一条都不删也不投递，只把恢复出的记忆与贴纸目录记进镜像", () => {
    aiEnabledChats.add(-1002);
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });

    aiChat.hydrateAiMemory(new Map([
      [-1001, "disabled-memory"],
      [-1002, "enabled-memory"],
    ]));
    aiChat.hydrateStickerCatalog(new Map([["pack_a", "restored-catalog"]]));

    expect(workerPosts).toEqual([]);
    // 关键断言：没有任何 deleteAiMemory 投出去。配置可用的那条路会为 -1001
    // 安排 durable 删除（见 mainMirrorRecovery.test.ts），这里一条都不该有。
    expect(diskPosts).toEqual([]);
    expect(pendingAiMemoryDeletes.size).toBe(0);
    expect([...latestAiMemories]).toEqual([[-1001, "disabled-memory"], [-1002, "enabled-memory"]]);
    expect([...latestStickerCatalogs]).toEqual([["pack_a", "restored-catalog"]]);
  });

  test("热重载补齐前提后 resumeAiChat 按启动顺序拉起 Worker，并按群开关投递或删除镜像", () => {
    aiEnabledChats.add(-1002);
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });
    aiChat.hydrateAiMemory(new Map([
      [-1001, "disabled-memory"],
      [-1002, "enabled-memory"],
    ]));
    aiChat.hydrateStickerCatalog(new Map([["pack_a", "restored-catalog"], ["retired_pack", "old-catalog"]]));

    aiChat.resumeAiChat();

    expect(initWorker).toHaveBeenCalledTimes(1);
    expect(workerPosts.map((message: AiChatWorkerMessage): string => message.type)).toEqual([
      "init",
      "hydrate",
      "hydrateStickerCatalog",
    ]);
    expect(workerPosts[0]).toMatchObject({ defaultAtmosphere: "teasing",
      type: "init",
      botInfo: { id: 99, username: "ninja_bot", first_name: "Ninja" },
    });
    expect(workerPosts[1]).toEqual({ type: "hydrate", memories: new Map([[-1002, "enabled-memory"]]) });
    expect(workerPosts[2]).toEqual({
      type: "hydrateStickerCatalog",
      catalogs: new Map([["pack_a", "restored-catalog"]]),
    });
    expect(diskPosts).toMatchObject([{ type: "deleteAiMemory", chatId: -1001 }]);
    expect(latestAiMemories.has(-1001)).toBe(false);
    expect(latestStickerCatalogs.has("retired_pack")).toBeFalse();
    expect(latestStickerCatalogs.get("pack_a")).toBe("restored-catalog");
    expect(lastInitState.current).toBe(workerPosts[0] as typeof lastInitState.current);
    expect(aiChatWorkerState.available).toBe(true);
  });

  test("还没记下机器人身份时 resumeAiChat 拒绝启动，不建线程", () => {
    expect(() => aiChat.resumeAiChat()).toThrow("AI chat cannot start before initAiChat recorded the bot identity.");
    expect(initWorker).not.toHaveBeenCalled();
    expect(workerPosts).toEqual([]);
  });

  test("停机 flush 直接结算成 flushed，不因线程没起而卡住预算", async () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });

    await expect(aiChat.flushAiMemory(1_000)).resolves.toBe("flushed");
    await expect(aiChat.terminateAiChat()).resolves.toBeUndefined();
  });
});
