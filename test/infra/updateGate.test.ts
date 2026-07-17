import { describe, expect, mock, test } from "bun:test";

/**
 * storage.ts -> logger.ts -> diskIO.ts，而 diskIO.ts 在模块顶层就会
 * `new Worker(...)` 指向项目真实的 memory/logs 目录：单测里绝不能让它真的
 * 跑起来（见 commands/luckChallenge.test.ts 同样的顾虑）。mock.module 必须
 * 在任何真实 import 之前调用，所以下面用动态 import 拿被 mock 过的版本。
 */
mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: mock((..._args: unknown[]): void => {}),
  onDiskIORespawn: mock((..._args: unknown[]): void => {}),
  relayLogMessage: mock((..._args: unknown[]): void => {}),
}));

const { getOrCreateChatState } = await import("../../src/infra/storage");
const { isSendCommandText, shouldPassInitGate, shouldPassPrivateCommandGate } = await import("../../src/infra/updateGate");

const ME = { id: 999, username: "test_bot", first_name: "TestBot" };

function fakeCtx(overrides: Record<string, unknown>): any {
  return { myChatMember: undefined, chat: undefined, msg: undefined, message: undefined, me: ME, ...overrides };
}

describe("shouldPassInitGate", () => {
  test("私聊：无条件放行", () => {
    const ctx = fakeCtx({ chat: { id: 1, type: "private" } });
    expect(shouldPassInitGate(ctx)).toBe(true);
  });

  test("my_chat_member 更新：无条件放行", () => {
    const ctx = fakeCtx({ myChatMember: {}, chat: { id: -1, type: "supergroup" } });
    expect(shouldPassInitGate(ctx)).toBe(true);
  });

  test("未初始化的群 + 普通消息：拦下", () => {
    const chatId = -1001111111111;
    const ctx = fakeCtx({ chat: { id: chatId, type: "supergroup" }, message: { text: "随便说点什么" } });
    expect(shouldPassInitGate(ctx)).toBe(false);
  });

  test("未初始化的群 + /init 指令本身：放行（否则永远没法首次初始化）", () => {
    const chatId = -1001111111112;
    const ctx = fakeCtx({ chat: { id: chatId, type: "supergroup" }, message: { text: "/init enable" } });
    expect(shouldPassInitGate(ctx)).toBe(true);
  });

  test("已 /init 过的群 + 普通消息：放行", () => {
    const chatId = -1001111111113;
    getOrCreateChatState(chatId).isInit = true;
    const ctx = fakeCtx({ chat: { id: chatId, type: "supergroup" }, message: { text: "随便说点什么" } });
    expect(shouldPassInitGate(ctx)).toBe(true);
  });

  test("回归用例：从未 /init 过的群里，/luck_challenge 选中后的 via_bot 确认消息仍要放行，" +
    "否则 handleIncomingMessage 永远够不到 confirmLuckDraw，抽签能看见却永远不落盘", () => {
    const chatId = -1001111111114;
    const ctx = fakeCtx({
      chat: { id: chatId, type: "supergroup" },
      message: { text: "你好，@someone\n汝的今日运势: 小凶\n有点不太妙哦，杂鱼小心点走路♡", via_bot: { id: ME.id } },
    });
    ctx.msg = ctx.message;
    expect(shouldPassInitGate(ctx)).toBe(true);
  });

  test("未初始化的群里，别的机器人发的 via_bot 消息（不是自己）：仍然拦下", () => {
    const chatId = -1001111111115;
    const ctx = fakeCtx({
      chat: { id: chatId, type: "supergroup" },
      message: { text: "别的机器人的内联结果", via_bot: { id: ME.id + 1 } },
    });
    ctx.msg = ctx.message;
    expect(shouldPassInitGate(ctx)).toBe(false);
  });
});

describe("isSendCommandText", () => {
  test("匹配 /send 及 /send@BotUsername 变体，不误配前缀相同的其它指令", () => {
    expect(isSendCommandText("/send")).toBe(true);
    expect(isSendCommandText("/send -100123")).toBe(true);
    expect(isSendCommandText("/send@my_bot finish")).toBe(true);
    expect(isSendCommandText("/sendx")).toBe(false);
    expect(isSendCommandText("/copy")).toBe(false);
  });
});

describe("shouldPassPrivateCommandGate", () => {
  test("群聊消息：无条件放行（这道网关只管私聊）", () => {
    const ctx = fakeCtx({ chat: { id: -1, type: "supergroup" }, message: { text: "/copy" } });
    expect(shouldPassPrivateCommandGate(ctx)).toBe(true);
  });

  test("私聊非指令文本：放行", () => {
    const ctx = fakeCtx({ chat: { id: 1, type: "private" }, message: { text: "随便聊两句" } });
    expect(shouldPassPrivateCommandGate(ctx)).toBe(true);
  });

  test("私聊里的 /send 本身：放行，不管这个私聊有没有在中转", () => {
    const ctx = fakeCtx({ chat: { id: 2, type: "private" }, message: { text: "/send -100123" } });
    expect(shouldPassPrivateCommandGate(ctx)).toBe(true);
  });

  test("私聊里 /send 以外的指令、且没有在中转：拦下", () => {
    const ctx = fakeCtx({ chat: { id: 3, type: "private" }, message: { text: "/copy" } });
    expect(shouldPassPrivateCommandGate(ctx)).toBe(false);
  });

  test("回归用例：这个私聊正在 /send 中转中，/ 开头的消息也要放行，" +
    "否则 auto/message.ts 的转发分支永远收不到——中转承诺转发任何消息", () => {
    const chatId = 4;
    getOrCreateChatState(chatId).isUseProxySend = true;
    const ctx = fakeCtx({ chat: { id: chatId, type: "private" }, message: { text: "/home/user/looks-like-a-command" } });
    expect(shouldPassPrivateCommandGate(ctx)).toBe(true);
  });

  test("中转会话已经 finish（isUseProxySend 变回 false）后，/ 开头消息重新被拦下", () => {
    const chatId = 5;
    getOrCreateChatState(chatId).isUseProxySend = true;
    const ctx = fakeCtx({ chat: { id: chatId, type: "private" }, message: { text: "/whatever" } });
    expect(shouldPassPrivateCommandGate(ctx)).toBe(true);

    getOrCreateChatState(chatId).isUseProxySend = false;
    expect(shouldPassPrivateCommandGate(ctx)).toBe(false);
  });
});
