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
    // hears 与 on 记在两个互不相干的数组里，各自的内容断言锁不住它们之间的
    // 相对顺序；这条有序流水专门用来钉住「hears 必须早于消息兜底」。
    const registrationOrder: string[] = [];
    let catchCount: number = 0;
    let caughtHandler: ((error: { ctx: Context; error: unknown }) => void) | undefined;
    const fakeBot: FakeBot = {
      use(handler: TestMiddleware): FakeBot {
        middleware.push(handler);
        registrationOrder.push(`use:${middleware.length}`);
        return fakeBot;
      },
      command(command: string, _handler: unknown): FakeBot {
        commands.push(command);
        registrationOrder.push(`command:${command}`);
        return fakeBot;
      },
      hears(trigger: RegExp, _handler: unknown): FakeBot {
        hearsTriggers.push(trigger);
        registrationOrder.push("hears");
        return fakeBot;
      },
      on(update: unknown, _handler: unknown): FakeBot {
        updates.push(update);
        registrationOrder.push(`on:${JSON.stringify(update)}`);
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
      "permission",
      "white",
      "copy",
      "r_copy",
      "nya_copy",
      "ja_copy",
      "steal_icon",
      "reset_icon",
      "stop_copy",
      "block",
      "batch_kick",
      "unblock",
      "ai_chat",
      "ad_detect",
      "flood_control",
      "antiraid",
      "bot_status",
      "query_mood",
      "switch_mood",
      "init",
      "quiet",
      "unquiet",
      "mute",
      "unmute",
      "gag",
      "ungag",
      "send",
      "set_qa",
      "query_qa",
      "remove_qa",
      "x",
    ]);
    // use:3 同时承载 init 与私聊命令门禁；全部命令都必须注册在它之后，避免
    // 新命令以后又意外绕过。
    for (const command of commands) {
      expect(registrationOrder.indexOf(`command:${command}`))
        .toBeGreaterThan(registrationOrder.indexOf("use:3"));
    }
    // 每一条命令都必须排在入群验证 ingress 之后，授权维护也不例外：命令
    // handler 一律不调 next()，注册在 ingress 之前的那条就会整条绕开刷屏计数、
    // 黑名单频道消息就地删除与待验证成员的消息追踪（见 antiRaid/updateIngress.ts
    // 的函数头）。只断言前置 use 是拦不住这种漏网的。
    const antiRaidIngressIndex: number =
      registrationOrder.indexOf(`on:${JSON.stringify("message")}`);
    expect(antiRaidIngressIndex).toBeGreaterThan(-1);
    const messageIngressIndices: number[] = [];
    for (let index: number = 0; index < registrationOrder.length; index++) {
      if (registrationOrder[index] === `on:${JSON.stringify("message")}`) {
        messageIngressIndices.push(index);
      }
    }
    // 三条 message ingress，顺序承重：Anti-Raid 先看原始消息以保持刷屏/黑名单
    // 事实口径，gag 次之（被 gag 的消息不得再往下走），最后是 /set_qa 表单结果
    // ——它认领后会删掉那条中转消息，再放行只会让下游处理一个不存在的东西。
    expect(messageIngressIndices).toHaveLength(3);
    const gagIngressIndex: number = messageIngressIndices[1]!;
    const qaIngressIndex: number = messageIngressIndices[2]!;
    expect(gagIngressIndex).toBeGreaterThan(antiRaidIngressIndex);
    expect(qaIngressIndex).toBeGreaterThan(gagIngressIndex);
    for (const command of commands) {
      expect(registrationOrder.indexOf(`command:${command}`))
        .toBeGreaterThan(qaIngressIndex);
    }
    // 中文动作命令没有 bot_command 实体，只能按原文 hears，且必须排在
    // 消息兜底之前，否则会被当成普通消息进入 AI/复读流水线。
    expect(hearsTriggers).toEqual([CJK_ACTION_COMMAND_PATTERN]);
    // 顺序是承重的，必须显式断言：把 hears 挪到消息兜底之后，上面所有断言依旧
    // 全绿，而运行时每条 `/咬` 都会先被 handleIncomingMessage 吞掉，整个动作
    // 命令特性静默失效并落进它明令要避开的 AI/复读流水线。
    const messageFallbackIndex: number =
      registrationOrder.indexOf(`on:${JSON.stringify(["message", "channel_post"])}`);
    expect(messageFallbackIndex).toBeGreaterThan(-1);
    expect(registrationOrder.indexOf("hears")).toBeGreaterThan(-1);
    expect(registrationOrder.indexOf("hears")).toBeGreaterThan(registrationOrder.indexOf("use:3"));
    expect(registrationOrder.indexOf("hears")).toBeLessThan(messageFallbackIndex);
    // /x 占位项同理：它也终止链路，必须先于消息兜底注册。
    expect(registrationOrder.indexOf("command:x")).toBeLessThan(messageFallbackIndex);
    expect(updates).toHaveLength(10);
    expect(catchCount).toBe(1);

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
