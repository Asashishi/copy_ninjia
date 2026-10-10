import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Api } from "grammy";
import type { RawApi, Transformer } from "grammy";
import { hydrateFiles } from "@grammyjs/files";
import type { FileApiFlavor } from "@grammyjs/files";
import type { TelegramWorkerApi, TelegramWorkerJsonCall, TelegramWorkerRequest } from "../../packages/types/telegramWorker";
import { telegramRetryCategoryFor } from "../../packages/infra/telegram/outboundRetryPolicy";
import { telegramOutboundGate } from "../../packages/infra/telegram/outboundGate";
import { drainTelegramOutbound, initTelegramOutbound, telegramOutboundStats } from "../../packages/infra/telegram/outboundLifecycle";
import { isSelfSent } from "../../packages/infra/selfSentTracker";

const calls: { readonly method: string; readonly payload: any; readonly signal: AbortSignal | undefined }[] = [];
let owner: "ai" | "antiRaid" = "ai";
let retry: boolean = false;
let messageSequence: number = 900;
const api: FileApiFlavor<Api> = new Api("123:test-only") as FileApiFlavor<Api>;
const transport: Transformer<RawApi> = async (...args: Parameters<Transformer<RawApi>>): Promise<any> => {
  const [, method, payload, signal]: Parameters<Transformer<RawApi>> = args;
  calls.push({ method, payload, signal: signal as AbortSignal | undefined });
  expect(telegramOutboundStats().active).toBeGreaterThan(0);
  if (retry) {
    retry = false;
    return { ok: false, error_code: 429, description: "retry", parameters: { retry_after: 0 } };
  }
  if (method === "getFile") return { ok: true, result: { file_id: "file", file_unique_id: "unique", file_path: "files/test.bin" } };
  return { ok: true, result: { message_id: ++messageSequence, chat: { id: -1001, type: "supergroup" }, text: "mock" } };
};
api.config.use(transport);
api.config.use(hydrateFiles("123:test-only"));
api.config.use(telegramOutboundGate());
mock.module("../../packages/infra/telegram/mainClient", () => ({ bot: { api } }));
mock.module("../../packages/libs/workerDuplex", () => ({
  requestMainThread: (request: TelegramWorkerRequest, signal?: AbortSignal): Promise<unknown> =>
    (owner === "ai" ? handleAiWorkerTelegramRequest : handleAntiRaidWorkerTelegramRequest)(request, signal ?? new AbortController().signal),
}));
const { handleAiWorkerTelegramRequest, handleAntiRaidWorkerTelegramRequest } =
  await import("../../packages/infra/telegram/workerRequests");
const { workerTelegramApi, downloadTelegramFileFromMain } = await import("../../packages/infra/telegram/workerClient");
const { installTelegramApi, telegramApi } = await import("../../packages/infra/telegram/client");
const { telegramApiState } = await import("../../packages/cache/perThread/telegramApi");

function assertWorkerApiContract(worker: TelegramWorkerApi): void {
  // @ts-expect-error 主线程专属复制能力不属于 Worker 接口。
  void worker.copyMessage;
  // @ts-expect-error 主线程专属编辑能力不属于 Worker 接口。
  void worker.editMessageText;
  // @ts-expect-error 主线程专属临时消息删除不属于 Worker 接口。
  void worker.deleteEphemeralMessage;
  // @ts-expect-error 主线程专属频道解封不属于 Worker 接口。
  void worker.unbanChatSenderChat;
  // @ts-expect-error 构造后的 Worker 代理方法不可替换。
  worker.sendMessage = async (): Promise<never> => { throw new Error("compile-only"); };
}
void assertWorkerApiContract;

beforeEach((): void => {
  calls.length = 0;
  owner = "ai";
  retry = false;
  initTelegramOutbound();
});
afterEach(async (): Promise<void> => {
  await drainTelegramOutbound(0);
  telegramApiState.current = null;
});

test("每个 JSON 方法逐 owner 验证允许与拒绝，主线程专属方法两边均拒绝", async (): Promise<void> => {
  const permissions: Readonly<Record<TelegramWorkerJsonCall["method"], readonly boolean[]>> = {
    answerCallbackQuery: [false, true], banChatMember: [false, true], banChatSenderChat: [false, true],
    deleteMessage: [false, true], deleteMessages: [false, true], getChat: [false, true],
    getChatAdministrators: [false, true], getChatMember: [false, true], getStickerSet: [true, false],
    restrictChatMember: [false, true], sendChatAction: [true, false], sendMessage: [true, true],
    sendSticker: [true, false], setChatPermissions: [false, true], setMessageReaction: [true, false],
    unbanChatMember: [false, true],
  };
  const methods: readonly string[] = [...Object.keys(permissions), "copyMessage", "deleteEphemeralMessage", "editMessageText", "unbanChatSenderChat"];
  for (const [index, handler] of [handleAiWorkerTelegramRequest, handleAntiRaidWorkerTelegramRequest].entries()) {
    for (const method of methods) {
      const request: TelegramWorkerRequest = { operation: "call", category: telegramRetryCategoryFor(method as keyof RawApi), call: { method, payload: { chat_id: -1001 } } } as TelegramWorkerRequest;
      const before: number = calls.length;
      const result: Promise<unknown> = handler(request, new AbortController().signal);
      if (permissions[method as TelegramWorkerJsonCall["method"]]?.[index] === true) {
        await result;
        expect(calls.at(-1)?.method).toBe(method);
        expect(calls.length).toBe(before + 1);
      } else {
        await expect(result).rejects.toThrow("unsupported Telegram capability");
        expect(calls.length).toBe(before);
      }
    }
  }
});

