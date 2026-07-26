import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types/chatState";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
let target: CachedUser | undefined;
const resolveCommandTarget = mock(async (..._args: unknown[]): Promise<CachedUser | undefined> => target);

mock.module("../../packages/infra/telegram", () => ({ sendMessage }));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));

const { handleCjkActionCommand, parseCjkActionCommand, tryConsumeCjkActionRateLimit } =
  await import("../../packages/commands/cjkAction");
const {
  CJK_ACTION_COMMAND_PATTERN,
  CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  CJK_ACTION_RATE_LIMIT_WINDOW_MS,
} = await import("../../packages/consts/commands");
const { recentActionCallTimestamps } = await import("../../packages/cache/cjkAction");
const { markSelfSent } = await import("../../packages/infra/selfSentTracker");
const { sentMessages } = await import("../../packages/cache/selfSentTracker");
const { resolveUsernameTarget } = await import("../../packages/users/senderIdentity");
const { handleCjkActionUsageCommand } = await import("../../packages/commands/cjkAction");

const actor = { id: 100, first_name: "ネオン", last_name: "アサ", username: "neon_asa" };

function context(text: string, from: unknown = actor): any {
  return {
    chat: { id: -1001 },
    msg: { message_id: 10, text, from, chat: { id: -1001, type: "supergroup" } },
    me: { id: 999, username: "MyBot" },
  };
}

/** 命令能否进入 handler 由注册时的 hears 正则决定，测试里显式复现这道门。 */
function hears(text: string): boolean {
  return CJK_ACTION_COMMAND_PATTERN.test(text);
}

let nextCalls: number = 0;
const next = async (): Promise<void> => { nextCalls++; };

beforeEach(() => {
  target = { id: 7, first_name: "冷曦[Hiyase] 🏳️‍🌈", username: "hiyase" };
  nextCalls = 0;
  recentActionCallTimestamps.clear();
  // 自发消息登记是模块级状态且 TTL 很长，不清会渗到后续用例里。
  for (const timer of sentMessages.values()) clearTimeout(timer);
  sentMessages.clear();
  sendMessage.mockClear();
  resolveCommandTarget.mockClear();
});

describe("parseCjkActionCommand 与 hears 匹配", () => {
  test("1~2 个中文字才算动作命令，三字及以上、拼音、纯符号都不匹配", () => {
    for (const text of ["/咬", "/摸 @alice", "/踢\n@alice", "/㐀", "/豈", "/贴贴", "/摸摸 @alice", "/咬人"]) {
      expect(hears(text)).toBe(true);
      expect(parseCjkActionCommand(text)?.actionWord).toBeTruthy();
    }
    // 三字及以上会先按 2 个字试、再回溯到 1 个字，两次都接不上空白或结束而失配。
    for (const text of ["/咬人人", "/copy", "/", "//咬", "咬", "/。", "/1", "/咬人人 @alice", "/贴贴贴"]) {
      expect(hears(text)).toBe(false);
      expect(parseCjkActionCommand(text)).toBeUndefined();
    }
  });

  test("参数与 @BotUsername 后缀分别解析，多余空白被去掉", () => {
    expect(parseCjkActionCommand("/咬")).toEqual({
      actionWord: "咬",
      addressedBotUsername: undefined,
      rawArgument: "",
    });
    expect(parseCjkActionCommand("/咬   @alice  ")).toEqual({
      actionWord: "咬",
      addressedBotUsername: undefined,
      rawArgument: "@alice",
    });
    expect(parseCjkActionCommand("/咬@MyBot @alice")).toEqual({
      actionWord: "咬",
      addressedBotUsername: "MyBot",
      rawArgument: "@alice",
    });
    // 两字动作词同样吃得下 @BotUsername 后缀与参数，动作词不会把第二个字漏掉。
    expect(parseCjkActionCommand("/贴贴@MyBot @alice")).toEqual({
      actionWord: "贴贴",
      addressedBotUsername: "MyBot",
      rawArgument: "@alice",
    });
    expect(parseCjkActionCommand(undefined)).toBeUndefined();
  });
});

