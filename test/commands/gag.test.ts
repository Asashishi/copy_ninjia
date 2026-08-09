import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  InlineKeyboardMarkup,
  Message,
  MessageEntity,
} from "@grammyjs/types";
import {
  GAG_INLINE_CHANNEL_LINK_PREFIX,
  GAG_SESSION_MAX,
} from "../../packages/consts/gag";
import { GAG_THUMBNAIL_URL } from "../../packages/consts/ui/assets";
import type { CachedUser } from "../../packages/types/chatState";
import type { GagSession } from "../../packages/types/gag";
import { settleTestBatch } from "../libs/helpers";

interface TextMessageParams {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
  readonly keyboard?: InlineKeyboardMarkup;
}

interface EphemeralMessageParams extends TextMessageParams {
  readonly receiverUserId: number;
}

interface EphemeralDeletionParams {
  readonly chatId: number;
  readonly receiverUserId: number;
  readonly ephemeralMessageId: number;
}

type InlineResult = Record<string, unknown>;
type InlineAnswerOptions = Record<string, unknown>;

const sendCommandMessage = mock(async (_params: TextMessageParams): Promise<number | undefined> => 56);
const sendMessage = mock(async (_params: TextMessageParams): Promise<number | undefined> => 56);
const sendEphemeralMessage = mock(async (_params: EphemeralMessageParams): Promise<number | undefined> => 57);
const deleteEphemeralMessageWithOutcome = mock(async (_params: EphemeralDeletionParams): Promise<string> => "deleted");
const deleteMessageWithOutcome = mock(async (_chatId: number, _messageId: number): Promise<string> => "deleted");
const probeChatMembership = mock(async (_chatId: number, _userId: number): Promise<boolean | undefined> => true);
const resolveCommandTarget = mock(async (_params: unknown): Promise<CachedUser | undefined> => ({
  id: 7,
  first_name: "Alice",
  username: "alice",
}));
const answerInlineQuery = mock(async (
  _results: readonly InlineResult[],
  _options: InlineAnswerOptions,
  _signal?: unknown
): Promise<void> => undefined);
let permissionAllowed: boolean = true;
let initEnabled: boolean = true;
let canDeleteMessages: boolean = true;

mock.module("../../packages/infra/botAdmin", () => ({
  botChatPermissionsIn: async (): Promise<Readonly<{ canDeleteMessages: boolean; canRestrictMembers: boolean }>> => ({
    canDeleteMessages,
    canRestrictMembers: true,
  }),
}));
mock.module("../../packages/infra/chatTeardown", () => ({
  registerChatTeardown: (): void => undefined,
}));
mock.module("../../packages/infra/logger", () => ({
  logger: { error(): void {}, info(): void {}, log(): void {}, warn(): void {} },
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: (): Readonly<{ isInitEnabled: boolean }> => ({ isInitEnabled: initEnabled }),
  getGagThumbnailUrl: (): string => GAG_THUMBNAIL_URL,
}));
mock.module("../../packages/infra/telegram", () => ({
  deleteEphemeralMessageWithOutcome,
  deleteMessageWithOutcome,
  logApiError: (): void => undefined,
  probeChatMembership,
  sendCommandMessage,
  sendEphemeralMessage,
  sendMessage,
}));
mock.module("../../packages/commands/commandActor", () => ({
  hasCommandPermission: (): boolean => permissionAllowed,
  resolveCommandActor: (): CachedUser => ({ id: 100, first_name: "Admin" }),
}));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));

const gag = await import("../../packages/commands/gag");
const rendering = await import("../../packages/commands/gag/rendering");
const {
  activeGagSessionCount,
  gagSessionCount,
  gagSessionsByChat,
} = await import("../../packages/cache/main/gag");
const originalDateNow: () => number = Date.now;

interface ContextOverrides {
  readonly chatId?: number;
  readonly chatType?: "group" | "supergroup" | "private";
  readonly match?: string;
  readonly replyToMessage?: Message;
}

function commandContext({
  chatId = -1001,
  chatType = "supergroup",
  match = "@alice 5",
  replyToMessage,
}: ContextOverrides = {}): never {
  const message: Record<string, unknown> = {
    message_id: 10,
    chat: { id: chatId, type: chatType },
    from: { id: 100, first_name: "Admin" },
  };
  if (replyToMessage !== undefined) message.reply_to_message = replyToMessage;
  return {
    chat: { id: chatId, type: chatType, title: "测试群" },
    from: { id: 100, first_name: "Admin" },
    me: { id: 999, username: "test_bot" },
    msg: message,
    msgId: 10,
    match,
  } as never;
}

