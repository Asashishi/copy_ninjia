import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AntiRaidWorkerMessage } from "../../packages/types/antiRaid";
import type { RemoveBlockedMembersParams } from "../../packages/types/blocklist";

const blockedIds = new Set<number>();
const errorLogs: string[] = [];
const requestBlocklistResweep = mock((_chatId: number, _nextRetryAt?: number): void => {});
const ensureBotChatPermissions = mock((_chatId: number): void => {});
const deleteMessageWithOutcome = mock(async (..._args: unknown[]): Promise<string> => "deleted");
let removalCounter: number = 0;
let trackFails: boolean = false;
let canDeleteMessages: boolean | undefined = true;

mock.module("../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));
mock.module("../../packages/infra/blocklist/membership", () => ({
  isUserBlocked: (userId: number): boolean => blockedIds.has(userId),
}));
mock.module("../../packages/infra/blocklist/outbox", () => ({
  registerBlockedMemberRemover: (): void => {},
  trackBlockedRemoval: (
    params: Omit<RemoveBlockedMembersParams, "removalId">
  ): RemoveBlockedMembersParams => {
    if (trackFails) throw new Error("Blocklist removal outbox reached its 10000-entry capacity.");
    return { ...params, removalId: ++removalCounter };
  },
}));
mock.module("../../packages/infra/blocklist/sweep", () => ({ requestBlocklistResweep }));
mock.module("../../packages/infra/botAdmin", () => ({
  botCanDeleteMessagesIn: (): boolean | undefined => canDeleteMessages,
  ensureBotChatPermissions,
}));
mock.module("../../packages/infra/telegram/actions", () => ({ deleteMessageWithOutcome }));

const {
  claimBlockedJoiner,
  deleteBlockedSenderChatMessage,
} = await import("../../packages/antiRaid/blocklistGuard");
const { recentBlockedJoinCounts } = await import("../../packages/cache/main/antiRaid/blocklistGuard");

beforeEach(() => {
  blockedIds.clear();
  errorLogs.length = 0;
  recentBlockedJoinCounts.clear();
  requestBlocklistResweep.mockClear();
  ensureBotChatPermissions.mockClear();
  deleteMessageWithOutcome.mockClear();
  deleteMessageWithOutcome.mockImplementation(async (): Promise<string> => "deleted");
  removalCounter = 0;
  trackFails = false;
  canDeleteMessages = true;
});

describe("已拉黑频道身份的漏网消息", () => {
  function senderChatMessage(senderChatId: number = -4004): never {
    return {
      message_id: 77,
      chat: { id: -1001, type: "supergroup" },
      sender_chat: { id: senderChatId, type: "channel", title: "Blocked Channel" },
    } as never;
  }

  test("命中永久黑名单后直接删除并接管消息", async () => {
    blockedIds.add(-4004);

    expect(await deleteBlockedSenderChatMessage(senderChatMessage())).toBeTrue();

    expect(ensureBotChatPermissions).toHaveBeenCalledWith(-1001);
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 77);
  });

  test("明确缺删除权限时不发送注定失败的请求，但仍阻止后续业务处理", async () => {
    blockedIds.add(-4004);
    canDeleteMessages = false;

    expect(await deleteBlockedSenderChatMessage(senderChatMessage())).toBeTrue();

    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();
    expect(errorLogs.some((line) => line.includes("can_delete_messages"))).toBeTrue();
  });

  test("权限未知时让 Telegram 裁决；删除失败也不把黑名单消息放回业务流水线", async () => {
    blockedIds.add(-4004);
    canDeleteMessages = undefined;
    deleteMessageWithOutcome.mockResolvedValueOnce("failed");

    expect(await deleteBlockedSenderChatMessage(senderChatMessage())).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 77);
    expect(errorLogs.some((line) => line.includes("could not be deleted (failed)"))).toBeTrue();
  });

  test("非黑名单频道与当前群匿名管理员皮套原样放行", async () => {
    expect(await deleteBlockedSenderChatMessage(senderChatMessage())).toBeFalse();

    blockedIds.add(-1001);
    expect(await deleteBlockedSenderChatMessage(senderChatMessage(-1001))).toBeFalse();
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();
  });
});

function joinMessage(chatId: number, userId: number): AntiRaidWorkerMessage {
  return {
    type: "join",
    chatId,
    member: { id: userId, first_name: "Joiner" },
    actorIsWhitelisted: false,
  };
}

