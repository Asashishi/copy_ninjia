import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { BlockedMembersRemovedEvent } from "../../../packages/types/antiRaid";

const probeChatMembership = mock(async (..._args: unknown[]): Promise<boolean | undefined> => true);
const banChatMemberWithOutcome = mock(async (..._args: unknown[]): Promise<string> => "banned");
const banChatSenderChatWithOutcome = mock(async (..._args: unknown[]): Promise<string> => "banned");
const probeChatAdmin = mock(async (..._args: unknown[]): Promise<boolean | undefined> => false);
const deleteMessage = mock(async (..._args: unknown[]): Promise<boolean> => true);
const recordJoin = mock((..._args: unknown[]): void => {});
const releaseAdDetectDedupKey = mock((..._args: unknown[]): void => {});
/** 入群守卫调用面的替身：断言处置始终使用受限 Worker 能力边界。 */
const guardApi = { kind: "guard-api" };

mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../packages/infra/telegram", () => ({
  probeChatMembership,
  probeChatAdmin,
  banChatMemberWithOutcome,
  banChatSenderChatWithOutcome,
  deleteMessage,
  telegramApi: guardApi,
}));
mock.module("../../../packages/workers/antiRaid/lockdownRuntime", () => ({ recordJoin }));
mock.module("../../../packages/workers/antiRaid/adDetect/queueState", () => ({
  releaseAdDetectDedupKey,
}));
// 真实节奏（5s 退避、25 个一批）在测试里没法等；只压缩时间，不改变分支。
mock.module("../../../packages/consts/antiRaid/blocklist", () => ({
  BLOCKLIST_REMOVAL_MAX_ATTEMPTS: 3,
  BLOCKLIST_REMOVAL_RETRY_DELAY_MS: 1,
  BLOCKLIST_SWEEP_BATCH_SIZE: 2,
  BLOCKLIST_SWEEP_BATCH_PAUSE_MS: 1,
}));

const { handleRemoveBlockedMembers } = await import("../../../packages/workers/antiRaid/blocklistEffects");
const {
  applyBotPermissionsChange,
  resetWorkerBotPermissions,
} = await import("../../../packages/workers/antiRaid/botPermissions");
const { bumpBlocklistRemovalEpoch, blocklistRemovalEpochs } = await import("../../../packages/cache/workers/antiRaid/blocklist");

const events: BlockedMembersRemovedEvent[] = [];
const publish = (event: BlockedMembersRemovedEvent): void => { events.push(event); };

/**
 * 轮询同步点的兜底上限。健康机器上实际只花一两毫秒；留足余量应对全量+覆盖率
 * 插桩下的调度抖动，又明显低于 bun 的用例超时——真出回归时，先失败的应该是
 * 紧随其后那条带具体数值的断言，而不是一句「test timed out」。
 */
const SETTLE_TIMEOUT_MS: number = 2_000;

/** 轮询等到条件成立；到点仍不成立就返回，让后面的断言给出真正的失败信息。 */
async function until(ready: () => boolean): Promise<void> {
  const deadline: number = Date.now() + SETTLE_TIMEOUT_MS;
  while (!ready() && Date.now() < deadline) await Bun.sleep(1);
}

/**
 * 副作用是事后执行的：等这批处置发出落定回执，而不是赌一个固定时长。
 *
 * handleRemoveBlockedMembers 恒在 removeBlockedMembers 完成之后（成功或异常）发且
 * 只发一条回执，所以回执到达就等于这批的探测、封禁、删公告、补记入群全部结束
 * ——它是这个单元真正的完成边界，不依赖机器负载或固定等待时长。
 */
function settle(): Promise<void> {
  return until((): boolean => events.length > 0);
}

