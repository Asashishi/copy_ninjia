import { describe, expect, test } from "bun:test";
import type { Bot, Context } from "grammy";
import { registerHandlers } from "../../packages/app/registerHandlers";

type TestMiddleware = (ctx: Context, next: () => Promise<void>) => unknown;

interface FakeComposer {
  command(command: string, handler: unknown): FakeComposer;
}

interface FakeBot extends FakeComposer {
  use(handler: TestMiddleware): FakeBot;
  hears(trigger: RegExp, handler: unknown): FakeBot;
  on(update: unknown, handler?: unknown): FakeBot | FakeComposer;
  catch(handler: unknown): FakeBot;
}

/** 只带 update 类型字段的最小上下文；ingress 外闸只读 message / channelPost。 */
function nonMessageContext(): Context {
  return { update: { update_id: 1 }, message: undefined, channelPost: undefined } as unknown as Context;
}

describe("application handler registration", () => {
  test("导入不注册；显式调用一次后安装完整更新链并追踪最大 update_id", async () => {
    const middleware: TestMiddleware[] = [];
    const commands: string[] = [];
    // 直接挂在 bot 上的命令与 hears，必须恒为空：命令注册在 :entities:bot_command
    // 子链上，中文动作命令收在「/」外闸后的子 Composer 里（见 app/registerHandlers.ts）。
    const directCommands: string[] = [];
    const directHears: RegExp[] = [];
    const updates: unknown[] = [];
    // use、on 与 command 记在同一条有序流水里，钉住承重的相对顺序。
    const registrationOrder: string[] = [];
    let catchCount: number = 0;
    let caughtHandler: ((error: { ctx: Context; error: unknown }) => void) | undefined;
    const fakeCommandGroup: FakeComposer = {
      command(command: string, _handler: unknown): FakeComposer {
        commands.push(command);
        registrationOrder.push(`command:${command}`);
        return fakeCommandGroup;
      },
    };
    const fakeBot: FakeBot = {
      use(handler: TestMiddleware): FakeBot {
        middleware.push(handler);
        registrationOrder.push(`use:${middleware.length}`);
        return fakeBot;
      },
      command(command: string, _handler: unknown): FakeBot {
        directCommands.push(command);
        commands.push(command);
        registrationOrder.push(`command:${command}`);
        return fakeBot;
      },
      hears(trigger: RegExp, _handler: unknown): FakeBot {
        directHears.push(trigger);
        registrationOrder.push("hears");
        return fakeBot;
      },
      on(update: unknown, _handler?: unknown): FakeBot | FakeComposer {
        updates.push(update);
        registrationOrder.push(`on:${JSON.stringify(update)}`);
        // 不带 handler 的 on 是在取一条子链；命令组就是这样挂的，返回一个只认
        // command 的记录器，避免它被误当成 bot 本体继续注册别的东西。
        return _handler === undefined ? fakeCommandGroup : fakeBot;
      },
      catch(handler: unknown): FakeBot {
        catchCount++;
        caughtHandler = handler as typeof caughtHandler;
        return fakeBot;
      },
    };

    expect(middleware).toHaveLength(0);
    const registration = registerHandlers(fakeBot as unknown as Bot);

    // 5 条前置 + Anti-Raid / gag / qa 三条 ingress + 中文动作命令外闸 + 消息兜底。
    expect(middleware).toHaveLength(10);
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
      "prompt",
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
    // use:3 是 init 与私聊命令门禁；use:6/7/8 依次是 Anti-Raid、gag、/qa set 表单
    // 三条 ingress（见 antiRaid/updateIngress.ts 的函数头）；use:9 是中文动作命令的
    // 「/」外闸，须早于 use:10 的消息兜底。
    const commandGroupIndex: number =
      registrationOrder.indexOf(`on:${JSON.stringify(":entities:bot_command")}`);
    expect(registrationOrder.slice(0, 8)).toEqual([
      "use:1", "use:2", "use:3", "use:4", "use:5", "use:6", "use:7", "use:8",
    ]);
    expect(commandGroupIndex).toBe(8);
    for (const command of commands) {
      expect(registrationOrder.indexOf(`command:${command}`)).toBeGreaterThan(commandGroupIndex);
      expect(registrationOrder.indexOf(`command:${command}`)).toBeLessThan(registrationOrder.indexOf("use:9"));
    }
    expect(registrationOrder.indexOf("use:9")).toBeLessThan(registrationOrder.indexOf("use:10"));
    // 两条 callback_query:data：/qa query 翻页先认领（未认领时 next()），
    // 未认领的交给入群验证（不调 next()）。
    expect(registrationOrder.slice(registrationOrder.indexOf("use:10") + 1)).toEqual([
      `on:${JSON.stringify("message_reaction")}`,
      `on:${JSON.stringify("chat_member")}`,
      `on:${JSON.stringify("my_chat_member")}`,
      `on:${JSON.stringify("callback_query:data")}`,
      `on:${JSON.stringify("callback_query:data")}`,
      `on:${JSON.stringify("inline_query")}`,
      `on:${JSON.stringify("chosen_inline_result")}`,
    ]);
    // 7 条非消息 update handler + 命令组那条只取子链的 on。
    expect(updates).toHaveLength(8);
    expect(catchCount).toBe(1);

    // 三条 ingress、「/」外闸与消息兜底对非消息 update 一律原样放行，且直接返回
    // next 的 Promise。
    for (let index: number = 5; index < 10; index++) {
      const nextResult: Promise<void> = Promise.resolve();
      let nextCalls: number = 0;
      const result: unknown = middleware[index]!(nonMessageContext(), (): Promise<void> => {
        nextCalls++;
        return nextResult;
      });
      expect(nextCalls).toBe(1);
      expect(result).toBe(nextResult);
    }

    const next = async (): Promise<void> => undefined;
    await middleware[0]!({ update: { update_id: 12 } } as Context, next);
    await middleware[0]!({ update: { update_id: 8 } } as Context, next);
    expect(registration.getLastSeenUpdateId()).toBe(12);

    // 普通消息回执检查必须直接返回 next 的 Promise，不能重新包一层微任务。
    let receiptNextCalled: boolean = false;
    const receiptNextResult: Promise<void> = Promise.resolve();
    const receiptMiddlewareResult: unknown = middleware[1]!({
      update: { update_id: 11 },
    } as Context, (): Promise<void> => {
      receiptNextCalled = true;
      return receiptNextResult;
    });
    expect(receiptNextCalled).toBeTrue();
    expect(receiptMiddlewareResult).toBe(receiptNextResult);

    const durabilityError = new Error("durability barrier failed");
    expect(() => caughtHandler!({
      ctx: { update: { update_id: 13 } } as Context,
      error: durabilityError,
    })).toThrow(durabilityError);
  });
});
