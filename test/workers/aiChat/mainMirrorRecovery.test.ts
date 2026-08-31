import { beforeEach, describe, expect, mock, test } from "bun:test";
import { aiRecordMessageFixture } from "../../helpers/aiMemoryFixtures";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";
import { getMoodConfig } from "../../../packages/config/mood";
import { getPersona } from "../../../packages/config/persona";
import { getReactionConfig } from "../../../packages/config/reactions";
import { getStickerConfig } from "../../../packages/config/stickers";
import { SUPER_ADMIN_USER_ID } from "../../../packages/config/telegram";
import type { AiChatWorkerEvent, AiChatWorkerMessage, AiInitMessage } from "../../../packages/types/aiChat/protocol";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryDeleteDiskMessage,
  AiMemoryDiskMessage,
  AiMemoryForgetDiskMessage,
  AiMemoryPersistedReply,
  DiskBusinessMessage,
  DiskIORecoveryTransport,
  DiskIORespawnListener,
  StickerCatalogDiskMessage,
} from "../../../packages/types/diskIO";

type AiDiskMessage =
  | AiMemoryDiskMessage
  | AiMemoryDeleteDiskMessage
  | AiMemoryForgetDiskMessage
  | StickerCatalogDiskMessage;

const workerPosts: AiChatWorkerMessage[] = [];
const diskPosts: AiDiskMessage[] = [];
const initWorker = mock((): void => {});
let workerPostAccepted: boolean = true;
let supervisorOptions: {
  onEvent: (event: AiChatWorkerEvent) => void;
  onRespawn: (post: (message: AiChatWorkerMessage) => boolean) => void;
  onGiveUp: () => void;
} | undefined;
let diskRespawn: DiskIORespawnListener | undefined;
let diskDeletePersisted: ((reply: AiMemoryDeletedPersistedReply) => void) | undefined;
let diskMemoryPersisted: ((reply: AiMemoryPersistedReply) => void) | undefined;
let diskGaveUp: (() => void) | undefined;
const aiEnabledChats = new Set<number>();

