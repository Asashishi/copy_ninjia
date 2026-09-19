import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import type { Message } from "grammy/types";
import type { TelegramFileDownloadResult } from "../../packages/types/telegram";

const sendCommandMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const downloads: Map<string, TelegramFileDownloadResult | Error> = new Map<string, TelegramFileDownloadResult | Error>();
/** 置为 true 时下载一直挂起，直到调用方的信号被取消。 */
let hangDownloads: boolean = false;
const downloadTelegramFileBytes = mock(async ({ fileId, signal }: { fileId: string; signal: AbortSignal }): Promise<TelegramFileDownloadResult> => {
  if (hangDownloads) {
    await new Promise<never>((_resolve: unknown, reject: (reason: unknown) => void): void => {
      signal.addEventListener("abort", (): void => reject(signal.reason), { once: true });
    });
  }
  const result: TelegramFileDownloadResult | Error | undefined = downloads.get(fileId);
  if (result instanceof Error) throw result;
  return result ?? { status: "httpError", httpStatus: 404 };
});
let permitted: boolean = true;
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../packages/infra/telegram", () => ({ sendCommandMessage, sendPhotoWithResult: async (): Promise<undefined> => undefined }));
mock.module("../../packages/infra/telegram/fileDownload", () => ({ downloadTelegramFileBytes }));
mock.module("../../packages/commands/commandActor", () => ({
  hasCommandPermission: (): boolean => permitted,
  resolveCommandActor: (): { id: number; first_name: string } => ({ id: 5, first_name: "Alice" }),
}));
mock.module("../../packages/consts/hImage", () => ({
  MEDIA_GROUP_CACHE_MAX: 256,
  MEDIA_GROUP_ITEMS_MAX: 10,
  H_IMAGE_ADD_TASK_BUDGET_MS: 200,
  H_IMAGE_ADD_METADATA_TIMEOUT_MS: 10_000,
  H_IMAGE_ADD_DOWNLOAD_TIMEOUT_MS: 25_000,
  H_IMAGE_ADD_ARGUMENT: "add",
}));
const { loggerStub } = await import("../helpers/loggerMock");
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));

const { handleHImageCommand } = await import("../../packages/commands/hImage");
const { drainDeferredCommandRuntime, initDeferredCommandRuntime } = await import("../../packages/commands/deferredCommands");
const { deferredCommandRuntime } = await import("../../packages/cache/main/deferredCommands");
const { mediaGroupImages } = await import("../../packages/cache/main/mediaGroups");
const { chatAtmosphere } = await import("../../packages/infra/atmosphere");
const { getRandomImageDirectory } = await import("../../packages/infra/storage/stateStore");

const CHAT_ID: number = -1001;
const JPEG: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);
const PNG: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);
const texts = chatAtmosphere(CHAT_ID).H_IMAGE_TEXTS;
const directory: string = getRandomImageDirectory();

function photo(uniqueId: string, fields: Record<string, unknown> = {}): Message {
  return {
    message_id: 9,
    date: 1,
    chat: { id: CHAT_ID, type: "supergroup" },
    photo: [{ file_id: `file-${uniqueId}`, file_unique_id: uniqueId, width: 1, height: 1 }],
    ...fields,
  } as unknown as Message;
}

function context(replyTo: Message | undefined): never {
  return {
    chat: { id: CHAT_ID, type: "supergroup" },
    msgId: 10,
    msg: { message_id: 10, chat: { id: CHAT_ID, type: "supergroup" }, reply_to_message: replyTo },
    match: "add",
  } as never;
}

async function runAdd(replyTo: Message | undefined): Promise<void> {
  await handleHImageCommand(context(replyTo));
  expect(await drainDeferredCommandRuntime(5_000)).toBe("flushed");
}

beforeEach(() => {
  sendCommandMessage.mockClear();
  downloadTelegramFileBytes.mockClear();
  loggerError.mockClear();
  downloads.clear();
  hangDownloads = false;
  permitted = true;
  for (const key of [...mediaGroupImages.keys()]) mediaGroupImages.delete(key);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  deferredCommandRuntime.current = null;
  initDeferredCommandRuntime();
});

afterEach(async () => {
  await drainDeferredCommandRuntime(0);
  rmSync(directory, { recursive: true, force: true });
});

