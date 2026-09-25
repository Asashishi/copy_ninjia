import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RandomImagePick } from "../../packages/types/randomImage";

const sendCommandMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const sendPhotoWithResult = mock(async (..._args: unknown[]): Promise<{ messageId: number } | undefined> => ({ messageId: 9 }));
const pickRandomImage = mock(async (_directory: string): Promise<RandomImagePick> => ({
  status: "ok",
  bytes: new Uint8Array([1]),
  mimeType: "image/png",
  fileName: "a.png",
}));

mock.module("../../packages/infra/telegram", () => ({ sendCommandMessage, sendPhotoWithResult }));
const recordBotImage = mock((..._args: unknown[]): void => {});
mock.module("../../packages/aiChat/botImages", () => ({ recordBotImage }));
mock.module("../../packages/infra/randomImage", () => ({
  pickRandomImage,
  readRandomImageLibrary: async (): Promise<unknown> => ({ size: 0, storedIds: new Set<string>() }),
  isRandomImageDirectory: async (): Promise<boolean> => true,
  storeRandomImage: async (): Promise<unknown> => ({ status: "unsupportedFormat" }),
}));

const { handleHImageCommand, tryConsumeHImageRateLimit } = await import("../../packages/commands/hImage");
const { recentHImageCallTimestamps } = await import("../../packages/cache/main/hImage");
const {
  H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  H_IMAGE_RATE_LIMIT_WINDOW_MS,
} = await import("../../packages/consts/hImage");
const {
  drainDeferredCommandRuntime: drainHImageRuntime,
  initDeferredCommandRuntime: initHImageRuntime,
  quiesceDeferredCommandRuntime: quiesceHImageRuntime,
} = await import("../../packages/commands/deferredCommands");
const { deferredCommandRuntime: hImageRuntime } = await import("../../packages/cache/main/deferredCommands");
const { chatAtmosphere } = await import("../../packages/infra/atmosphere");
const { getRandomHImageDirectory } = await import("../../packages/infra/storage/stateStore");
const {
  DEFERRED_COMMAND_MAX_CONCURRENT: H_IMAGE_MAX_CONCURRENT,
  DEFERRED_COMMAND_MAX_PENDING: H_IMAGE_MAX_PENDING,
} = await import("../../packages/consts/deferredCommands");

const CHAT_ID: number = -1001;

function context(match: string = "", topic: number | undefined = undefined): never {
  const chat = { id: CHAT_ID, type: "supergroup" };
  return {
    chat,
    msgId: 10,
    msg: {
      message_id: 10,
      chat,
      ...(topic === undefined ? {} : { is_topic_message: true, message_thread_id: topic }),
    },
    match,
  } as never;
}

const texts = chatAtmosphere(CHAT_ID).H_IMAGE_TEXTS;

/** 发一次 `/h_image`；这一组只测执行器的容量与结果，因此每次都让出全局限流配额。 */
async function submitHImage(ctx: never): Promise<void> {
  recentHImageCallTimestamps.clear();
  await handleHImageCommand(ctx);
}

beforeEach(() => {
  recentHImageCallTimestamps.clear();
  for (const mocked of [sendCommandMessage, sendPhotoWithResult, pickRandomImage, recordBotImage]) mocked.mockClear();
  pickRandomImage.mockImplementation(async (): Promise<RandomImagePick> => ({
    status: "ok",
    bytes: new Uint8Array([1]),
    mimeType: "image/png",
    fileName: "a.png",
  }));
  hImageRuntime.current = null;
  initHImageRuntime();
});

afterEach(async () => {
  await drainHImageRuntime(0);
});

