import { installTemporaryMessageWorkerMock } from "../../helpers/temporaryMessageWorkerMock";
installTemporaryMessageWorkerMock();
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BotActionPermissions } from "../../../packages/types/telegram";
import type { FloodCandidateMessage } from "../../../packages/types/antiRaid";
import type { FloodWindowEntry } from "../../../packages/types/antiRaid/internal";

const errorLogs: string[] = [];
const sentTexts: string[] = [];
const deleteAfterCalls: {
  chatId: number;
  messageId: number;
  delayMs: number;
  api?: unknown;
  batchOnFlush?: boolean;
}[] = [];
/** 每条公告请求带的取消信号；公告可能等待 grammY 消息桶。 */
const noticeSignals: (AbortSignal | undefined)[] = [];
const muteCalls: { chatId: number; userId: number; mutedUntil: number }[] = [];

/** 各群的管理员集合；undefined 表示缓存未命中，freshAdminIds 据此返回 undefined。 */
const cachedAdmins = new Map<number, Set<number>>();
const fetchedAdmins = new Map<number, Set<number>>();
let muteOutcome: "muted" | "forbidden" | "failed" = "muted";
/** 模拟三态之外的意外异常，验证处置的兜底 catch。 */
let muteThrows: boolean = false;
let noticeMessageId: number | undefined = 500;
/** 把下一次禁言/身份确证卡在途中，模拟网络或分类 429 退避尚未结算的窗口。 */
let holdMute: boolean = false;
let releaseMute: (() => void) | undefined;
let holdAdminFetch: boolean = false;
let releaseAdminFetch: (() => void) | undefined;

mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));
mock.module("../../../packages/infra/telegram", () => ({
  telegramApi: { kind: "guard-api" },
  muteChatMemberWithOutcome: async (
    params: { chatId: number; userId: number; mutedUntil: number; signal?: AbortSignal }
  ): Promise<string> => {
    muteCalls.push({ chatId: params.chatId, userId: params.userId, mutedUntil: params.mutedUntil });
    if (muteThrows) throw new Error("unexpected transport failure");
    if (holdMute) {
      holdMute = false;
      await new Promise<void>((resolve) => { releaseMute = resolve; });
    }
    // 真实实现里排队中的请求被 abort 就结算成 failed，原因由统一错误边界处理。
    if (params.signal?.aborted === true) return "failed";
    return muteOutcome;
  },
  sendMessage: async (params: { text: string; signal?: AbortSignal }): Promise<number | undefined> => {
    noticeSignals.push(params.signal);
    // 真实实现里被 abort 的请求返回 undefined（错误由统一边界吞掉）。
    if (params.signal?.aborted === true) return undefined;
    sentTexts.push(params.text);
    return noticeMessageId;
  },
  deleteMessageAfter: (params: {
    chatId: number;
    messageId: number;
    delayMs: number;
    api?: unknown;
    batchOnFlush?: boolean;
  }): void => {
    deleteAfterCalls.push(params);
  },
}));
const fetchAdminIds = async (chatId: number): Promise<Set<number>> => {
  if (holdAdminFetch) {
    holdAdminFetch = false;
    await new Promise<void>((resolve) => { releaseAdminFetch = resolve; });
  }
  const admins: Set<number> | undefined = fetchedAdmins.get(chatId);
  if (!admins) throw new Error("admin fetch failed");
  return admins;
};

