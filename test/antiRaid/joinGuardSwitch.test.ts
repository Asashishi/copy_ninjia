import type { FlushResult } from "../../packages/types/lifecycle";
import { diskIOStub } from "../helpers/diskIOMock";
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type { Message } from "grammy/types";
import type { AntiRaidWorkerMessage } from "../../packages/types";
import type { AdDetectionMessageContext } from
  "../../packages/types/antiRaid/adDetect";
import type { DiskBusinessMessage, AdSampleDiskMessage } from "../../packages/types/diskIO";

/**
 * `/antiraid` 这道开关在主线程投递侧的边界（见 antiRaid/updateIngress.ts）。
 *
 * 要守的是**范围**：关掉的只有入群验证与防冲群私密模式这一条链路，同样跑在
 * Anti-Raid Worker 里的黑名单秒踢、广告检测、防刷屏计数，以及 `/batch_kick`
 * 依赖的入群日志，一律照旧——它们各有各的开关，把它们一起关掉是这次改动最
 * 容易犯、也最难在群里发现的错。
 */

/** 测试观察业务写入与诊断消息。 */
type TestDiskMessage = DiskBusinessMessage | AdSampleDiskMessage;

const workerPosts: AntiRaidWorkerMessage[] = [];
const diskPosts: TestDiskMessage[] = [];
const answeredCallbacks: { callbackQueryId: string; text?: string }[] = [];
const temporaryAdBypassActivityMessages: Message[] = [];
const temporaryAdBypassActivityTimes: number[] = [];
/** 逐用例可改的群状态；缺省是「已开防刷屏、未开入群守卫」。 */
const chatState: Record<string, boolean> = {};

mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub(),
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  clearChatStateField: (): boolean => false,
  getChatState: () => chatState,
  getChatStateCache: () => new Map(),
  getOrCreateChatState: () => ({}),
  persistChatState: async (): Promise<void> => {},
  flushStateToDisk: async (): Promise<FlushResult> => "flushed",
  saveChatStateInBackground: (): void => {},
}));
mock.module("../../packages/infra/telegram/actions", () => ({
  answerCallbackQuery: async (params: { callbackQueryId: string; text?: string }): Promise<boolean> => {
    answeredCallbacks.push(params);
    return true;
  },
  sendMessage: async (): Promise<number | undefined> => undefined,
  deleteMessageAfter: (): void => {},
  deleteMessageWithOutcome: async (): Promise<"deleted"> => "deleted",
}));
mock.module("../../packages/infra/telegram/client", () => ({
  installTelegramApi: (): void => {},
  logApiError: (): void => {},
  telegramApi: { kind: "guard-api" },
}));
/**
 * 机器人在本群的管理员判定：`undefined` 逼 ingress 退回一次现查
 * （resolveBotAdminStatus），其余值走同步快路径。默认是已确证的管理员。
 */
const botAdminStatus: { cached: boolean | undefined; resolved: boolean } = { cached: true, resolved: true };
mock.module("../../packages/infra/botAdmin", () => ({
  resolveBotAdminStatus: async (): Promise<boolean> => botAdminStatus.resolved,
  // ingress 的同步快路径读它；未确证时返回 undefined 才会退回上面那次现查。
  cachedBotAdminStatus: (): boolean | undefined => botAdminStatus.cached,
  markBotAdminObserved: async (): Promise<void> => {},
  botChatPermissionsIn: async (): Promise<undefined> => undefined,
  registerBotPermissionObserver: (): void => {},
  ensureBotChatPermissions: (): void => {},
  botCanDeleteMessagesIn: (): true => true,
}));
mock.module("../../packages/infra/supervisedWorker", () => ({
  superviseWorker: () => ({
    init(): void {},
    post: (message: AntiRaidWorkerMessage): boolean => {
      workerPosts.push(message);
      return true;
    },
    terminate: async (): Promise<void> => {},
  }),
}));
mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  flushDiskIO: async (): Promise<FlushResult> => "flushed",
  flushDiskIODomain: async (): Promise<FlushResult> => "flushed",
  isDiskIOBuffering: (): boolean => false,
  flushDiskIODomainOutcome: async (): Promise<{ result: FlushResult }> => ({ result: "flushed" }),
  onDiskIORespawn: (): void => {},
  onIdentityStoragePersisted: (): void => {},
  onVerificationPersisted: (): void => {},
  postDiskIO: (message: TestDiskMessage): boolean => {
    diskPosts.push(message);
    return true;
  },
  postDiskIODiagnostic: (message: TestDiskMessage): boolean => {
    diskPosts.push(message);
    return true;
  },
})));
mock.module("../../packages/antiRaid/temporaryAdBypass", () => ({
  recordEligibleTemporaryAdBypassActivity(
    options: AdDetectionMessageContext
  ): boolean {
    temporaryAdBypassActivityMessages.push(options.message);
    temporaryAdBypassActivityTimes.push(options.now);
    return true;
  },
}));