interface SessionOverrides {
  readonly chatId?: number;
  readonly targetId?: number;
  readonly tool?: string;
  readonly phase?: GagSession["phase"];
  readonly expiresAt?: number;
  readonly publicNoticeMessageId?: number;
  readonly ephemeralNoticeMessageId?: number;
}

function createSession({
  chatId = -1001,
  targetId = 7,
  tool = "口塞",
  phase = "active",
  expiresAt = 1_300_000,
  publicNoticeMessageId = 54,
  ephemeralNoticeMessageId,
}: SessionOverrides = {}): GagSession {
  return {
    chatId,
    targetId,
    targetLabel: "Alice (@alice)",
    chatLabel: `群 ${chatId}`,
    tool,
    durationMinutes: 5,
    phase,
    expiresAt,
    publicNoticeMessageId,
    ephemeralNoticeMessageId:
      ephemeralNoticeMessageId ?? (targetId > 0 ? 55 : 0),
    noticePending: false,
    timer: null,
    cleanupRetryIndex: 0,
    cleanupTimer: null,
    endingTask: null,
  };
}

function addSession(session: GagSession): void {
  const sessions: GagSession[] | undefined = gagSessionsByChat.get(session.chatId);
  if (sessions === undefined) gagSessionsByChat.set(session.chatId, [session]);
  else sessions.push(session);
}

function sessionFor(chatId: number, targetId: number = 7): GagSession | undefined {
  return gagSessionsByChat.get(chatId)?.find((session: GagSession): boolean =>
    session.targetId === targetId
  );
}

function gagInlineEntities(session: GagSession): MessageEntity[] {
  const prefix: string = rendering.gagSpeechPrefix(session.tool);
  if (session.targetId > 0) return [];
  return [{
    type: "text_link",
    offset: 0,
    length: prefix.length,
    url: `${GAG_INLINE_CHANNEL_LINK_PREFIX}${session.targetId}`,
  }];
}

function normalMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    message_id: 88,
    chat: { id: -1001, type: "supergroup", title: "测试群" },
    date: 1,
    from: { id: 7, is_bot: false, first_name: "Alice" },
    text: "普通消息",
    ...overrides,
  } as Message;
}

function lastCommandText(): string {
  return (sendCommandMessage.mock.calls.at(-1)?.[0] as { text: string }).text;
}

function lastStateText(): string {
  return (sendMessage.mock.calls.at(-1)?.[0] as { text: string }).text;
}

function lastEphemeralText(): string {
  return (sendEphemeralMessage.mock.calls.at(-1)?.[0] as { text: string }).text;
}

beforeEach(() => {
  gag.resetGagSessions();
  permissionAllowed = true;
  initEnabled = true;
  canDeleteMessages = true;
  Date.now = (): number => 1_000_000;
  for (const mocked of [
    deleteEphemeralMessageWithOutcome,
    sendCommandMessage,
    sendEphemeralMessage,
    sendMessage,
    deleteMessageWithOutcome,
    probeChatMembership,
    resolveCommandTarget,
    answerInlineQuery,
  ]) mocked.mockClear();
  sendCommandMessage.mockImplementation(async (_params: TextMessageParams): Promise<number | undefined> => 56);
  sendEphemeralMessage.mockImplementation(async (_params: EphemeralMessageParams): Promise<number | undefined> => 57);
  deleteEphemeralMessageWithOutcome.mockImplementation(async (_params: EphemeralDeletionParams): Promise<string> => "deleted");
  sendMessage.mockImplementation(async (_params: TextMessageParams): Promise<number | undefined> => 56);
  deleteMessageWithOutcome.mockImplementation(async (_chatId: number, _messageId: number): Promise<string> => "deleted");
  probeChatMembership.mockImplementation(async (_chatId: number, _userId: number): Promise<boolean | undefined> => true);
  resolveCommandTarget.mockImplementation(async (_params: unknown): Promise<CachedUser | undefined> => ({
    id: 7,
    first_name: "Alice",
    username: "alice",
  }));
});

afterEach(() => {
  gag.resetGagSessions();
  Date.now = originalDateNow;
});