mock.module("../../../packages/workers/antiRaid/adminCache", () => ({
  freshAdminIds: (chatId: number): Set<number> | undefined => cachedAdmins.get(chatId),
  fetchAdminIds,
  // 三态契约的替身：先看缓存、冷了才现拉，拉不到一律 undefined（=没查出来，
  // 别处置）。真实现见 packages/workers/antiRaid/adminCache.ts 的 isChatAdmin，
  // 那边由 test/workers/antiRaid/adminCache.test.ts 单独钉住。
  isChatAdmin: async (chatId: number, userId: number): Promise<boolean | undefined> => {
    const cached: Set<number> | undefined = cachedAdmins.get(chatId);
    if (cached !== undefined) return cached.has(userId);
    try {
      return (await fetchAdminIds(chatId)).has(userId);
    } catch {
      // 文案与真实现保持一致：下面有用例断言这一行确实进了 logs/。
      errorLogs.push(`Failed to check admin exemption for flooding user ${userId} in chat ${chatId}:`);
      return undefined;
    }
  },
}));

const {
  clearChatFloodWindows,
  formatFloodMuteNotice,
  handleFloodCandidate,
  observeMemberMessage,
  resetFloodWindows,
  sweepFloodWindows,
} = await import("../../../packages/workers/antiRaid/floodControl");
const {
  applyBotPermissionsChange,
  botCanDeleteIn,
  botCanRestrictIn,
  forgetWorkerBotPermissions,
  resetWorkerBotPermissions,
} = await import("../../../packages/workers/antiRaid/botPermissions");
const {
  floodWindowCacheStateHolder,
  floodWindowsByChat,
} = await import("../../../packages/cache/workers/antiRaid/flood");
const { antiRaidInFlightTasks } = await import("../../../packages/cache/workers/antiRaid/tasks");
const {
  quiesceAntiRaidDispatch,
  resetAntiRaidTaskTracker,
} = await import("../../../packages/workers/antiRaid/taskTracker");
const {
  FLOOD_MESSAGE_LIMIT,
  FLOOD_MUTE_DURATION_MS,
  FLOOD_WINDOW_MAX_MEMBERS,
  FLOOD_WINDOW_MS,
} = await import("../../../packages/consts/antiRaid/flood");

const FULL_RIGHTS: BotActionPermissions = { canRestrictMembers: true, canDeleteMessages: true };

function candidate(chatId: number = -1001, userId: number = 7): FloodCandidateMessage {
  return { type: "floodCandidate", chatId, userId, label: "刷屏怪" };
}

/** 测试读取分层数值索引，不在断言里重新引入生产已移除的复合字符串键。 */
function floodEntry(chatId: number, userId: number): FloodWindowEntry | undefined {
  return floodWindowsByChat.get(chatId)?.get(userId);
}

/** 连投 count 条并等待派生的后台任务结算。 */
async function flood(count: number, message: FloodCandidateMessage = candidate()): Promise<void> {
  for (let i: number = 0; i < count; i++) handleFloodCandidate(message);
  await Promise.allSettled([...antiRaidInFlightTasks]);
}

beforeEach(() => {
  resetFloodWindows();
  resetWorkerBotPermissions();
  cachedAdmins.clear();
  fetchedAdmins.clear();
  errorLogs.length = 0;
  sentTexts.length = 0;
  deleteAfterCalls.length = 0;
  noticeSignals.length = 0;
  muteCalls.length = 0;
  muteOutcome = "muted";
  muteThrows = false;
  noticeMessageId = 500;
  holdMute = false;
  releaseMute = undefined;
  holdAdminFetch = false;
  releaseAdminFetch = undefined;
  // 停机用的取消控制器一旦 abort 就永久 abort：不换新的，上一个用例 quiesce 过
  // 之后所有后续用例的请求都会当场失败。
  resetAntiRaidTaskTracker();
  // 默认：机器人有限制成员权限，目标不是管理员。
  applyBotPermissionsChange(-1001, FULL_RIGHTS);
  cachedAdmins.set(-1001, new Set([42]));
});

afterEach(() => {
  resetFloodWindows();
  resetWorkerBotPermissions();
});