const {
  handleAntiRaidMessageIngress,
  handleChatMemberUpdate,
  handleVerificationCallback,
} = await import("../../packages/antiRaid");
const { blocklistEntryCache, whitelistEntryCache } =
  await import("../../packages/cache/main/identityStorage");
const { runWithUpdateAbortSignal } = await import("../../packages/infra/updateContext");
const { chatIsSupergroupById } = await import("../../packages/cache/main/antiRaid/chatKind");
const { activeVerificationSnapshots } = await import("../../packages/cache/main/antiRaid/verificationMirror");

/** 一条「从不在群里变成群成员」的 chat_member 更新。 */
function joinUpdate(userId: number): never {
  return {
    chatMember: {
      chat: { id: -1001, type: "supergroup" },
      from: { id: 5, is_bot: false, first_name: "Inviter" },
      old_chat_member: { status: "left", user: { id: userId, is_bot: false, first_name: "Zako" } },
      new_chat_member: { status: "member", user: { id: userId, is_bot: false, first_name: "Zako" } },
      date: 1,
    },
    me: { id: 999 },
  } as never;
}

/** 一条「非匿名管理员被降回普通成员」的 chat_member 更新。 */
function demoteUpdate(userId: number): never {
  return {
    chatMember: {
      chat: { id: -1001, type: "supergroup" },
      from: { id: 5, is_bot: false, first_name: "Owner" },
      old_chat_member: {
        status: "administrator",
        is_anonymous: false,
        user: { id: userId, is_bot: false, first_name: "ExAdmin" },
      },
      new_chat_member: { status: "member", user: { id: userId, is_bot: false, first_name: "ExAdmin" } },
      date: 3,
    },
    me: { id: 999 },
  } as never;
}

/** 一条「群成员变成已离开」的 chat_member 更新。 */
function leaveUpdate(userId: number): never {
  return {
    chatMember: {
      chat: { id: -1001, type: "supergroup" },
      from: { id: userId, is_bot: false, first_name: "Zako" },
      old_chat_member: { status: "member", user: { id: userId, is_bot: false, first_name: "Zako" } },
      new_chat_member: { status: "left", user: { id: userId, is_bot: false, first_name: "Zako" } },
      date: 2,
    },
    me: { id: 999 },
  } as never;
}

function typesOf(): string[] {
  return workerPosts.map((message): string => message.type);
}

beforeEach(() => {
  workerPosts.length = 0;
  diskPosts.length = 0;
  answeredCallbacks.length = 0;
  temporaryAdBypassActivityMessages.length = 0;
  temporaryAdBypassActivityTimes.length = 0;
  blocklistEntryCache.clear();
  whitelistEntryCache.clear();
  activeVerificationSnapshots.clear();
  chatIsSupergroupById.clear();
  for (const key of Object.keys(chatState)) delete chatState[key];
  chatState.isFloodControlEnabled = true;
  botAdminStatus.cached = true;
  botAdminStatus.resolved = true;
});

