import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdDetectedEvent } from "../../../packages/types/antiRaid";
import type { RemoveBlockedMembersParams } from "../../../packages/types/blocklist";
import type { TelegramConfig } from "../../../packages/types/config";
import { botPermissions } from "../../helpers/botPermissions";
const chatStates = new Map<number, Record<string, unknown>>();
const activeVerificationSnapshots = new Map<string, unknown>();
const dispatched: RemoveBlockedMembersParams[][] = [];
const errorLogs: string[] = [];
const blockedIds = new Set<number>();
const temporaryWhitelistIds = new Set<number>();
const blockUser = mock((userId: number): boolean => blockedIds.has(userId) ? false : (blockedIds.add(userId), true));
const confirmBlocklistPersisted = mock(async (): Promise<boolean> => true);
const isUserBlocked = mock((userId: number): boolean => blockedIds.has(userId));
const diskMessages: unknown[] = [];
const postDiskIO = mock((message: unknown): boolean => (diskMessages.push(message), true));
const dispatchBlockedRemovals = mock(async (removals: readonly RemoveBlockedMembersParams[]): Promise<void> => {
  dispatched.push([...removals]);
});
let removalCounter: number = 0;
const resweepRequests: number[] = [];
const requestBlocklistResweep = mock((chatId: number): void => { resweepRequests.push(chatId); });
const trackBlockedRemoval = mock((params: Omit<RemoveBlockedMembersParams, "removalId">): RemoveBlockedMembersParams => ({
  ...params,
  removalId: ++removalCounter,
}));
/** 播报消息 id；真实 sendMessage 会把它同步交给 onSent，再作为返回值交出去。 */
const NOTICE_MESSAGE_ID: number = 555;
interface SendMessageMockParams {
  readonly chatId: number;
  readonly text: string;
  readonly onSent?: (messageId: number) => void;
}
/**
 * 复刻真实 sendMessage 的 onSent 契约：远端收下的同步时点先回调 onSent，
 * 之后才把 id 作为返回值交出。停机 abort 会吃掉返回值但吃不掉这次回调，
 * 因此删除 owner 只能挂在 onSent 上（见 infra/telegram/actions/core.ts）。
 */
const sendMessage = mock(async (params: SendMessageMockParams): Promise<number | undefined> => {
  params.onSent?.(NOTICE_MESSAGE_ID);
  return NOTICE_MESSAGE_ID;
});
const deleteMessageAfter = mock((..._args: unknown[]): void => {});
const clearTemporaryWhitelistActivity = mock((_id: number): boolean => true);
mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));
mock.module("../../../packages/config/telegram", () => ({
  SUPER_ADMIN_USER_ID: 1,
  getTelegramConfig: (): TelegramConfig => ({ botToken: "telegram-token", superAdminUserId: 1 }),
}));
// 1 是超级管理员：SQLite 没有其白名单记录，但由 packages/infra/identityPolicy/whitelist.ts
// 的读取边界直接算进白名单边界并持有全部权限，这里的 mock 照实模拟那层结论。
mock.module("../../../packages/infra/identityPolicy/whitelist", () => ({
  hasPermanentWhitelistPermission: (id: number, key: string): boolean =>
    id === 1 ||
    ((id === 100 || id === -200) && key === "isCanBypassFloodControl"),
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 1 ||
    ((id === 100 || id === -200 || temporaryWhitelistIds.has(id)) &&
      key === "isCanBypassAdDetection"),
  isWhitelisted: (id: number): boolean =>
    id === 1 || id === 100 || id === 101 || id === -200,
}));
mock.module("../../../packages/infra/telegram/actions", () => ({
  sendMessage,
  deleteMessageAfter,
}));
mock.module("../../../packages/infra/blocklist/membership", () => ({
  blockUser,
  confirmBlocklistPersisted,
  isUserBlocked,
}));
mock.module("../../../packages/infra/identityPolicy/temporaryWhitelist", () => ({
  clearTemporaryWhitelistActivity,
  hasActiveTemporaryWhitelist: (id: number): boolean =>
    temporaryWhitelistIds.has(id),
  hasActiveTemporaryWhitelistAt: (id: number): boolean => temporaryWhitelistIds.has(id),
  hydrateTemporaryWhitelistActivities: (): void => {},
  isTemporaryWhitelistActivityCached: (): boolean => true,
}));
mock.module("../../../packages/infra/blocklist/outbox", () => ({
  dispatchBlockedRemovals,
  trackBlockedRemoval,
}));
mock.module("../../../packages/infra/blocklist/sweep", () => ({ requestBlocklistResweep }));
mock.module("../../../packages/cache/main/antiRaid/verificationMirror", () => ({ activeVerificationSnapshots }));
mock.module("../../../packages/infra/diskIO", () => ({ postDiskIODiagnostic: postDiskIO }));
mock.module("../../../packages/infra/storage/stateStore", () => ({
  getChatStateCache: () => chatStates,
  getChatState: (chatId: number) => chatStates.get(chatId) ?? {},
}));
const {
  drainAdDisposals,
  formatAdNotice,
  handleAdDetected,
  handleAdVerdictTrue,
} =
  await import("../../../packages/antiRaid/adDetect");
