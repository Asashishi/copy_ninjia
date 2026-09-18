import { beforeEach, describe, expect, mock, test } from "bun:test";
import { waitUntil } from "../../helpers/waitUntil";
import type { BlockedMembersRemovedEvent } from "../../../packages/types/antiRaid";

/**
 * 补扫处置里 PARTICIPANT_ID_INVALID 的判定：只有补扫中全部探测与封禁都被这样拒绝、
 * 且未被停机打断才报进回执；重试次数与未落定判定保持不变。
 */

const probeChatMembershipWithOutcome = mock(async (..._args: unknown[]): Promise<string> => "present");
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
  probeChatAdmin,
  banChatMemberWithOutcome,
  banChatSenderChatWithOutcome,
  deleteMessage,
  telegramApi: guardApi,
}));
mock.module("../../../packages/infra/telegram/actions/membership", () => ({
  probeChatMembershipWithOutcome,
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
const { resetWorkerBotPermissions } = await import("../../../packages/workers/antiRaid/botPermissions");
const { blocklistRemovalEpochs } = await import("../../../packages/cache/workers/antiRaid/blocklist");
const {
  quiesceAntiRaidDispatch,
  resetAntiRaidTaskTracker,
} = await import("../../../packages/workers/antiRaid/taskTracker");

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
  await waitUntil(ready, SETTLE_TIMEOUT_MS);
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
    probeChatMembershipWithOutcome,
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
  probeChatMembershipWithOutcome.mockImplementation(async (): Promise<string> => "present");
  banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "banned");
  banChatSenderChatWithOutcome.mockImplementation(async (): Promise<string> => "banned");
  deleteMessage.mockImplementation(async (): Promise<boolean> => true);
  events.length = 0;
  // 换回未 abort 的停机取消信号，并清空上一条用例留下的在途任务。
  resetAntiRaidTaskTracker();
  blocklistRemovalEpochs.clear();
  resetWorkerBotPermissions();
});

describe("黑名单处置的 PARTICIPANT_ID_INVALID 观测（守卫线程侧）", () => {
  test("补扫里探测与封禁全部 PARTICIPANT_ID_INVALID：照常重试且算未落定，回执报出该 id", async () => {
    probeChatMembershipWithOutcome.mockImplementation(async (): Promise<string> => "participantInvalid");
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "participantInvalid");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: true, removalId: 50 },
      publish,
    });
    await settle();

    // 重试次数与未落定判定都不变：计数只由主线程按回执累加。
    expect(probeChatMembershipWithOutcome).toHaveBeenCalledTimes(3);
    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(3);
    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 50, complete: false, permissionDenied: false, targetIsAdmin: false, participantInvalidUserIds: [7], settledUserIds: [] }]);
  });

  test("任一次请求不是 PARTICIPANT_ID_INVALID，这次处置就不计入销号", async () => {
    probeChatMembershipWithOutcome.mockImplementation(async (): Promise<string> => "participantInvalid");
    let bans: number = 0;
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> =>
      ++bans === 2 ? "failed" : "participantInvalid");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: true, removalId: 51 },
      publish,
    });
    await settle();

    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(3);
    expect(events[0]?.complete).toBeFalse();
    expect(events[0]?.participantInvalidUserIds).toEqual([]);
  });

  test("探测失败但不是 PARTICIPANT_ID_INVALID 时同样不计入", async () => {
    probeChatMembershipWithOutcome.mockImplementation(async (): Promise<string> => "failed");
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "participantInvalid");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: true, removalId: 52 },
      publish,
    });
    await settle();

    expect(events[0]?.participantInvalidUserIds).toEqual([]);
  });

  test("秒踢批次不读成员身份，封禁的 PARTICIPANT_ID_INVALID 不计入", async () => {
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "participantInvalid");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: false, removalId: 53 },
      publish,
    });
    await settle();

    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(3);
    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 53, complete: false, permissionDenied: false, targetIsAdmin: false, participantInvalidUserIds: [], settledUserIds: [] }]);
  });

  test("停机取消打断的重试不计入销号", async () => {
    probeChatMembershipWithOutcome.mockImplementation(async (): Promise<string> => "participantInvalid");
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => {
      quiesceAntiRaidDispatch();
      return "participantInvalid";
    });

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: true, removalId: 54 },
      publish,
    });
    await settle();

    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(1);
    expect(events[0]?.participantInvalidUserIds).toEqual([]);
  });

  test("混合批次按处置顺序分别报出销号观测与已落定 id", async () => {
    probeChatMembershipWithOutcome.mockImplementation(async (_chatId: unknown, userId: unknown): Promise<string> => {
      if (userId === 7 || userId === 10) return "participantInvalid";
      return userId === 8 ? "absent" : "present";
    });
    banChatMemberWithOutcome.mockImplementation(async (_chatId: unknown, userId: unknown): Promise<string> =>
      userId === 7 || userId === 10 ? "participantInvalid" : "banned");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7, 8, 9, 10], probeMembership: true, removalId: 55 },
      publish,
    });
    await settle();

    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 55, complete: false, permissionDenied: false, targetIsAdmin: false, participantInvalidUserIds: [7, 10], settledUserIds: [8, 9] }]);
  });
});