mock.module("../../../packages/infra/supervisedWorker", () => ({
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
mock.module("../../../packages/infra/diskIO", () => ({
  postDiskIO: (message: AiDiskMessage): boolean => { diskPosts.push(message); return true; },
  onAiMemoryDeletedPersisted: (callback: (reply: AiMemoryDeletedPersistedReply) => void): void => {
    diskDeletePersisted = callback;
  },
  onAiMemoryPersisted: (callback: (reply: AiMemoryPersistedReply) => void): void => {
    diskMemoryPersisted = callback;
  },
  // 按 owner 名捕获，不用「最后注册的那个」：同一个 isolate 里还有别的领域
  // （群状态、群问答、身份策略）也会登记重放回调，谁最后被 import 就会顶掉
  // 前一个，测试于是悄悄换成在验别人的重放。
  onDiskIORespawn: (owner: string, _priority: number, listener: DiskIORespawnListener): void => {
    if (owner === "AI memory") diskRespawn = listener;
  },
  onDiskIOGiveUp: (callback: () => void): void => { diskGaveUp = callback; },
  relayLogMessage: (): boolean => true,
}));
// hydrate 的删除判据要求 state.json 确实认识这个群（见 aiChat/index.ts）：
// 只在状态表里、开关不是 true 的群才回收磁盘残留。开着的群必然在表里，
// 因此这里取两个集合的并集。
const knownChats = new Set<number>();
mock.module("../../../packages/infra/storage/stateStore", () => ({
  getChatState: (chatId: number) => ({ isAIChatEnabled: aiEnabledChats.has(chatId) }),
  getChatStateCache: (): Map<number, unknown> =>
    new Map([...aiEnabledChats, ...knownChats].map((chatId: number): [number, unknown] => [chatId, {}])),
}));

const aiChat = await import("../../../packages/aiChat");
const {
  lastInitState,
  latestAiMemories,
  latestStickerCatalogs,
  moodRequestCounter,
  moodRequestWaiters,
  purgedAiMemoryChats,
  aiChatWorkerState,
  aiMemoryDeleteWaiters,
  aiMemoryRevisionCounters,
  aiChatInvalidateRequestCounter,
  aiChatInvalidateWaiters,
  latestAiMemoryRevisions,
  pendingAiMemoryDeletes,
  postPurgeAiMemoryPersistRevisions,
} = await import("../../../packages/cache/main/aiChat");

beforeEach(() => {
  workerPosts.length = 0;
  diskPosts.length = 0;
  initWorker.mockClear();
  lastInitState.current = null;
  latestAiMemories.clear();
  latestAiMemoryRevisions.clear();
  aiMemoryRevisionCounters.clear();
  pendingAiMemoryDeletes.clear();
  postPurgeAiMemoryPersistRevisions.clear();
  for (const waiters of aiMemoryDeleteWaiters.values()) {
    for (const waiter of waiters) clearTimeout(waiter.timer);
  }
  aiMemoryDeleteWaiters.clear();
  for (const waiter of aiChatInvalidateWaiters.values()) clearTimeout(waiter.timer);
  aiChatInvalidateWaiters.clear();
  aiChatInvalidateRequestCounter.current = 0;
  for (const waiter of moodRequestWaiters.values()) clearTimeout(waiter.timer);
  moodRequestWaiters.clear();
  moodRequestCounter.current = 0;
  latestStickerCatalogs.clear();
  purgedAiMemoryChats.clear();
  aiChatWorkerState.available = false;
  aiEnabledChats.clear();
  knownChats.clear();
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

    const aiRespawnPosts: AiChatWorkerMessage[] = [];
    supervisorOptions!.onRespawn((message) => {
      aiRespawnPosts.push(message);
      return true;
    });

    expect(initWorker).toHaveBeenCalledTimes(1);
    expect(aiRespawnPosts).toEqual([
      {
        type: "init",
        botInfo: { id: 99, username: "ninja_bot", first_name: "Ninja" },
        superAdminUserId: SUPER_ADMIN_USER_ID,
        // 重放的是进程启动时那条 init 本身，配置快照因此逐字节相同——新
        // isolate 不会顺手加载磁盘上已经被改过的 agent.json。
        agent: getAgentDeploymentConfig(),
        mood: getMoodConfig(),
        reactions: getReactionConfig(),
        stickers: getStickerConfig(),
        persona: getPersona(),
      },
      { type: "hydrate", memories: new Map([[-1001, "latest-memory"]]) },
      { type: "hydrateStickerCatalog", catalogs: new Map([["pack_a", "latest-catalog"]]) },
    ]);
    expect((aiRespawnPosts[0] as AiInitMessage).agent).toBe(getAgentDeploymentConfig());

    diskPosts.length = 0;
    const recoveryTransport: DiskIORecoveryTransport = {
      post: (message: DiskBusinessMessage): boolean => {
        diskPosts.push(message as AiDiskMessage);
        return true;
      },
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("Unexpected luck secret request.");
      },
    };
    expect(await diskRespawn!(recoveryTransport)).toBeTrue();
    expect(await diskRespawn!({
      ...recoveryTransport,
      post: (): boolean => false,
    })).toBeFalse();
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
    const invalidateRequest: AiChatWorkerMessage | undefined =
      workerPosts.find((message: AiChatWorkerMessage): boolean => message.type === "invalidateChat");
    if (invalidateRequest?.type !== "invalidateChat") throw new Error("Expected an invalidateChat request");
    supervisorOptions!.onEvent({
      type: "chatInvalidated",
      chatId: -1001,
      requestId: invalidateRequest.requestId,
    });
    await invalidated;
  });

  test("启动恢复不会 hydrate 已关闭群，并为磁盘残留安排 durable 删除", () => {
    aiEnabledChats.add(-1002);
    // -1001 在 state.json 里，只是开关不是 true —— 这才是管理员关掉了它。
    knownChats.add(-1001);
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

  test("state.json 不认识的群：留着文件并点名，不当成「已关闭」删掉", () => {
    // 「群在状态表里、开关不是 true」是管理员关掉了它；「群根本不在状态表里」
    // 说明状态自己丢了（LKG 回滚等），这时没有任何权威依据支持删除——而那
    // 恰恰是最该保住记忆的时刻。留下的是可回收的垃圾，删错的是找不回来的数据。
    aiEnabledChats.add(-1002);
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });

    aiChat.hydrateAiMemory(new Map([
      [-1001, "orphaned-memory"],
      [-1002, "enabled-memory"],
    ]));

    expect(pendingAiMemoryDeletes.size).toBe(0);
    expect(diskPosts.every((message: AiDiskMessage): boolean => message.type !== "deleteAiMemory")).toBeTrue();
    expect(workerPosts.at(-1)).toEqual({
      type: "hydrate",
      memories: new Map([[-1002, "enabled-memory"]]),
    });
  });

  test("purge 后首份新记忆跨两级 Worker 立即持久化，确认后恢复普通批处理", async () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });
    const invalidated = aiChat.invalidateAiChat(-1001, true);
    const invalidateRequest: AiChatWorkerMessage | undefined = workerPosts.at(-1);
    if (invalidateRequest?.type !== "invalidateChat") throw new Error("Expected an invalidateChat request");
    supervisorOptions!.onEvent({ type: "memoryDeleted", chatId: -1001 });
    diskDeletePersisted!({ type: "aiMemoryDeletedPersisted", chatId: -1001, revision: 1 });
    supervisorOptions!.onEvent({
      type: "chatInvalidated",
      chatId: -1001,
      requestId: invalidateRequest.requestId,
    });
    await invalidated;
    workerPosts.length = 0;
    diskPosts.length = 0;

    // 每次都现造一份载荷，与生产一致：recordChatMessage 会就地置位
    // persistImmediately，复用同一个对象投第二次会把上一次的标志带过去
    // （所有权约定见 aiChat/messageIngress.ts）。
    const memory = (messageId: number, text: string) => aiRecordMessageFixture({
      chatId: -1001,
      senderId: 7,
      firstName: "Alice",
      lastName: "",
      messageId,
      text,
    });
    aiChat.recordChatMessage(memory(10, "new memory"));
    expect(workerPosts.at(-1)).toEqual({ ...memory(10, "new memory"), persistImmediately: true });
    expect(postPurgeAiMemoryPersistRevisions.get(-1001)).toBeNull();

    supervisorOptions!.onEvent({
      type: "memory",
      chatId: -1001,
      snapshot: "post-purge-memory",
      persistImmediately: true,
    });
    expect(diskPosts.at(-1)).toEqual({
      type: "aiMemory",
      chatId: -1001,
      revision: 2,
      snapshot: "post-purge-memory",
      persistImmediately: true,
    });
    expect(postPurgeAiMemoryPersistRevisions.get(-1001)).toBe(2);

    diskPosts.length = 0;
    const recoveryTransport: DiskIORecoveryTransport = {
      post: (message: DiskBusinessMessage): boolean => {
        diskPosts.push(message as AiDiskMessage);
        return true;
      },
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("Unexpected luck secret request.");
      },
    };
    expect(await diskRespawn!(recoveryTransport)).toBeTrue();
    expect(await diskRespawn!({
      ...recoveryTransport,
      post: (): boolean => false,
    })).toBeFalse();
    expect(diskPosts).toEqual([{
      type: "aiMemory",
      chatId: -1001,
      revision: 2,
      snapshot: "post-purge-memory",
      persistImmediately: true,
    }]);

    // 快照已交给 Disk I/O 后由主线程镜像负责重放，后续记录恢复普通上报。
    aiChat.recordChatMessage(memory(11, "second memory"));
    expect(workerPosts.at(-1)).toHaveProperty("persistImmediately", false);

    diskMemoryPersisted!({ type: "aiMemoryPersisted", chatId: -1001, revision: 2 });
    expect(postPurgeAiMemoryPersistRevisions.has(-1001)).toBeFalse();

    aiChat.recordChatMessage(memory(12, "normal memory"));
    expect(workerPosts.at(-1)).toHaveProperty("persistImmediately", false);
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

  test("心情查询/重抽回执按 requestId 结算；崩溃重启与投递失败都立即 reject", async () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });

    const queried = aiChat.queryAiMood(-1001);
    const queryRequest = workerPosts.at(-1);
    if (queryRequest?.type !== "queryMood") throw new Error("Expected a queryMood request");
    expect(queryRequest.deadlineAt).toBeGreaterThan(Date.now());
    supervisorOptions!.onEvent({ type: "moodQueried", chatId: -1001, requestId: queryRequest.requestId, moodName: "平静" });
    await expect(queried).resolves.toBe("平静");
    expect(moodRequestWaiters.size).toBe(0);

    const switched = aiChat.switchAiMood(-1001);
    const switchRequest = workerPosts.at(-1);
    if (switchRequest?.type !== "switchMood") throw new Error("Expected a switchMood request");
    expect(switchRequest.deadlineAt).toBeGreaterThan(Date.now());
    supervisorOptions!.onEvent({ type: "moodSwitched", chatId: -1001, requestId: switchRequest.requestId, moodName: "摆烂" });
    await expect(switched).resolves.toBe("摆烂");
    expect(moodRequestWaiters.size).toBe(0);

    // 迟到/重复回执不应产生副作用。
    supervisorOptions!.onEvent({ type: "moodSwitched", chatId: -1001, requestId: switchRequest.requestId, moodName: "开心" });

    const crashed = aiChat.queryAiMood(-1001);
    supervisorOptions!.onRespawn(() => true);
    await expect(crashed).rejects.toThrow("AI Worker crashed before acknowledging the mood request.");
    expect(moodRequestWaiters.size).toBe(0);

    workerPostAccepted = false;
    await expect(aiChat.switchAiMood(-1001)).rejects.toThrow("AI Worker is unavailable.");
    expect(moodRequestWaiters.size).toBe(0);
    expect(aiChatWorkerState.available).toBeFalse();
  });

  test("revision 计数器只在 teardown 之后丢掉，还有在途墓碑时留着", async () => {
    const { forgetAiMemoryRevisionCounter } = await import("../../../packages/aiChat/memoryMirror");
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });

    const deleted = aiChat.invalidateAiChat(-1001, true);
    // 墓碑还没拿到 durable 回执：这时清掉计数器，重置后的 revision 1 会与在途
    // 的那一号撞车，一条过期回执就能把新记忆判成已删。
    forgetAiMemoryRevisionCounter(-1001);
    expect(aiMemoryRevisionCounters.get(-1001)).toBe(1);

    diskDeletePersisted!({ type: "aiMemoryDeletedPersisted", chatId: -1001, revision: 1 });
    const invalidateRequest: AiChatWorkerMessage | undefined =
      workerPosts.find((message: AiChatWorkerMessage): boolean => message.type === "invalidateChat");
    if (invalidateRequest?.type !== "invalidateChat") throw new Error("Expected an invalidateChat request");
    supervisorOptions!.onEvent({
      type: "chatInvalidated",
      chatId: -1001,
      requestId: invalidateRequest.requestId,
    });
    await deleted;

    // 全部结算之后才允许摘掉——这是 AI 记忆那套状态里唯一没有容量上界的表。
    forgetAiMemoryRevisionCounter(-1001);
    expect(aiMemoryRevisionCounters.has(-1001)).toBeFalse();
    // 落盘侧的水位线必须同一时刻一起丢：只归零主线程计数器的话，重新启用后的
    // revision 1 会被 Worker 判成迟到消息静默丢弃，直到爬过删除时的旧水位。
    expect(diskPosts.filter((message: AiDiskMessage): boolean => message.type === "forgetAiMemory"))
      .toEqual([{ type: "forgetAiMemory", chatId: -1001 }]);
  });

  test("回归：Disk I/O 放弃自愈时删除 waiter 立刻失败，不干等满超时", async () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });
    // 放弃之后没有替补 Worker：onDiskIORespawn 不会跑，deleteAiMemory 不会重放，
    // durable 回执永远不会来。干等那两秒恰好和同一个 fatal 信号触发的停机抢排空
    // 预算，失败原因也会被表述成超时而不是「Worker 已经放弃」。
    const deleted = aiChat.invalidateAiChat(-1001, true);
    expect(aiMemoryDeleteWaiters.size).toBe(1);

    diskGaveUp!();

    // allSettled 不能在 durable 一侧先失败时提前返回：Worker 侧仍要拿到回执并清
    // 自己的 waiter，随后才向调用方保留原来的单一失败原因。
    expect(aiChatInvalidateWaiters.size).toBe(1);
    const invalidateRequest: AiChatWorkerMessage | undefined =
      workerPosts.find((message: AiChatWorkerMessage): boolean => message.type === "invalidateChat");
    if (invalidateRequest?.type !== "invalidateChat") throw new Error("Expected an invalidateChat request");
    supervisorOptions!.onEvent({
      type: "chatInvalidated",
      chatId: -1001,
      requestId: invalidateRequest.requestId,
    });
    await expect(deleted).rejects.toThrow(
      "Persistence Worker gave up self-healing before the AI memory deletion was durable."
    );
    expect(aiMemoryDeleteWaiters.size).toBe(0);
    expect(aiChatInvalidateWaiters.size).toBe(0);
  });

  test("还有在途状态时不发 forgetAiMemory：水位线要挡住迟到的 upsert", async () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });
    const { forgetAiMemoryRevisionCounter } = await import("../../../packages/aiChat/memoryMirror");

    const deleted = aiChat.invalidateAiChat(-1001, true);
    forgetAiMemoryRevisionCounter(-1001);
    expect(diskPosts.some((message: AiDiskMessage): boolean => message.type === "forgetAiMemory")).toBeFalse();

    diskDeletePersisted!({ type: "aiMemoryDeletedPersisted", chatId: -1001, revision: 1 });
    const invalidateRequest: AiChatWorkerMessage | undefined =
      workerPosts.find((message: AiChatWorkerMessage): boolean => message.type === "invalidateChat");
    if (invalidateRequest?.type !== "invalidateChat") throw new Error("Expected an invalidateChat request");
    supervisorOptions!.onEvent({
      type: "chatInvalidated",
      chatId: -1001,
      requestId: invalidateRequest.requestId,
    });
    await deleted;
  });

  test("Worker 放弃自愈只清 Worker purge guard，不丢未确认的 durable tombstone", async () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });
    const firstDelete = aiChat.invalidateAiChat(-1001, true);
    expect(purgedAiMemoryChats.has(-1001)).toBeTrue();

    supervisorOptions!.onGiveUp();
    expect(aiChatWorkerState.available).toBeFalse();
    expect(purgedAiMemoryChats.size).toBe(0);
    expect(pendingAiMemoryDeletes.get(-1001)).toBe(1);
    // Worker 侧先失败也必须等 durable 删除结算，不能把仍在途的墓碑留给调用方。
    diskDeletePersisted!({ type: "aiMemoryDeletedPersisted", chatId: -1001, revision: 1 });
    await expect(firstDelete).rejects.toThrow(
      "AI Worker gave up before completing chat invalidation."
    );

    const secondDelete = aiChat.invalidateAiChat(-1002, true);
    expect(purgedAiMemoryChats.size).toBe(0);
    expect(diskPosts.at(-1)).toEqual({ type: "deleteAiMemory", chatId: -1002, revision: 1 });
    diskDeletePersisted!({ type: "aiMemoryDeletedPersisted", chatId: -1002, revision: 1 });
    await secondDelete;
  });

  test("Worker 放弃自愈后停机 flush 直接短路，不扣住最终 offset", async () => {
    aiChat.initAiChat({ id: 99, username: "ninja_bot", first_name: "Ninja" });
    expect(lastInitState.current).not.toBeNull();

    supervisorOptions!.onGiveUp();

    // 身份注入记录必须跟着一起清掉：flushAiMemory 用它判断「这条线根本没起来」。
    // 留着的话停机 flush 会越过短路、进 barrier 后因 post 失败结算成 "failed"，
    // 于是 flushAllToDisk 返回 false、wait() 拒绝确认最终 offset，Telegram 重投
    // 上次确认点之后的全部更新，重复执行复读/命令回执这些非幂等副作用。而本功能
    // 既定的降级只是「AI 闲聊静默停用到下次重启」。
    expect(lastInitState.current).toBeNull();
    workerPosts.length = 0;
    await expect(aiChat.flushAiMemory(1_000)).resolves.toBe("flushed");
    expect(workerPosts).toEqual([]);
  });
});