const { KICK_NOTICE_AUTO_DELETE_MS } = await import("../../../packages/consts/telegram");
const { inFlightAdDisposals } = await import("../../../packages/cache/main/antiRaid/adDisposal");
const { blocklistIdentityMutationQueues } = await import("../../../packages/cache/main/blocklist");
const { runBlocklistIdentityMutation } = await import("../../../packages/infra/identityPolicy/coordination");
const { inlineResultSources } = await import("../../../packages/cache/main/inlineResultSources");
const { resetSelfSentTracker } = await import("../../../packages/cache/perThread/selfSentTracker");
const { blocklistEntryCache, whitelistEntryCache } =
  await import("../../../packages/cache/main/identityStorage");
function detected(overrides: Partial<AdDetectedEvent> = {}): AdDetectedEvent {
  return {
    type: "adDetected",
    chatId: -1001,
    senderId: 7,
    isChannel: false,
    label: "@spammer",
    meta: { firstName: "Spammer", lastName: "", username: "spammer" },
    reason: "引流",
    messages: [{ messageId: 11, text: "加我微信", replyTo: "在吗", quote: "别人说过的话" }],
    ...overrides,
  };
}

beforeEach(() => {
  chatStates.clear();
  chatStates.set(-1001, {
    isAdDetectEnabled: true,
    isInitEnabled: true,
    botPermissions: botPermissions(),
  });
  activeVerificationSnapshots.clear();
  dispatched.length = 0;
  errorLogs.length = 0;
  removalCounter = 0;
  resweepRequests.length = 0;
  requestBlocklistResweep.mockClear();
  trackBlockedRemoval.mockClear();
  trackBlockedRemoval.mockImplementation((params: Omit<RemoveBlockedMembersParams, "removalId">): RemoveBlockedMembersParams => ({
    ...params,
    removalId: ++removalCounter,
  }));
  blockedIds.clear();
  temporaryWhitelistIds.clear();
  blocklistEntryCache.clear();
  whitelistEntryCache.clear();
  for (const id of [7, -300, -1005]) {
    blocklistEntryCache.set(id, null);
    whitelistEntryCache.set(id, null);
  }
  blockUser.mockClear();
  clearTemporaryWhitelistActivity.mockClear();
  confirmBlocklistPersisted.mockClear();
  confirmBlocklistPersisted.mockImplementation(async (): Promise<boolean> => true);
  isUserBlocked.mockClear();
  dispatchBlockedRemovals.mockClear();
  inFlightAdDisposals.clear();
  blocklistIdentityMutationQueues.clear();
  sendMessage.mockClear();
  sendMessage.mockImplementation(async (params: SendMessageMockParams): Promise<number | undefined> => {
    params.onSent?.(NOTICE_MESSAGE_ID);
    return NOTICE_MESSAGE_ID;
  });
  deleteMessageAfter.mockClear();
  diskMessages.length = 0;
  postDiskIO.mockClear();
  postDiskIO.mockImplementation((message: unknown): boolean => (diskMessages.push(message), true));
  resetSelfSentTracker();
  inlineResultSources.clear();
});