describe("gag 参数与文本渲染", () => {
  test("普通按钮只带 gag 前缀，频道按钮额外解析规范负数 id", () => {
    expect(rendering.parseGagInlineQuery("gag: 你好"))
      .toEqual({ text: "你好" });
    expect(rendering.parseGagInlineQuery("gag:7 你好")).toBeUndefined();
    expect(rendering.parseGagInlineQuery("gag:-1002233445566 你好"))
      .toEqual({
        targetChannelId: -1002233445566,
        text: "你好",
      });
    expect(rendering.parseGagInlineQuery("普通查询")).toBeUndefined();
  });

  test("显式目标、回复目标、可选时长、默认用具和自由文本用具分别解析", () => {
    expect(rendering.parseGagCommand("@alice 5")).toEqual({
      durationMinutes: 5,
      rawTarget: "@alice",
      tool: "口塞",
    });
    expect(rendering.parseGagCommand("@alice")).toEqual({
      durationMinutes: 5,
      rawTarget: "@alice",
      tool: "口塞",
    });
    expect(rendering.parseGagCommand("@alice 丝带 结")).toEqual({
      durationMinutes: 5,
      rawTarget: "@alice",
      tool: "丝带 结",
    });
    expect(rendering.parseGagCommand("10 丝带 结", true)).toEqual({
      durationMinutes: 10,
      rawTarget: "",
      tool: "丝带 结",
    });
    expect(rendering.parseGagCommand("", true)).toEqual({
      durationMinutes: 5,
      rawTarget: "",
      tool: "口塞",
    });
    expect(rendering.parseGagCommand("绳子", true)).toEqual({
      durationMinutes: 5,
      rawTarget: "",
      tool: "绳子",
    });
    expect(rendering.parseGagCommand("7 绳子")).toEqual({
      durationMinutes: 5,
      rawTarget: "7",
      tool: "绳子",
    });
    expect(rendering.parseGagCommand("-1001234567890 15")).toEqual({
      durationMinutes: 15,
      rawTarget: "-1001234567890",
      tool: "口塞",
    });
    expect(rendering.parseGagCommand("7 绳子", true)).toBeUndefined();
    expect(rendering.parseGagCommand("@alice 20 绳子")).toBeUndefined();
  });

  test("每个扩展字形后按 50/10/10/10/10/10 边界抽样并固定追加半角空格", () => {
    const rolls: number[] = [0.49, 0.50, 0.60, 0.70, 0.80, 0.90];
    let index: number = 0;
    const text: string = rendering.renderGagSpeech({
      text: "甲乙丙丁戊己",
      tool: "口塞",
      random: (): number => rolls[index++]!,
    });
    expect(text).toBe("（透过口塞）甲... 乙唔 丙啊 丁嗯 戊哦 己齁 ");
  });

  test("组合 emoji 只按一个字形填充，空正文仍产出可发送内容", () => {
    expect(rendering.renderGagSpeech({
      text: "👨‍👩‍👧‍👦",
      tool: "丝带",
      random: (): number => 0,
    })).toBe("（透过丝带）👨‍👩‍👧‍👦... ");
    expect(rendering.renderGagSpeech({
      text: "",
      tool: "口塞",
      random: (): number => 0.99,
    })).toBe("（透过口塞）... ");
  });
});

