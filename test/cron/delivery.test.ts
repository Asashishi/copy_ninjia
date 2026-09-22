import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { HttpError, InputFile } from "grammy";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CronAction, CronDeliveryOutcome } from "../../packages/types/cron";
import type { RandomImagePick } from "../../packages/types/randomImage";

/** 记录调用并按预设返回的 grammY api 替身。 */
const calls: { method: string; args: unknown[] }[] = [];
let nextFailure: unknown = undefined;
function apiMethod(method: string): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]): Promise<unknown> => {
    calls.push({ method, args });
    if (nextFailure !== undefined) {
      const failure: unknown = nextFailure;
      nextFailure = undefined;
      throw failure;
    }
    if (method === "sendMediaGroup") return (args[1] as unknown[]).map((_: unknown, index: number) => ({ message_id: 77 + index, chat: { id: -1001 } }));
    return { message_id: 77, chat: { id: -1001 } };
  };
}
const markSelfSent = mock((_chatId: number, _messageId: number): void => {});
const pickRandomImage = mock(async (_directory: string): Promise<RandomImagePick> => ({
  status: "ok",
  bytes: new Uint8Array([9]),
  mimeType: "image/png",
  fileName: "drawn.png",
}));
mock.module("../../packages/infra/telegram/mainClient", () => ({
  bot: {
    api: {
      sendMessage: apiMethod("sendMessage"),
      sendPhoto: apiMethod("sendPhoto"),
      sendMediaGroup: apiMethod("sendMediaGroup"),
      sendDocument: apiMethod("sendDocument"),
    },
  },
}));
mock.module("../../packages/infra/selfSentTracker", () => ({ markSelfSent }));
mock.module("../../packages/infra/randomImage", () => ({ pickRandomImage }));

const { deliverCronAction } = await import("../../packages/cron/delivery");
const { TEST_DATA_ROOT } = await import("../preloadEnv");
/** 本地来源的测试目录；cron.json 的 path 解析后一律是绝对路径。 */
const FILES_ROOT: string = join(TEST_DATA_ROOT, "cron-delivery-files");
const { getRandomHImageDirectory } = await import("../../packages/infra/storage/stateStore");
const { TelegramRetryQueueFullError } = await import("../../packages/infra/telegram/outboundRetryPolicy");
const { TELEGRAM_PHOTO_UPLOAD_MAX_BYTES } = await import("../../packages/consts/telegram");

function deliver(action: CronAction, signal: AbortSignal = new AbortController().signal): Promise<CronDeliveryOutcome> {
  return deliverCronAction(-1001, action, signal);
}

