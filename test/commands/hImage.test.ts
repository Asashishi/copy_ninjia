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
mock.module("../../packages/infra/randomImage", () => ({ pickRandomImage }));

const { handleHImageCommand } = await import("../../packages/commands/hImage");
const {
  drainDeferredCommandRuntime: drainHImageRuntime,
  initDeferredCommandRuntime: initHImageRuntime,
  quiesceDeferredCommandRuntime: quiesceHImageRuntime,
} = await import("../../packages/commands/deferredCommands");
const { deferredCommandRuntime: hImageRuntime } = await import("../../packages/cache/main/deferredCommands");
const { chatAtmosphere } = await import("../../packages/infra/atmosphere");
const { getRandomImageDirectory } = await import("../../packages/infra/storage/stateStore");
const {
  DEFERRED_COMMAND_MAX_CONCURRENT: H_IMAGE_MAX_CONCURRENT,
  DEFERRED_COMMAND_MAX_PENDING: H_IMAGE_MAX_PENDING,
} = await import("../../packages/consts/deferredCommands");

const CHAT_ID: number = -1001;

function context(match: string = "", topic: number | undefined = undefined): never {
  return {
    chat: { id: CHAT_ID, type: "supergroup" },
    msgId: 10,
    msg: {
      message_id: 10,
      ...(topic === undefined ? {} : { is_topic_message: true, message_thread_id: topic }),
    },
    match,
  } as never;
}

/** 可以从外部结算的一次抽取。 */
function deferredPick(): { promise: Promise<RandomImagePick>; resolve: (pick: RandomImagePick) => void } {
  let resolve!: (pick: RandomImagePick) => void;
  const promise: Promise<RandomImagePick> = new Promise<RandomImagePick>((settle: (pick: RandomImagePick) => void): void => {
    resolve = settle;
  });
  return { promise, resolve };
}

const texts = chatAtmosphere(CHAT_ID).H_IMAGE_TEXTS;

beforeEach(() => {
  for (const mocked of [sendCommandMessage, sendPhotoWithResult, pickRandomImage]) mocked.mockClear();
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
    await handleHImageCommand(context("more"));
    expect(pickRandomImage).not.toHaveBeenCalled();
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.usage, replyToMessageId: 10 });
  });

  test("handler 接纳后立即返回，抽取与上传在执行器里完成；结果图片带话题并回复触发消息", async () => {
    const pending = deferredPick();
    pickRandomImage.mockImplementation((): Promise<RandomImagePick> => pending.promise);

    await handleHImageCommand(context("", 7));
    expect(sendPhotoWithResult).not.toHaveBeenCalled();
    expect(pickRandomImage).toHaveBeenCalledWith(getRandomImageDirectory());

    pending.resolve({ status: "ok", bytes: new Uint8Array([4, 5]), mimeType: "image/webp", fileName: "b.webp" });
    expect(await drainHImageRuntime(1_000)).toBe("flushed");
    // 长期保留的结果图片：唯一边界 sendHImageResult，不挂固定延迟删除。
    expect(sendPhotoWithResult).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      bytes: new Uint8Array([4, 5]),
      mimeType: "image/webp",
      replyToMessageId: 10,
      messageThreadId: 7,
    });
    expect(sendCommandMessage).not.toHaveBeenCalled();
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
      await handleHImageCommand(context());
      expect(await drainHImageRuntime(1_000)).toBe("flushed");
      initHImageRuntime();
      expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text, replyToMessageId: 10 });
    }
    expect(sendPhotoWithResult).not.toHaveBeenCalled();
  });

  test("在途与等待位都占满后，新请求直接回「稍后再试」", async () => {
    const pending = deferredPick();
    pickRandomImage.mockImplementation((): Promise<RandomImagePick> => pending.promise);
    for (let index: number = 0; index < H_IMAGE_MAX_CONCURRENT + H_IMAGE_MAX_PENDING; index++) {
      await handleHImageCommand(context());
    }
    expect(sendCommandMessage).not.toHaveBeenCalled();

    await handleHImageCommand(context());
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.busy, replyToMessageId: 10 });

    pending.resolve({ status: "empty" });
    expect(await drainHImageRuntime(5_000)).toBe("flushed");
  });

  test("停止接纳后新请求回忙碌；零预算排空取消在途请求并报 timedOut", async () => {
    const pending = deferredPick();
    pickRandomImage.mockImplementation((): Promise<RandomImagePick> => pending.promise);
    await handleHImageCommand(context());

    quiesceHImageRuntime();
    await handleHImageCommand(context());
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.busy, replyToMessageId: 10 });

    expect(await drainHImageRuntime(0)).toBe("timedOut");
    expect(hImageRuntime.current!.controller.signal.aborted).toBe(true);
    pending.resolve({ status: "empty" });
  });
});