describe("/gag 与 /ungag 状态机", () => {
  test("权限、初始化和删除权限逐层 fail closed", async () => {
    permissionAllowed = false;
    await gag.handleGagCommand(commandContext());
    expect(resolveCommandTarget).not.toHaveBeenCalled();

    permissionAllowed = true;
    initEnabled = false;
    await gag.handleGagCommand(commandContext());
    expect(resolveCommandTarget).not.toHaveBeenCalled();

    initEnabled = true;
    canDeleteMessages = false;
    await gag.handleGagCommand(commandContext());
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(sendCommandMessage).toHaveBeenCalledTimes(3);
  });

  test("普通用户先收到群内无按钮状态，再收到目标专属入口，全部成功后才激活", async () => {
    await gag.handleGagCommand(commandContext({ match: "@alice 5" }));

    const session: GagSession | undefined = sessionFor(-1001);
    expect(session?.phase).toBe("active");
    expect(session?.expiresAt).toBe(1_300_000);
    expect(session?.publicNoticeMessageId).toBe(56);
    expect(session?.ephemeralNoticeMessageId).toBe(57);
    expect(session?.timer).not.toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      chatId: -1001,
      replyToMessageId: 10,
    });
    expect(sendMessage.mock.calls[0]?.[0]).not.toHaveProperty("keyboard");
    expect(lastStateText()).toContain("已经戴上");
    expect(lastStateText()).not.toContain("发言入口");
    expect(sendEphemeralMessage.mock.calls[0]?.[0]).toMatchObject({
      chatId: -1001,
      receiverUserId: 7,
    });
    expect(sendEphemeralMessage.mock.calls[0]?.[0]).not
      .toHaveProperty("callbackQueryId");
    const sessionButton = sendEphemeralMessage.mock.calls[0]?.[0]?.keyboard
      ?.inline_keyboard[0]?.[0];
    expect(sessionButton).toMatchObject({
      text: "发言",
      switch_inline_query_current_chat: "gag: ",
    });
    expect(sessionButton).not.toHaveProperty("callback_data");
    expect(resolveCommandTarget.mock.calls[0]?.[0]).toMatchObject({
      botUserId: 999,
      messages: { selfTarget: "哈？还想 gag 本天才？杂鱼再做一百年梦也不可能啦♡" },
    });
    expect(lastEphemeralText()).toContain("只有你看得到这个发言入口");
  });

  test("回复目标只写用具时使用默认 5 分钟，并把空目标交给回复解析", async () => {
    await gag.handleGagCommand(commandContext({
      match: "丝带",
      replyToMessage: normalMessage(),
    }));

    const session: GagSession | undefined = sessionFor(-1001);
    expect(session?.durationMinutes).toBe(5);
    expect(session?.tool).toBe("丝带");
    expect(resolveCommandTarget.mock.calls[0]?.[0]).toMatchObject({ rawArgument: "" });
  });

  test("群内状态发送失败释放预约，且不再发送目标入口", async () => {
    sendMessage.mockImplementationOnce(async (_params: TextMessageParams): Promise<undefined> => undefined);
    await gag.handleGagCommand(commandContext());
    expect(gagSessionsByChat.has(-1001)).toBeFalse();
    expect(sendEphemeralMessage).not.toHaveBeenCalled();
  });

  test("目标入口发送失败时删除已发出的群内状态并释放预约", async () => {
    sendEphemeralMessage.mockImplementationOnce(async (_params: EphemeralMessageParams): Promise<undefined> => undefined);
    await gag.handleGagCommand(commandContext());
    expect(gagSessionsByChat.has(-1001)).toBeFalse();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 56);
  });

  test("同群可管教多个目标，但同目标不重复，全局最多 5 个", async () => {
    addSession(createSession());
    resolveCommandTarget.mockImplementationOnce(async (_params: unknown): Promise<CachedUser> => ({
      id: 8,
      first_name: "Bob",
    }));
    await gag.handleGagCommand(commandContext({ match: "8" }));
    expect(gagSessionsByChat.get(-1001)).toHaveLength(2);

    sendCommandMessage.mockClear();
    probeChatMembership.mockClear();
    await gag.handleGagCommand(commandContext());
    expect(gagSessionsByChat.get(-1001)).toHaveLength(2);
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
    expect(lastCommandText()).toContain("已经被管教");

    gag.resetGagSessions();
    sendCommandMessage.mockClear();
    for (let index: number = 0; index < GAG_SESSION_MAX; index++) {
      const chatId: number = -10_000 - index;
      addSession(createSession({ chatId }));
    }
    await gag.handleGagCommand(commandContext({ chatId: -999 }));
    expect(gagSessionCount()).toBe(GAG_SESSION_MAX);
    expect(activeGagSessionCount()).toBe(GAG_SESSION_MAX);
    expect(lastCommandText()).toContain(String(GAG_SESSION_MAX));
  });

  test("目标不豁免白名单身份，但必须是当前群成员", async () => {
    resolveCommandTarget.mockImplementationOnce(async (_params: unknown): Promise<CachedUser> => ({
      id: 100,
      first_name: "Admin",
    }));
    await gag.handleGagCommand(commandContext());
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);

    gag.resetGagSessions();
    probeChatMembership.mockImplementationOnce(async (_chatId: number, _userId: number): Promise<boolean> => false);
    await gag.handleGagCommand(commandContext());
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
    expect(lastCommandText()).toContain("不在这个群");
  });

  test("频道身份可通过回复、@username 或负数 id 被 gag，且不误用用户成员查询", async () => {
    resolveCommandTarget.mockImplementationOnce(async (
      params: unknown
    ): Promise<CachedUser> => {
      expect(params).toMatchObject({ acceptChatId: true });
      return { id: -1002233445566, isChannel: true, title: "测试频道" };
    });
    await gag.handleGagCommand(commandContext({ match: "-1002233445566" }));

    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(sessionFor(-1001, -1002233445566)?.targetId).toBe(-1002233445566);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]?.keyboard?.inline_keyboard[0]?.[0])
      .toMatchObject({
        text: "发言",
        switch_inline_query_current_chat: "gag:-1002233445566 ",
      });
    expect(lastStateText()).toContain("频道马甲想说话就必须先乖乖点");
    expect(lastStateText()).toContain("直接 @ 本天才可不会给你选项");
  });

  test("/ungag 按 @ 目标删除开始提示、释放状态并发送统一 30 秒回执", async () => {
    const session: GagSession = createSession();
    addSession(session);
    resolveCommandTarget.mockClear();
    await gag.handleUngagCommand(commandContext({ match: "@alice" }));

    expect(gagSessionsByChat.has(session.chatId)).toBeFalse();
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 55,
    });
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 54);
    expect(resolveCommandTarget).toHaveBeenCalledWith(expect.objectContaining({
      acceptChatId: true,
      acceptUserId: true,
      rawArgument: "@alice",
    }));
    expect(sendCommandMessage).toHaveBeenCalledTimes(1);
    expect(lastCommandText()).toContain("提前解除");
  });

  test("/ungag 必须定向目标，并支持回复、@ 和正负 id", async () => {
    resolveCommandTarget.mockImplementationOnce(async (_params: unknown): Promise<undefined> => undefined);
    await gag.handleUngagCommand(commandContext({ match: "" }));
    expect(sendCommandMessage).not.toHaveBeenCalled();

    for (const rawArgument of ["@alice", "7", "-1002233445566"]) {
      sendCommandMessage.mockClear();
      await gag.handleUngagCommand(commandContext({ match: rawArgument }));
      expect(lastCommandText()).toContain("根本没被");
    }
    sendCommandMessage.mockClear();
    await gag.handleUngagCommand(commandContext({
      match: "",
      replyToMessage: normalMessage(),
    }));
    expect(resolveCommandTarget.mock.calls.at(-1)?.[0]).toMatchObject({
      rawArgument: "",
      message: expect.objectContaining({ reply_to_message: expect.anything() }),
    });
    expect(lastCommandText()).toContain("根本没被");
  });

  test("teardown 静默删除提示，不发送解除回执", async () => {
    const session: GagSession = createSession();
    const second: GagSession = createSession({
      targetId: -1002233445566,
      publicNoticeMessageId: 66,
    });
    addSession(session);
    addSession(second);
    await gag.teardownGagInChat(session.chatId);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 55,
    });
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 54);
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 66);
    expect(sendCommandMessage).not.toHaveBeenCalled();
    expect(gagSessionsByChat.has(session.chatId)).toBeFalse();
  });

  test("提示删除失败时保留 ending owner，后续 teardown 成功才释放", async () => {
    deleteEphemeralMessageWithOutcome.mockImplementationOnce(
      async (): Promise<string> => "failed"
    );
    const session: GagSession = createSession();
    addSession(session);

    await gag.teardownGagInChat(session.chatId);
    expect(sessionFor(session.chatId)).toBe(session);
    expect(session.phase).toBe("ending");
    expect(session.cleanupTimer).not.toBeNull();
    expect(sendCommandMessage).not.toHaveBeenCalled();

    await gag.teardownGagInChat(session.chatId);
    expect(gagSessionsByChat.has(session.chatId)).toBeFalse();
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledTimes(2);
  });

  test("进程 drain 在 Telegram 总闸关闭前删除提示，并停止接纳新会话", async () => {
    const session: GagSession = createSession();
    addSession(session);

    await expect(gag.drainGagRuntime(1_000)).resolves.toBe("flushed");
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 55,
    });
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 54);
    expect(gagSessionsByChat.size).toBe(0);

    sendEphemeralMessage.mockClear();
    await gag.handleGagCommand(commandContext());
    expect(sendEphemeralMessage).not.toHaveBeenCalled();

    gag.initGagRuntime();
    await gag.handleGagCommand(commandContext());
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
  });

  test("旧会话 Telegram 收尾未完成时保持 ending 占位，不让新 gag 穿插", async () => {
    let finishDelete: (() => void) | undefined;
    deleteEphemeralMessageWithOutcome.mockImplementationOnce((_params: EphemeralDeletionParams): Promise<string> =>
      new Promise<string>((resolve: (value: string) => void): void => {
        finishDelete = (): void => resolve("deleted");
      })
    );
    const session: GagSession = createSession();
    addSession(session);
    const teardown: Promise<void> = gag.teardownGagInChat(session.chatId);
    await Promise.resolve();
    expect(sessionFor(session.chatId)?.phase).toBe("ending");

    await gag.handleGagCommand(commandContext());
    expect(sendEphemeralMessage).not.toHaveBeenCalled();
    expect(lastCommandText()).toContain("收尾");

    finishDelete!();
    await teardown;
    expect(gagSessionsByChat.has(session.chatId)).toBeFalse();
  });

  test("开始提示已删但解除回执仍在途时，ending 独占任务继续占住槽位", async () => {
    let finishReceipt: ((messageId: number) => void) | undefined;
    sendCommandMessage.mockImplementationOnce((_params: TextMessageParams): Promise<number> =>
      new Promise<number>((resolve: (messageId: number) => void): void => {
        finishReceipt = resolve;
      })
    );
    const session: GagSession = createSession();
    addSession(session);

    const ungag: Promise<void> = gag.handleUngagCommand(commandContext());
    for (let step: number = 0; step < 6 && finishReceipt === undefined; step++) {
      await Promise.resolve();
    }
    expect(finishReceipt).toBeDefined();
    expect(session.phase).toBe("ending");
    expect(session.endingTask).not.toBeNull();
    expect(sessionFor(session.chatId)).toBe(session);

    const teardown: Promise<void> = gag.teardownGagInChat(session.chatId);
    await Promise.resolve();
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledTimes(1);
    expect(sessionFor(session.chatId)).toBe(session);

    finishReceipt!(56);
    await settleTestBatch([ungag, teardown]);
    expect(gagSessionsByChat.has(session.chatId)).toBeFalse();
  });

  test("teardown 在开始提示发送期间到达时不会复活会话，并撤掉迟到提示", async () => {
    let finishSend: ((messageId: number) => void) | undefined;
    sendEphemeralMessage.mockImplementationOnce((_params: EphemeralMessageParams): Promise<number> =>
      new Promise<number>((resolve: (messageId: number) => void): void => {
        finishSend = resolve;
      })
    );
    const starting: Promise<void> = gag.handleGagCommand(commandContext());
    for (let step: number = 0; step < 6 && finishSend === undefined; step++) {
      await Promise.resolve();
    }
    expect(finishSend).toBeDefined();
    expect(sessionFor(-1001)?.phase).toBe("starting");

    await gag.teardownGagInChat(-1001);
    finishSend!(77);
    await starting;
    expect(gagSessionsByChat.has(-1001)).toBeFalse();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 56);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 77,
    });
  });

  test("回归：提示已发出后遭遇停机 abort，message id 不丢，排空仍能删掉它", async () => {
    // 远端已经收下提示、handler 还没走到提交那一行时 runner.abortActive() 落下：
    // await 以 AbortError 解开并带走返回值。没有同步登记的话这条提示从此没人
    // 知道它的 id，drainGagRuntime 每次都判 failed，进程带非零码退出并扣住实例锁。
    sendEphemeralMessage.mockImplementationOnce(
      async (params: EphemeralMessageParams & { readonly onSent?: (messageId: number) => void }): Promise<number> => {
        params.onSent?.(91);
        throw new DOMException("Telegram update aborted during shutdown.", "AbortError");
      }
    );

    await expect(gag.handleGagCommand(commandContext())).rejects.toThrow();
    expect(gagSessionsByChat.size).toBe(0);
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 56);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 91,
    });

    await expect(gag.drainGagRuntime(1_000)).resolves.toBe("flushed");
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 91,
    });
    expect(gagSessionsByChat.size).toBe(0);
    gag.initGagRuntime();
  });

  test("回归：目标入口没发出去就 abort 时删除公开状态并撤销预约", async () => {
    sendEphemeralMessage.mockImplementationOnce(async (): Promise<number> => {
      throw new DOMException("Telegram update aborted during shutdown.", "AbortError");
    });

    await expect(gag.handleGagCommand(commandContext())).rejects.toThrow();
    expect(gagSessionsByChat.size).toBe(0);
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 56);

    await expect(gag.drainGagRuntime(1_000)).resolves.toBe("flushed");
    expect(deleteEphemeralMessageWithOutcome).not.toHaveBeenCalled();
    gag.initGagRuntime();
  });
});

