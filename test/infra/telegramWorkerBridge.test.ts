import { beforeEach, describe, expect, mock, test } from "bun:test";
import { InputFile } from "grammy";
import type {
  TelegramMemoryFile,
  TelegramWorkerJsonCall,
  TelegramWorkerRequest,
} from "../../packages/types/telegramWorker";
import { telegramRetryCategoryFor } from "../../packages/infra/telegram/outboundRetryPolicy";

interface CapturedDuplexRequest {
  readonly request: TelegramWorkerRequest;
  readonly signal: AbortSignal | undefined;
  readonly transfer: Bun.Transferable[] | undefined;
}

const duplexRequests: CapturedDuplexRequest[] = [];
const requestMainThread = mock(async (
  request: TelegramWorkerRequest,
  signal?: AbortSignal,
  transfer?: Bun.Transferable[]
): Promise<unknown> => {
  duplexRequests.push({ request, signal, transfer });
  return { message_id: 17 };
});
const rawSendMessage = mock(async (..._args: unknown[]): Promise<unknown> => ({ message_id: 18 }));
const rawGetChat = mock(async (..._args: unknown[]): Promise<unknown> => ({ id: -1001, type: "supergroup" }));
const rawDispatches: { method: string; payload: unknown; signal: AbortSignal }[] = [];
const rawApi: Record<PropertyKey, unknown> = new Proxy<Record<PropertyKey, unknown>>({
  sendMessage: rawSendMessage,
  getChat: rawGetChat,
}, {
  get(target: Record<PropertyKey, unknown>, property: PropertyKey): unknown {
    const existing: unknown = target[property];
    if (existing !== undefined) return existing;
    return async (payload: unknown, signal: AbortSignal): Promise<unknown> => {
      rawDispatches.push({ method: String(property), payload, signal });
      return { method: property };
    };
  },
});
const mainSendPhoto = mock(async (..._args: unknown[]): Promise<unknown> => ({ message_id: 19 }));
const mainSendAudio = mock(async (..._args: unknown[]): Promise<unknown> => ({ message_id: 20 }));
let hydratedFilePath: string | undefined = "files/media.bin";
const mainGetFile = mock(async (..._args: unknown[]): Promise<unknown> => ({
  file_path: hydratedFilePath,
  getUrl: (): string => "https://api.telegram.test/files/media.bin",
}));
const actionSendMessage = mock(async (
  params: { onSent?: (messageId: number) => void }
): Promise<number> => {
  params.onSent?.(88);
  return 88;
});
const deleteMessageAfter = mock((..._args: unknown[]): void => {});

mock.module("../../packages/libs/workerDuplex", () => ({ requestMainThread }));
mock.module("../../packages/infra/telegram/mainClient", () => ({
  bot: {
    api: {
      raw: rawApi,
      getFile: mainGetFile,
      sendPhoto: mainSendPhoto,
      sendAudio: mainSendAudio,
    },
  },
}));
mock.module("../../packages/infra/telegram/actions/messages", () => ({
  sendMessage: actionSendMessage,
}));
mock.module("../../packages/infra/telegram/actions/messageLifecycle", () => ({
  deleteMessageAfter,
}));

const { sendTemporaryMessageFromMain, workerTelegramApi } =
  await import("../../packages/infra/telegram/workerClient");
const {
  handleAiWorkerTelegramRequest,
  handleAntiRaidWorkerTelegramRequest,
  telegramWorkerResponseTransfer,
} = await import("../../packages/infra/telegram/workerRequests");

beforeEach((): void => {
  duplexRequests.length = 0;
  requestMainThread.mockClear();
  rawSendMessage.mockClear();
  rawGetChat.mockClear();
  rawDispatches.length = 0;
  mainSendPhoto.mockClear();
  mainSendAudio.mockClear();
  mainGetFile.mockClear();
  hydratedFilePath = "files/media.bin";
  actionSendMessage.mockClear();
  deleteMessageAfter.mockClear();
});