describe("/<1~2 个中文字> 动作命令", () => {
  test("回复目标时输出「发起人 X了 目标!」，两个名字各自挂 t.me 链接", async () => {
    await handleCjkActionCommand(context("/咬"), next);

    expect(nextCalls).toBe(0);
    // first_name + last_name 拼接，目标名里的 emoji 按 UTF-16 计长度。
    const text: string = "ネオン アサ 咬了 冷曦[Hiyase] 🏳️‍🌈！";
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text,
      replyToMessageId: 10,
      entities: [
        { type: "text_link", offset: 0, length: 6, url: "https://t.me/neon_asa" },
        { type: "text_link", offset: 10, length: 17, url: "https://t.me/hiyase" },
      ],
      // 两个名字都挂 t.me 链接，必须关掉 Telegram 的自动预览卡片。
      disableLinkPreview: true,
    });
    // 实体必须精确覆盖两个名字，否则链接会错位到旁边的文字上。
    expect(text.slice(0, 6)).toBe("ネオン アサ");
    expect(text.slice(10, 10 + 17)).toBe("冷曦[Hiyase] 🏳️‍🌈");
  });

  test("两字动作词整体念进句子，目标名的实体偏移随之右移", async () => {
    target = { id: 7, first_name: "Bob", username: "bob" };
    await handleCjkActionCommand(context("/贴贴", { id: 100, first_name: "Alice", username: "alice" }), next);

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: "Alice 贴贴了 Bob！",
      replyToMessageId: 10,
      // 动作词多一个字，目标名的 offset 就得跟着从 9 挪到 10，否则链接会错位。
      entities: [
        { type: "text_link", offset: 0, length: 5, url: "https://t.me/alice" },
        { type: "text_link", offset: 10, length: 3, url: "https://t.me/bob" },
      ],
      disableLinkPreview: true,
    });
  });

  test("参数原样交给共享目标解析，错误文案带上动作字", async () => {
    await handleCjkActionCommand(context("/摸 @alice"), next);

    const params = resolveCommandTarget.mock.calls[0]![0] as {
      chatId: number;
      botUserId: number;
      rawArgument: string;
      messages: {
        missingTarget: string;
        selfTarget: string;
        unknownUsername: (raw: string) => string;
        invalidUsername: (raw: string) => string;
      };
    };
    expect(params.chatId).toBe(-1001);
    expect(params.botUserId).toBe(999);
    expect(params.rawArgument).toBe("@alice");
    expect(params.messages.missingTarget).toContain("/摸");
    expect(params.messages.selfTarget).toContain("摸");
    expect(params.messages.unknownUsername("bob")).toContain("摸");
    expect(params.messages.invalidUsername("@bad-name")).toContain("摸");
    expect(params.messages.invalidUsername("@bad-name")).toContain("@bad-name");
  });

  test("目标解析失败时不再发送动作消息（提示已由解析层发出）", async () => {
    target = undefined;
    await handleCjkActionCommand(context("/咬"), next);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(nextCalls).toBe(0);
  });

  test("没有 username 的双方退化为纯文本，不产生任何实体", async () => {
    target = { id: 7, first_name: "Bob" };
    await handleCjkActionCommand(context("/咬", { id: 100, first_name: "Alice" }), next);

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: "Alice 咬了 Bob！",
      replyToMessageId: 10,
      entities: [],
      disableLinkPreview: true,
    });
  });

  test("昵称里的换行被压平，频道马甲用 title，姓名全缺时退化为 @username", async () => {
    target = { id: -2002, title: "Some\nChannel", username: "some_channel", isChannel: true };
    await handleCjkActionCommand(context("/咬", { id: 100, first_name: "A\n\nB", username: "ab_user" }), next);

    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "A B 咬了 Some Channel！",
    }));

    target = { id: 7, username: "nameless" };
    await handleCjkActionCommand(context("/咬", { id: 100, first_name: "Alice" }), next);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "Alice 咬了 @nameless！",
      entities: [{ type: "text_link", offset: 9, length: 9, url: "https://t.me/nameless" }],
    }));

    // 姓名和 username 都没有（只靠回复解析出来的目标）时仍要有句子可念。
    target = { id: 7 };
    await handleCjkActionCommand(context("/咬", { id: 100, first_name: "Alice" }), next);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "Alice 咬了 这个杂鱼！",
      entities: [],
    }));
  });

  test("指名其它机器人、缺少发送者身份时放行给普通消息流水线", async () => {
    await handleCjkActionCommand(context("/咬@OtherBot"), next);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(nextCalls).toBe(1);

    // 大小写不敏感：@mybot 仍然是发给自己的。
    await handleCjkActionCommand(context("/咬@mybot"), next);
    expect(nextCalls).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // 既没有 from 也没有 sender_chat 的消息形态：拿不到发起人就没法造句。
    await handleCjkActionCommand(context("/咬", null), next);
    expect(nextCalls).toBe(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("全局配额每 90 秒 450 次，超额后静默丢弃且不再解析目标", async () => {
    expect(CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW).toBe(450);
    expect(CJK_ACTION_RATE_LIMIT_WINDOW_MS).toBe(90_000);

    // handler 内部取墙钟，所以窗口要按真实时刻填满。
    const now: number = Date.now();
    for (let filled: number = 0; filled < CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW; filled++) {
      recentActionCallTimestamps.push(now);
    }

    await handleCjkActionCommand(context("/咬"), next);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    // 超额不 next()：限流就是不为这条更新产生任何输出，也不转交下游流水线。
    expect(nextCalls).toBe(0);
  });

  test("配额跨群跨用户合并计数，窗口滑过后恢复", () => {
    const now: number = 2_000_000;
    for (let call: number = 0; call < CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW; call++) {
      expect(tryConsumeCjkActionRateLimit(now + call)).toBeTrue();
    }
    expect(tryConsumeCjkActionRateLimit(now + CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW)).toBeFalse();
    // 最早一次滑出窗口后名额释放。
    expect(tryConsumeCjkActionRateLimit(now + CJK_ACTION_RATE_LIMIT_WINDOW_MS + 1)).toBeTrue();
  });

  test("拿不到消息或会话时同样放行，不吞掉更新", async () => {
    await handleCjkActionCommand({ chat: { id: -1001 }, me: { id: 999, username: "MyBot" } } as any, next);
    await handleCjkActionCommand({ msg: { message_id: 1, text: "/咬" }, me: { id: 999, username: "MyBot" } } as any, next);
    // hears 与 handler 用同一条正则，理论上不会出现匹配了却解析不出的消息；
    // 这里补上防御分支，确保真出现时是放行而不是静默丢弃。
    await handleCjkActionCommand(context("/copy"), next);
    expect(nextCalls).toBe(3);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("动作命令的认领边界", () => {
  test("caption 形态不认领，放行回消息流水线", async () => {
    // bot.hears 对 caption 也匹配。若在这里认领，这条带图消息就再也到不了
    // handleIncomingMessage，那张图不会进 AI 滚动记忆与视觉流水线。
    const ctx: any = context("/咬");
    delete ctx.msg.text;
    ctx.msg.caption = "/咬";
    ctx.msg.photo = [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }];

    await handleCjkActionCommand(ctx, next);

    expect(nextCalls).toBe(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resolveCommandTarget).not.toHaveBeenCalled();
  });

  test("机器人自己发出的消息不认领，避免自问自答的刷屏循环", async () => {
    // 本 handler 排在消息流水线之前，拿不到它那道自发消息门禁；频道里机器人
    // 自己的帖子会被原样推回，而回复正文里的名字可被对方设成 /咬 开头。
    const ctx: any = context("/咬");
    markSelfSent(-1001, 10);

    await handleCjkActionCommand(ctx, next);

    expect(nextCalls).toBe(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("认领消息时顺手把发起人写进 username 缓存", async () => {
    // 被认领的消息不再流经 handleIncomingMessage，而 cacheSender 只在那里调用；
    // 不补这一次，发言以动作命令为主的人就永远查不到。
    // 用本文件独有的名字：模块级 username 缓存会被同文件先前的用例填过。
    expect(resolveUsernameTarget("only_seen_via_action")).toBeUndefined();

    await handleCjkActionCommand(
      context("/咬", { id: 4242, first_name: "Zed", username: "only_seen_via_action" }),
      next
    );

    expect(resolveUsernameTarget("only_seen_via_action")).toMatchObject({
      id: 4242,
      username: "only_seen_via_action",
    });
  });
});

describe("/x 菜单占位项", () => {
  test("回一句用法提示，而不是静默吞掉更新", async () => {
    await handleCjkActionUsageCommand(context("/x"));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const params = sendMessage.mock.calls[0]![0] as { chatId: number; text: string; replyToMessageId: number };
    expect(params.chatId).toBe(-1001);
    expect(params.replyToMessageId).toBe(10);
    expect(params.text).toContain("/咬");
  });
});
