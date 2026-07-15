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
const { shouldPassInitGate } = await import("../../src/infra/updateGate");

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
