import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Bot, Context } from "grammy";

/**
 * update 前置身份预热中间件的收集口径。
 *
 * 判定点（whitelist.ts 的 isWhitelisted、infra/blocklist/membership.ts 的
 * isUserBlocked）都是同步读 LRU、冷缺失 fail-closed，因此「这条 update 里哪些
 * 身份会被判定」必须与「预热收集了哪些 id」严格对齐——漏一个就等于让那个身份在
 * 本条 update 里被当成未授权。
 */

const prefetchedBatches: readonly number[][] = [];
const prefetchIdentityPolicies = mock(
  async (ids: readonly number[]): Promise<boolean> => {
    (prefetchedBatches as number[][]).push([...ids]);
    return true;
  }
);

// 只替换本用例观察的那两个出口；其余出口由真实模块提供（whitelist.ts 等
// 下游模块仍需要它们）。
const identityStorage = await import("../../packages/infra/identityStorage");
mock.module("../../packages/infra/identityStorage", () => ({
  ...identityStorage,
  isIdentityPolicyCached: (): boolean => false,
  prefetchIdentityPolicies,
}));

const { registerHandlers } = await import("../../packages/app/registerHandlers");

type TestMiddleware = (ctx: Context, next: () => Promise<void>) => unknown;

/** 前置网关会读 ctx.me；本用例只关心预热收集，给一个最小 bot 身份即可。 */
const botContext: Record<string, unknown> = { me: { id: 999, username: "test_bot" } };

/** 只收集 bot.use 注册的中间件；命令与 update handler 本用例不关心。 */
function collectMiddleware(): TestMiddleware[] {
  const middleware: TestMiddleware[] = [];
  const fakeBot: Record<string, unknown> = {
    use(handler: TestMiddleware): unknown {
      middleware.push(handler);
      return fakeBot;
    },
    command(): unknown { return fakeBot; },
    hears(): unknown { return fakeBot; },
    on(): unknown { return fakeBot; },
    catch(): unknown { return fakeBot; },
  };
  registerHandlers(fakeBot as unknown as Bot);
  return middleware;
}

/**
 * 预热中间件是唯一一个会调用 prefetchIdentityPolicies 的 bot.use；按行为定位而
 * 不是按下标，前面插一道无关中间件时本用例不会悄悄测到别的东西。
 */
async function runPrefetchMiddleware(ctx: Record<string, unknown>): Promise<void> {
  for (const handler of collectMiddleware()) {
    await handler(ctx as unknown as Context, (): Promise<void> => Promise.resolve());
    if (prefetchIdentityPolicies.mock.calls.length > 0) return;
  }
  throw new Error("The identity prefetch middleware was never reached.");
}

beforeEach(() => {
  prefetchIdentityPolicies.mockClear();
  (prefetchedBatches as number[][]).length = 0;
});

describe("update 前置身份预热", () => {
  test("普通群消息收集发言人、频道马甲与回复双方", async () => {
    await runPrefetchMiddleware({
      ...botContext,
      update: { update_id: 1 },
      from: { id: 100 },
      chat: { id: -1001, type: "supergroup" },
      msg: {
        sender_chat: { id: -1002233445566 },
        reply_to_message: { from: { id: 7 }, sender_chat: { id: -1009 } },
      },
    });

    expect(prefetchedBatches[0]).toEqual([100, -1002233445566, 7, -1009]);
  });

  test("频道帖没有 from 也没有 sender_chat 时补上频道自己的 id", async () => {
    await runPrefetchMiddleware({
      ...botContext,
      update: { update_id: 2 },
      chat: { id: -1002233445566, type: "channel" },
      msg: { text: "/query_mood" },
    });

    // users/visibleSender.ts、commands/commandActor.ts 与 infra/updateGate.ts 都
    // 按 ctx.chat.id 解析频道帖的行为主体；不收集它的话，已在 whitelist_entries
    // 里的频道在自己频道发命令会撞上冷 LRU 的 fail-closed 判定被拒。
    expect(prefetchedBatches[0]).toEqual([-1002233445566]);
  });

  test("频道帖带 sender_chat 时以它为准，不重复收集会话 id", async () => {
    await runPrefetchMiddleware({
      ...botContext,
      update: { update_id: 3 },
      chat: { id: -1002233445566, type: "channel" },
      msg: { sender_chat: { id: -1009988776655 } },
    });

    expect(prefetchedBatches[0]).toEqual([-1009988776655]);
  });

  test("转发、被回复转发与跨群回复的原始身份一并预热", async () => {
    await runPrefetchMiddleware({
      ...botContext,
      update: { update_id: 4 },
      from: { id: 100 },
      chat: { id: -1001, type: "supergroup" },
      msg: {
        forward_origin: {
          type: "user",
          date: 1,
          sender_user: { id: 200, is_bot: false, first_name: "Forwarded" },
        },
        reply_to_message: {
          from: { id: 300 },
          forward_origin: {
            type: "channel",
            date: 1,
            chat: { id: -400, type: "channel", title: "Origin" },
            message_id: 1,
          },
        },
        external_reply: {
          origin: {
            type: "chat",
            date: 1,
            sender_chat: { id: -500, type: "channel", title: "External" },
          },
        },
      },
    });

    expect(prefetchedBatches[0]).toEqual([100, 300, 200, -400, -500]);
  });

  test("入群服务消息把操作者与全部新成员一并预热", async (): Promise<void> => {
    await runPrefetchMiddleware({
      ...botContext,
      update: { update_id: 5 },
      from: { id: 100 },
      chat: { id: -1001, type: "supergroup" },
      msg: {
        new_chat_members: [
          { id: 201, is_bot: false, first_name: "One" },
          { id: 202, is_bot: true, first_name: "Two" },
        ],
      },
    });

    expect(prefetchedBatches[0]).toEqual([100, 201, 202]);
  });

  test("退群服务消息同时预热操作者与离群成员", async (): Promise<void> => {
    await runPrefetchMiddleware({
      ...botContext,
      update: { update_id: 6 },
      from: { id: 100 },
      chat: { id: -1001, type: "supergroup" },
      msg: {
        left_chat_member: { id: 203, is_bot: false, first_name: "Left" },
      },
    });

    expect(prefetchedBatches[0]).toEqual([100, 203]);
  });

  test("chat_member 更新预热操作者与变更后的成员身份", async (): Promise<void> => {
    await runPrefetchMiddleware({
      ...botContext,
      update: { update_id: 7 },
      from: { id: 100 },
      chat: { id: -1001, type: "supergroup" },
      chatMember: {
        new_chat_member: {
          status: "member",
          user: { id: 204, is_bot: false, first_name: "Changed" },
        },
      },
    });

    expect(prefetchedBatches[0]).toEqual([100, 204]);
  });
});
