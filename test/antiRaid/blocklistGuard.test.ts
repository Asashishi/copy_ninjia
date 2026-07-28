import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AntiRaidWorkerMessage } from "../../packages/types/antiRaid";
import type { RemoveBlockedMembersParams } from "../../packages/types/blocklist";

const blockedIds = new Set<number>();
const errorLogs: string[] = [];
const requestBlocklistResweep = mock((_chatId: number, _nextRetryAt?: number): void => {});
let removalCounter: number = 0;
let trackFails: boolean = false;

mock.module("../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));
mock.module("../../packages/infra/blocklist", () => ({
  isUserBlocked: (userId: number): boolean => blockedIds.has(userId),
  registerBlockedMemberRemover: (): void => {},
  requestBlocklistResweep,
  trackBlockedRemoval: (
    params: Omit<RemoveBlockedMembersParams, "removalId">
  ): RemoveBlockedMembersParams => {
    if (trackFails) throw new Error("Blocklist removal outbox reached its 10000-entry capacity.");
    return { ...params, removalId: ++removalCounter };
  },
}));

const { claimBlockedJoiner } = await import("../../packages/antiRaid/blocklistGuard");
const { recentBlockedJoinCounts } = await import("../../packages/cache/antiRaid/blocklistGuard");

beforeEach(() => {
  blockedIds.clear();
  errorLogs.length = 0;
  recentBlockedJoinCounts.clear();
  requestBlocklistResweep.mockClear();
  removalCounter = 0;
  trackFails = false;
});

describe("黑名单入群秒踢的投递侧", () => {
  test("名单里的人就地登记一批处置，同一次物理入群只补记一次入群计数", () => {
    blockedIds.add(42);
    const messages: AntiRaidWorkerMessage[] = [];

    expect(claimBlockedJoiner({ chatId: -1001, userId: 42, messages, now: 1_000 })).toBeTrue();
    expect(claimBlockedJoiner({ chatId: -1001, userId: 42, messages, now: 1_050 })).toBeTrue();

    expect(messages).toHaveLength(2);
    // 两条投递路径（chat_member 与 new_chat_members）会为同一次入群各来一次；
    // 两条都带 joinedAt 就是记两次，阈值对黑名单账号实际减半。
    expect(messages.map((message) => (message as RemoveBlockedMembersParams).joinedAt)).toEqual([1_000, undefined]);
  });

  test("不在名单里的人原样放行给普通入群守卫", () => {
    const messages: AntiRaidWorkerMessage[] = [];
    expect(claimBlockedJoiner({ chatId: -1001, userId: 42, messages })).toBeFalse();
    expect(messages).toHaveLength(0);
  });

  test("登记失败不上抛：那会在更新中间件里换来一个重启循环", () => {
    // 抛出去的话，整批 update 失败 → 扣住 offset → 非零退出 → systemd 重启 →
    // Telegram 重投同一条 update → 再抛。只能靠手改 memory/blocklist/removals.json
    // 解开，而 outbox 满本身通常正是一批永远封不掉的处置堆出来的。
    blockedIds.add(42);
    trackFails = true;
    const messages: AntiRaidWorkerMessage[] = [];

    expect(() => claimBlockedJoiner({ chatId: -1001, userId: 42, messages })).not.toThrow();
    expect(messages).toHaveLength(0);
    expect(errorLogs.some((line) => line.includes("Failed to queue removal of blocklisted user 42"))).toBeTrue();
    // 仍算「已按黑名单处置」：名单判定没变，不该反过来给他开一个验证窗口。
    // 位置留给补扫：outbox 腾出空间后由下一次管理员身份观测接上。
    expect(requestBlocklistResweep).toHaveBeenCalledWith(-1001);
  });
});
