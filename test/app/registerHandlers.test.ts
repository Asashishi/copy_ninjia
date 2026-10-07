import { describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { Composer, GrammyError } from "grammy";
import type { Bot, Context } from "grammy";
import { botMessageActivity } from "../../packages/cache/main/botMessage";
import { BOT_MESSAGE_ACTIVITY_LIMIT } from "../../packages/consts/botMessage";
const composerUseAtImport: Mock<Composer<Context>["use"]> = spyOn(Composer.prototype, "use");
const { registerHandlers } = await import("../../packages/app/registerHandlers");
/** 显式注册之前调用 SDK use 的次数；模块导入不安装任何中间件。 */
const SDK_REGISTRATIONS_AFTER_IMPORT: number = composerUseAtImport.mock.calls.length;
composerUseAtImport.mockRestore();

type TestMiddleware = (ctx: Context, next: () => Promise<void>) => unknown;

interface FakeBot {
  use(...handlers: TestMiddleware[]): FakeBot;
  command(command: string, handler: unknown): FakeBot;
  hears(trigger: RegExp, handler: unknown): FakeBot;
  on(update: unknown, handler?: unknown): FakeBot;
  catch(handler: unknown): FakeBot;
}

/** 只带 update 类型字段的最小上下文；ingress 外闸只读 message / channelPost。 */
function nonMessageContext(): Context {
  return { update: { update_id: 1 }, message: undefined, channelPost: undefined, me: { id: 999 } } as unknown as Context;
}

/** 一次 registerHandlers 在假 bot 上留下的全部登记。 */
interface Registration {
  readonly registration: ReturnType<typeof registerHandlers>;
  readonly used: readonly (readonly TestMiddleware[])[];
  /** 直接挂在 bot 上的命令与 hears，必须恒为空（见 app/registerHandlers.ts）。 */
  readonly directCommands: readonly string[];
  readonly directHears: readonly RegExp[];
  readonly updates: readonly unknown[];
  /** use 与 on 记在同一条有序流水里，钉住承重的相对顺序。 */
  readonly registrationOrder: readonly string[];
  readonly catchHandlers: readonly ((error: { ctx: Context; error: unknown }) => void)[];
  /** 子 Composer 上按注册顺序登记的命令名。 */
  readonly commands: readonly unknown[];
  readonly middleware: readonly TestMiddleware[];
}

function registerOnFakeBot(): Registration {
  const used: TestMiddleware[][] = [];
  const directCommands: string[] = [];
  const directHears: RegExp[] = [];
  const updates: unknown[] = [];
  const registrationOrder: string[] = [];
  const catchHandlers: ((error: { ctx: Context; error: unknown }) => void)[] = [];
  const fakeBot: FakeBot = {
    use(...handlers: TestMiddleware[]): FakeBot {
      used.push(handlers);
      registrationOrder.push("use");
      return fakeBot;
    },
    command(command: string, _handler: unknown): FakeBot {
      directCommands.push(command);
      registrationOrder.push(`command:${command}`);
      return fakeBot;
    },
    hears(trigger: RegExp, _handler: unknown): FakeBot {
      directHears.push(trigger);
      registrationOrder.push("hears");
      return fakeBot;
    },
    on(update: unknown, _handler?: unknown): FakeBot {
      updates.push(update);
      registrationOrder.push(`on:${JSON.stringify(update)}`);
      return fakeBot;
    },
    catch(handler: unknown): FakeBot {
      catchHandlers.push(handler as (error: { ctx: Context; error: unknown }) => void);
      return fakeBot;
    },
  };
  const composerCommands = spyOn(Composer.prototype, "command");
  try {
    const registration: ReturnType<typeof registerHandlers> = registerHandlers(fakeBot as unknown as Bot);
    return {
      registration,
      used,
      directCommands,
      directHears,
      updates,
      registrationOrder,
      catchHandlers,
      commands: composerCommands.mock.calls.map((call: unknown[]): unknown => call[0]),
      middleware: used[0] ?? [],
    };
  } finally {
    composerCommands.mockRestore();
  }
}

describe("application handler registration", () => {
  test("导入不注册；显式调用后整条前置链只挂一次 bot.use，命令全部收在外闸后的子 Composer", () => {
    expect(SDK_REGISTRATIONS_AFTER_IMPORT).toBe(0);
    const { used, middleware, commands, directCommands, directHears }: Registration = registerOnFakeBot();

    // 前置链 + Anti-Raid / gag / qa 三条 ingress + 命令外闸 + 中文动作命令外闸 + 消息兜底，按这个顺序收在同一个数组里。
    expect(used).toHaveLength(1);
    expect(middleware).toHaveLength(12);
    expect(used[0]).toBe(middleware);
    expect(commands).toEqual([
      "permission",
      "white",
      "copy",
      "translate",
      "icon",
      "wed",
      "h_image",
      "info",
      "block",
      "batch_kick",
      "ai_chat",
      "clear_context",
      "ad_detect",
      "flood_control",
      "antiraid",
      "bot_status",
      "mood",
      "init",
      "quiet",
      "unquiet",
      "mute",
      "unmute",
      "gag",
      "ungag",
      "send",
      "qa",
      "x",
    ]);
    expect(directCommands).toEqual([]);
    expect(directHears).toEqual([]);
  });

  test("非消息 update 在前置链之后按固定顺序登记，错误处理器只装一个", () => {
    const { registrationOrder, updates, catchHandlers }: Registration = registerOnFakeBot();
    // callback_query:data 的 handler：/qa query 翻页先认领（未认领时 next()），未认领的交给入群验证（不调 next()）。
    expect(registrationOrder).toEqual([
      "use",
      `on:${JSON.stringify("message_reaction")}`,
      `on:${JSON.stringify("chat_member")}`,
      `on:${JSON.stringify("my_chat_member")}`,
      `on:${JSON.stringify("callback_query:data")}`,
      `on:${JSON.stringify("callback_query:data")}`,
      `on:${JSON.stringify("inline_query")}`,
      `on:${JSON.stringify("chosen_inline_result")}`,
    ]);
    expect(updates).toHaveLength(7);
    expect(catchHandlers).toHaveLength(1);
  });

  test("消息类外闸对非消息 update 原样放行，并直接返回 next 的 Promise", () => {
    const { middleware }: Registration = registerOnFakeBot();
    // 发言限流、各 ingress、命令外闸、「/」外闸与消息兜底。
    for (const index of [1, 6, 7, 8, 9, 10, 11]) {
      const nextResult: Promise<void> = Promise.resolve();
      let nextCalls: number = 0;
      const result: unknown = middleware[index]!(nonMessageContext(), (): Promise<void> => {
        nextCalls++;
        return nextResult;
      });
      expect(nextCalls).toBe(1);
      expect(result).toBe(nextResult);
    }

    // 普通消息回执检查同样不能重新包一层微任务。
    let receiptNextCalled: boolean = false;
    const receiptNextResult: Promise<void> = Promise.resolve();
    const receiptMiddlewareResult: unknown = middleware[2]!({
      update: { update_id: 11 },
    } as Context, (): Promise<void> => {
      receiptNextCalled = true;
      return receiptNextResult;
    });
    expect(receiptNextCalled).toBeTrue();
    expect(receiptMiddlewareResult).toBe(receiptNextResult);
  });

  test("第一道前置追踪见过的最大 update_id", async () => {
    const { middleware, registration }: Registration = registerOnFakeBot();
    const next = async (): Promise<void> => undefined;
    await middleware[0]!({ update: { update_id: 12 } } as Context, next);
    await middleware[0]!({ update: { update_id: 8 } } as Context, next);
    expect(registration.getLastSeenUpdateId()).toBe(12);
  });

  test("第二道前置在回执和业务分发之前截断超额 bot 消息", () => {
    const { middleware }: Registration = registerOnFakeBot();
    const botMessage: Context = {
      me: { id: 999 }, message: { from: { id: 42, is_bot: true } },
    } as Context;
    let passedBotMessages: number = 0;
    try {
      for (let index: number = 0; index <= BOT_MESSAGE_ACTIVITY_LIMIT; index += 1) {
        middleware[1]!(botMessage, (): Promise<void> => {
          passedBotMessages += 1;
          return Promise.resolve();
        });
      }
      expect(passedBotMessages).toBe(BOT_MESSAGE_ACTIVITY_LIMIT);
    } finally {
      for (const activity of botMessageActivity.values()) {
        if (activity.timer !== null) clearTimeout(activity.timer);
      }
      botMessageActivity.clear();
    }
  });

  test("GrammyError 只记状态码与描述，不把请求 payload 写进日志", () => {
    const { catchHandlers }: Registration = registerOnFakeBot();
    const secret: string = "private-message-text-marker";
    const apiError: GrammyError = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
      "sendMessage",
      { chat_id: 7, text: secret }
    );
    const consoleError: Mock<typeof console.error> = spyOn(console, "error").mockImplementation((): void => {});
    try {
      expect(() => catchHandlers[0]!({ ctx: { update: { update_id: 14 } } as Context, error: apiError })).toThrow(apiError);
      const logged: string = consoleError.mock.calls.map((call: unknown[]): string => call.map(String).join(" ")).join("\n");
      expect(logged).toBe("Unhandled error while handling update 14: 403 Forbidden: bot was blocked by the user");
      expect(logged).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("错误处理器把错误原样抛回 runner", () => {
    const { catchHandlers }: Registration = registerOnFakeBot();
    const durabilityError = new Error("durability barrier failed");
    expect(() => catchHandlers[0]!({
      ctx: { update: { update_id: 13 } } as Context,
      error: durabilityError,
    })).toThrow(durabilityError);
  });
});