describe("入群守卫开关（主线程投递侧）", () => {
  test("关着时不投 join/left", async () => {
    await handleChatMemberUpdate(joinUpdate(42));
    await handleChatMemberUpdate(leaveUpdate(42));

    expect(typesOf()).not.toContain("join");
    expect(typesOf()).not.toContain("left");
  });

  test("关着时邀请者豁免变更照投：这条不受开关管", async () => {
    // 缓存条目按 fetchedAt 判过期，applyAdminChange 不刷新它（见
    // workers/antiRaid/adminCache.ts）。漏掉这条，「关闭 → 降权 → 重新开启」挤在
    // 同一个 ADMIN_CACHE_TTL_MS 窗口里时，被降权的人在剩余时间里拉进来的人仍会
    // 免验证。投过去没有副作用：applyAdminChange 只改缓存，不碰状态机。
    await handleChatMemberUpdate(demoteUpdate(7));

    expect(workerPosts).toContainEqual(expect.objectContaining({
      type: "adminsChanged",
      chatId: -1001,
      userId: 7,
      isInviterExempt: false,
    }));
  });

  test("开着时照常投 join/left", async () => {
    chatState.isAntiRaidEnabled = true;

    await handleChatMemberUpdate(joinUpdate(42));
    await handleChatMemberUpdate(leaveUpdate(42));

    expect(typesOf()).toContain("join");
    expect(typesOf()).toContain("left");
  });

  test("关着时入群日志照记：那是 /batch_kick 的依据，不归这道开关管", async () => {
    await handleChatMemberUpdate(joinUpdate(42));

    expect(diskPosts).toContainEqual(expect.objectContaining({
      type: "joinLog",
      chatId: -1001,
      userId: 42,
    }));
  });

  test("关着时黑名单照样秒踢，但这次入群不计进反刷群窗口", async () => {
    blocklistEntryCache.set(42, {
      blockedAt: "2026/08/06 00:00:00",
      meta: { firstName: "Zako", lastName: "", username: "" },
    });

    await handleChatMemberUpdate(joinUpdate(42));

    const removal: AntiRaidWorkerMessage | undefined =
      workerPosts.find((message): boolean => message.type === "removeBlockedMembers");
    expect(removal).toBeDefined();
    // joinedAt 是给私密模式滑动窗口补记的那一笔；守卫关着就不该由黑名单成员的
    // 入群把阈值凑出来——否则「关掉了」的群还是会自己锁上。
    expect(removal).toMatchObject({ chatId: -1001, userIds: [42], joinedAt: undefined });
    expect(typesOf()).not.toContain("join");
  });

  test("关着时不投验证用的 message，刷屏计数照投", async () => {
    // 评论区线索这一路不依赖待验证镜像，最容易在关掉之后继续白投。
    await handleAntiRaidMessageIngress({
      chat: { id: -1001, type: "supergroup" },
      message_id: 9,
      from: { id: 42, is_bot: false, first_name: "Zako" },
      message_thread_id: 3,
      text: "hi",
    } as never, 999);

    expect(typesOf()).not.toContain("message");
    expect(typesOf()).toContain("floodCandidate");
  });

  test("稳定态普通群消息同步返回 false，不为每条群消息分配 Promise", () => {
    // 管理员身份已确证（cachedBotAdminStatus 命中）、没有黑名单频道身份、不是
    // 服务消息、待验证镜像为空：整条判定全同步。返回 Promise 就意味着每条群
    // 消息都白付一次 Promise 分配与一个微任务回合（见 app/registerHandlers.ts
    // 的 claimOrContinue）。这条断言是那条形态契约唯一的守卫。
    const started: boolean | Promise<boolean> = handleAntiRaidMessageIngress({
      chat: { id: -1001, type: "supergroup" },
      message_id: 11,
      from: { id: 42, is_bot: false, first_name: "Zako" },
      text: "普通群消息",
    } as never, 999);

    expect(started).toBe(false);
    // 同步返回不等于跳过投递：刷屏计数照样在同一次调用里投出去。
    expect(typesOf()).toContain("floodCandidate");
  });

  test("只有用户内容消息进入临时广告免检累计，平台服务事件全部跳过", () => {
    chatState.isAdDetectEnabled = true;
    const contentMessages: readonly Partial<Message>[] = [
      { text: "text" },
      { photo: [] },
      { sticker: {} as never },
      { paid_media: {} as never },
      { checklist: {} as never },
    ];
    const serviceMessages: readonly Partial<Message>[] = [
      { pinned_message: {} as never },
      { new_chat_title: "新标题" },
      { forum_topic_created: {} as never },
      { video_chat_started: {} as never },
      { successful_payment: {} as never },
      { giveaway: {} as never },
    ];
    let messageId: number = 100;
    for (const content of contentMessages) {
      handleAntiRaidMessageIngress({
        chat: { id: -1001, type: "supergroup" },
        message_id: messageId++,
        date: 1,
        from: { id: 42, is_bot: false, first_name: "Zako" },
        ...content,
      } as Message, 999);
    }
    for (const service of serviceMessages) {
      handleAntiRaidMessageIngress({
        chat: { id: -1001, type: "supergroup" },
        message_id: messageId++,
        date: 1,
        from: { id: 42, is_bot: false, first_name: "Zako" },
        ...service,
      } as Message, 999);
    }

    expect(temporaryAdBypassActivityMessages).toHaveLength(contentMessages.length);
    expect(temporaryAdBypassActivityMessages.map(
      (message: Message): number => message.message_id
    )).toEqual([100, 101, 102, 103, 104]);
  });

  test("同一条 update 只读一次墙钟，累计上下文与刷屏投递共用那一个时刻", async () => {
    chatState.isAdDetectEnabled = true;
    const now: number = 1_800_000_000_000;
    const nowSpy: ReturnType<typeof spyOn> = spyOn(Date, "now")
      .mockReturnValue(now);
    try {
      // 生产里 bot.handleUpdate 一定跑在这个作用域内（见 app/updateRunner.ts），
      // 广告判定上下文与刷屏候选因此共用 updateNow 那唯一一次读取。
      await runWithUpdateAbortSignal(
        new AbortController().signal,
        async (): Promise<void> => {
          await handleAntiRaidMessageIngress({
            chat: { id: -1001, type: "supergroup" },
            message_id: 200,
            date: 1,
            from: { id: 42, is_bot: false, first_name: "Zako" },
            text: "普通群消息",
          } as Message, 999);
        }
      );
      expect(nowSpy).toHaveBeenCalledTimes(1);
      expect(temporaryAdBypassActivityTimes).toEqual([now]);
      const flood: AntiRaidWorkerMessage | undefined = workerPosts.find(
        (message: AntiRaidWorkerMessage): boolean => message.type === "floodCandidate"
      );
      expect(flood).toEqual({
        type: "floodCandidate",
        chatId: -1001,
        userId: 42,
        observedAt: now,
        label: "Zako",
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("关着时入群公告照样被吞掉：服务消息本来就不该进复读/AI 流水线", async () => {
    const handled: boolean = await handleAntiRaidMessageIngress({
      chat: { id: -1001, type: "supergroup" },
      message_id: 10,
      from: { id: 5, is_bot: false, first_name: "Inviter" },
      new_chat_members: [{ id: 42, is_bot: false, first_name: "Zako" }],
    } as never, 999);

    expect(handled).toBeTrue();
    expect(typesOf()).not.toContain("join");
  });

  test("关着时旧按钮当场应答，不投给 Worker", async () => {
    await handleVerificationCallback({
      callbackQuery: {
        id: "cb-1",
        data: "verify:42",
        from: { id: 7, is_bot: false, first_name: "Clicker" },
        message: { chat: { id: -1001 } },
      },
    } as never);

    expect(answeredCallbacks).toHaveLength(1);
    expect(answeredCallbacks[0]?.callbackQueryId).toBe("cb-1");
    expect(typesOf()).not.toContain("callback");
  });

  test("开着时按钮照常投给 Worker", async () => {
    chatState.isAntiRaidEnabled = true;

    await handleVerificationCallback({
      callbackQuery: {
        id: "cb-2",
        data: "verify:42",
        from: { id: 7, is_bot: false, first_name: "Clicker" },
        message: { chat: { id: -1001 } },
      },
    } as never);

    expect(typesOf()).toContain("callback");
    expect(workerPosts).toContainEqual(expect.objectContaining({
      type: "callback",
      action: "self",
      targetUserId: 42,
    }));
  });

  test("「通过」按钮按前缀投成 approve，其它前缀的回调不认领", async () => {
    chatState.isAntiRaidEnabled = true;

    await handleVerificationCallback({
      callbackQuery: {
        id: "cb-3",
        data: "approve:42",
        from: { id: 900, is_bot: false, first_name: "Admin" },
        message: { chat: { id: -1001 } },
      },
    } as never);
    await handleVerificationCallback({
      callbackQuery: {
        id: "cb-4",
        data: "qa_page:1",
        from: { id: 900, is_bot: false, first_name: "Admin" },
        message: { chat: { id: -1001 } },
      },
    } as never);

    expect(workerPosts.filter((message): boolean => message.type === "callback")).toEqual([
      expect.objectContaining({ type: "callback", action: "approve", targetUserId: 42, callbackQueryId: "cb-3" }),
    ]);
    expect(answeredCallbacks).toHaveLength(0);
  });
});

describe("机器人不是本群管理员时的投递门禁", () => {
  /** 一条普通群消息；new_chat_members 为真时是入群公告。 */
  function groupMessage(overrides: Record<string, unknown> = {}): never {
    return {
      message_id: 11,
      date: 1,
      chat: { id: -1001, type: "supergroup" },
      from: { id: 42, is_bot: false, first_name: "Zako" },
      text: "喵",
      ...overrides,
    } as never;
  }

  test("已确证不是管理员时一条都不投，入群公告仍被吞掉", async () => {
    botAdminStatus.cached = false;
    chatState.isAntiRaidEnabled = true;

    const announcement: boolean = await handleAntiRaidMessageIngress(
      groupMessage({ new_chat_members: [{ id: 43, is_bot: false, first_name: "New" }] }),
      999
    );
    const ordinary: boolean = await handleAntiRaidMessageIngress(groupMessage(), 999);

    expect(announcement).toBeTrue();
    expect(ordinary).toBeFalse();
    // 群类型镜像刻意排在管理员门禁之前，其余一条都不投。
    expect(typesOf()).toEqual(["chatKind"]);
  });

  test("未确证时退回一次现查，现查说不是管理员同样不投", async () => {
    botAdminStatus.cached = undefined;
    botAdminStatus.resolved = false;
    chatState.isAntiRaidEnabled = true;

    const announcement: boolean = await handleAntiRaidMessageIngress(
      groupMessage({ new_chat_members: [{ id: 43, is_bot: false, first_name: "New" }] }),
      999
    );

    expect(announcement).toBeTrue();
    expect(typesOf()).toEqual(["chatKind"]);
  });

  test("未确证但现查说是管理员时照常走投递段", async () => {
    botAdminStatus.cached = undefined;
    botAdminStatus.resolved = true;
    chatState.isAntiRaidEnabled = true;

    await handleAntiRaidMessageIngress(
      groupMessage({ new_chat_members: [{ id: 43, is_bot: false, first_name: "New" }] }),
      999
    );

    expect(typesOf()).toContain("join");
  });

  test("私聊消息不进这条链路", async () => {
    expect(await handleAntiRaidMessageIngress(
      groupMessage({ chat: { id: 42, type: "private" } }),
      999
    )).toBeFalse();
    expect(typesOf()).toEqual([]);
  });
});

describe("验证按钮的非法目标", () => {
  async function click(data: string, id: string): Promise<void> {
    await handleVerificationCallback({
      callbackQuery: {
        id,
        data,
        from: { id: 7, is_bot: false, first_name: "Clicker" },
        message: { chat: { id: -1001 } },
      },
    } as never);
  }

  // NaN / 0 / 负数进 Worker 会生成一个永远不会被结算的状态键，按钮只会一直转。
  // 后四种是裸 `Number()` 会放行、而本 bot 从不生成的非规范写法：指数、十六进制、
  // 前导空白、带小数点与带正号（见 libs/telegramId.ts 的 parseUserIdArgument）。
  test.each([
    "verify:abc", "verify:", "verify:0", "verify:-5", "approve:abc",
    "verify:1e3", "verify:0x10", "verify: 12", "verify:12.0", "verify:+5",
  ])(
    "%s 当场以「非法目标」应答，不投给 Worker",
    async (data: string) => {
      chatState.isAntiRaidEnabled = true;

      await click(data, "cb-invalid");

      expect(answeredCallbacks).toHaveLength(1);
      expect(answeredCallbacks[0]?.callbackQueryId).toBe("cb-invalid");
      expect(typesOf()).not.toContain("callback");
    }
  );
});
