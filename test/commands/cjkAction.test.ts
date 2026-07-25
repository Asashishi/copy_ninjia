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
  sendMessage.mockClear();
  resolveCommandTarget.mockClear();
});

describe("parseCjkActionCommand 与 hears 匹配", () => {
  test("单个中文字才算动作命令，多字、拼音、纯符号都不匹配", () => {
    for (const text of ["/咬", "/摸 @alice", "/踢\n@alice", "/㐀", "/豈"]) {
      expect(hears(text)).toBe(true);
      expect(parseCjkActionCommand(text)?.actionWord).toBeTruthy();
    }
    for (const text of ["/咬人", "/copy", "/", "//咬", "咬", "/。", "/1", "/咬人 @alice"]) {
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
    expect(parseCjkActionCommand(undefined)).toBeUndefined();
  });
});

describe("/<单字> 动作命令", () => {
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
    });
    // 实体必须精确覆盖两个名字，否则链接会错位到旁边的文字上。
    expect(text.slice(0, 6)).toBe("ネオン アサ");
    expect(text.slice(10, 10 + 17)).toBe("冷曦[Hiyase] 🏳️‍🌈");
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