beforeEach(() => {
  calls.length = 0;
  nextFailure = undefined;
  markSelfSent.mockClear();
  pickRandomImage.mockClear();
  mkdirSync(FILES_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(FILES_ROOT, { recursive: true, force: true });
});

describe("cron 发送边界", () => {
  test("文字消息不带话题、不设 parse_mode，成功后登记自发消息", async () => {
    expect(await deliver({ type: "send_message", content: "hi" })).toEqual({ kind: "sent" });
    expect(calls).toEqual([{ method: "sendMessage", args: [-1001, "hi", undefined, expect.any(AbortSignal)] }]);
    expect(markSelfSent).toHaveBeenCalledWith(-1001, 77);
  });

  test("图片与文件的地址原样交给 Telegram 拉取，附加文字作为 caption", async () => {
    await deliver({ type: "send_image", content: "今日图", source: { kind: "urls", urls: ["https://e.com/a.png"] }, isBlurred: false });
    await deliver({ type: "send_file", content: undefined, source: { kind: "url", url: "https://e.com/r.zip" } });
    expect(calls).toEqual([
      { method: "sendPhoto", args: [-1001, "https://e.com/a.png", { caption: "今日图" }, expect.any(AbortSignal)] },
      { method: "sendDocument", args: [-1001, "https://e.com/r.zip", { caption: undefined }, expect.any(AbortSignal)] },
    ]);
  });

  test("本地文件用可重复打开的上传源，429 重放或重试不会拿到读完的流", async () => {
    const path: string = join(FILES_ROOT, "report.pdf");
    await Bun.write(path, "pdf-bytes");
    await deliver({ type: "send_file", content: "周报", source: { kind: "path", path } });
    const upload: InputFile = calls[0]!.args[1] as InputFile;
    expect(upload).toBeInstanceOf(InputFile);
    expect(upload.filename).toBe("report.pdf");
    for (let attempt: number = 0; attempt < 2; attempt++) {
      const raw: unknown = await (upload as unknown as { toRaw(): Promise<ReadableStream<Uint8Array>> }).toRaw();
      expect(await new Response(raw as ReadableStream<Uint8Array>).text()).toBe("pdf-bytes");
    }
  });

  test("本地文件缺失或超过上传上限按不可重试失败返回，不发请求", async () => {
    expect(await deliver({ type: "send_file", content: undefined, source: { kind: "path", path: join(FILES_ROOT, "gone.pdf") } }))
      .toEqual({ kind: "permanent", detail: "local file gone.pdf is missing" });
    const big: string = join(FILES_ROOT, "big.png");
    await Bun.write(big, new Uint8Array(TELEGRAM_PHOTO_UPLOAD_MAX_BYTES + 1));
    expect(await deliver({ type: "send_image", content: undefined, source: { kind: "paths", paths: [big] }, isBlurred: false }))
      .toMatchObject({ kind: "permanent", detail: expect.stringContaining("big.png exceeds the Telegram upload limit") });
    expect(calls).toEqual([]);
  });

  test("rand_image 每次调用都重新抽取；省略目录时用 state 的随机图片目录", async () => {
    await deliver({ type: "send_image", content: undefined, source: { kind: "random", directory: null }, isBlurred: false });
    await deliver({ type: "send_image", content: undefined, source: { kind: "random", directory: FILES_ROOT }, isBlurred: false });
    expect(pickRandomImage.mock.calls.map((call: [string]): string => call[0])).toEqual([getRandomHImageDirectory(), FILES_ROOT]);
    expect((calls[0]!.args[1] as InputFile).filename).toBe("drawn.png");

    pickRandomImage.mockImplementationOnce(async (): Promise<RandomImagePick> => ({ status: "empty" }));
    expect(await deliver({ type: "send_image", content: undefined, source: { kind: "random", directory: null }, isBlurred: false }))
      .toEqual({ kind: "permanent", detail: "the random image directory has no pictures" });
  });

  test("is_blurred 为 true 时以剧透遮罩发送；为 false 时请求里不带 has_spoiler", async () => {
    await deliver({ type: "send_image", content: undefined, source: { kind: "urls", urls: ["https://e.com/a.png"] }, isBlurred: true });
    await deliver({ type: "send_image", content: undefined, source: { kind: "random", directory: FILES_ROOT }, isBlurred: true });
    await deliver({ type: "send_image", content: "图", source: { kind: "urls", urls: ["https://e.com/b.png"] }, isBlurred: false });
    const options = calls.map((call: { args: unknown[] }): { has_spoiler?: boolean } => call.args[2] as { has_spoiler?: boolean });
    expect(options.map((option: { has_spoiler?: boolean }): boolean | undefined => option.has_spoiler)).toEqual([true, true, undefined]);
  });

  test("失败分类：5xx、网络与出站队列满可重试，其余 4xx 不可重试", async () => {
    const message: CronAction = { type: "send_message", content: "hi" };
    nextFailure = Object.assign(new Error("Bad Gateway"), { error_code: 502, description: "Bad Gateway" });
    expect(await deliver(message)).toEqual({ kind: "retryable", detail: "502 Bad Gateway" });
    nextFailure = Object.assign(new Error("Forbidden"), { error_code: 403, description: "Forbidden: bot was kicked" });
    expect(await deliver(message)).toEqual({ kind: "permanent", detail: "403 Forbidden: bot was kicked" });
    nextFailure = new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNRESET"));
    expect(await deliver(message)).toMatchObject({ kind: "retryable" });
    nextFailure = new TelegramRetryQueueFullError();
    expect(await deliver(message)).toEqual({ kind: "retryable", detail: "the Telegram outbound retry queue is full" });
    expect(markSelfSent).not.toHaveBeenCalled();
  });

  test("停机取消后失败按 aborted 返回", async () => {
    const controller: AbortController = new AbortController();
    controller.abort();
    nextFailure = new Error("aborted");
    expect(await deliver({ type: "send_message", content: "hi" }, controller.signal)).toEqual({ kind: "aborted" });
  });
});

test("多图只发一次相册，首张有 caption，遮罩覆盖每张，登记全部消息 ID", async () => {
  for (const isBlurred of [false, true]) {
    calls.length = 0;
    markSelfSent.mockClear();
    expect(await deliver({ type: "send_image", content: "相册", isBlurred, source: { kind: "urls", urls: ["https://e.com/a.png", "https://e.com/b.png"] } }))
      .toEqual({ kind: "sent" });
    expect(calls).toEqual([{ method: "sendMediaGroup", args: [-1001, [
      { type: "photo", media: "https://e.com/a.png", caption: "相册", has_spoiler: isBlurred ? true : undefined },
      { type: "photo", media: "https://e.com/b.png", caption: undefined, has_spoiler: isBlurred ? true : undefined },
    ], undefined, expect.any(AbortSignal)] }]);
    expect(markSelfSent.mock.calls).toEqual([[-1001, 77], [-1001, 78]]);
  }
});

test("本地相册整组预检，任一项失效不发送；每张上传流均可重放", async () => {
  const first: string = join(FILES_ROOT, "first.png");
  const second: string = join(FILES_ROOT, "second.png");
  await Bun.write(first, "first");
  const action: CronAction = { type: "send_image", content: undefined, isBlurred: false, source: { kind: "paths", paths: [first, second] } };
  expect(await deliver(action)).toMatchObject({ kind: "permanent" });
  expect(calls).toEqual([]);
  await Bun.write(second, "second");
  nextFailure = Object.assign(new Error("429"), { error_code: 429, description: "Too Many Requests" });
  expect(await deliver(action)).toMatchObject({ kind: "retryable" });
  expect(markSelfSent).not.toHaveBeenCalled();
  expect(await deliver(action)).toEqual({ kind: "sent" });
  for (const call of calls) {
    for (const [index, media] of (call.args[1] as { media: InputFile }[]).entries()) {
      for (let attempt: number = 0; attempt < 2; attempt++) {
        const raw: ReadableStream<Uint8Array> = await (media.media as unknown as { toRaw(): Promise<ReadableStream<Uint8Array>> }).toRaw();
        expect(await new Response(raw).text()).toBe(index === 0 ? "first" : "second");
      }
    }
  }
});

test("抽图异步返回前取消，停止后不提交发送", async () => {
  const controller: AbortController = new AbortController();
  pickRandomImage.mockImplementationOnce(async (): Promise<RandomImagePick> => {
    await Promise.resolve();
    controller.abort();
    return { status: "ok", bytes: new Uint8Array([1]), fileName: "a.png", mimeType: "image/png" };
  });
  expect(await deliver({ type: "send_image", content: undefined, isBlurred: false, source: { kind: "random", directory: null } }, controller.signal))
    .toEqual({ kind: "aborted" });
  expect(calls).toEqual([]);
});
