import { describe, expect, mock, test } from "bun:test";

const botUse = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});
const apiThrottler = mock((..._args: unknown[]) => ({ kind: "throttler" }));
const OVERFLOW_STRATEGY: number = 3;
const hydrateFiles = mock((token: string) => ({ kind: "files", token }));
const telegramOutboundGate = mock(() => ({ kind: "outbound-gate" }));
const initTelegramOutbound = mock((): void => {});
const mainSendPhoto = mock(async (..._args: unknown[]) => ({ message_id: 19 }));
const mainSendAudio = mock(async (..._args: unknown[]) => ({ message_id: 20 }));
const rawDeleteEphemeralMessage = mock(async (..._args: unknown[]): Promise<true> => true);
const mainApiCalls: { readonly method: string; readonly args: readonly unknown[] }[] = [];
let botConstructions: number = 0;

class FakeGrammyError extends Error {
  constructor(
    _message: string,
    readonly error: { error_code: number; description: string }
  ) {
    super(_message);
  }

  get error_code(): number {
    return this.error.error_code;
  }

  get description(): string {
    return this.error.description;
  }
}

class FakeBot {
  readonly api: Readonly<Record<PropertyKey, unknown>>;
  constructor(readonly token: string) {
    botConstructions++;
    this.api = new Proxy<Record<PropertyKey, unknown>>({
      config: { use: botUse },
      raw: { deleteEphemeralMessage: rawDeleteEphemeralMessage },
      sendAudio: mainSendAudio,
      sendPhoto: mainSendPhoto,
    }, {
      get(target: Record<PropertyKey, unknown>, property: PropertyKey): unknown {
        const existing: unknown = target[property];
        if (existing !== undefined) return existing;
        return async (...args: unknown[]): Promise<unknown> => {
          mainApiCalls.push({ method: String(property), args });
          return { ok: true };
        };
      },
    });
  }
}

class FakeApi {
  constructor(readonly token: string) {}
}

class FakeInputFile {
  constructor(
    readonly bytes: Uint8Array,
    readonly fileName: string
  ) {}
}

mock.module("grammy", () => ({
  Api: FakeApi,
  Bot: FakeBot,
  GrammyError: FakeGrammyError,
  InputFile: FakeInputFile,
}));
mock.module("@grammyjs/transformer-throttler", () => ({
  apiThrottler,
  BottleneckStrategy: { OVERFLOW: OVERFLOW_STRATEGY },
}));
mock.module("@grammyjs/files", () => ({ hydrateFiles }));
mock.module("../../packages/infra/telegram/outboundGate", () => ({
  initTelegramOutbound,
  telegramOutboundGate,
}));
mock.module("../../packages/config/telegram", () => ({ BOT_TOKEN: "token:secret" }));
mock.module("../../packages/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
}));

const client = await import("../../packages/infra/telegram/client");
const botConstructionsAfterFacadeImport: number = botConstructions;
const mainClient = await import("../../packages/infra/telegram/mainClient");

