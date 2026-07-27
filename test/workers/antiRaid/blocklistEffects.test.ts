import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { BlockedMembersRemovedEvent } from "../../../packages/types/antiRaid";

const probeChatMembership = mock(async (..._args: unknown[]): Promise<boolean | undefined> => true);
const banChatMember = mock(async (..._args: unknown[]): Promise<boolean> => true);
const banChatSenderChat = mock(async (..._args: unknown[]): Promise<boolean> => true);
const deleteMessage = mock(async (..._args: unknown[]): Promise<boolean> => true);
const recordJoin = mock((..._args: unknown[]): void => {});
/** 入群守卫专用客户端的替身：断言处置没有落到默认客户端的队列上。 */
const guardApi = { kind: "guard-api" };

mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../packages/infra/telegram", () => ({
  probeChatMembership,
  banChatMember,
  banChatSenderChat,
  deleteMessage,
  joinVerificationApi: guardApi,
}));
mock.module("../../../packages/workers/antiRaid/lockdownRuntime", () => ({ recordJoin }));
// 真实节奏（5s 退避、25 个一批）在测试里没法等；只压缩时间，不改变分支。
mock.module("../../../packages/consts/antiRaid/blocklist", () => ({
  BLOCKLIST_REMOVAL_MAX_ATTEMPTS: 3,
  BLOCKLIST_REMOVAL_RETRY_DELAY_MS: 1,
  BLOCKLIST_SWEEP_BATCH_SIZE: 2,
  BLOCKLIST_SWEEP_BATCH_PAUSE_MS: 1,
}));

const { handleRemoveBlockedMembers } = await import("../../../packages/workers/antiRaid/blocklistEffects");
const { bumpBlocklistRemovalEpoch, blocklistRemovalEpochs } = await import("../../../packages/cache/antiRaid/blocklist");

const events: BlockedMembersRemovedEvent[] = [];
const publish = (event: BlockedMembersRemovedEvent): void => { events.push(event); };

/** 副作用是事后执行的，断言前把微任务与压缩后的退避都跑完。 */
function settle(): Promise<void> {
  return Bun.sleep(20);
}

beforeEach(() => {
  for (const mocked of [probeChatMembership, banChatMember, banChatSenderChat, deleteMessage, recordJoin]) {
    mocked.mockClear();
  }
  probeChatMembership.mockImplementation(async (): Promise<boolean | undefined> => true);
  banChatMember.mockImplementation(async (): Promise<boolean> => true);
  banChatSenderChat.mockImplementation(async (): Promise<boolean> => true);
  deleteMessage.mockImplementation(async (): Promise<boolean> => true);
  events.length = 0;
  blocklistRemovalEpochs.clear();
});