describe("刷屏发言窗口", () => {
  test("差一条不算刷屏，压垮窗口的那一条才交回条目供调用方置抑制位", () => {
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT - 1; i++) {
      expect(observeMemberMessage(-1001, 7, 1_000 + i)).toBeUndefined();
    }
    expect(observeMemberMessage(-1001, 7, 1_000 + FLOOD_MESSAGE_LIMIT))
      .toBe(floodEntry(-1001, 7)!);
  });

  test("命中后窗口整体清空：禁言没打成时也要再刷满一整个窗口才会重来", () => {
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT; i++) {
      observeMemberMessage(-1001, 7, 1_000 + i);
    }
    expect(floodEntry(-1001, 7)?.timestamps.size).toBe(0);

    expect(observeMemberMessage(-1001, 7, 2_000)).toBeUndefined();
    expect(floodEntry(-1001, 7)?.timestamps.size).toBe(1);
  });

  test("滑出一分钟窗口的发言不再累计", () => {
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT - 1; i++) {
      observeMemberMessage(-1001, 7, 1_000);
    }
    expect(observeMemberMessage(-1001, 7, 1_000 + FLOOD_WINDOW_MS)).toBeUndefined();
    expect(floodEntry(-1001, 7)?.timestamps.size).toBe(1);
  });

  test("抑制期内到达的消息既不计数也不重复触发", () => {
    observeMemberMessage(-1001, 7, 1_000);
    const entry: FloodWindowEntry | undefined = floodEntry(-1001, 7);
    expect(entry).toBeDefined();
    entry!.suppressedUntil = 1_000 + FLOOD_MUTE_DURATION_MS;

    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT * 2; i++) {
      expect(observeMemberMessage(-1001, 7, 2_000 + i)).toBeUndefined();
    }
    expect(entry!.timestamps.size).toBe(1);
  });

  test("群与成员各自计数，互不连累", () => {
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT - 1; i++) {
      observeMemberMessage(-1001, 7, 1_000 + i);
    }
    expect(observeMemberMessage(-2002, 7, 1_100)).toBeUndefined();
    expect(observeMemberMessage(-1001, 8, 1_100)).toBeUndefined();
    expect(observeMemberMessage(-1001, 7, 1_100)).toBeDefined();
  });

  test("条目数达到全局硬顶后跨群按精确 LRU 淘汰", () => {
    for (let member: number = 1; member <= FLOOD_WINDOW_MAX_MEMBERS; member++) {
      observeMemberMessage(-1001, member, 1_000);
    }
    observeMemberMessage(-1001, 1, 2_000);
    observeMemberMessage(-2002, 1, 2_000);

    expect(floodWindowCacheStateHolder.current.entryCount).toBe(FLOOD_WINDOW_MAX_MEMBERS);
    expect(floodEntry(-1001, 1)).toBeDefined();
    expect(floodEntry(-1001, 2)).toBeUndefined();
    expect(floodEntry(-2002, 1)).toBeDefined();
  });

  test("统一 sweep 删掉空闲满一个窗口的条目，仍在抑制期的留到抑制结束", () => {
    observeMemberMessage(-1001, 7, 1_000);
    observeMemberMessage(-1001, 8, 1_000);
    floodEntry(-1001, 8)!.suppressedUntil = 1_000 + FLOOD_MUTE_DURATION_MS;

    expect(sweepFloodWindows(1_000 + FLOOD_WINDOW_MS)).toBe(0);
    expect(sweepFloodWindows(1_001 + FLOOD_WINDOW_MS)).toBe(1);
    expect(floodEntry(-1001, 7)).toBeUndefined();
    // 抑制还没到点：条目要留着，删掉就等于让抑制提前失效。
    expect(floodEntry(-1001, 8)).toBeDefined();
    expect(sweepFloodWindows(2_000 + FLOOD_MUTE_DURATION_MS)).toBe(1);
    expect(floodWindowCacheStateHolder.current.entryCount).toBe(0);
  });

  test("停管/`/init disable` 丢掉该群全部窗口，别的群不受影响", () => {
    observeMemberMessage(-1001, 7, 1_000);
    observeMemberMessage(-1001, 8, 1_000);
    observeMemberMessage(-2002, 7, 1_000);

    clearChatFloodWindows(-1001);
    expect([...floodWindowsByChat.keys()]).toEqual([-2002]);
    expect(floodWindowCacheStateHolder.current.entryCount).toBe(1);
    const remaining: FloodWindowEntry | undefined = floodEntry(-2002, 7);
    expect(floodWindowCacheStateHolder.current.newest).toBe(remaining!);
    expect(floodWindowCacheStateHolder.current.oldest).toBe(remaining!);
    expect(remaining?.lruNewer).toBeNull();
    expect(remaining?.lruOlder).toBeNull();
  });

  test("reset 摘掉外部仍持有条目的 LRU 引用，避免一条在途任务留住整张表", () => {
    observeMemberMessage(-1001, 7, 1_000);
    observeMemberMessage(-1001, 8, 1_001);
    const retained: FloodWindowEntry | undefined = floodEntry(-1001, 7);
    expect(retained?.lruNewer).toBeDefined();

    resetFloodWindows();

    expect(retained?.lruNewer).toBeNull();
    expect(retained?.lruOlder).toBeNull();
    expect(floodWindowsByChat.size).toBe(0);
    expect(floodWindowCacheStateHolder.current).toEqual({
      entryCount: 0,
      newest: null,
      oldest: null,
    });
  });
});

