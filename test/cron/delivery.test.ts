import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { HttpError, InputFile } from "grammy";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CronAction, CronDeliveryOutcome, CronRoundVoices } from "../../packages/types/cron";
import type { VoiceSynthesisResult } from "../../packages/types/aiChat/voiceMessage";
import type { RandomImagePick } from "../../packages/types/randomImage";

/** 记录调用并按预设返回的 grammY api 替身。 */
const calls: { method: string; args: unknown[] }[] = [];
/** 发图应答里的 photo 档位。 */
const SENT_PHOTO = [{ file_id: "sent", file_unique_id: "sent-u", width: 800, height: 600 }];
let nextFailure: unknown = undefined;
function apiMethod(method: string): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]): Promise<unknown> => {
    calls.push({ method, args });
    if (nextFailure !== undefined) {
      const failure: unknown = nextFailure;
      nextFailure = undefined;
      throw failure;
    }
    if (method === "sendMediaGroup") {
      return (args[1] as { caption?: string }[]).map((item: { caption?: string }, index: number) => ({
        message_id: 77 + index, chat: { id: -1001 }, photo: SENT_PHOTO, caption: item.caption,
      }));
    }
    if (method === "sendPhoto") {
      return { message_id: 77, chat: { id: -1001 }, photo: SENT_PHOTO, caption: (args[2] as { caption?: string }).caption };
    }
    if (method === "sendVoice") {
      return { message_id: 77, chat: { id: -1001 }, voice: { file_id: "voice-file", file_unique_id: "voice-u", duration: 3 } };
    }
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
      sendVoice: apiMethod("sendVoice"),
    },
  },
}));
mock.module("../../packages/infra/selfSentTracker", () => ({ markSelfSent }));
mock.module("../../packages/infra/randomImage", () => ({ pickRandomImage }));
const recordBotImage = mock((..._args: unknown[]): void => {});
mock.module("../../packages/aiChat/botImages", () => ({ recordBotImage }));
/** OGG 头 + 两字节的合成替身；每次返回新数组，确认复用的是登记下的那一份。 */
function voiceResult(): VoiceSynthesisResult {
  return { ok: true, voice: { bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2]), durationSeconds: 3 } };
}
const synthesizeVoice = mock(async (..._args: unknown[]): Promise<VoiceSynthesisResult> => voiceResult());
const realWorkerBridge = await import("../../packages/aiChat/workerBridge");
mock.module("../../packages/aiChat/workerBridge", () => ({ ...realWorkerBridge, synthesizeVoice }));

const { deliverCronAction } = await import("../../packages/cron/delivery");
const { TEST_DATA_ROOT } = await import("../preloadEnv");
/** 本地来源的测试目录；cron.json 的 path 解析后一律是绝对路径。 */
const FILES_ROOT: string = join(TEST_DATA_ROOT, "cron-delivery-files");
const { getRandomHImageDirectory } = await import("../../packages/infra/storage/stateStore");
const { TelegramRetryQueueFullError } = await import("../../packages/infra/telegram/outboundRetryPolicy");
const { TELEGRAM_PHOTO_UPLOAD_MAX_BYTES } = await import("../../packages/consts/telegram");

function deliver(
  action: CronAction,
  signal: AbortSignal = new AbortController().signal,
  voices: CronRoundVoices = new Map()
): Promise<CronDeliveryOutcome> {
  return deliverCronAction({ chatId: -1001, action, signal, voices });
}