describe("黑名单处置副作用（守卫线程侧）", () => {
  test("probeMembership=false 时直接封禁，不多打一次成员探测", async () => {
    // 刚到的入群更新：人此刻确定在群里，再探一次纯属浪费一次 API 调用。
    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [42], probeMembership: false, removalId: 1 },
      publish,
    });
    await settle();

    expect(probeChatMembership).not.toHaveBeenCalled();
    // 与验证超时踢人共用 joinVerificationApi，不占默认客户端的额度。
    expect(banChatMember).toHaveBeenCalledWith(-1001, 42, guardApi);
    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 1, complete: true }]);
  });

  test("probeMembership=true 时逐个探测，只封此刻真在群里的人", async () => {
    probeChatMembership.mockImplementation(async (_chatId: unknown, userId: unknown): Promise<boolean> => userId === 7);

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7, 8], probeMembership: true, removalId: 2 },
      publish,
    });
    await settle();

    expect(probeChatMembership.mock.calls.map((call) => call[1])).toEqual([7, 8]);
    expect(banChatMember).toHaveBeenCalledTimes(1);
    expect(banChatMember).toHaveBeenCalledWith(-1001, 7, guardApi);
    // 确认不在群不算失败：这批算完整落定。
    expect(events[0]?.complete).toBeTrue();
  });

  test("探测失败不算「不在群」：宁可多封一次，也不放过坐在群里的人", async () => {
    probeChatMembership.mockImplementation(async (): Promise<boolean | undefined> => undefined);

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: true, removalId: 3 },
      publish,
    });
    await settle();

    expect(banChatMember).toHaveBeenCalledWith(-1001, 7, guardApi);
    expect(events[0]?.complete).toBeTrue();
  });

  test("封禁失败按退避重试，最终仍失败时回执 complete=false", async () => {
    // 黑名单入群不开验证窗口，没有超时踢人兜底——这次处置是唯一的机会。
    banChatMember.mockImplementation(async (): Promise<boolean> => false);

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: false, removalId: 4 },
      publish,
    });
    await settle();

    expect(banChatMember).toHaveBeenCalledTimes(3);
    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 4, complete: false }]);
  });

  test("重试期间恢复正常就算落定", async () => {
    let attempts: number = 0;
    banChatMember.mockImplementation(async (): Promise<boolean> => ++attempts >= 2);

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: false, removalId: 5 },
      publish,
    });
    await settle();

    expect(banChatMember).toHaveBeenCalledTimes(2);
    expect(events[0]?.complete).toBeTrue();
  });

  test("秒踢路径补记入群计数并清掉入群公告", async () => {
    // 不投 join 就没人替这次入群记刷群计数、也没人删那条公告。
    const before: number = Date.now();
    handleRemoveBlockedMembers({
      msg: {
        type: "removeBlockedMembers",
        chatId: -1001,
        userIds: [7],
        probeMembership: false,
        removalId: 6,
        // 主线程在 durable outbox flush 之前取的时刻：必然早于本线程随后记下的
        // 那些入群。
        joinedAt: before - 1_000,
        announcementMessageId: 88,
      },
      publish,
    });
    await settle();

    // 记的必须是本线程观测到的时刻。直接把 joinedAt 当「现在」交给 recordJoin
    // 的话，trimSlidingWindow 会把同一批里刚记下的、时间戳更新的真实入群全部
    // 当成时钟回拨丢掉，反刷群阈值再也凑不满。
    expect(recordJoin).toHaveBeenCalledTimes(1);
    const [recordedChatId, recordedAt] = recordJoin.mock.calls[0] as [number, number];
    expect(recordedChatId).toBe(-1001);
    expect(recordedAt).toBeGreaterThanOrEqual(before);
    expect(deleteMessage).toHaveBeenCalledWith(-1001, 88, guardApi);
  });

  test("已经滑出窗口的 joinedAt 不再补记：跨进程重放不该凭空多算一次入群", async () => {
    handleRemoveBlockedMembers({
      msg: {
        type: "removeBlockedMembers",
        chatId: -1001,
        userIds: [7],
        probeMembership: false,
        removalId: 9,
        // 上一个进程的入群潮：启动恢复与 Worker 重生都会原样重投这条。
        joinedAt: Date.now() - 10 * 60_000,
      },
      publish,
    });
    await settle();

    expect(recordJoin).not.toHaveBeenCalled();
  });

  test("群被停管后整批放弃：不在已经不归自己管的群里继续封人", async () => {
    let releaseFirst!: (banned: boolean) => void;
    banChatMember.mockImplementationOnce((): Promise<boolean> =>
      new Promise((resolve: (banned: boolean) => void): void => { releaseFirst = resolve; }));

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7, 8, 9], probeMembership: false, removalId: 7 },
      publish,
    });
    await Bun.sleep(0);
    // 第一条还悬着的时候 /init disable：补扫可能还要跑几分钟，必须立刻收手。
    bumpBlocklistRemovalEpoch(-1001);
    releaseFirst(true);
    await settle();

    expect(banChatMember).toHaveBeenCalledTimes(1);
    // 没扫完，回执必须说清楚——重新接管后还要再欠一次。
    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 7, complete: false }]);
  });

  test("频道身份没有「成员」一说：直接封发言权，不做成员探测", async () => {
    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [-4004], probeMembership: true, removalId: 8 },
      publish,
    });
    await settle();

    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(banChatSenderChat).toHaveBeenCalledWith(-1001, -4004, guardApi);
  });

  test("返回在途任务但由 mailbox 调度器后台登记：一波刷屏入群时不阻塞路由", async () => {
    let settleBan!: (banned: boolean) => void;
    let firstCall: boolean = true;
    banChatMember.mockImplementation((): Promise<boolean> => {
      if (!firstCall) return Promise.resolve(true);
      firstCall = false;
      return new Promise((resolve: (banned: boolean) => void): void => { settleBan = resolve; });
    });

    const returned: Promise<void> = handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7, 8], probeMembership: false, removalId: 9 },
      publish,
    });

    let settled: boolean = false;
    void returned.finally((): void => { settled = true; });
    await Bun.sleep(0);
    expect(settled).toBeFalse();
    // 第一条还悬着，第二条就不该发出——同批内部仍是串行，不并发轰 API。
    expect(banChatMember).toHaveBeenCalledTimes(1);

    settleBan(true);
    await returned;
    expect(banChatMember).toHaveBeenCalledTimes(2);
  });

  test("抛错被兜住，不冒泡成 Worker 的未处理拒绝，且照样回执", async () => {
    banChatMember.mockImplementation(async (): Promise<boolean> => { throw new Error("network down"); });

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [42], probeMembership: false, removalId: 10 },
      publish,
    });
    await settle();

    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 10, complete: false }]);
  });
});