describe("机器人自身权限镜像", () => {
  test("镜像是三态：「没观测到」与「观测到没有」必须分得开", () => {
    applyBotPermissionsChange(-3003, { canRestrictMembers: true, canDeleteMessages: false });
    expect(botCanRestrictIn(-3003)).toBeTrue();
    expect(botCanDeleteIn(-3003)).toBeFalse();

    // 从没镜像过的群是 undefined，不是 false——压成一个布尔就没法让调用方
    // 对「确证没权限」和「还不知道」分别处置。
    expect(botCanRestrictIn(-4004)).toBeUndefined();
    expect(botCanDeleteIn(-4004)).toBeUndefined();

    // 主线程对撤管理员/离群/现查失败发的都是「未知」，不得沿用旧值。
    applyBotPermissionsChange(-3003, undefined);
    expect(botCanRestrictIn(-3003)).toBeUndefined();

    applyBotPermissionsChange(-3003, FULL_RIGHTS);
    forgetWorkerBotPermissions(-3003);
    expect(botCanRestrictIn(-3003)).toBeUndefined();
  });
});

describe("刷屏禁言的处置", () => {
  test("越过阈值即禁言并播报，公告三十秒后由主线程删除", async () => {
    await flood(FLOOD_MESSAGE_LIMIT);

    expect(muteCalls).toHaveLength(1);
    expect(muteCalls[0]).toMatchObject({ chatId: -1001, userId: 7 });
    expect(muteCalls[0]!.mutedUntil).toBeGreaterThan(Date.now());
    expect(sentTexts).toEqual([formatFloodMuteNotice("刷屏怪")]);
    expect(deleteAfterCalls).toEqual([{
      chatId: -1001,
      messageId: 500,
      delayMs: 30_000,
      api: { kind: "guard-api" },
      batchOnFlush: true,
    }]);
  });

  test("回归用例：停机 flush 按群合批，几条公告只花一个请求——逐条发会把 drain 拖过预算", async () => {
    // 同一个群里几名成员在三分钟内接连刷屏，册子上就攒下好几条待删公告。它们
    // 逐条删除会产生 N 个 delete 类请求；该类别若正处于 429 恢复期，秒级 drain
    // 很容易耗尽并换来脏退出 + 整批 update 重投。
    for (const [index, userId] of [11, 12, 13, 14].entries()) {
      noticeMessageId = 600 + index;
      await flood(FLOOD_MESSAGE_LIMIT, candidate(-1001, userId));
    }
    // 另一个群单独一条：deleteMessages 不能跨 chat 合批，因此各自一个请求。
    applyBotPermissionsChange(-1002, FULL_RIGHTS);
    cachedAdmins.set(-1002, new Set([42]));
    noticeMessageId = 700;
    await flood(FLOOD_MESSAGE_LIMIT, candidate(-1002, 21));

    expect(deleteAfterCalls.map((entry) => [entry.chatId, entry.messageId]))
      .toEqual([
        [-1001, 600], [-1001, 601], [-1001, 602], [-1001, 603],
        [-1002, 700],
      ]);
    expect(deleteAfterCalls.every((entry): boolean => entry.batchOnFlush === true))
      .toBeTrue();
  });

  test("禁言期间还在路上的消息不会换来第二次禁言", async () => {
    await flood(FLOOD_MESSAGE_LIMIT * 2);
    expect(muteCalls).toHaveLength(1);
    expect(sentTexts).toHaveLength(1);
  });

  test("没有确证的限制成员权限时一个请求都不发，且一场刷屏只留一行诊断", async () => {
    applyBotPermissionsChange(-1001, { canRestrictMembers: false, canDeleteMessages: true });
    await flood(FLOOD_MESSAGE_LIMIT * 2);
    expect(muteCalls).toBeEmpty();
    expect(sentTexts).toBeEmpty();
    // 结论在权限变回来之前不会变，抑制位因此保留：不保留的话，这场刷屏就是
    // 每 35 条往 logs/ 里刷同一行。
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toContain("does not have permission to restrict members");
  });

  test("目标是群管理员时不禁言，且不刷「机器人没权限」的假线索", async () => {
    cachedAdmins.set(-1001, new Set([7]));
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toBeEmpty();
    expect(errorLogs).toBeEmpty();
  });

  test("管理员身份确证不了时不动手：放过一次刷屏好过把群主按住", async () => {
    // 缓存冷 + 全量拉取失败 = 查不出身份。
    cachedAdmins.delete(-1001);
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toBeEmpty();
    expect(errorLogs[0]).toContain("Failed to check admin exemption");

    // 冷缓存但拉得到时照常处置。
    fetchedAdmins.set(-1001, new Set([42]));
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(1);
  });

  test("禁言没落地就不播报——公告断言的是「人已经被按住了」", async () => {
    muteOutcome = "failed";
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(1);
    expect(sentTexts).toBeEmpty();
    expect(deleteAfterCalls).toBeEmpty();

    // 限流/抖动是瞬时失败：抑制位回滚，再刷满一整个窗口会重试。
    muteOutcome = "muted";
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(2);
  });

  test("Telegram 明确拒绝时保留抑制位，不让一场刷屏反复重打注定失败的请求", async () => {
    muteOutcome = "forbidden";
    await flood(FLOOD_MESSAGE_LIMIT * 3);
    expect(muteCalls).toHaveLength(1);
    expect(sentTexts).toBeEmpty();
  });

  test("权限镜像还没到时照常尝试，由 Telegram 当裁判", async () => {
    // 主线程的按需现查撞上一次 429 就会退避几分钟；那几分钟里把刷屏放过去，
    // 比多打一个请求糟得多。未知 ≠ 确证没有权限。
    forgetWorkerBotPermissions(-1001);
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(1);
    expect(sentTexts).toHaveLength(1);
    // 这条路径不该刷「机器人没有限制成员权限」——那句话此刻并没有依据。
    expect(errorLogs).toBeEmpty();
  });

  test("公告发不出去时不排自删计时器", async () => {
    noticeMessageId = undefined;
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(1);
    expect(deleteAfterCalls).toBeEmpty();
  });

  test("处置意外抛错时回滚抑制位并留下诊断，下一个满窗口照常重试", async () => {
    muteThrows = true;
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(sentTexts).toBeEmpty();
    expect(errorLogs.some((line: string): boolean => line.includes("Failed to mute flooding user"))).toBeTrue();

    muteThrows = false;
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(2);
    expect(sentTexts).toHaveLength(1);
  });

  test("禁言任务登记进在途集合，停机 drain 会等它结算", async () => {
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT; i++) handleFloodCandidate(candidate());
    expect(antiRaidInFlightTasks.size).toBe(1);
    await Promise.allSettled([...antiRaidInFlightTasks]);
    expect(antiRaidInFlightTasks.size).toBe(0);
  });

  test("回归用例：公告也带派发截止时间，不能在消息桶里排成迟到噪音", async () => {
    // 公告与验证提醒等功能性消息共享 grammY message 桶，但踢人使用独立 kick
    // 类别。带上截止时间可让过时公告腾出消息位且不拖住 drain。
    await flood(FLOOD_MESSAGE_LIMIT);

    expect(sentTexts).toHaveLength(1);
    expect(noticeSignals).toHaveLength(1);
    expect(noticeSignals[0]).toBeInstanceOf(AbortSignal);
    expect(noticeSignals[0]!.aborted).toBeFalse();
  });

  test("回归用例：drain 已经开始时连身份确证都不发——禁言的派发窗口是分钟级，drain 的预算是秒级", async () => {
    quiesceAntiRaidDispatch();
    await flood(FLOOD_MESSAGE_LIMIT);

    expect(muteCalls).toBeEmpty();
    expect(sentTexts).toBeEmpty();
  });

  test("回归用例：禁言已经排上队时 drain 就地撤掉它，不发那条公告", async () => {
    // 请求按设计最长排 FLOOD_MUTE_DISPATCH_TIMEOUT_MS（2 分钟），而 drain 的预算是
    // ANTI_RAID_DRAIN_TIMEOUT_MS 那一档的秒级数值：不撤掉就是每次撞上都换来一次
    // 脏退出（offset 不确认、非零状态）加一批 update 重投。
    holdMute = true;
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT; i++) handleFloodCandidate(candidate());
    await Bun.sleep(1);
    expect(muteCalls).toHaveLength(1);

    quiesceAntiRaidDispatch();
    releaseMute!();
    await Promise.allSettled([...antiRaidInFlightTasks]);

    expect(sentTexts).toBeEmpty();
    expect(deleteAfterCalls).toBeEmpty();
  });

  test("回归用例：身份确证期间群被停管，就不再禁言、也不往那个群里说话", async () => {
    // 缓存冷时身份确证是一整次 getChatAdministrators，够管理员执行完 `/init disable`：
    // deactivateChat → clearChatFloodWindows 丢掉这个群的全部窗口。机器人此刻多半
    // 仍是 Telegram 管理员，禁得动也发得出话，但那已经是一个本进程不再管理的群，
    // 而禁言没有恢复计时器。
    cachedAdmins.delete(-1001);
    fetchedAdmins.set(-1001, new Set([42]));
    holdAdminFetch = true;
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT; i++) handleFloodCandidate(candidate());
    await Bun.sleep(1);

    clearChatFloodWindows(-1001);
    releaseAdminFetch!();
    await Promise.allSettled([...antiRaidInFlightTasks]);

    expect(muteCalls).toBeEmpty();
    expect(sentTexts).toBeEmpty();
  });

  test("播报只说清谁被按了多久，不回显刷屏内容", () => {
    const notice: string = formatFloodMuteNotice("@noisy");
    expect(notice).toContain("@noisy");
    expect(notice).toContain(String(FLOOD_MESSAGE_LIMIT));
    expect(notice).toContain(`${FLOOD_MUTE_DURATION_MS / 60_000} 分钟`);
    // 文案只由标签与两个常量拼成，不带任何消息正文——回显等于替他再刷一遍。
    expect(notice).not.toContain("spam");
  });
});