describe("gag 消息与 inline 入口", () => {
  test("用户目标不携带 id，只放行当前 bot、用具和发送用户 id 同时匹配的结果", async () => {
    const session: GagSession = createSession();
    addSession(session);

    expect(await gag.handleGagMessageIngress(normalMessage(), 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);

    deleteMessageWithOutcome.mockClear();
    expect(await gag.handleGagMessageIngress(normalMessage({
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(session),
    }), 999)).toBeFalse();
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();

    expect(await gag.handleGagMessageIngress(normalMessage({
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过丝带）功... ",
    }), 999)).toBeTrue();

    expect(await gag.handleGagMessageIngress(normalMessage({
      via_bot: { id: 998, is_bot: true, first_name: "Other" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(session),
    }), 999)).toBeTrue();

    deleteMessageWithOutcome.mockClear();
    expect(await gag.handleGagMessageIngress(normalMessage({
      from: { id: 8, is_bot: false, first_name: "Bob" },
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(session),
    }), 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);
  });

  test("频道目标必须结果标记 id 与 sender_chat.id 同时匹配，匿名服务用户不能覆盖", async () => {
    const session: GagSession = createSession({ targetId: -1002233445566 });
    addSession(session);
    const channelMessage: Message = normalMessage({
      sender_chat: {
        id: -1002233445566,
        type: "channel",
        title: "测试频道",
      },
      from: {
        id: 136817688,
        is_bot: true,
        first_name: "Channel",
      },
    });

    expect(await gag.handleGagMessageIngress(channelMessage, 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);

    deleteMessageWithOutcome.mockClear();
    expect(await gag.handleGagMessageIngress({
      ...channelMessage,
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(session),
    }, 999)).toBeFalse();
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();

    const wrongMarker: MessageEntity[] = gagInlineEntities({
      ...session,
      targetId: -1009988776655,
    });
    expect(await gag.handleGagMessageIngress({
      ...channelMessage,
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: wrongMarker,
    }, 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);

    deleteMessageWithOutcome.mockClear();
    expect(await gag.handleGagMessageIngress(normalMessage({
      from: { id: 8, is_bot: false, first_name: "Bob" },
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(session),
    }), 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);

    deleteMessageWithOutcome.mockClear();
    expect(await gag.handleGagMessageIngress(normalMessage({
      sender_chat: {
        id: -1009988776655,
        type: "channel",
        title: "其它频道",
      },
      from: { id: 136817688, is_bot: true, first_name: "Channel" },
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(session),
    }), 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);
  });

  test("本 bot 的过期或跨群 gag 标记在无活动会话时也会删除", async () => {
    const stale: GagSession = createSession({ targetId: -1002233445566 });
    expect(await gag.handleGagMessageIngress(normalMessage({
      via_bot: { id: 999, is_bot: true, first_name: "Bot" },
      text: "（透过口塞）功... ",
      entities: gagInlineEntities(stale),
    }), 999)).toBeTrue();
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 88);
  });

  test("到期消息先完成解除，再按正常消息交给下游", async () => {
    addSession(createSession({ expiresAt: 999_999 }));
    expect(await gag.handleGagMessageIngress(normalMessage(), 999)).toBeFalse();
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 55,
    });
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 54);
    expect(lastCommandText()).toContain("时间到");
    expect(gagSessionsByChat.has(-1001)).toBeFalse();
  });

  test("普通 @ 查询只进入运势，按钮 gag 前缀仅向当前 gag 用户返回 gag", async () => {
    const session: GagSession = createSession();
    addSession(session);
    const handled: boolean = await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-1",
        from: { id: 7, is_bot: false, first_name: "Alice" },
        query: "gag: 功能没了喵",
        offset: "",
      },
      answerInlineQuery,
    } as never);
    expect(handled).toBeTrue();
    const [results, options]: [readonly InlineResult[], InlineAnswerOptions, unknown?] =
      answerInlineQuery.mock.calls[0]!;
    expect(results).toHaveLength(1);
    expect(results[0]?.thumbnail_url).toBe(GAG_THUMBNAIL_URL);
    const content: { message_text: string; entities?: MessageEntity[] } =
      results[0]?.input_message_content as {
        message_text: string;
        entities?: MessageEntity[];
      };
    expect(content.message_text).toStartWith("（透过口塞）功");
    expect(content.entities).toBeUndefined();
    expect(options).toEqual({ cache_time: 0, is_personal: true, next_offset: "" });

    answerInlineQuery.mockClear();
    const gagUserOrdinaryQueryPassed: boolean = await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-2",
        from: { id: 7, is_bot: false, first_name: "Alice" },
        query: "",
        offset: "",
      },
      answerInlineQuery,
    } as never);
    expect(gagUserOrdinaryQueryPassed).toBeFalse();
    expect(answerInlineQuery).not.toHaveBeenCalled();

    const otherUserOrdinaryQueryPassed: boolean = await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-3",
        from: { id: 8, is_bot: false, first_name: "Bob" },
        query: "",
        offset: "",
      },
      answerInlineQuery,
    } as never);
    expect(otherUserOrdinaryQueryPassed).toBeFalse();
    expect(answerInlineQuery).not.toHaveBeenCalled();

    const copiedGagPrefixHandled: boolean = await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-4",
        from: { id: 8, is_bot: false, first_name: "Bob" },
        query: "gag: 偷来的入口",
        offset: "",
      },
      answerInlineQuery,
    } as never);
    expect(copiedGagPrefixHandled).toBeTrue();
    expect(answerInlineQuery.mock.calls[0]?.[0]).toHaveLength(0);
  });

  test("开始提示的频道 id 只定位目标，并从最终发言正文中剥掉", async () => {
    addSession(createSession({
      targetId: -1002233445566,
    }));
    addSession(createSession({
      chatId: -1002,
      targetId: -1009988776655,
    }));

    const handled: boolean = await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-channel",
        from: { id: 100, is_bot: false, first_name: "Admin" },
        query: "gag:-1002233445566 功能没了喵",
        offset: "",
      },
      answerInlineQuery,
    } as never);

    expect(handled).toBeTrue();
    const results: readonly InlineResult[] = answerInlineQuery.mock.calls[0]?.[0] ?? [];
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("gag--1001--1002233445566");
    const content: { message_text: string; entities?: MessageEntity[] } =
      results[0]?.input_message_content as {
        message_text: string;
        entities?: MessageEntity[];
      };
    const messageText: string = content.message_text;
    expect(messageText).toStartWith("（透过口塞）功");
    expect(messageText).not.toContain("-1002233445566");
    expect(content.entities?.[0]).toEqual({
      type: "text_link",
      offset: 0,
      length: rendering.gagSpeechPrefix("口塞").length,
      url: `${GAG_INLINE_CHANNEL_LINK_PREFIX}-1002233445566`,
    });
  });

  test("非法或过期 gag 前缀静默返回空结果，不生成可发送拒绝文本", async () => {
    addSession(createSession());
    const handled: boolean = await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-stolen-user",
        from: { id: 8, is_bot: false, first_name: "Bob" },
        query: "gag: ",
        offset: "",
      },
      answerInlineQuery,
    } as never);

    expect(handled).toBeTrue();
    let results: readonly InlineResult[] = answerInlineQuery.mock.calls[0]?.[0] ?? [];
    expect(results).toHaveLength(0);

    gag.resetGagSessions();
    answerInlineQuery.mockClear();
    await gag.handleGagInlineQuery({
      inlineQuery: {
        id: "inline-stale",
        from: { id: 100, is_bot: false, first_name: "Admin" },
        query: "gag:-1002233445566",
        offset: "",
      },
      answerInlineQuery,
    } as never);
    results = answerInlineQuery.mock.calls[0]?.[0] ?? [];
    expect(results).toHaveLength(0);
  });

  test("同一用户在多群的选项最多 5 条，不需要第二页", async () => {
    for (let index: number = 0; index < GAG_SESSION_MAX; index++) {
      const chatId: number = -10_000 - index;
      addSession(createSession({ chatId }));
    }
    const context: Record<string, unknown> = {
      inlineQuery: {
        id: "inline-page",
        from: { id: 7, is_bot: false, first_name: "Alice" },
        query: "gag: 测试",
        offset: "",
      },
      answerInlineQuery,
    };
    expect(await gag.handleGagInlineQuery(context as never)).toBeTrue();
    expect(answerInlineQuery.mock.calls[0]?.[0]).toHaveLength(GAG_SESSION_MAX);
    expect((answerInlineQuery.mock.calls[0]?.[1] as { next_offset: string }).next_offset).toBe("");
  });
});