test("代理贯通真实接收端与出站闸，保留话题、429 重试和自发登记", async (): Promise<void> => {
  retry = true;
  const expectedMessageId: number = messageSequence + 1;
  expect(isSelfSent(-1001, expectedMessageId)).toBeFalse();
  const sent: Awaited<ReturnType<typeof workerTelegramApi.sendMessage>> = await workerTelegramApi.sendMessage(-1001, "hello", { message_thread_id: 71 });
  expect(sent.message_id).toBe(expectedMessageId);
  expect(calls).toHaveLength(2);
  expect(calls.every((call): boolean => call.method === "sendMessage" && call.payload.message_thread_id === 71)).toBeTrue();
  expect(isSelfSent(-1001, sent.message_id)).toBeTrue();
});

test("上传与 CDN 下载均经主线程出站闸；跨 owner 调用和取消不出站", async (): Promise<void> => {
  await workerTelegramApi.sendPhoto(-1001, { bytes: new Uint8Array([1]), fileName: "test.png" }, { message_thread_id: 72 });
  await workerTelegramApi.sendVoice(-1001, { bytes: new Uint8Array([2]), fileName: "test.ogg" }, { message_thread_id: 73 });
  expect(calls.map((call): string => call.method)).toEqual(["sendPhoto", "sendVoice"]);
  expect(calls[0]?.payload.message_thread_id).toBe(72);
  expect(calls[1]?.payload.message_thread_id).toBe(73);
  const originalFetch: typeof fetch = globalThis.fetch;
  let downloads: number = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    downloads++;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(telegramOutboundStats().active).toBeGreaterThan(0);
    return new Response(new Uint8Array([3, 4]));
  }) as typeof fetch;
  try {
    await expect(downloadTelegramFileFromMain({ fileId: "file", purpose: "vision" })).resolves.toEqual({ status: "ok", bytes: new Uint8Array([3, 4]) });
    expect(downloads).toBe(1);
    expect(calls.at(-1)?.method).toBe("getFile");
    owner = "antiRaid";
    await expect(downloadTelegramFileFromMain({ fileId: "file", purpose: "vision" })).rejects.toThrow("unsupported Telegram capability");
    owner = "ai";
    const controller: AbortController = new AbortController();
    controller.abort();
    const before: number = calls.length;
    await expect(workerTelegramApi.sendMessage(-1001, "cancelled", {}, controller.signal as never)).rejects.toThrow();
    expect(calls.length).toBe(before);
    expect(downloads).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("能力白名单之内仍按操作核对 429 类别与临时消息参数，不符时拒绝且不出站", async (): Promise<void> => {
  const signal: AbortSignal = new AbortController().signal;
  const rejected: [TelegramWorkerRequest, string][] = [
    [
      { operation: "call", category: "query", call: { method: "sendMessage", payload: { chat_id: -1001, text: "x" } } } as TelegramWorkerRequest,
      "category does not match its Bot API method",
    ],
    [
      { operation: "sendPhoto", category: "download", chatId: -1001, bytes: new Uint8Array([1]), fileName: "a.png", other: {} } as unknown as TelegramWorkerRequest,
      "sendPhoto must use the message category",
    ],
    [
      { operation: "sendVoice", category: "download", chatId: -1001, bytes: new Uint8Array([1]), fileName: "a.ogg", other: {} } as unknown as TelegramWorkerRequest,
      "sendVoice must use the message category",
    ],
    [
      { operation: "downloadFile", category: "message", fileId: "file", purpose: "vision" } as unknown as TelegramWorkerRequest,
      "downloadFile must use the download category",
    ],
    [
      { operation: "sendTemporaryMessage", category: "download", purpose: "notice", chatId: -1001, text: "x" } as unknown as TelegramWorkerRequest,
      "temporary messages must use the message category",
    ],
  ];
  for (const [request, message] of rejected) {
    await expect(handleAiWorkerTelegramRequest(request, signal)).rejects.toThrow(message);
  }
  expect(calls).toEqual([]);
});

test("Worker 代理没有主线程专属方法，共享门面在本地拒绝这些方法", (): void => {
  installTelegramApi(workerTelegramApi);
  expect("copyMessage" in workerTelegramApi).toBeFalse();
  expect("deleteEphemeralMessage" in workerTelegramApi).toBeFalse();
  expect("editMessageText" in workerTelegramApi).toBeFalse();
  expect("unbanChatSenderChat" in workerTelegramApi).toBeFalse();
  expect(() => telegramApi.copyMessage(-1001, -1002, 1)).toThrow("only available on the main thread");
  expect(() => telegramApi.editMessageText(-1001, 1, "test")).toThrow("only available on the main thread");
  expect(() => telegramApi.deleteEphemeralMessage({ chatId: -1001, receiverUserId: 1, ephemeralMessageId: 1 })).toThrow("only available on the main thread");
  expect(() => telegramApi.unbanChatSenderChat(-1001, -1002)).toThrow("only available on the main thread");
  expect(calls).toHaveLength(0);
});