describe("黑名单入群秒踢的投递侧", () => {
  test("名单里的人就地登记一批处置，同一次物理入群只补记一次入群计数", () => {
    blockedIds.add(42);
    const messages: AntiRaidWorkerMessage[] = [];
    const replacedJoins = new Map<number, AntiRaidWorkerMessage>();
    const replacedJoin = joinMessage(-1001, 42);

    expect(claimBlockedJoiner({ chatId: -1001, userId: 42, messages, replacedJoin, replacedJoins, now: 1_000 })).toBeTrue();
    expect(claimBlockedJoiner({ chatId: -1001, userId: 42, messages, replacedJoin, replacedJoins, now: 1_050 })).toBeTrue();

    expect(messages).toHaveLength(2);
    // 两条投递路径（chat_member 与 new_chat_members）会为同一次入群各来一次；
    // 两条都带 joinedAt 就是记两次，阈值对黑名单账号实际减半。
    expect(messages.map((message) => (message as RemoveBlockedMembersParams).joinedAt)).toEqual([1_000, undefined]);
    // 每批处置都登记下它取代掉的那条 join：批次被并发 /unblock 取消时，
    // durable 对账要靠它把验证窗口补回来（见 blocklistDelivery.ts）。
    expect([...replacedJoins.keys()]).toEqual([1, 2]);
    expect(replacedJoins.get(1)).toBe(replacedJoin);
  });

  test("不在名单里的人原样放行给普通入群守卫", () => {
    const messages: AntiRaidWorkerMessage[] = [];
    const replacedJoins = new Map<number, AntiRaidWorkerMessage>();
    expect(claimBlockedJoiner({
      chatId: -1001,
      userId: 42,
      messages,
      replacedJoin: joinMessage(-1001, 42),
      replacedJoins,
    })).toBeFalse();
    expect(messages).toHaveLength(0);
    expect(replacedJoins.size).toBe(0);
  });

  test("登记失败不上抛：那会在更新中间件里换来一个重启循环", () => {
    // 抛出去的话，整批 update 失败 → 扣住 offset → 非零退出 → systemd 重启 →
    // Telegram 重投同一条 update → 再抛。只能靠手改 memory/blocklist/removals.json
    // 解开，而 outbox 满本身通常正是一批永远封不掉的处置堆出来的。
    blockedIds.add(42);
    trackFails = true;
    const messages: AntiRaidWorkerMessage[] = [];

    const replacedJoins = new Map<number, AntiRaidWorkerMessage>();
    expect(() => claimBlockedJoiner({
      chatId: -1001,
      userId: 42,
      messages,
      replacedJoin: joinMessage(-1001, 42),
      replacedJoins,
    })).not.toThrow();
    expect(messages).toHaveLength(0);
    // 登记失败时也不能留下兜底 join：名单判定没变，不该给他开验证窗口。
    expect(replacedJoins.size).toBe(0);
    expect(errorLogs.some((line) => line.includes("Failed to queue removal of blocklisted user 42"))).toBeTrue();
    // 仍算「已按黑名单处置」：名单判定没变，不该反过来给他开一个验证窗口。
    // 位置留给补扫：outbox 腾出空间后由下一次管理员身份观测接上。
    expect(requestBlocklistResweep).toHaveBeenCalledWith(-1001);
  });

  test("登记失败时不消耗入群计数认领：另一路投递还能替这次入群补记", () => {
    // 认领写在实参位置时，trackBlockedRemoval 抛错走降级返回，去重项却已经被
    // 消耗掉——同一次物理入群的另一路投递随后只能带 joinedAt: undefined，这次
    // 入群从反刷群滑动窗口里整个消失。一波以黑名单账号为主的突袭因此凑不满
    // ANTI_RAID_PER_MINUTE_LIMIT，私密模式不触发，紧随其后的非黑名单号各自
    // 拿满一个三分钟验证窗口而不是被秒踢。
    blockedIds.add(42);
    trackFails = true;
    const messages: AntiRaidWorkerMessage[] = [];
    const replacedJoins = new Map<number, AntiRaidWorkerMessage>();
    const replacedJoin = joinMessage(-1001, 42);

    expect(claimBlockedJoiner({ chatId: -1001, userId: 42, messages, replacedJoin, replacedJoins, now: 1_000 })).toBeTrue();
    expect(messages).toHaveLength(0);
    expect(recentBlockedJoinCounts.size).toBe(0);

    // outbox 腾出位置后，同一次入群的第二路投递照常把计数补上。
    trackFails = false;
    expect(claimBlockedJoiner({ chatId: -1001, userId: 42, messages, replacedJoin, replacedJoins, now: 1_050 })).toBeTrue();
    expect(messages.map((message) => (message as RemoveBlockedMembersParams).joinedAt)).toEqual([1_050]);
  });
});