describe("/h_image add", () => {
  test("没有 isCanAddHImage 时拒绝，不下载", async () => {
    permitted = false;
    await runAdd(photo("a"));
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.addRejected("Alice"), replyToMessageId: 10 });
    expect(downloadTelegramFileBytes).not.toHaveBeenCalled();
  });

  test("没有回复或回复的消息里没有图时只回提示", async () => {
    await runAdd(undefined);
    expect(sendCommandMessage).toHaveBeenLastCalledWith({ chatId: CHAT_ID, text: texts.addUsage, replyToMessageId: 10 });
    await runAdd({ ...photo("a"), photo: undefined, text: "hi" } as unknown as Message);
    expect(sendCommandMessage).toHaveBeenLastCalledWith({ chatId: CHAT_ID, text: texts.addNoImage, replyToMessageId: 10 });
    expect(downloadTelegramFileBytes).not.toHaveBeenCalled();
  });

  test("收齐被回复的图与同一相册的其余几张；图库已有的跳过，按格式命名写入", async () => {
    mediaGroupImages.set("album", {
      chatId: CHAT_ID,
      items: [
        { fileId: "file-a", fileUniqueId: "a", fileSize: 10 },
        { fileId: "file-b", fileUniqueId: "b", fileSize: 10 },
        { fileId: "file-c", fileUniqueId: "c", fileSize: 10 },
      ],
    });
    await Bun.write(`${directory}/c.webp`, "existing");
    downloads.set("file-a", { status: "ok", bytes: JPEG });
    downloads.set("file-b", { status: "ok", bytes: PNG });

    await runAdd(photo("a", { media_group_id: "album" }));
    expect(downloadTelegramFileBytes.mock.calls.map((call: [{ fileId: string }]): string => call[0].fileId)).toEqual(["file-a", "file-b"]);
    expect(readdirSync(directory).sort()).toEqual(["a.jpg", "b.png", "c.webp"]);
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: texts.addResult({ added: 2, librarySize: 1, existing: 1, failed: 0 }), replyToMessageId: 10,
    });
  });

  test("汇总里「本来就有」是收图前图库的张数，与本次跳过的重复张数分开写", async () => {
    for (const name of ["old1.jpg", "old2.png", "old3.webp", "old4.jpg", "old5.jpg", "old6.png", "old7.jpg", "notes.txt", ".h_image-add-x.jpg"]) {
      await Bun.write(`${directory}/${name}`, "x");
    }
    downloads.set("file-a", { status: "ok", bytes: JPEG });

    await runAdd(photo("a"));
    expect(readdirSync(directory)).toContain("a.jpg");
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: "收好啦：新收 1 张，图库里本来就有 7 张，杂鱼♡", replyToMessageId: 10,
    });
    expect(texts.addResult({ added: 2, librarySize: 8, existing: 1, failed: 1 })).toBe(
      "收好啦：新收 2 张，图库里本来就有 8 张，有 1 张早就在图库里了，没再收，还有 1 张没收成（超过 10 MB、格式不对或下载失败），杂鱼♡"
    );
  });

  test("超限不下载；格式不对、下载失败与抛错都计为失败", async () => {
    mediaGroupImages.set("album", {
      chatId: CHAT_ID,
      items: [
        { fileId: "file-big", fileUniqueId: "big", fileSize: 11 * 1024 * 1024 },
        { fileId: "file-gif", fileUniqueId: "gif", fileSize: 10 },
        { fileId: "file-404", fileUniqueId: "missing", fileSize: 10 },
        { fileId: "file-err", fileUniqueId: "err", fileSize: 10 },
      ],
    });
    downloads.set("file-gif", { status: "ok", bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) });
    downloads.set("file-err", new Error("ECONNRESET"));

    await runAdd(photo("big", { media_group_id: "album", photo: undefined, text: "caption only" }));
    expect(downloadTelegramFileBytes.mock.calls.map((call: [{ fileId: string }]): string => call[0].fileId))
      .toEqual(["file-gif", "file-404", "file-err"]);
    expect(readdirSync(directory)).toEqual([]);
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: texts.addResult({ added: 0, librarySize: 0, existing: 0, failed: 4 }), replyToMessageId: 10,
    });
    expect(loggerError).toHaveBeenCalledTimes(2);
  });

  test("图库目录不在时回目录缺失提示", async () => {
    rmSync(directory, { recursive: true, force: true });
    await runAdd(photo("a"));
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.missingDirectory, replyToMessageId: 10 });
    expect(downloadTelegramFileBytes).not.toHaveBeenCalled();
  });

  test("总预算耗尽后剩下的图记为失败，照常回汇总", async () => {
    hangDownloads = true;
    mediaGroupImages.set("album", {
      chatId: CHAT_ID,
      items: [{ fileId: "file-a", fileUniqueId: "a", fileSize: 1 }, { fileId: "file-b", fileUniqueId: "b", fileSize: 1 }],
    });
    await runAdd(photo("a", { media_group_id: "album" }));
    expect(downloadTelegramFileBytes).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: texts.addResult({ added: 0, librarySize: 0, existing: 0, failed: 2 }), replyToMessageId: 10,
    });
  });

  test("停机取消时静默收场，不回汇总", async () => {
    hangDownloads = true;
    await handleHImageCommand(context(photo("a")));
    expect(await drainDeferredCommandRuntime(0)).toBe("timedOut");
    await Bun.sleep(10);
    expect(sendCommandMessage).not.toHaveBeenCalled();
  });

  test("执行器停止接纳时回「稍后再试」", async () => {
    deferredCommandRuntime.current!.accepting = false;
    await handleHImageCommand(context(photo("a")));
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.busy, replyToMessageId: 10 });
  });
});