beforeEach(() => {
  calls.length = 0;
  nextFailure = undefined;
  markSelfSent.mockClear();
  pickRandomImage.mockClear();
  recordBotImage.mockClear();
  synthesizeVoice.mockClear();
  synthesizeVoice.mockImplementation(async (): Promise<VoiceSynthesisResult> => voiceResult());
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

  test("发出的每张图都写一条 AI 记忆占位自录，文字与文件不写", async () => {
    await deliver({ type: "send_message", content: "hi" });
    await deliver({ type: "send_file", content: undefined, source: { kind: "url", url: "https://e.com/r.zip" } });
    expect(recordBotImage).not.toHaveBeenCalled();

    await deliver({ type: "send_image", content: "今日图", source: { kind: "urls", urls: ["https://e.com/a.png"] }, isBlurred: false });
    expect(recordBotImage).toHaveBeenCalledWith({ chatId: -1001, messageId: 77, caption: "今日图", edited: false });

    recordBotImage.mockClear();
    await deliver({ type: "send_image", content: "相册", source: { kind: "urls", urls: ["https://e.com/a.png", "https://e.com/b.png"] }, isBlurred: false });
    expect(recordBotImage.mock.calls).toEqual([
      [{ chatId: -1001, messageId: 77, caption: "相册", edited: false }],
      [{ chatId: -1001, messageId: 78, caption: "", edited: false }],
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

describe("send_voice", () => {
  const VOICE: CronAction = { type: "send_voice", content: "おやすみ", tone: "眠そうに" };

  test("台词与语气交给公共合成实现，以 OGG 语音气泡发送并登记自发消息", async () => {
    const signal: AbortSignal = new AbortController().signal;
    expect(await deliver(VOICE, signal)).toEqual({ kind: "sent" });
    expect(synthesizeVoice).toHaveBeenCalledWith({ text: "おやすみ", tone: "眠そうに", signal });
    expect(calls).toHaveLength(1);
    const [chatId, upload, options] = calls[0]!.args as [number, InputFile, { duration: number }];
    expect(calls[0]!.method).toBe("sendVoice");
    expect(chatId).toBe(-1001);
    expect(upload).toBeInstanceOf(InputFile);
    expect(upload.filename).toBe("voice.ogg");
    expect(options).toEqual({ duration: 3 });
    expect(markSelfSent).toHaveBeenCalledWith(-1001, 77);
    expect(recordBotImage).not.toHaveBeenCalled();
  });

  test("同一轮只合成一次；首次发送成功前的重试重新上传，成功后后续会话改用 file_id", async () => {
    const voices: CronRoundVoices = new Map();
    nextFailure = Object.assign(new Error("Bad Gateway"), { error_code: 502, description: "Bad Gateway" });
    expect(await deliver(VOICE, undefined, voices)).toEqual({ kind: "retryable", detail: "502 Bad Gateway" });
    expect(voices.get(VOICE)?.fileId).toBeUndefined();
    expect(await deliver(VOICE, undefined, voices)).toEqual({ kind: "sent" });
    expect(voices.get(VOICE)?.fileId).toBe("voice-file");
    expect(await deliverCronAction({ chatId: -1002, action: VOICE, signal: new AbortController().signal, voices }))
      .toEqual({ kind: "sent" });
    expect(synthesizeVoice).toHaveBeenCalledTimes(1);
    expect(voices.get(VOICE)?.voice.durationSeconds).toBe(3);
    const sources: unknown[] = calls.map((call: { args: unknown[] }): unknown => call.args[1]);
    expect(sources[0]).toBeInstanceOf(InputFile);
    expect(sources[1]).toBeInstanceOf(InputFile);
    expect(sources[2]).toBe("voice-file");
    expect(calls[2]!.args[0]).toBe(-1002);
    expect(calls[2]!.args[2]).toEqual({ duration: 3 });
    expect(markSelfSent).toHaveBeenLastCalledWith(-1002, 77);
    // 新的一轮用新表，重新合成。
    await deliver(VOICE);
    expect(synthesizeVoice).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["worker unavailable", "retryable"],
    ["synthesis failed", "retryable"],
    ["timed out", "retryable"],
    ["tts unconfigured", "permanent"],
    ["tts unsupported", "permanent"],
    ["opus encoder failed", "permanent"],
  ] as const)("合成失败 %s 按 %s 返回，不发送也不登记", async (reason, kind) => {
    const voices: CronRoundVoices = new Map();
    synthesizeVoice.mockImplementationOnce(async (): Promise<VoiceSynthesisResult> => ({ ok: false, reason }));
    expect(await deliver(VOICE, undefined, voices)).toEqual({ kind, detail: `speech synthesis failed: ${reason}` });
    expect(calls).toEqual([]);
    expect(voices.size).toBe(0);
  });

  test("合成期间取消按 aborted 返回，不发送", async () => {
    const controller: AbortController = new AbortController();
    synthesizeVoice.mockImplementationOnce(async (): Promise<VoiceSynthesisResult> => {
      controller.abort();
      return voiceResult();
    });
    expect(await deliver(VOICE, controller.signal)).toEqual({ kind: "aborted" });
    synthesizeVoice.mockImplementationOnce(async (): Promise<VoiceSynthesisResult> => ({ ok: false, reason: "aborted" }));
    expect(await deliver(VOICE)).toEqual({ kind: "aborted" });
    expect(calls).toEqual([]);
  });
});