describe("/h_image", () => {
  test("带参数时只回用法提示，不抽取", async () => {
    await submitHImage(context("more"));
    expect(pickRandomImage).not.toHaveBeenCalled();
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.usage, replyToMessageId: 10 });
  });

  // 子命令词不区分大小写，口径同 `/copy`、`/qa`、`/icon`、`/translate`、`/mood`。
  test.each(["ADD", "Add"])("/h_image %s 走收图分支而不是用法提示", async (argument: string) => {
    await submitHImage(context(argument));
    expect(pickRandomImage).not.toHaveBeenCalled();
    expect(sendCommandMessage).not.toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.usage, replyToMessageId: 10 });
  });

  test("handler 接纳后立即返回，抽取与上传在执行器里完成；结果图片带话题并回复触发消息", async () => {
    const pending: PromiseWithResolvers<RandomImagePick> = Promise.withResolvers<RandomImagePick>();
    pickRandomImage.mockImplementation((): Promise<RandomImagePick> => pending.promise);

    await submitHImage(context("", 7));
    expect(sendPhotoWithResult).not.toHaveBeenCalled();
    expect(pickRandomImage).toHaveBeenCalledWith(getRandomHImageDirectory());

    pending.resolve({ status: "ok", bytes: new Uint8Array([4, 5]), mimeType: "image/webp", fileName: "b.webp" });
    expect(await drainHImageRuntime(1_000)).toBe("flushed");
    // 长期保留的结果图片：唯一边界 sendHImageResult，固定剧透遮罩，不挂固定延迟删除。
    expect(sendPhotoWithResult).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      bytes: new Uint8Array([4, 5]),
      mimeType: "image/webp",
      replyToMessageId: 10,
      messageThreadId: 7,
      hasSpoiler: true,
    });
    expect(sendCommandMessage).not.toHaveBeenCalled();
    // 发送成功后写一条没有图注的 AI 记忆占位自录。
    expect(recordBotImage).toHaveBeenCalledWith({ chatId: CHAT_ID, messageId: 9, caption: "", edited: false });
  });

  test("抽取失败按结果回 30 秒提示", async () => {
    const outcomes: readonly [RandomImagePick, string][] = [
      [{ status: "missingDirectory" }, texts.missingDirectory],
      [{ status: "empty" }, texts.empty],
      [{ status: "tooLarge", fileName: "huge.jpg" }, texts.tooLarge("huge.jpg")],
    ];
    for (const [pick, text] of outcomes) {
      sendCommandMessage.mockClear();
      pickRandomImage.mockImplementation(async (): Promise<RandomImagePick> => pick);
      await submitHImage(context());
      expect(await drainHImageRuntime(1_000)).toBe("flushed");
      initHImageRuntime();
      expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text, replyToMessageId: 10 });
    }
    expect(sendPhotoWithResult).not.toHaveBeenCalled();
  });

  test("在途与等待位都占满后，新请求直接回「稍后再试」", async () => {
    const pending: PromiseWithResolvers<RandomImagePick> = Promise.withResolvers<RandomImagePick>();
    pickRandomImage.mockImplementation((): Promise<RandomImagePick> => pending.promise);
    for (let index: number = 0; index < H_IMAGE_MAX_CONCURRENT + H_IMAGE_MAX_PENDING; index++) {
      await submitHImage(context());
    }
    expect(sendCommandMessage).not.toHaveBeenCalled();

    await submitHImage(context());
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.busy, replyToMessageId: 10 });

    pending.resolve({ status: "empty" });
    expect(await drainHImageRuntime(5_000)).toBe("flushed");
  });

  test("停止接纳后新请求回忙碌；零预算排空取消在途请求并报 timedOut", async () => {
    const pending: PromiseWithResolvers<RandomImagePick> = Promise.withResolvers<RandomImagePick>();
    pickRandomImage.mockImplementation((): Promise<RandomImagePick> => pending.promise);
    await submitHImage(context());

    quiesceHImageRuntime();
    await submitHImage(context());
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.busy, replyToMessageId: 10 });

    expect(await drainHImageRuntime(0)).toBe("timedOut");
    expect(hImageRuntime.current!.controller.signal.aborted).toBe(true);
    pending.resolve({ status: "empty" });
  });
});

describe("/h_image 的全局限流", () => {
  test(`每 ${H_IMAGE_RATE_LIMIT_WINDOW_MS} 毫秒最多受理 ${H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW} 次，超额的不解析参数也不回消息`, async () => {
    for (let index: number = 0; index < H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW; index++) {
      await handleHImageCommand(context("more"));
    }
    expect(sendCommandMessage).toHaveBeenCalledTimes(H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW);

    sendCommandMessage.mockClear();
    await handleHImageCommand(context("more"));
    await handleHImageCommand(context());
    expect(sendCommandMessage).not.toHaveBeenCalled();
    expect(pickRandomImage).not.toHaveBeenCalled();
  });

  test("窗口滑过之后重新放行，被拒的那几次不占后续配额", () => {
    const start: number = 1_000_000;
    for (let index: number = 0; index < H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW; index++) {
      expect(tryConsumeHImageRateLimit(start)).toBe(true);
    }
    expect(tryConsumeHImageRateLimit(start)).toBe(false);
    // 窗口是 (now - windowMs, now]，落在窗口末端的那 5 次还占着名额。
    expect(tryConsumeHImageRateLimit(start + H_IMAGE_RATE_LIMIT_WINDOW_MS - 1)).toBe(false);
    for (let index: number = 0; index < H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW; index++) {
      expect(tryConsumeHImageRateLimit(start + H_IMAGE_RATE_LIMIT_WINDOW_MS)).toBe(true);
    }
  });
});
