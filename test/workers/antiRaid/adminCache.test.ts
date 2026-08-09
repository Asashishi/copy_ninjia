import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * 处置前那道身份闸的三态契约（packages/workers/antiRaid/adminCache.ts 的
 * isChatAdmin）。
 *
 * 它是一条权限边界：`undefined` 表示「没查出来」，调用方必须按不处置办。刷屏
 * 禁言与广告处置两条链路此前各抄了一份实现，改一份漏一份就会对「谁豁免」各执
 * 一词；收敛到一处之后，那两条链路的用例把它 mock 掉，真语义只剩这里钉。
 */

const errorLogs: string[] = [];
const cachedAdmins = new Map<number, Set<number>>();
const fetchedAdmins = new Map<number, Set<number>>();
let fetchCalls: number = 0;

mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));
mock.module("../../../packages/infra/telegram", () => ({
  joinVerificationApi: {
    getChatAdministrators: async (chatId: number): Promise<{ user: { id: number }; is_anonymous?: boolean }[]> => {
      fetchCalls++;
      const admins: Set<number> | undefined = fetchedAdmins.get(chatId);
      if (!admins) throw new Error("admin fetch failed");
      return [...admins].map((id: number): { user: { id: number } } => ({ user: { id } }));
    },
  },
}));
mock.module("../../../packages/workers/antiRaid/taskTracker", () => ({
  trackAntiRaidTask: <T>({ task }: { task: Promise<T> }): Promise<T> => task,
}));

const { isChatAdmin } = await import("../../../packages/workers/antiRaid/adminCache");
const { chatAdmins } = await import("../../../packages/cache/workers/antiRaid/admins");

beforeEach(() => {
  errorLogs.length = 0;
  cachedAdmins.clear();
  fetchedAdmins.clear();
  chatAdmins.clear();
  fetchCalls = 0;
});

/** 直接写进 owner 缓存，模拟入群守卫那边已经把这个群拉热了。 */
function seedFreshCache(chatId: number, adminIds: readonly number[]): void {
  chatAdmins.set(chatId, { adminIds: new Set(adminIds), fetchedAt: Date.now() });
}

describe("处置前的管理员身份闸", () => {
  test("缓存热时直接判定，不产生任何一次现拉", async () => {
    seedFreshCache(-1001, [7]);

    expect(await isChatAdmin(-1001, 7, "flooding user")).toBeTrue();
    expect(await isChatAdmin(-1001, 8, "flooding user")).toBeFalse();
    expect(fetchCalls).toBe(0);
  });

  test("缓存冷时现拉一次全量再判定", async () => {
    fetchedAdmins.set(-1001, new Set([7]));

    expect(await isChatAdmin(-1001, 7, "sender")).toBeTrue();
    expect(fetchCalls).toBe(1);
  });

  test("拉取失败返回 undefined 而不是 false：确证不了一律不处置", async () => {
    // 这一条是整个契约的重点。把失败当成「不是管理员」等于在 Telegram 抖动时
    // 对着群主动手，而 restrictChatMember 回的那句 400 与「机器人自己缺权限」
    // 完全一样，运维只会被引向权限配置。
    expect(await isChatAdmin(-1001, 7, "flooding user")).toBeUndefined();
    expect(errorLogs[0]).toContain("Failed to check admin exemption for flooding user 7 in chat -1001");
  });

  test("失败日志带上调用方的处置名，两条链路分得清是谁没查出来", async () => {
    await isChatAdmin(-1002, 9, "sender");

    expect(errorLogs[0]).toContain("Failed to check admin exemption for sender 9 in chat -1002");
  });
});
