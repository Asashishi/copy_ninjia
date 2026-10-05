/** 注册边界使用真实 grammY 链，核对外层回退、提前消费、异常和末层 next 语义。 */
import { describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { Bot, Composer, Context } from "grammy";
import type { MiddlewareFn, NextFunction } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { registerHandlers } from "../../packages/app/registerHandlers";
import { botMessageActivity } from "../../packages/cache/main/botMessage";
import {
  BOT_MESSAGE_ACTIVITY_LIMIT,
  BOT_MESSAGE_ACTIVITY_TTL_MS,
} from "../../packages/consts/botMessage";

const BOT_INFO: Readonly<UserFromGetMe> = {
  id: 999,
  is_bot: true,
  first_name: "Chain",
  username: "chain_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: true,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

interface RegisteredBot {
  readonly bot: Bot;
  readonly registration: ReturnType<typeof registerHandlers>;
}

/** 在生产注册边界前后安装用例自己的探针，不启动 Bot 或建立外部连接。 */
function registerBot(
  before?: MiddlewareFn<Context>,
  after?: MiddlewareFn<Context>
): RegisteredBot {
  const bot: Bot = new Bot("1:AAA", { botInfo: BOT_INFO });
  if (before !== undefined) bot.use(before);
  const registration: ReturnType<typeof registerHandlers> = registerHandlers(bot);
  if (after !== undefined) bot.use(after);
  return { bot, registration };
}

describe("registerHandlers SDK 链边界", () => {
  test("前置链与 update handler 放行后只调用一次外层 next，并按安装顺序回退", async (): Promise<void> => {
    const calls: string[] = [];
    const { bot, registration }: RegisteredBot = registerBot(
      async (_ctx: Context, next: NextFunction): Promise<void> => {
        calls.push("before:enter");
        await next();
        calls.push("before:leave");
      },
      async (_ctx: Context, next: NextFunction): Promise<void> => {
        calls.push("after:enter");
        expect(registration.getLastSeenUpdateId()).toBe(12);
        await next();
        calls.push("after:leave");
      }
    );
    const ctx: Context = new Context({ update_id: 12 }, bot.api, BOT_INFO);
    await bot.middleware()(ctx, (): Promise<void> => {
      calls.push("outer");
      return Promise.resolve();
    });
    expect(calls).toEqual([
      "before:enter", "after:enter", "outer", "after:leave", "before:leave",
    ]);
  });

  test("bot 发言外闸消费更新后不执行回执、下游或外层 next", async (): Promise<void> => {
    const calls: string[] = [];
    const { bot, registration }: RegisteredBot = registerBot(
      async (_ctx: Context, next: NextFunction): Promise<void> => {
        calls.push("before:enter");
        await next();
        calls.push("before:leave");
      },
      (): undefined => { calls.push("after"); return undefined; }
    );
    const otherBotId: number = 42;
    botMessageActivity.set(otherBotId, {
      count: BOT_MESSAGE_ACTIVITY_LIMIT,
      expiresAt: Date.now() + BOT_MESSAGE_ACTIVITY_TTL_MS,
      timer: null,
    });
    const ctx: Context = new Context({
      update_id: 13,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -1001, type: "supergroup", title: "chain" },
        from: { id: otherBotId, is_bot: true, first_name: "Other" },
      },
    }, bot.api, BOT_INFO);
    Object.defineProperty(ctx, "msg", {
      get(): never { throw new Error("The receipt boundary must not be reached."); },
    });
    try {
      await bot.middleware()(ctx, (): Promise<void> => {
        calls.push("outer");
        return Promise.resolve();
      });
      expect(calls).toEqual(["before:enter", "before:leave"]);
      expect(registration.getLastSeenUpdateId()).toBe(13);
    } finally {
      const timer: ReturnType<typeof setTimeout> | null | undefined = botMessageActivity.get(otherBotId)?.timer;
      if (timer !== undefined && timer !== null) clearTimeout(timer);
      botMessageActivity.delete(otherBotId);
    }
  });

  test("同步异常与外层 next 的异步拒绝保留同一个错误对象", async (): Promise<void> => {
    const { bot, registration }: RegisteredBot = registerBot();
    const synchronousFailure: Error = new Error("synchronous chain failure");
    const ctx: Context = new Context({ update_id: 14 }, bot.api, BOT_INFO);
    Object.defineProperty(ctx, "me", {
      get(): never { throw synchronousFailure; },
    });
    await expect(bot.middleware()(ctx, (): Promise<void> => Promise.resolve()))
      .rejects.toBe(synchronousFailure);
    expect(registration.getLastSeenUpdateId()).toBe(14);

    const asynchronousFailure: Error = new Error("asynchronous chain failure");
    const nextCtx: Context = new Context({ update_id: 15 }, bot.api, BOT_INFO);
    await expect(bot.middleware()(nextCtx, (): Promise<void> => Promise.reject(asynchronousFailure)))
      .rejects.toBe(asynchronousFailure);
    expect(registration.getLastSeenUpdateId()).toBe(15);
  });

  test("前层重复 next 由 SDK 拒绝，外层只执行一次", async (): Promise<void> => {
    const { bot }: RegisteredBot = registerBot(async (_ctx: Context, next: NextFunction): Promise<void> => {
      await next();
      await next();
    });
    const ctx: Context = new Context({ update_id: 16 }, bot.api, BOT_INFO);
    let outerCalls: number = 0;
    await expect(bot.middleware()(ctx, (): Promise<void> => {
      outerCalls += 1;
      return Promise.resolve();
    })).rejects.toThrow();
    expect(outerCalls).toBe(1);
  });

  test("批量注册的最后一层 next 直接使用外层回调，可按 SDK 契约调用两次", async (): Promise<void> => {
    const bot: Bot = new Bot("1:AAA", { botInfo: BOT_INFO });
    const sdkUse: Mock<Bot["use"]> = spyOn(bot, "use");
    registerHandlers(bot);
    const preamble: Parameters<Bot["use"]> | undefined = sdkUse.mock.calls[0];
    sdkUse.mockRestore();
    if (preamble === undefined) throw new Error("The preamble batch must be registered.");
    expect(preamble).toHaveLength(12);
    // 使用登记的整批前置链，只把末层替换为用例自己的 next 探针。
    const boundary: Composer<Context> = new Composer<Context>();
    boundary.use(...preamble.slice(0, -1), async (_ctx: Context, next: NextFunction): Promise<void> => {
      await next();
      await next();
    });
    const ctx: Context = new Context({ update_id: 17 }, bot.api, BOT_INFO);
    let outerCalls: number = 0;
    await boundary.middleware()(ctx, (): Promise<void> => {
      outerCalls += 1;
      return Promise.resolve();
    });
    expect(outerCalls).toBe(2);
  });
});
