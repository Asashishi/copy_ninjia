import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GrammyError } from "grammy";
import {
  AVATAR_FETCH_MAX_ATTEMPTS,
  AVATAR_MAX_DOWNLOAD_BYTES,
  USER_PROFILE_PHOTOS_LIMIT,
} from "../../packages/consts/telegram";

const loggerErrorMock = mock((..._args: unknown[]): void => {});
mock.module("../../packages/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerErrorMock,
  },
}));

const realFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];

const { bot } = await import("../../packages/infra/telegram/mainClient");
const { copyUserProfilePhoto } = await import("../../packages/infra/telegram/avatar");

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
          <meta property="og:image" content="https://cdn1.telesco.pe/avatar.jpg">
        `);
      }
      if (url === "https://cdn1.telesco.pe/avatar.jpg") {
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
      "Skipping t.me web profile scrape fallback: getChat lookup for channel -1003952764805 failed"
    );
  });

  test("调用方给的 username 只进日志，抓取目标一律以 getChat 现查的为准", async () => {
    // username 来自 reply_to_message 或身份缓存，可能是几个月前的快照，而 Telegram
    // 用户名释放后可以被别人重新注册。短路掉权威查询就会把现任持有者的头像顶上去，
    // 而成功提示里写的还是原目标。
    getChatMock
      .mockImplementationOnce(async (_chatId: number): Promise<any> => ({ id: -1003952764805, type: "channel", title: "Yuna Sakagami" }))
      .mockImplementationOnce(async (_chatId: number): Promise<any> => ({
        id: -1003952764805,
        type: "channel",
        title: "Yuna Sakagami",
        username: "YunaSakagami",
      }));

    const result: boolean = await copyUserProfilePhoto(-1003952764805, true, { username: "StaleHandle" });

    expect(result).toBe(true);
    // 现查了一次，而且抓的是现查回来的那个 handle，不是调用方给的。
    expect(getChatMock).toHaveBeenCalledTimes(2);
    expect(loggerErrorMock).toHaveBeenCalledWith("Falling back to t.me web profile scrape for @YunaSakagami");
  });

  test("现查不到 username 时不拿调用方给的顶上，只把它写进日志", async () => {
    getChatMock.mockImplementation(async (_chatId: number): Promise<any> => ({
      id: -1003952764805,
      type: "channel",
      title: "Yuna Sakagami",
    }));

    const result: boolean = await copyUserProfilePhoto(-1003952764805, true, { username: "StaleHandle" });

    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "Skipping t.me web profile scrape fallback: channel -1003952764805 has no public username" +
      " (command context suggested @StaleHandle, not used because it cannot be proven to still belong to this id)"
    );
  });
});

describe("copyUserProfilePhoto Bot API 主路径", () => {
  const getUserProfilePhotosMock = mock(async (): Promise<any> => ({
    total_count: 0,
    photos: [],
  }));
  const getFileMock = mock(async (): Promise<any> => ({
    file_id: "avatar-file",
    file_unique_id: "avatar-unique",
    file_path: "photos/avatar.jpg",
    getUrl: (): string => "https://api.telegram.org/file/bottest-token/photos/avatar.jpg",
  }));
  let fetchCalls: { readonly input: string; readonly init: RequestInit | undefined }[];

  beforeEach(() => {
    loggerErrorMock.mockClear();
    getChatMock.mockClear();
    getUserProfilePhotosMock.mockClear();
    getFileMock.mockClear();
    setMyProfilePhotoMock.mockClear();
    getChatMock.mockImplementation(async (_chatId: number): Promise<any> => ({
      id: 42,
      type: "private",
      first_name: "Alice",
      photo: { big_file_unique_id: "active-avatar" },
    }));
    getUserProfilePhotosMock.mockImplementation(async (): Promise<any> => ({
      total_count: 1,
      photos: [[
        { file_id: "small-avatar", file_unique_id: "small-active", width: 80, height: 80 },
        { file_id: "active-avatar-file", file_unique_id: "active-avatar", width: 640, height: 640 },
      ]],
    }));
    getFileMock.mockImplementation(async (): Promise<any> => ({
      file_id: "avatar-file",
      file_unique_id: "avatar-unique",
      file_path: "photos/avatar.jpg",
      getUrl: (): string => "https://api.telegram.org/file/bottest-token/photos/avatar.jpg",
    }));
    setMyProfilePhotoMock.mockImplementation(async (): Promise<boolean> => true);
    (bot.api as any).getChat = getChatMock;
    (bot.api as any).getUserProfilePhotos = getUserProfilePhotosMock;
    (bot.api as any).getFile = getFileMock;
    (bot.api as any).setMyProfilePhoto = setMyProfilePhotoMock;
    fetchCalls = [];
    globalThis.fetch = mock(async (
      input: FetchInput,
      init?: RequestInit
    ): Promise<Response> => {
      fetchCalls.push({ input: urlOf(input), init });
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("频道头像下载拒绝重定向并只上传一次", async () => {
    getChatMock.mockImplementation(async (_chatId: number): Promise<any> => ({
      id: -1001,
      type: "channel",
      title: "Channel",
      photo: { big_file_id: "channel-avatar-file" },
    }));

    await expect(copyUserProfilePhoto(-1001, true)).resolves.toBeTrue();

    expect(getFileMock).toHaveBeenCalledWith("channel-avatar-file", undefined);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.init?.redirect).toBe("error");
    expect(fetchCalls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(setMyProfilePhotoMock).toHaveBeenCalledTimes(1);
  });

  test("用户路径从前一百张历史中精确匹配当前头像", async () => {
    await expect(copyUserProfilePhoto(42)).resolves.toBeTrue();

    expect(getUserProfilePhotosMock).toHaveBeenCalledWith(
      42,
      { offset: 0, limit: USER_PROFILE_PHOTOS_LIMIT },
      undefined
    );
    expect(getFileMock).toHaveBeenCalledWith("active-avatar-file", undefined);
    expect(setMyProfilePhotoMock).toHaveBeenCalledTimes(1);
  });

  test("声明体积超限时不读取或上传头像", async () => {
    globalThis.fetch = mock(async (): Promise<Response> => new Response(
      new Uint8Array([1]),
      { headers: { "content-length": String(AVATAR_MAX_DOWNLOAD_BYTES + 1) } }
    )) as unknown as typeof fetch;

    await expect(copyUserProfilePhoto(42)).resolves.toBeFalse();

    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("exceeded the download limit")
    );
  });

  test("调用前已取消时不发起 Telegram 或下载请求", async () => {
    const controller: AbortController = new AbortController();
    controller.abort();

    await expect(
      copyUserProfilePhoto(42, false, { signal: controller.signal })
    ).resolves.toBeFalse();

    expect(getChatMock).not.toHaveBeenCalled();
    expect(getFileMock).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  test("瞬时下载失败会重试，成功后只上传一次", async () => {
    let downloadAttempt: number = 0;
    globalThis.fetch = mock(async (): Promise<Response> => {
      downloadAttempt++;
      return downloadAttempt === 1
        ? new Response(null, { status: 503 })
        : new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;

    await expect(copyUserProfilePhoto(42)).resolves.toBeTrue();

    expect(getFileMock).toHaveBeenCalledTimes(2);
    expect(setMyProfilePhotoMock).toHaveBeenCalledTimes(1);
  });

  test("上传持续失败时用尽重试次数且不误报成功", async () => {
    setMyProfilePhotoMock.mockRejectedValue(new Error("upload failed"));

    await expect(copyUserProfilePhoto(42)).resolves.toBeFalse();

    expect(getFileMock).toHaveBeenCalledTimes(AVATAR_FETCH_MAX_ATTEMPTS);
    expect(setMyProfilePhotoMock).toHaveBeenCalledTimes(AVATAR_FETCH_MAX_ATTEMPTS);
  });
});
