import { describe, expect, test } from "bun:test";

const { getOrCreateChatState } = await import("../../packages/infra/storage/stateStore");
const {
  isSendCommandText,
  shouldPassInitGate,
  shouldPassPrivateCommandGate,
  shouldRoutePrivateProxyMessage,
} = await import("../../packages/infra/updateGate");
const { SUPER_ADMIN_USER_ID } = await import("../../packages/config/telegram");

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

  test("未初始化的群拦下普通消息和除 /init 外的各类命令入口", () => {
    const chatId = -1001111111111;
    for (const text of ["随便说点什么", "/copy", "/permission", "/white", "/send", "/wed", "/咬 @someone"]) {
      const ctx = fakeCtx({ chat: { id: chatId, type: "supergroup" }, message: { text } });
      expect(shouldPassInitGate(ctx)).toBe(false);
    }
  });

  test("/wed 按钮只有群已启用时放行，disable 后旧按钮也被拦下", () => {
    const chatId: number = -1001111111120;
    const chat = { id: chatId, type: "supergroup" };
    const message = { message_id: 7, chat, date: 1, caption: "你的群友老婆是 群友!" };
    const ctx = fakeCtx({
      chat, msg: message, from: { id: SUPER_ADMIN_USER_ID },
      callbackQuery: { data: `wed:${SUPER_ADMIN_USER_ID}:2:change`, message },
    });
    expect(shouldPassInitGate(ctx)).toBeFalse();
    getOrCreateChatState(chatId).isInitEnabled = true;
    expect(shouldPassInitGate(ctx)).toBeTrue();
    getOrCreateChatState(chatId).isInitEnabled = false;
    expect(shouldPassInitGate(ctx)).toBeFalse();
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

  test("频道白名单身份也不能在未初始化群首次启用", () => {
    const chatId = -1001111111118;
    const channelId = -1002222222222;
    const message = {
      text: "/init enable",
      sender_chat: { id: channelId, type: "channel", title: "Trusted Channel" },
    };
    const ctx = fakeCtx({
      chat: { id: chatId, type: "supergroup" },
      from: { id: SUPER_ADMIN_USER_ID + 1 },
      message,
      msg: message,
    });
    expect(shouldPassInitGate(ctx)).toBe(false);
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

  test("回归用例：从未 /init 过的群里，指向自己的 via_bot 内联结果一样拦下——inline 模式对所有人" +
    "开放，放行等于把「每条消息换一次没有缓存的 getChatMember」的触发权交给任意用户", () => {
    const chatId = -1001111111114;
    const ctx = fakeCtx({
      chat: { id: chatId, type: "supergroup" },
      message: { text: "你好，@someone\n汝的今日运势: 小凶\n有点不太妙哦，杂鱼小心点走路♡", via_bot: { id: ME.id } },
    });
    ctx.msg = ctx.message;
    // 运势回执不受影响：confirmLuckDraw 是 registerHandlers.ts 里排在本网关之前
    // 的一道 bot.use（转发副本也要认），从来不靠这条豁免够到。
    expect(shouldPassInitGate(ctx)).toBe(false);
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

  test("已 /init 过的群里，指向自己的 via_bot 内联结果照常放行（走的是 isInitEnabled 那一行）", () => {
    const chatId = -1001111111117;
    getOrCreateChatState(chatId).isInitEnabled = true;
    try {
      const ctx = fakeCtx({
        chat: { id: chatId, type: "supergroup" },
        message: { text: "内联结果", via_bot: { id: ME.id } },
      });
      ctx.msg = ctx.message;
      expect(shouldPassInitGate(ctx)).toBe(true);
    } finally {
      getOrCreateChatState(chatId).isInitEnabled = undefined;
    }
  });
});

describe("isSendCommandText", () => {
  test("只匹配 /send 及发给当前机器人的 @BotUsername 变体", () => {
    expect(isSendCommandText("/send", ME.username)).toBe(true);
    expect(isSendCommandText("/send -100123", ME.username)).toBe(true);
    expect(isSendCommandText("/send@Test_Bot finish", ME.username)).toBe(true);
    expect(isSendCommandText("/send@other_bot finish", ME.username)).toBe(false);
    expect(isSendCommandText("/sendx", ME.username)).toBe(false);
    expect(isSendCommandText("/copy", ME.username)).toBe(false);
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

  test("私聊只放行超级管理员发给当前机器人的 /send", () => {
    const base = { chat: { id: SUPER_ADMIN_USER_ID, type: "private" } };
    expect(shouldPassPrivateCommandGate(fakeCtx({
      ...base,
      from: { id: SUPER_ADMIN_USER_ID },
      message: { text: "/send -100123" },
    }))).toBe(true);
    expect(shouldPassPrivateCommandGate(fakeCtx({
      ...base,
      from: { id: SUPER_ADMIN_USER_ID },
      message: { text: "/send@Test_Bot finish" },
    }))).toBe(true);
    expect(shouldPassPrivateCommandGate(fakeCtx({
      ...base,
      from: { id: SUPER_ADMIN_USER_ID },
      message: { text: "/send@other_bot finish" },
    }))).toBe(false);
    expect(shouldPassPrivateCommandGate(fakeCtx({
      chat: { id: SUPER_ADMIN_USER_ID + 1, type: "private" },
      from: { id: SUPER_ADMIN_USER_ID + 1 },
      message: { text: "/send -100123" },
    }))).toBe(false);
  });

  test("私聊里 /send 以外的所有已注册命令入口都拦下", () => {
    for (const text of ["/copy", "/permission", "/white", "/init enable", "/batch_kick 1h", "/咬 @someone"]) {
      const ctx = fakeCtx({
        chat: { id: SUPER_ADMIN_USER_ID, type: "private" },
        from: { id: SUPER_ADMIN_USER_ID },
        message: { text },
      });
      expect(shouldPassPrivateCommandGate(ctx)).toBe(false);
    }
  });

  test("caption 里的指令同样拦下：bot.hears 对 caption 也匹配", () => {
    // bot.command 只认 text，但 `/咬` 这类中文动作命令走 bot.hears，text 和
    // caption 都会匹配。网关只看 text 的话，一张 caption 写着指令的图片就能绕过
    // 私聊封锁，让任意陌生人驱使机器人在私聊里作答、并借回复差异探测缓存。
    const ctx = fakeCtx({
      chat: { id: 4, type: "private" },
      message: { caption: "/咬 @someone", photo: [{ file_id: "f" }] },
    });
    expect(shouldPassPrivateCommandGate(ctx)).toBe(false);
    expect(shouldPassPrivateCommandGate(fakeCtx({
      chat: { id: SUPER_ADMIN_USER_ID, type: "private" },
      from: { id: SUPER_ADMIN_USER_ID },
      message: { caption: "/send -100123", photo: [{ file_id: "f" }] },
    }))).toBe(false);
  });

  test("私聊里的普通 caption（不以 / 开头）仍放行", () => {
    const ctx = fakeCtx({
      chat: { id: 5, type: "private" },
      message: { caption: "看看这张图", photo: [{ file_id: "f" }] },
    });
    expect(shouldPassPrivateCommandGate(ctx)).toBe(true);
  });

});

describe("shouldRoutePrivateProxyMessage", () => {
  test("活动中转会话只路由超管的非命令消息", () => {
    const targetChatId = -1006666666666;
    getOrCreateChatState(targetChatId).isProxySendEnabled = true;
    try {
      const base = { chat: { id: SUPER_ADMIN_USER_ID, type: "private" }, from: { id: SUPER_ADMIN_USER_ID } };
      expect(shouldRoutePrivateProxyMessage(fakeCtx({ ...base, message: { text: "普通文本" } }))).toBe(true);
      expect(shouldRoutePrivateProxyMessage(fakeCtx({ ...base, message: { text: "/stop_copy" } }))).toBe(false);
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