describe("Telegram Worker 双工代理", () => {
  test("把 grammY 参数收敛成可克隆 payload，并保持取消信号", async (): Promise<void> => {
    const controller: AbortController = new AbortController();

    await workerTelegramApi.sendMessage(
      -1001,
      "hello",
      { disable_notification: true },
      controller.signal as never
    );

    expect(duplexRequests).toEqual([{
      request: {
        operation: "call",
        category: "message",
        call: {
          method: "sendMessage",
          payload: {
            chat_id: -1001,
            text: "hello",
            disable_notification: true,
          },
        },
      },
      signal: controller.signal,
      transfer: undefined,
    }]);
  });

  test("临时提示以组合请求交给主线程认领删除生命周期", async (): Promise<void> => {
    const signal: AbortSignal = new AbortController().signal;

    await sendTemporaryMessageFromMain({
      chatId: -1001,
      text: "temporary",
      deleteAfterMs: 30_000,
      signal,
    });

    expect(duplexRequests).toEqual([{
      request: {
        operation: "sendTemporaryMessage",
        category: "message",
        chatId: -1001,
        text: "temporary",
        deleteAfterMs: 30_000,
      },
      signal,
      transfer: undefined,
    }]);
  });

  test("内存图片只跨线程传字节，拒绝 Worker 自己解析外部文件来源", async (): Promise<void> => {
    const photoBytes: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3]);
    await workerTelegramApi.sendPhoto(
      -1001,
      { bytes: photoBytes, fileName: "reply.png" },
      { caption: "image" }
    );

    expect(duplexRequests[0]?.request).toEqual({
      operation: "sendPhoto",
      category: "message",
      chatId: -1001,
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "reply.png",
      other: { caption: "image" },
    });
    const photoRequest = duplexRequests[0]?.request as
      | Extract<TelegramWorkerRequest, { operation: "sendPhoto" }>
      | undefined;
    const photoBuffer: ArrayBufferLike | undefined = photoRequest?.bytes.buffer;
    expect(photoRequest?.bytes).toBe(photoBytes);
    expect(photoBuffer).toBe(photoBytes.buffer);
    expect(photoBuffer).toBeInstanceOf(ArrayBuffer);
    if (!(photoBuffer instanceof ArrayBuffer)) throw new Error("photo buffer is not transferable");
    expect(duplexRequests[0]?.transfer).toEqual([photoBuffer]);
    await expect(workerTelegramApi.sendPhoto(
      -1001,
      "remote-file-id" as unknown as TelegramMemoryFile
    )).rejects.toThrow(
      "Worker photo must use the project-owned in-memory file shape."
    );
  });

  test("音频与缩略图直接转移原 ArrayBuffer，不建立媒体全量副本", async (): Promise<void> => {
    const audioBytes: Uint8Array<ArrayBuffer> = new Uint8Array(24 * 1_024 * 1_024);
    const thumbnailBytes: Uint8Array<ArrayBuffer> = new Uint8Array([4, 5, 6]);

    await workerTelegramApi.sendAudio(
      -1001,
      { bytes: audioBytes, fileName: "song.mp3" },
      { thumbnail: { bytes: thumbnailBytes, fileName: "cover.jpg" } }
    );

    const request = duplexRequests[0]?.request as
      | Extract<TelegramWorkerRequest, { operation: "sendAudio" }>
      | undefined;
    expect(request?.bytes).toBe(audioBytes);
    expect(request?.thumbnailBytes).toBe(thumbnailBytes);
    expect(duplexRequests[0]?.transfer).toEqual([
      audioBytes.buffer,
      thumbnailBytes.buffer,
    ]);
  });

  test("子视图只复制可见区间，避免转移并 detach 仍被其它视图共享的 backing store", async (): Promise<void> => {
    const backing: Uint8Array<ArrayBuffer> = new Uint8Array([0, 1, 2, 3, 4]);
    const view: Uint8Array<ArrayBuffer> = backing.subarray(1, 4);

    await workerTelegramApi.sendPhoto(
      -1001,
      { bytes: view, fileName: "slice.png" }
    );

    const request = duplexRequests[0]?.request as
      | Extract<TelegramWorkerRequest, { operation: "sendPhoto" }>
      | undefined;
    expect(request?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(request?.bytes).not.toBe(view);
    expect(request?.bytes.buffer).not.toBe(backing.buffer);
    expect(duplexRequests[0]?.transfer).toEqual([request?.bytes.buffer as ArrayBuffer]);
  });
});