describe("广告判定命中后的处置", () => {
  test("任何 ad=true 回投先清空连续日累计", async () => {
    handleAdVerdictTrue({ type: "adVerdictTrue", chatId: -1001, senderId: 7 });
    await drainAdDisposals(5_000);

    expect(clearTemporaryWhitelistActivity).toHaveBeenCalledWith(7);
    expect(blockUser).not.toHaveBeenCalled();
  });

  test("入队后才获得临时广告豁免时，旧判定不撤权也不处置", async () => {
    temporaryWhitelistIds.add(7);

    handleAdVerdictTrue({ type: "adVerdictTrue", chatId: -1001, senderId: 7 });
    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(clearTemporaryWhitelistActivity).not.toHaveBeenCalled();
    expect(blockUser).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
    expect(diskMessages).toHaveLength(0);
  });

  test("按 /block 同样的动作：先写名单落盘，再给每个在管群登记一批封禁", async () => {
    chatStates.set(-1002, { isInitEnabled: true, botPermissions: botPermissions() });
    chatStates.set(-1003, {
      isInitEnabled: true,
      botPermissions: botPermissions({ isAdministrator: false, canManageChat: false }),
    });
    chatStates.set(-1004, { botPermissions: botPermissions() });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(blockUser).toHaveBeenCalledWith(7, {
      firstName: "Spammer",
      lastName: "",
      username: "spammer",
    });
    expect(confirmBlocklistPersisted).toHaveBeenCalledTimes(1);
    // 触发判定的群排最前：那里正躺着刚发出来的广告。未初始化或没有管理员
    // 身份的群不进清单——在那里封人本来就会失败。
    expect(dispatched[0]?.map((params) => params.chatId)).toEqual([-1001, -1002]);
    expect(dispatched[0]?.[0]).toMatchObject({ userIds: [7], probeMembership: false });
  });

  test("落盘失败留下可排查的错误日志", async () => {
    confirmBlocklistPersisted.mockImplementation(async (): Promise<boolean> => false);

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(errorLogs.some((line) => line.includes("memory-only"))).toBe(true);
    expect(dispatched).toHaveLength(1);
  });

  test("较晚的同身份解封等待广告处置完整结算，最终不会被旧封禁覆盖", async () => {
    let releasePersist: (() => void) | undefined;
    confirmBlocklistPersisted.mockImplementationOnce((): Promise<boolean> =>
      new Promise<boolean>((resolve: (value: boolean) => void): void => {
        releasePersist = (): void => resolve(true);
      }));

    handleAdDetected(detected());
    await Bun.sleep(0);
    expect(releasePersist).toBeFunction();

    let unblockStarted: boolean = false;
    const laterUnblock: Promise<void> = runBlocklistIdentityMutation(7, (): void => {
      unblockStarted = true;
      blockedIds.delete(7);
    });
    await Bun.sleep(0);

    // 广告处置持有同身份尾链；管理员的较晚解封不能先跑完，再被旧任务补封。
    expect(unblockStarted).toBeFalse();
    expect(trackBlockedRemoval).not.toHaveBeenCalled();

    releasePersist!();
    await drainAdDisposals(5_000);
    await laterUnblock;

    expect(dispatched).toHaveLength(1);
    expect(unblockStarted).toBeTrue();
    expect(blockedIds.has(7)).toBeFalse();
    expect(blocklistIdentityMutationQueues.size).toBe(0);
  });

  test("重复命中只补触发群一批封禁，不再重走整套落盘与各群登记", async () => {
    chatStates.set(-1002, { isInitEnabled: true, botPermissions: botPermissions() });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);
    expect(dispatched[0]?.map((params) => params.chatId)).toEqual([-1001, -1002]);
    expect(confirmBlocklistPersisted).toHaveBeenCalledTimes(1);

    // 封禁落地前这人又被判了一次：整套重来的代价是一次带 fsync 的名单落盘 +
    // 每个在管群各一批封禁（每批都要整份 outbox 落盘），按群数放大成 O(n²)。
    handleAdDetected(detected());
    await drainAdDisposals(5_000);
    expect(confirmBlocklistPersisted).toHaveBeenCalledTimes(1);
    expect(dispatched[1]?.map((params) => params.chatId)).toEqual([-1001]);
  });

  test("重复命中时若触发群已停管，则一批都不登记", async () => {
    handleAdDetected(detected());
    await drainAdDisposals(5_000);
    expect(dispatched).toHaveLength(1);

    chatStates.set(-1001, {
      isAdDetectEnabled: true,
      isInitEnabled: true,
      botPermissions: botPermissions({ isAdministrator: false, canManageChat: false }),
    });
    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(dispatched).toHaveLength(1);
    expect(errorLogs.some((line) => line.includes("no chat to enforce"))).toBe(true);
  });

  test("某个群登记失败只作废那个群：其余群照常封，失败的群改欠一次补扫", async () => {
    chatStates.set(-1002, { isInitEnabled: true, botPermissions: botPermissions() });
    chatStates.set(-1003, { isInitEnabled: true, botPermissions: botPermissions() });
    // outbox 满：登记在第二个群上抛出。整段用 map 的话这一抛会让已登记的第一
    // 批留在 outbox 里而 dispatchBlockedRemovals 一次都调不到，这个刷屏号在
    // 所有群都封不掉。
    trackBlockedRemoval.mockImplementation(
      (params: Omit<RemoveBlockedMembersParams, "removalId">): RemoveBlockedMembersParams => {
        if (params.chatId === -1002) throw new Error("Blocklist removal outbox reached its capacity.");
        return { ...params, removalId: ++removalCounter };
      }
    );

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(dispatched[0]?.map((params) => params.chatId)).toEqual([-1001, -1003]);
    expect(resweepRequests).toEqual([-1002]);
    expect(errorLogs.some((line) => line.includes("owe a resweep"))).toBe(true);
  });

  test("每个群都登记失败时不投空批次，且每个群都欠上补扫", async () => {
    chatStates.set(-1002, { isInitEnabled: true, botPermissions: botPermissions() });
    trackBlockedRemoval.mockImplementation((): RemoveBlockedMembersParams => {
      throw new Error("Blocklist removal outbox reached its capacity.");
    });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(dispatched).toHaveLength(0);
    expect(resweepRequests).toEqual([-1001, -1002]);
    expect(errorLogs.some((line) => line.includes("no chat to enforce"))).toBe(true);
  });

  test("播报发在触发的群里，带展示标签与理由，30 秒后自撤", async () => {
    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    const notice = sendMessage.mock.calls[0]?.[0] as { chatId: number; text: string };
    expect(notice.chatId).toBe(-1001);
    expect(notice.text).toContain("@spammer");
    expect(notice.text).toContain("引流");
    expect(notice.text).toContain("在所有盯着的群里一起封掉了");
    expect(deleteMessageAfter).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1001,
      messageId: NOTICE_MESSAGE_ID,
      delayMs: KICK_NOTICE_AUTO_DELETE_MS,
      batchOnFlush: true,
    }));
  });

  test("一个群都没登记上时改口点名管理员，绝不宣称已经到处封了", async () => {
    trackBlockedRemoval.mockImplementation((): RemoveBlockedMembersParams => {
      throw new Error("Blocklist removal outbox reached its capacity.");
    });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    const notice = sendMessage.mock.calls[0]?.[0] as { text: string };
    // 人根本没被踢走，说「在所有盯着的群里一起封掉了」就是一条与事实相反的公告。
    expect(notice.text).not.toContain("在所有盯着的群里一起封掉了");
    expect(notice.text).toContain("一个群都封不动");
  });

  test("模型没给理由时播报用兜底文案，不留空", () => {
    expect(formatAdNotice({ label: "@spammer", reason: "", enforcedChats: 2, failedChats: 0 }))
      .toContain("整串消息通篇都是推广引流");
    expect(formatAdNotice({ label: "@spammer", reason: "卖号", enforcedChats: 2, failedChats: 0 }))
      .toContain("理由：卖号");
  });

  test("部分群登记失败时只报封上的群数，不说「在所有盯着的群里」", () => {
    // 那些登记失败的群里人还坐着，说「所有」同样是假话。
    const notice: string = formatAdNotice({
      label: "@spammer",
      reason: "卖号",
      enforcedChats: 3,
      failedChats: 2,
    });
    expect(notice).not.toContain("在所有盯着的群里一起封掉了");
    expect(notice).toContain("在 3 个群封掉了");
    expect(notice).toContain("2 个群没封动");
  });

  test("回归用例：播报不断言删消息——删除跑在判定线程上、排在事件回投之后，" +
    "主线程根本不知道它成没成，机器人也可能压根没有 can_delete_messages", () => {
    // 只说这边确证得了的两件事：记进名单、封了几个群。
    for (const enforcedChats of [0, 2]) {
      const notice: string = formatAdNotice({
        label: "@spammer",
        reason: "卖号",
        enforcedChats,
        failedChats: 0,
      });
      expect(notice).not.toContain("删干净");
      expect(notice).toContain("记进小本本");
    }
  });

  test("播报发送失败时不安排删除", async () => {
    sendMessage.mockImplementation(async (): Promise<number | undefined> => undefined);

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(deleteMessageAfter).not.toHaveBeenCalled();
  });

  test("远端已收下、返回值被停机 abort 吃掉时，删除 owner 仍已认领", async () => {
    // runTelegramAction 先跑 map（onSent 在其中）再检查 update 取消，取消时抛错、
    // 返回值丢失。认领点若写在 await 之后，这条播报就永久留在群里——而 30 秒清理
    // 是硬约定（见 AGENTS.md「Telegram 提示留存」）。
    sendMessage.mockImplementation(async (params: SendMessageMockParams): Promise<number | undefined> => {
      params.onSent?.(NOTICE_MESSAGE_ID);
      throw new DOMException("Telegram update was aborted during shutdown.", "AbortError");
    });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(deleteMessageAfter).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1001,
      messageId: NOTICE_MESSAGE_ID,
      delayMs: KICK_NOTICE_AUTO_DELETE_MS,
      batchOnFlush: true,
    }));
  });

  test("自己人即使被判成广告也不处置", async () => {
    handleAdDetected(detected({ senderId: 100 }));
    await drainAdDisposals(5_000);

    expect(blockUser).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
    expect(errorLogs.some((line) => line.includes("protected sender"))).toBe(true);
  });

  test("白名单关闭广告绕过权限后即使命中，也不得写入永久黑名单", async () => {
    handleAdDetected(detected({ senderId: 101 }));
    await drainAdDisposals(5_000);

    expect(blockUser).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
    expect(diskMessages).toHaveLength(0);
    expect(errorLogs.some((line) => line.includes("protected sender 101"))).toBe(true);
  });

  test("处置排到写名单之前 /ad_detect disable 已经生效时，整条判定丢掉", async () => {
    // 事件回调是同步的，而处置要先排过 identity 串行队列才轮到写名单——这中间
    // 正好够管理员那条 /ad_detect disable 落地。clearAdDetection 只清得掉判定
    // 线程里还没判的队列，够不到一条已经发布出来的判定，所以这道复查必须在
    // 主线程这边（见 antiRaid/adDetect.ts）。
    handleAdDetected(detected());
    chatStates.set(-1001, {
      isAdDetectEnabled: false,
      isInitEnabled: true,
      botPermissions: botPermissions(),
    });
    await drainAdDisposals(5_000);

    expect(blockUser).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
    expect(diskMessages).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();
    // 这是预期内的竞态结局，不是错误：不该占用 protected sender 那条告警。
    expect(errorLogs.some((line) => line.includes("protected sender"))).toBeFalse();
  });

  test("一个可执行的群都没有时只留名单与日志，不投空批次", async () => {
    chatStates.set(-1001, {
      isAdDetectEnabled: true,
      isInitEnabled: true,
      botPermissions: botPermissions({ isAdministrator: false, canManageChat: false }),
    });

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(blockUser).toHaveBeenCalledWith(7, expect.objectContaining({ username: "spammer" }));
    expect(dispatched).toHaveLength(0);
    expect(errorLogs.some((line) => line.includes("no chat to enforce"))).toBe(true);
  });

  test("命中即写一条旁路样本，含时间、消息、理由与引用/回复上下文", async () => {
    // 判定规则由提示词定死，题材口径全靠 config/ad_samples.json 的示例，而示例
    // 只能从真实命中里攒——这条旁路就是那份原始素材。
    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(diskMessages).toEqual([{
      type: "adSample",
      chatId: -1001,
      senderId: 7,
      label: "@spammer",
      detectedAt: expect.any(String),
      reason: "引流",
      messages: [{ messageId: 11, text: "加我微信", replyTo: "在吗", quote: "别人说过的话" }],
    }]);
  });

  test("样本投递失败不影响封禁本身：只记一行日志", async () => {
    // 纯旁路：丢了不影响任何运行时状态，绝不该反过来拖住不可丢的那一半。
    postDiskIO.mockImplementation((): boolean => false);

    handleAdDetected(detected());
    await drainAdDisposals(5_000);

    expect(errorLogs.some((line) => line.includes("Failed to queue the ad detection sample"))).toBe(true);
    expect(blockUser).toHaveBeenCalledWith(7, expect.objectContaining({ username: "spammer" }));
    expect(dispatched).toHaveLength(1);
  });

  test("自己人被判成广告时连样本都不写：那是模型错了，不是素材", async () => {
    handleAdDetected(detected({ senderId: 100 }));
    await drainAdDisposals(5_000);
    expect(diskMessages).toHaveLength(0);
  });

  test("排空受预算约束：预算为 0 时立刻结算成 timedOut，不拖到强制退出线", async () => {
    // 异常退出路径把全部预算设成 0（EMERGENCY_FLUSH_TIMEOUTS）。裸等的话，处置内部
    // 的落盘确认与 outbox 屏障会把停机一路拖到 15 秒强制退出：进程带非零码死在
    // 半路，实例锁不释放、offset 不确认。
    let release: (() => void) | undefined;
    dispatchBlockedRemovals.mockImplementationOnce((): Promise<void> =>
      new Promise<void>((resolve) => { release = resolve; }));

    handleAdDetected(detected());
    expect(await drainAdDisposals(0)).toBe("timedOut");
    expect(inFlightAdDisposals.size).toBe(1);

    // protected-identity 串行边界与落盘确认各让步一次；零预算 drain 本身不会
    // 等这些 microtask，先让处置推进到故意悬挂的投递点再释放。
    await Bun.sleep(0);
    expect(release).toBeFunction();
    release!();
    expect(await drainAdDisposals(5_000)).toBe("flushed");
    expect(inFlightAdDisposals.size).toBe(0);
  });

  test("投递失败不上抛，处置任务照样从在途集合里摘掉", async () => {
    dispatchBlockedRemovals.mockImplementationOnce(async (): Promise<void> => {
      throw new Error("worker unavailable");
    });

    handleAdDetected(detected());
    expect(inFlightAdDisposals.size).toBe(1);
    await drainAdDisposals(5_000);

    expect(inFlightAdDisposals.size).toBe(0);
    expect(errorLogs.some((line) => line.includes("Failed to dispose the ad verdict"))).toBe(true);
  });
});
