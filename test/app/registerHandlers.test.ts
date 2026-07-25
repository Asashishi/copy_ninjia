import { describe, expect, test } from "bun:test";
import type { Bot, Context } from "grammy";
import { registerHandlers } from "../../packages/app/registerHandlers";
import { CJK_ACTION_COMMAND_PATTERN } from "../../packages/consts/commands";

type TestMiddleware = (ctx: Context, next: () => Promise<void>) => unknown;

interface FakeBot {
  use(handler: TestMiddleware): FakeBot;
  command(command: string, handler: unknown): FakeBot;
  hears(trigger: RegExp, handler: unknown): FakeBot;
  on(update: unknown, handler: unknown): FakeBot;
  catch(handler: unknown): FakeBot;
}

describe("application handler registration", () => {
  test("导入不注册；显式调用一次后安装完整更新链并追踪最大 update_id", async () => {
    const middleware: TestMiddleware[] = [];
    const commands: string[] = [];
    const hearsTriggers: RegExp[] = [];
    const updates: unknown[] = [];
    let catchCount: number = 0;
    let caughtHandler: ((error: { ctx: Context; error: unknown }) => void) | undefined;
    const fakeBot: FakeBot = {
      use(handler: TestMiddleware): FakeBot {
        middleware.push(handler);
        return fakeBot;
      },
      command(command: string, _handler: unknown): FakeBot {
        commands.push(command);
        return fakeBot;
      },
      hears(trigger: RegExp, _handler: unknown): FakeBot {
        hearsTriggers.push(trigger);
        return fakeBot;
      },
      on(update: unknown, _handler: unknown): FakeBot {
        updates.push(update);
        return fakeBot;
      },
      catch(handler: unknown): FakeBot {
        catchCount++;
        caughtHandler = handler as typeof caughtHandler;
        return fakeBot;
      },
    };

    expect(middleware).toHaveLength(0);
    const registration = registerHandlers(fakeBot as unknown as Bot);

    expect(middleware).toHaveLength(5);
    expect(commands).toEqual([
      "copy",
      "r_copy",
      "nya_copy",
      "ja_copy",
      "steal_icon",
      "stop_copy",
      "kick",
      "ai_chat",
      "switch_mood",
      "init",
      "quiet",
      "unquiet",
      "send",
      "x",
    ]);
    // 单字中文动作命令没有 bot_command 实体，只能按原文 hears，且必须排在
    // 消息兜底之前，否则会被当成普通消息进入 AI/复读流水线。
    expect(hearsTriggers).toEqual([CJK_ACTION_COMMAND_PATTERN]);
    expect(updates).toHaveLength(8);
    expect(catchCount).toBe(1);

    const next = async (): Promise<void> => undefined;
    await middleware[0]!({ update: { update_id: 12 } } as Context, next);
    await middleware[0]!({ update: { update_id: 8 } } as Context, next);
    expect(registration.getLastSeenUpdateId()).toBe(12);

    const durabilityError = new Error("durability barrier failed");
    expect(() => caughtHandler!({
      ctx: { update: { update_id: 13 } } as Context,
      error: durabilityError,
    })).toThrow(durabilityError);
  });
});
