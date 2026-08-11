import { beforeEach, describe, expect, mock, test } from "bun:test";
import { InputFile } from "grammy";
import type {
  TelegramMemoryFile,
  TelegramWorkerRequest,
} from "../../packages/types/telegramWorker";

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
const mainSendPhoto = mock(async (..._args: unknown[]): Promise<unknown> => ({ message_id: 19 }));
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
      raw: {
        sendMessage: rawSendMessage,
        getChat: rawGetChat,
      },
      sendPhoto: mainSendPhoto,
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
} = await import("../../packages/infra/telegram/workerRequests");

beforeEach((): void => {
  duplexRequests.length = 0;
  requestMainThread.mockClear();
  rawSendMessage.mockClear();
  rawGetChat.mockClear();
  mainSendPhoto.mockClear();
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