beforeEach(() => {
  for (const mocked of [
    probeChatMembership,
    probeChatAdmin,
    banChatMemberWithOutcome,
    banChatSenderChatWithOutcome,
    deleteMessage,
    recordJoin,
    releaseAdDetectDedupKey,
  ]) {
    mocked.mockClear();
  }
  probeChatAdmin.mockImplementation(async (): Promise<boolean | undefined> => false);
  probeChatMembership.mockImplementation(async (): Promise<boolean | undefined> => true);
  banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "banned");
  banChatSenderChatWithOutcome.mockImplementation(async (): Promise<string> => "banned");
  deleteMessage.mockImplementation(async (): Promise<boolean> => true);
  events.length = 0;
  blocklistRemovalEpochs.clear();
  resetWorkerBotPermissions();
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
    // 与验证超时踢人共用 kick 类别，不进入消息发送的 grammY 桶。
    expect(banChatMemberWithOutcome).toHaveBeenCalledWith(-1001, 42, guardApi);
    expect(releaseAdDetectDedupKey).toHaveBeenCalledWith(-1001, 42);
    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 1, complete: true, permissionDenied: false, targetIsAdmin: false }]);
  });

  test("去重回收抛出也不改回执：一个已经跑完的批次不能被重投", async () => {
    // 回收排在 publish 之前时，这里抛出会转进 .catch 并改发 complete:false，
    // 主线程据此重投一个其实已经完成的批次。回执必须先于任何尽力而为的清理。
    releaseAdDetectDedupKey.mockImplementationOnce((): void => {
      throw new Error("ad-detect release failed");
    });

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [42], probeMembership: false, removalId: 9 },
      publish,
    });
    await settle();

    expect(banChatMemberWithOutcome).toHaveBeenCalledWith(-1001, 42, guardApi);
    // 恰好一条，且是真实结果；不能既发 complete:true 又补一条 complete:false。
    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 9, complete: true, permissionDenied: false, targetIsAdmin: false }]);
  });

  test("probeMembership=true 时逐个探测，只封此刻真在群里的人", async () => {
    probeChatMembership.mockImplementation(async (_chatId: unknown, userId: unknown): Promise<boolean> => userId === 7);

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7, 8], probeMembership: true, removalId: 2 },
      publish,
    });
    await settle();

    expect(probeChatMembership.mock.calls.map((call) => call[1])).toEqual([7, 8]);
    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(1);
    expect(banChatMemberWithOutcome).toHaveBeenCalledWith(-1001, 7, guardApi);
    // 确认不在群不算失败：这批算完整落定。
    expect(events[0]?.complete).toBeTrue();
    // 补扫批次可能很大，不用它逐 id 触发广告去重回收。
    expect(releaseAdDetectDedupKey).not.toHaveBeenCalled();
  });

  test("探测失败不算「不在群」：宁可多封一次，也不放过坐在群里的人", async () => {
    probeChatMembership.mockImplementation(async (): Promise<boolean | undefined> => undefined);

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: true, removalId: 3 },
      publish,
    });
    await settle();

    expect(banChatMemberWithOutcome).toHaveBeenCalledWith(-1001, 7, guardApi);
    expect(events[0]?.complete).toBeTrue();
  });

  test("封禁失败按退避重试，最终仍失败时回执 complete=false", async () => {
    // 黑名单入群不开验证窗口，没有超时踢人兜底——这次处置是唯一的机会。
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "failed");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: false, removalId: 4 },
      publish,
    });
    await settle();

    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(3);
    expect(releaseAdDetectDedupKey).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 4, complete: false, permissionDenied: false, targetIsAdmin: false }]);
  });

  test("「目标是管理员」只结算这个 id，不把整个群标成权限受阻", async () => {
    // Telegram 对「机器人没权限」和「目标本身是管理员」返回的是同一句 400。
    // 混在一起就意味着一个封不掉的管理员会把整个群的清扫永久闩死：此后补扫
    // 早退、重扫请求被拒、每次重启跳过重放，而唯一的解锁边沿是「机器人的封禁
    // 权限变了」——那件事根本不会发生。
    banChatMemberWithOutcome.mockImplementation(async (..._args: unknown[]): Promise<string> =>
      _args[1] === 7 ? "forbidden" : "banned");
    probeChatAdmin.mockImplementation(async (..._args: unknown[]): Promise<boolean | undefined> => _args[1] === 7);

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7, 8], probeMembership: false, removalId: 41 },
      publish,
    });
    await settle();

    expect(probeChatAdmin).toHaveBeenCalledWith(-1001, 7, guardApi);
    // 同批其余 id 照常处置完，整批就此落定——不留给按时间的重试，也不闩住群。
    expect(banChatMemberWithOutcome).toHaveBeenCalledWith(-1001, 8, guardApi);
    expect(events).toEqual([
      { type: "blockedMembersRemoved", chatId: -1001, removalId: 41, complete: true, permissionDenied: false, targetIsAdmin: true },
    ]);
    expect(releaseAdDetectDedupKey).not.toHaveBeenCalled();
  });

  test("确证不了目标身份时维持原判：仍按机器人缺权限上报", async () => {
    // 没有确证就把群级闩锁降级成逐个重试，等于把「永远封不掉」重新变成
    // 每个退避窗口一次 O(名单长度) 的请求风暴。
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "forbidden");
    probeChatAdmin.mockImplementation(async (): Promise<boolean | undefined> => undefined);

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: false, removalId: 42 },
      publish,
    });
    await settle();

    expect(events).toEqual([
      { type: "blockedMembersRemoved", chatId: -1001, removalId: 42, complete: false, permissionDenied: true, targetIsAdmin: false },
    ]);
  });

  test("重试期间恢复正常就算落定", async () => {
    let attempts: number = 0;
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => ++attempts >= 2 ? "banned" : "failed");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: false, removalId: 5 },
      publish,
    });
    await settle();

    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(2);
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

  test("确证没有删消息权限时不发那次注定 400 的公告删除", async () => {
    // 机器人可以是「有 can_restrict_members、没有 can_delete_messages」的管理员。
    // 那种群里每个黑名单入群都换来一次必败的 deleteMessage，而这些请求排在与
    // 验证超时踢人共用的 kick 类别 429 FIFO 上——一波协同入群时，
    // 它们会把真正的踢人顶到验证窗口之后，公告本身照样删不掉。
    applyBotPermissionsChange(-1001, { canRestrictMembers: true, canDeleteMessages: false });

    handleRemoveBlockedMembers({
      msg: {
        type: "removeBlockedMembers",
        chatId: -1001,
        userIds: [7],
        probeMembership: false,
        removalId: 61,
        announcementMessageId: 88,
      },
      publish,
    });
    await settle();

    expect(deleteMessage).not.toHaveBeenCalled();
    // 封禁本身照常执行：这道闸只挡删消息。
    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(1);
  });

  test("权限未观测到时照常尝试删除，由 Telegram 当裁判", async () => {
    // 三态里只拦确证的 false：撤管理员、离群、/init 切换和现查失败发的都是同
    // 一条「权限未知」，把它折算成「没有权限」等于在一个权限齐全的群里白白留着
    // 那条公告（口径见 workers/antiRaid/botPermissions.ts）。
    handleRemoveBlockedMembers({
      msg: {
        type: "removeBlockedMembers",
        chatId: -1001,
        userIds: [7],
        probeMembership: false,
        removalId: 62,
        announcementMessageId: 88,
      },
      publish,
    });
    await settle();

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
    let releaseFirst!: (outcome: string) => void;
    banChatMemberWithOutcome.mockImplementationOnce((): Promise<string> =>
      new Promise((resolve: (outcome: string) => void): void => { releaseFirst = resolve; }));

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7, 8, 9], probeMembership: false, removalId: 7 },
      publish,
    });
    // 等第一次封禁真的发出去——releaseFirst 是在那个 mock 实现里才被赋值的。
    // 同样不赌固定时长：赌少了这里会变成 releaseFirst is not a function。
    await until((): boolean => banChatMemberWithOutcome.mock.calls.length > 0);
    // 第一条还悬着的时候 /init disable：补扫可能还要跑几分钟，必须立刻收手。
    bumpBlocklistRemovalEpoch(-1001);
    releaseFirst("banned");
    await settle();

    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(1);
    // 没扫完，回执必须说清楚——重新接管后还要再欠一次。
    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 7, complete: false, permissionDenied: false, targetIsAdmin: false }]);
  });

  test("频道身份没有「成员」一说：直接封发言权，不做成员探测", async () => {
    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [-4004], probeMembership: true, removalId: 8 },
      publish,
    });
    await settle();

    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(banChatSenderChatWithOutcome).toHaveBeenCalledWith(-1001, -4004, guardApi);
  });

  test("频道身份也要能报权限受阻：否则那批只会一直按时间重试注定失败的请求", async () => {
    banChatSenderChatWithOutcome.mockImplementation(async (): Promise<string> => "forbidden");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [-4004], probeMembership: false, removalId: 20 },
      publish,
    });
    await settle();

    // 权限不够不消耗剩余尝试，也不该退化成 failed——permissionDenied 才是那道
    // 「停掉按时间重试、只等权限变更」的闩锁的唯一入口。
    expect(banChatSenderChatWithOutcome).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "blockedMembersRemoved", chatId: -1001, removalId: 20, complete: false, permissionDenied: true, targetIsAdmin: false },
    ]);
  });

  test("确认封不了人后立刻收手，不把整份名单的注定失败请求压进共用队列", async () => {
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "forbidden");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [1, 2, 3, 4, 5], probeMembership: false, removalId: 21 },
      publish,
    });
    await settle();

    // 只为第一个 id 付一次 banChatMember + 一次 probeChatAdmin；剩下四个不再发。
    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(1);
    expect(probeChatAdmin).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "blockedMembersRemoved", chatId: -1001, removalId: 21, complete: false, permissionDenied: true, targetIsAdmin: false },
    ]);
  });

  test("返回在途任务但由 mailbox 调度器后台登记：一波刷屏入群时不阻塞路由", async () => {
    let settleBan!: (outcome: string) => void;
    let firstCall: boolean = true;
    banChatMemberWithOutcome.mockImplementation((): Promise<string> => {
      if (!firstCall) return Promise.resolve("banned");
      firstCall = false;
      return new Promise((resolve: (outcome: string) => void): void => { settleBan = resolve; });
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
    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(1);

    settleBan("banned");
    await returned;
    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(2);
  });

  test("抛错被兜住，不冒泡成 Worker 的未处理拒绝，且照样回执", async () => {
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => { throw new Error("network down"); });

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [42], probeMembership: false, removalId: 10 },
      publish,
    });
    await settle();

    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 10, complete: false, permissionDenied: false, targetIsAdmin: false }]);
  });
});
