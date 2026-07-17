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
const { SUPER_ADMIN_USER_ID } = await import("../../src/infra/config");

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

  test("有 /send 中转会话时只放行超管的其它私聊指令，外部用户仍被拦截", () => {
    // getActiveProxySendTarget 是全局扫描，不像 shouldPassInitGate 那样只看
    // 单个 chatId：这里设的 true 若不清掉，会污染同进程里跑在它之后的其它
    // 测试（包括其它测试文件——bun test 默认同进程共享 infra/storage 的
    // 模块级 chatStates），务必 finally 里清回去。
    const targetChatId = -1004444444444;
    getOrCreateChatState(targetChatId).isUseProxySend = true;
    try {
      const adminCtx = fakeCtx({
        chat: { id: SUPER_ADMIN_USER_ID, type: "private" },
        from: { id: SUPER_ADMIN_USER_ID },
        message: { text: "/home/user/looks-like-a-command" },
      });
      const outsiderCtx = fakeCtx({
        chat: { id: SUPER_ADMIN_USER_ID + 1, type: "private" },
        from: { id: SUPER_ADMIN_USER_ID + 1 },
        message: { text: "/stop_copy" },
      });
      expect(shouldPassPrivateCommandGate(adminCtx)).toBe(true);
      expect(shouldPassPrivateCommandGate(outsiderCtx)).toBe(false);
    } finally {
      getOrCreateChatState(targetChatId).isUseProxySend = false;
    }
  });

  test("中转会话已经 finish（目标群的 isUseProxySend 变回 false）后，/ 开头消息重新被拦下", () => {
    const targetChatId = -1005555555555;
    getOrCreateChatState(targetChatId).isUseProxySend = true;
    const ctx = fakeCtx({ chat: { id: SUPER_ADMIN_USER_ID, type: "private" }, from: { id: SUPER_ADMIN_USER_ID }, message: { text: "/whatever" } });
    expect(shouldPassPrivateCommandGate(ctx)).toBe(true);

    getOrCreateChatState(targetChatId).isUseProxySend = false;
    expect(shouldPassPrivateCommandGate(ctx)).toBe(false);
  });
});
