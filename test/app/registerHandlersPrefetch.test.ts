import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Bot, Context } from "grammy";

/**
 * 身份预热中间件的两条路径（`app/registerHandlers.ts` 的第 4 条 `bot.use`）：
 * 全热 update 直接返回 `next()`，有冷身份时先等预热完成再进入下游。
 */

/** 调用顺序流水：预热与下游各记一笔，用来钉住两者的先后。 */
const calls: string[] = [];
let allCached: boolean = true;

const prefetchIdentityPolicies = mock(
  async (ids: readonly number[]): Promise<boolean> => {
    // 跨一次真实调度点后才记账，用以区分「已发起」与「已完成」。
    await Bun.sleep(0);
    calls.push(`prefetch:${[...ids].join(",")}`);
    return true;
  }
);

// 只覆写这两个出口，其余保留：identityStorage 其它导出仍被黑名单成员判定、
// 命令目标解析等模块使用。
const actualIdentityStorage = await import("../../packages/infra/identityStorage");
mock.module("../../packages/infra/identityStorage", () => ({
  ...actualIdentityStorage,
  isIdentityPolicyCached: (): boolean => allCached,
  prefetchIdentityPolicies,
}));

const { registerHandlers } = await import("../../packages/app/registerHandlers");

type TestMiddleware = (ctx: Context, next: () => Promise<void>) => Promise<void>;

/** 装一次链路，取出身份预热那一条（第 4 个 `bot.use`）。 */
function identityPrefetchMiddleware(): TestMiddleware {
  const middleware: TestMiddleware[] = [];
  const noop = (): unknown => fakeBot;
  const fakeBot: Record<string, unknown> = {
    use: (handler: TestMiddleware): unknown => {
      middleware.push(handler);
      return fakeBot;
    },
    command: noop,
    hears: noop,
    on: noop,
    catch: noop,
  };
  registerHandlers(fakeBot as unknown as Bot);
  const prefetchMiddleware: TestMiddleware | undefined = middleware[3];
  if (prefetchMiddleware === undefined) throw new Error("identity prefetch middleware is missing");
  return prefetchMiddleware;
}

const next = (): Promise<void> => {
  calls.push("next");
  return Promise.resolve();
};

beforeEach((): void => {
  calls.length = 0;
  allCached = true;
  prefetchIdentityPolicies.mockClear();
});

describe("身份预热中间件", () => {
  test("全热 update 不做跨线程读取，直接进入下游", async (): Promise<void> => {
    await identityPrefetchMiddleware()(
      { from: { id: 123 }, msg: {}, chat: { id: -1001, type: "supergroup" } } as unknown as Context,
      next
    );

    expect(prefetchIdentityPolicies).not.toHaveBeenCalled();
    expect(calls).toEqual(["next"]);
  });

  test("有冷身份时先预热完再进入下游——下游是同步 LRU 读，留冷就会误判未授权", async (): Promise<void> => {
    allCached = false;

    await identityPrefetchMiddleware()(
      { from: { id: 123 }, msg: {}, chat: { id: -1001, type: "supergroup" } } as unknown as Context,
      next
    );

    expect(calls).toEqual(["prefetch:123", "next"]);
  });

  test("一条 update 里的多个可见身份合并成一次预热", async (): Promise<void> => {
    allCached = false;

    await identityPrefetchMiddleware()({
      from: { id: 123 },
      msg: {
        sender_chat: { id: -1009 },
        reply_to_message: { from: { id: 456 } },
      },
      chat: { id: -1001, type: "supergroup" },
    } as unknown as Context, next);

    expect(prefetchIdentityPolicies).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["prefetch:123,-1009,456", "next"]);
  });
});