describe("主线程 Telegram Worker 能力边界", () => {
  test("AI 只获得回复类能力，安全处置请求被拒绝", async (): Promise<void> => {
    const signal: AbortSignal = new AbortController().signal;
    await expect(handleAiWorkerTelegramRequest({
      operation: "call",
      category: "message",
      call: {
        method: "sendMessage",
        payload: { chat_id: -1001, text: "reply" },
      },
    }, signal)).resolves.toEqual({ message_id: 18 });
    expect(rawSendMessage).toHaveBeenCalledWith(
      { chat_id: -1001, text: "reply" },
      signal
    );

    await expect(handleAiWorkerTelegramRequest({
      operation: "call",
      category: "kick",
      call: {
        method: "banChatMember",
        payload: { chat_id: -1001, user_id: 7 },
      },
    }, signal)).rejects.toThrow("unsupported Telegram capability");
  });

  test("Anti-Raid 可查询群状态，但不能借能力边界读取贴纸目录", async (): Promise<void> => {
    const signal: AbortSignal = new AbortController().signal;
    await expect(handleAntiRaidWorkerTelegramRequest({
      operation: "call",
      category: "query",
      call: { method: "getChat", payload: { chat_id: -1001 } },
    }, signal)).resolves.toEqual({ id: -1001, type: "supergroup" });
    expect(rawGetChat).toHaveBeenCalledWith({ chat_id: -1001 }, signal);

    await expect(handleAntiRaidWorkerTelegramRequest({
      operation: "call",
      category: "query",
      call: { method: "getStickerSet", payload: { name: "pack" } },
    }, signal)).rejects.toThrow("unsupported Telegram capability");
  });

  test("Anti-Raid 临时提示成功时主线程同步登记固定删除", async (): Promise<void> => {
    const signal: AbortSignal = new AbortController().signal;

    await expect(handleAntiRaidWorkerTelegramRequest({
      operation: "sendTemporaryMessage",
      category: "message",
      chatId: -1001,
      text: "warning",
      deleteAfterMs: 30_000,
    }, signal)).resolves.toEqual({
      messageId: 88,
      sentAt: expect.any(Number),
    });

    expect(actionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1001,
      text: "warning",
      signal,
      onSent: expect.any(Function),
    }));
    expect(deleteMessageAfter).toHaveBeenCalledWith({
      chatId: -1001,
      messageId: 88,
      delayMs: 30_000,
      batchOnFlush: true,
    });
  });

  test("临时提示拒绝非法删除期限，发送动作不会先落地", async (): Promise<void> => {
    const signal: AbortSignal = new AbortController().signal;
    await expect(handleAntiRaidWorkerTelegramRequest({
      operation: "sendTemporaryMessage",
      category: "message",
      chatId: -1001,
      text: "warning",
      deleteAfterMs: 0,
    }, signal)).rejects.toThrow("positive safe integer");
    await expect(handleAntiRaidWorkerTelegramRequest({
      operation: "sendTemporaryMessage",
      category: "message",
      chatId: -1001,
      text: "warning",
      deleteAfterMs: 1.5,
    }, signal)).rejects.toThrow("positive safe integer");
    expect(actionSendMessage).not.toHaveBeenCalled();
  });

  test("主线程重新构造 InputFile 后才进入统一 bot.api", async (): Promise<void> => {
    const signal: AbortSignal = new AbortController().signal;
    await handleAiWorkerTelegramRequest({
      operation: "sendPhoto",
      category: "message",
      chatId: -1001,
      bytes: new Uint8Array([4, 5, 6]),
      fileName: "generated.png",
      other: { caption: "generated" },
    }, signal);

    const args: unknown[] | undefined = mainSendPhoto.mock.calls[0];
    expect(args?.[0]).toBe(-1001);
    expect(args?.[1]).toBeInstanceOf(InputFile);
    expect(await (args?.[1] as InputFile).toRaw()).toEqual(new Uint8Array([4, 5, 6]));
    expect(args?.[2]).toEqual({ caption: "generated" });
    expect(args?.[3]).toBe(signal);
  });

  test("音频与可选缩略图都在主线程重建 InputFile", async (): Promise<void> => {
    const signal: AbortSignal = new AbortController().signal;
    await handleAiWorkerTelegramRequest({
      operation: "sendAudio",
      category: "message",
      chatId: -1001,
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "song.mp3",
      thumbnailBytes: new Uint8Array([4, 5, 6]),
      other: { caption: "song" },
    }, signal);

    const args: unknown[] | undefined = mainSendAudio.mock.calls[0];
    expect(args?.[0]).toBe(-1001);
    expect(args?.[1]).toBeInstanceOf(InputFile);
    expect(await (args?.[1] as InputFile).toRaw()).toEqual(new Uint8Array([1, 2, 3]));
    const other = args?.[2] as { caption?: string; thumbnail?: InputFile } | undefined;
    expect(other?.caption).toBe("song");
    expect(other?.thumbnail).toBeInstanceOf(InputFile);
    expect(await other?.thumbnail?.toRaw()).toEqual(new Uint8Array([4, 5, 6]));
    expect(args?.[3]).toBe(signal);
  });

  test("下载能力区分缺路径、HTTP、体积、空响应与成功字节，并只转移成功 buffer", async (): Promise<void> => {
    const originalFetch: typeof fetch = globalThis.fetch;
    const responses: Response[] = [
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      new Response("unavailable", { status: 503 }),
      new Response(new Uint8Array([9]), {
        status: 200,
        headers: { "content-length": "999999999" },
      }),
      new Response(new Uint8Array(), { status: 200 }),
    ];
    const fetchMock = mock(async (..._args: unknown[]): Promise<Response> => responses.shift()!);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const signal: AbortSignal = new AbortController().signal;
    const request: TelegramWorkerRequest = {
      operation: "downloadFile",
      category: "download",
      fileId: "file-id",
      purpose: "vision",
    };

    try {
      const succeeded: unknown = await handleAiWorkerTelegramRequest(request, signal);
      expect(succeeded).toEqual({ status: "ok", bytes: new Uint8Array([1, 2, 3]) });
      const successBytes: Uint8Array = (succeeded as { bytes: Uint8Array }).bytes;
      const successBuffer: ArrayBufferLike = successBytes.buffer;
      expect(successBuffer).toBeInstanceOf(ArrayBuffer);
      if (!(successBuffer instanceof ArrayBuffer)) throw new Error("download buffer is not transferable");
      expect(telegramWorkerResponseTransfer(request, succeeded)).toEqual([successBuffer]);

      await expect(handleAiWorkerTelegramRequest(request, signal)).resolves.toEqual({
        status: "httpError",
        httpStatus: 503,
      });
      await expect(handleAiWorkerTelegramRequest(request, signal)).resolves.toEqual({
        status: "tooLarge",
        observedBytes: 999_999_999,
      });
      await expect(handleAiWorkerTelegramRequest(request, signal)).resolves.toEqual({ status: "empty" });

      hydratedFilePath = undefined;
      await expect(handleAiWorkerTelegramRequest(request, signal)).resolves.toEqual({ status: "missingPath" });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(telegramWorkerResponseTransfer(request, { status: "empty" })).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("两类 Worker 的全部 JSON 白名单方法逐项路由到同名 raw API", async (): Promise<void> => {
    const signal: AbortSignal = new AbortController().signal;
    const cases: readonly {
      readonly owner: "ai" | "antiRaid";
      readonly method: TelegramWorkerJsonCall["method"];
    }[] = [
      { owner: "ai", method: "getStickerSet" },
      { owner: "ai", method: "sendChatAction" },
      { owner: "ai", method: "sendSticker" },
      { owner: "ai", method: "setMessageReaction" },
      { owner: "antiRaid", method: "answerCallbackQuery" },
      { owner: "antiRaid", method: "banChatMember" },
      { owner: "antiRaid", method: "banChatSenderChat" },
      { owner: "antiRaid", method: "deleteMessage" },
      { owner: "antiRaid", method: "deleteMessages" },
      { owner: "antiRaid", method: "getChatAdministrators" },
      { owner: "antiRaid", method: "getChatMember" },
      { owner: "antiRaid", method: "restrictChatMember" },
      { owner: "antiRaid", method: "setChatPermissions" },
      { owner: "antiRaid", method: "unbanChatMember" },
    ];

    for (const entry of cases) {
      const payload: Record<string, string> = { marker: entry.method };
      const request = {
        operation: "call",
        category: telegramRetryCategoryFor(entry.method),
        call: { method: entry.method, payload },
      } as unknown as TelegramWorkerRequest;
      const handler: typeof handleAiWorkerTelegramRequest = entry.owner === "ai"
        ? handleAiWorkerTelegramRequest
        : handleAntiRaidWorkerTelegramRequest;
      await handler(request, signal);
    }

    expect(rawDispatches.map((call): string => call.method))
      .toEqual(cases.map((entry): string => entry.method));
    expect(rawDispatches.every((call): boolean => call.signal === signal)).toBeTrue();
    expect(rawDispatches.map((call): unknown => call.payload))
      .toEqual(cases.map((entry): Record<string, string> => ({ marker: entry.method })));
  });

  test("调用方类别与真实 Bot API 方法不一致时主线程拒绝", async (): Promise<void> => {
    const signal: AbortSignal = new AbortController().signal;
    await expect(handleAiWorkerTelegramRequest({
      operation: "call",
      category: "query",
      call: {
        method: "sendMessage",
        payload: { chat_id: -1001, text: "reply" },
      },
    }, signal)).rejects.toThrow("category does not match");
    expect(rawSendMessage).not.toHaveBeenCalled();
  });
});