describe("Telegram 客户端初始化", () => {
  test("共享门面导入不读取 token 或构造 grammY Bot", () => {
    expect(botConstructionsAfterFacadeImport).toBe(0);
    expect(botConstructions).toBe(1);
  });

  test("唯一客户端安装文件增强、消息节流和分类型 429 闸门，重复初始化幂等", () => {
    mainClient.initTelegramClients();
    mainClient.initTelegramClients();

    expect(botUse).toHaveBeenCalledTimes(3);
    expect(botUse).toHaveBeenNthCalledWith(1, { kind: "files", token: "token:secret" });
    expect(botUse).toHaveBeenNthCalledWith(2, expect.any(Function));
    expect(botUse).toHaveBeenNthCalledWith(3, { kind: "outbound-gate" });
    expect(apiThrottler).toHaveBeenCalledTimes(1);
    expect(apiThrottler).toHaveBeenCalledWith({
      global: expect.objectContaining({
        reservoir: 30,
        reservoirRefreshAmount: 30,
        reservoirRefreshInterval: 1_000,
        highWater: 8_192,
        strategy: OVERFLOW_STRATEGY,
      }),
      group: {
        maxConcurrent: 1,
        minTime: 1_000,
        highWater: 128,
        strategy: OVERFLOW_STRATEGY,
      },
      out: expect.objectContaining({
        maxConcurrent: 1,
        minTime: 1_000,
        highWater: 256,
        strategy: OVERFLOW_STRATEGY,
      }),
    });
    expect(telegramOutboundGate).toHaveBeenCalledTimes(1);
    expect(initTelegramOutbound).toHaveBeenCalledTimes(1);
    expect(hydrateFiles).toHaveBeenCalledTimes(1);
    expect(hydrateFiles).toHaveBeenCalledWith("token:secret");
    expect((mainClient.bot as unknown as FakeBot).token).toBe("token:secret");
    expect(client.currentTelegramApi()).not.toBe(mainClient.bot.api);
    expect(client.telegramApi).not.toBe(mainClient.bot.api);
  });

  test("主线程适配器在最终网络边界才构造 InputFile", async () => {
    mainClient.initTelegramClients();
    mainSendPhoto.mockClear();
    const bytes: Uint8Array = new Uint8Array([1, 2, 3]);

    await client.telegramApi.sendPhoto(
      -1001,
      { bytes, fileName: "generated.png" },
      { caption: "generated" }
    );

    expect(mainSendPhoto).toHaveBeenCalledWith(
      -1001,
      expect.objectContaining({ bytes, fileName: "generated.png" }),
      { caption: "generated" },
      undefined
    );
  });

  test("共享门面与主线程适配器逐项原样转交全部 JSON 方法", async (): Promise<void> => {
    mainClient.initTelegramClients();
    mainApiCalls.length = 0;
    const signal: AbortSignal = new AbortController().signal;
    const permissions: Readonly<Record<string, boolean>> = { can_send_messages: false };
    const cases: readonly Readonly<{
      method: Exclude<keyof typeof client.telegramApi,
        "deleteEphemeralMessage" | "sendAudio" | "sendPhoto">;
      args: readonly unknown[];
    }>[] = [
      { method: "answerCallbackQuery", args: ["callback-id", { text: "done" }, signal] },
      { method: "banChatMember", args: [-1001, 7, { until_date: 123 }, signal] },
      { method: "banChatSenderChat", args: [-1001, -2002, signal] },
      { method: "copyMessage", args: [-1001, -1002, 8, { caption: "copy" }, signal] },
      { method: "deleteMessage", args: [-1001, 9, signal] },
      { method: "deleteMessages", args: [-1001, [9, 10], signal] },
      { method: "editMessageText", args: [-1001, 12, "updated", { parse_mode: "HTML" }, signal] },
      { method: "getChat", args: [-1001, signal] },
      { method: "getChatAdministrators", args: [-1001, signal] },
      { method: "getChatMember", args: [-1001, 7, signal] },
      { method: "getStickerSet", args: ["pack", signal] },
      { method: "restrictChatMember", args: [-1001, 7, permissions, { until_date: 456 }, signal] },
      { method: "sendChatAction", args: [-1001, "typing", { message_thread_id: 3 }, signal] },
      { method: "sendMessage", args: [-1001, "hello", { disable_notification: true }, signal] },
      { method: "sendSticker", args: [-1001, "sticker-id", { emoji: "x" }, signal] },
      {
        method: "setChatPermissions",
        args: [-1001, permissions, { use_independent_chat_permissions: true }, signal],
      },
      { method: "setMessageReaction", args: [-1001, 13, [], { is_big: true }, signal] },
      { method: "unbanChatMember", args: [-1001, 7, { only_if_banned: true }, signal] },
      { method: "unbanChatSenderChat", args: [-1001, -2002, signal] },
    ];
    const methods = client.telegramApi as unknown as Readonly<Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >>;

    for (const entry of cases) {
      const method: ((...args: unknown[]) => Promise<unknown>) | undefined = methods[entry.method];
      if (method === undefined) throw new Error(`missing main Telegram method: ${entry.method}`);
      await method(...entry.args);
    }

    expect(mainApiCalls).toEqual(cases.map((entry): Readonly<{
      method: string;
      args: readonly unknown[];
    }> => ({ method: entry.method, args: entry.args })));
  });

  test("音频、缩略图和取消信号完整透传到最终 grammY 边界", async () => {
    mainClient.initTelegramClients();
    mainSendAudio.mockClear();
    const audioBytes: Uint8Array = new Uint8Array([1, 2, 3]);
    const thumbnailBytes: Uint8Array = new Uint8Array([4, 5, 6]);
    const signal: AbortSignal = new AbortController().signal;

    await client.telegramApi.sendAudio(
      -1001,
      { bytes: audioBytes, fileName: "song.mp3" },
      {
        caption: "song",
        thumbnail: { bytes: thumbnailBytes, fileName: "cover.jpg" },
      },
      signal as never
    );

    const args: unknown[] | undefined = mainSendAudio.mock.calls[0];
    expect(args?.[0]).toBe(-1001);
    expect(args?.[1]).toEqual(expect.objectContaining({
      bytes: audioBytes,
      fileName: "song.mp3",
    }));
    expect(args?.[2]).toEqual({
      caption: "song",
      thumbnail: expect.objectContaining({
        bytes: thumbnailBytes,
        fileName: "cover.jpg",
      }),
    });
    expect(args?.[3]).toBe(signal);
  });

  test("临时消息删除参数只在主线程转换为 Bot API payload", async () => {
    mainClient.initTelegramClients();
    rawDeleteEphemeralMessage.mockClear();
    const signal: AbortSignal = new AbortController().signal;

    await client.telegramApi.deleteEphemeralMessage({
      chatId: -1001,
      receiverUserId: 42,
      ephemeralMessageId: 7,
    }, signal);

    expect(rawDeleteEphemeralMessage).toHaveBeenCalledWith({
      chat_id: -1001,
      receiver_user_id: 42,
      ephemeral_message_id: 7,
    }, signal);
  });

  test("GrammyError 展开状态码，普通异常保留原对象", () => {
    const apiError = new FakeGrammyError("failed", { error_code: 429, description: "Too Many Requests" });
    client.logApiError("send message", apiError);
    expect(loggerError).toHaveBeenLastCalledWith("Failed to send message: 429 Too Many Requests");

    const generic = new Error("socket closed");
    client.logApiError("send message", generic);
    expect(loggerError).toHaveBeenLastCalledWith("Error trying to send message:", generic);
  });
});
