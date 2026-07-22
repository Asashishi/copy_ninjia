import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GrammyError } from "grammy";

const loggerErrorMock = mock((..._args: unknown[]): void => {});
mock.module("../../src/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerErrorMock,
  },
}));

const realFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];

const { bot, copyUserProfilePhoto } = await import("../../src/infra/telegram");

const getChatMock = mock(async (_chatId: number): Promise<any> => ({
  id: -1003952764805,
  type: "channel",
  title: "Yuna Sakagami",
  username: "YunaSakagami",
}));
const setMyProfilePhotoMock = mock(async (..._args: unknown[]): Promise<boolean> => true);
let fetchMock: any;

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("copyUserProfilePhoto t.me 兜底", () => {
  beforeEach(() => {
    loggerErrorMock.mockClear();
    getChatMock.mockClear();
    setMyProfilePhotoMock.mockClear();
    getChatMock.mockImplementation(async (_chatId: number): Promise<any> => ({
      id: -1003952764805,
      type: "channel",
      title: "Yuna Sakagami",
      username: "YunaSakagami",
    }));
    (bot.api as any).getChat = getChatMock;
    (bot.api as any).setMyProfilePhoto = setMyProfilePhotoMock;
    fetchMock = mock(async (input: FetchInput): Promise<Response> => {
      const url = urlOf(input);
      if (url === "https://telegram.me/YunaSakagami") {
        return new Response(`
          <meta property="al:ios:url" content="tg://resolve?domain=YunaSakagami">
          <meta property="og:image" content="https://cdn.example/avatar.jpg">
        `);
      }
      if (url === "https://cdn.example/avatar.jpg") {
        return new Response(new Uint8Array([1, 2, 3]));
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("调用方没传频道 username 时，从 getChat 补查后继续爬 t.me 主页", async () => {
    const result: boolean = await copyUserProfilePhoto(-1003952764805, true);

    expect(result).toBe(true);
    expect(getChatMock).toHaveBeenCalledTimes(2);
    expect(loggerErrorMock).toHaveBeenCalledWith("Channel -1003952764805 has no chat photo visible to the bot");
    expect(loggerErrorMock).toHaveBeenCalledWith("Falling back to t.me web profile scrape for @YunaSakagami");
    expect(setMyProfilePhotoMock).toHaveBeenCalledTimes(1);
    expect((setMyProfilePhotoMock.mock.calls[0]![0] as any).type).toBe("static");
  });

  test("补查 public username 遇到 403 时只记录不可访问，不断言 bot 被踢或没有公开 username", async () => {
    const forbidden = new GrammyError(
      "Call to 'getChat' failed!",
      { ok: false, error_code: 403, description: "Forbidden: bot was kicked from the channel chat" },
      "getChat",
      { chat_id: -1003952764805 }
    );
    getChatMock
      .mockImplementationOnce(async (_chatId: number): Promise<any> => ({ id: -1003952764805, type: "channel", title: "Yuna Sakagami" }))
      .mockImplementationOnce(async (): Promise<any> => {
        throw forbidden;
      });

    const result: boolean = await copyUserProfilePhoto(-1003952764805, true);

    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith("Could not check channel -1003952764805 public username via getChat: 403 Forbidden (chat is not accessible to the bot)");
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "Skipping t.me web profile scrape fallback: channel -1003952764805 has no public username available from command context, and getChat lookup failed"
    );
  });
});
