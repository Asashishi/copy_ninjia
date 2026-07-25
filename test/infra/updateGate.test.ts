import { describe, expect, test } from "bun:test";

const { getOrCreateChatState } = await import("../../packages/infra/storage");
const {
  isSendCommandText,
  shouldPassInitGate,
  shouldPassPrivateCommandGate,
  shouldRoutePrivateProxyMessage,
} = await import("../../packages/infra/updateGate");
const { SUPER_ADMIN_USER_ID } = await import("../../packages/infra/config");

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
    const ctx = fakeCtx({
      chat: { id: chatId, type: "supergroup" },
      from: { id: SUPER_ADMIN_USER_ID },
      message: { text: "/init enable" },
    });
    expect(shouldPassInitGate(ctx)).toBe(true);
  });

  test("未初始化群只放行超管发给当前机器人的 /init，外部用户和其它 bot 后缀都拦下", () => {
    const chatId = -1001111111116;
    const base = { chat: { id: chatId, type: "supergroup" }, from: { id: SUPER_ADMIN_USER_ID } };
    expect(shouldPassInitGate(fakeCtx({ ...base, message: { text: "/init@Test_Bot enable" } }))).toBe(true);
    expect(shouldPassInitGate(fakeCtx({ ...base, message: { text: "/init@other_bot enable" } }))).toBe(false);
    expect(shouldPassInitGate(fakeCtx({
      chat: base.chat,
      from: { id: SUPER_ADMIN_USER_ID + 1 },
      message: { text: "/init enable" },
    }))).toBe(false);
  });

  test("已 /init 过的群 + 普通消息：放行", () => {
    const chatId = -1001111111113;
    getOrCreateChatState(chatId).isInitEnabled = true;
    // 若误用非隔离测试，同进程会共享 infra/storage 的模块级 chatStates（同文件的
    // /send 中转测试也有这条注意事项），务必测完把这个字段清回去，不留给
    // 同进程里跑在它之后的其它测试文件。注意：这里只重置字段、不能用
    // 删除整个状态——本文件只 mock 了 infra/diskIO（防的是 logger.ts
    // 间接把真实 Worker 拉起来），没有 mock infra/storage 本体，
    // 若调用带落盘的删除路径，会触发 saveStateInBackground 真的写项目根
    // 目录下的 state.json，那是这台机器上正在跑的真实 bot 在用的文件。
    try {
      const ctx = fakeCtx({ chat: { id: chatId, type: "supergroup" }, message: { text: "随便说点什么" } });
      expect(shouldPassInitGate(ctx)).toBe(true);
    } finally {
      getOrCreateChatState(chatId).isInitEnabled = undefined;
    }
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

  test("caption 里的指令同样拦下：bot.hears 对 caption 也匹配", () => {
    // bot.command 只认 text，但 `/咬` 这类单字中文动作命令走 bot.hears，text 和
    // caption 都会匹配。网关只看 text 的话，一张 caption 写着指令的图片就能绕过
    // 私聊封锁，让任意陌生人驱使机器人在私聊里作答、并借回复差异探测缓存。
    const ctx = fakeCtx({
      chat: { id: 4, type: "private" },
      message: { caption: "/咬 @someone", photo: [{ file_id: "f" }] },
    });
    expect(shouldPassPrivateCommandGate(ctx)).toBe(false);
  });

  test("私聊里的普通 caption（不以 / 开头）仍放行", () => {
    const ctx = fakeCtx({
      chat: { id: 5, type: "private" },
      message: { caption: "看看这张图", photo: [{ file_id: "f" }] },
    });
    expect(shouldPassPrivateCommandGate(ctx)).toBe(true);
  });

  test("有 /send 中转会话时只放行超管的其它私聊指令，外部用户仍被拦截", () => {
    // getActiveProxySendTarget 是全局扫描，不像 shouldPassInitGate 那样只看
    // 单个 chatId：这里设的 true 若不清掉，会污染同进程里跑在它之后的其它
    // 测试（包括其它测试文件——非隔离测试会在同进程共享 infra/storage 的
    // 模块级 chatStates），务必 finally 里清回去。
    const targetChatId = -1004444444444;
    getOrCreateChatState(targetChatId).isProxySendEnabled = true;
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
      getOrCreateChatState(targetChatId).isProxySendEnabled = false;
    }
  });

  test("中转会话已经 finish（目标群的 isProxySendEnabled 变回 false）后，/ 开头消息重新被拦下", () => {
    const targetChatId = -1005555555555;
    getOrCreateChatState(targetChatId).isProxySendEnabled = true;
    const ctx = fakeCtx({ chat: { id: SUPER_ADMIN_USER_ID, type: "private" }, from: { id: SUPER_ADMIN_USER_ID }, message: { text: "/whatever" } });
    expect(shouldPassPrivateCommandGate(ctx)).toBe(true);

    getOrCreateChatState(targetChatId).isProxySendEnabled = false;
    expect(shouldPassPrivateCommandGate(ctx)).toBe(false);
  });
});

describe("shouldRoutePrivateProxyMessage", () => {
  test("活动中转会话的普通消息和撞名指令都在命令注册前短路，/send 本身除外", () => {
    const targetChatId = -1006666666666;
    getOrCreateChatState(targetChatId).isProxySendEnabled = true;
    try {
      const base = { chat: { id: SUPER_ADMIN_USER_ID, type: "private" }, from: { id: SUPER_ADMIN_USER_ID } };
      expect(shouldRoutePrivateProxyMessage(fakeCtx({ ...base, message: { text: "普通文本" } }))).toBe(true);
      expect(shouldRoutePrivateProxyMessage(fakeCtx({ ...base, message: { text: "/stop_copy" } }))).toBe(true);
      expect(shouldRoutePrivateProxyMessage(fakeCtx({ ...base, message: { photo: [{}] } }))).toBe(true);
      expect(shouldRoutePrivateProxyMessage(fakeCtx({ ...base, message: { text: "/send finish" } }))).toBe(false);
      expect(shouldRoutePrivateProxyMessage(fakeCtx({
        chat: { id: SUPER_ADMIN_USER_ID + 1, type: "private" },
        from: { id: SUPER_ADMIN_USER_ID + 1 },
        message: { text: "/stop_copy" },
      }))).toBe(false);
    } finally {
      getOrCreateChatState(targetChatId).isProxySendEnabled = false;
    }
  });
});
