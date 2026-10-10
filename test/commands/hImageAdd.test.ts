import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import type { Message } from "grammy/types";
import type { TelegramFileDownloadResult } from "../../packages/types/telegram";
import { imageFixture } from "../helpers/image";
import { waitUntil } from "../helpers/waitUntil";

const sendCommandMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const downloads: Map<string, TelegramFileDownloadResult | Error> = new Map<string, TelegramFileDownloadResult | Error>();
/** 置为 true 时下载一直挂起，直到调用方的信号被取消。 */
let hangDownloads: boolean = false;
/** 列在这里的 fileId 下载等对应的 Promise 兑现才返回；调用方的信号被取消时照常抛出。 */
const downloadGates: Map<string, Promise<void>> = new Map<string, Promise<void>>();
const downloadTelegramFileBytes = mock(async ({ fileId, signal }: { fileId: string; signal: AbortSignal }): Promise<TelegramFileDownloadResult> => {
  const gate: Promise<void> | undefined = downloadGates.get(fileId);
  if (hangDownloads || gate !== undefined) {
    await new Promise<void>((resolve: () => void, reject: (reason: unknown) => void): void => {
      signal.addEventListener("abort", (): void => reject(signal.reason), { once: true });
      if (!hangDownloads) void gate!.then(resolve);
    });
  }
  const result: TelegramFileDownloadResult | Error | undefined = downloads.get(fileId);
  if (result instanceof Error) throw result;
  return result ?? { status: "httpError", httpStatus: 404 };
});
let permitted: boolean = true;
/** 测试把每页张数压到 2：三四张的相册就会跨页。 */
const DOWNLOAD_BATCH_SIZE: number = 2;
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../packages/infra/telegram", () => ({ sendCommandMessage, sendPhotoWithResult: async (): Promise<undefined> => undefined }));
mock.module("../../packages/infra/telegram/fileDownload", () => ({ downloadTelegramFileBytes }));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  hasWhitelistPermission: (id: number, key: string): boolean => id === 5 && key === "isCanAddHImage" && permitted,
}));
mock.module("../../packages/consts/hImage", () => ({
  MEDIA_GROUP_CACHE_MAX: 256,
  MEDIA_GROUP_ITEMS_MAX: 10,
  H_IMAGE_ADD_TASK_BUDGET_MS: 200,
  H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE: DOWNLOAD_BATCH_SIZE,
  H_IMAGE_ADD_METADATA_TIMEOUT_MS: 10_000,
  H_IMAGE_ADD_DOWNLOAD_TIMEOUT_MS: 25_000,
  H_IMAGE_ADD_ARGUMENT: "add",
  H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW: 5,
  H_IMAGE_RATE_LIMIT_WINDOW_MS: 1_000,
}));
const { loggerStub } = await import("../helpers/loggerMock");
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));

const { handleHImageCommand } = await import("../../packages/commands/hImage");
const { drainDeferredCommandRuntime, initDeferredCommandRuntime } = await import("../../packages/commands/deferredCommands");
const { deferredCommandRuntime } = await import("../../packages/cache/main/deferredCommands");
const { mediaGroupImages } = await import("../../packages/cache/main/mediaGroups");
const { recentHImageCallTimestamps } = await import("../../packages/cache/main/hImage");
const { chatAtmosphere } = await import("../../packages/infra/atmosphere");
const { getAssetConfig } = await import("../../packages/config/assets");

const CHAT_ID: number = -1001;
// 真实可解码的字节：收图路径要读一次宽高（infra/image.ts 的 readImageDimensions），手写魔数头过不了解码。
const JPEG: Uint8Array = await new Bun.Image(imageFixture(4, 4)).jpeg().bytes();
const PNG: Uint8Array = await new Bun.Image(imageFixture(4, 4)).png().bytes();
const WEBP: Uint8Array = await new Bun.Image(imageFixture(4, 4)).webp().bytes();
/** 宽高之和超过 TELEGRAM_PHOTO_MAX_DIMENSION_SUM：字节数只有几十 KB，字节闸放行，sendPhoto 会拒。 */
const OVERSIZED: Uint8Array = await new Bun.Image(imageFixture(12_000, 40)).png().bytes();
/** 宽高之和合规，长宽比超过 TELEGRAM_PHOTO_MAX_ASPECT_RATIO。 */
const SKEWED: Uint8Array = await new Bun.Image(imageFixture(2_100, 100)).png().bytes();
/** 临界值：长宽比恰好等于 TELEGRAM_PHOTO_MAX_ASPECT_RATIO（宽高之和也在门槛内），应照收。
 *  两条门槛的逐像素边界另在 test/libs/telegramImage.test.ts 直接验证纯判定。 */
const AT_LIMIT: Uint8Array = await new Bun.Image(imageFixture(2_000, 100)).png().bytes();
const texts = chatAtmosphere().H_IMAGE_TEXTS;
const directory: string = getAssetConfig().randomHImageDirectory;
/** 收图写下的文件名：内容 SHA-256 加保存扩展名。 */
const CONTENT_NAME: RegExp = /^[0-9a-f]{64}\.(?:jpg|png|webp)$/;

/** 图库里由收图写下的那些文件。 */
function collectedNames(): string[] {
  return readdirSync(directory).filter((name: string): boolean => CONTENT_NAME.test(name)).sort();
}

/** 本次调用依次请求下载的 fileId。 */
function downloadedFileIds(): string[] {
  return downloadTelegramFileBytes.mock.calls.map((call: [{ fileId: string }]): string => call[0].fileId);
}

/** 某份内容在图库里的文件名；名字即内容摘要，收图与预置共用这一个算法。 */
function storedName(bytes: Uint8Array, extension: string): string {
  return `${Bun.SHA256.hash(bytes, "hex")}${extension}`;
}

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
    from: { id: 5, is_bot: false, first_name: "Alice" },
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
  recentHImageCallTimestamps.clear();
  sendCommandMessage.mockClear();
  downloadTelegramFileBytes.mockClear();
  loggerError.mockClear();
  downloads.clear();
  downloadGates.clear();
  hangDownloads = false;
  permitted = true;
  mediaGroupImages.clear();
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

  test("收齐被回复的图与同一相册的其余几张；内容已在图库里的报已有，按内容摘要命名写入", async () => {
    mediaGroupImages.set("album", {
      chatId: CHAT_ID,
      items: [
        { fileId: "file-a", fileUniqueId: "a", fileSize: 10 },
        { fileId: "file-b", fileUniqueId: "b", fileSize: 10 },
        { fileId: "file-c", fileUniqueId: "c", fileSize: 10 },
      ],
    });
    // 预置的是 WEBP 这份内容本身：去重靠重算哈希，与 file_unique_id 无关。
    await Bun.write(`${directory}/${storedName(WEBP, ".webp")}`, WEBP);
    downloads.set("file-a", { status: "ok", bytes: JPEG });
    downloads.set("file-b", { status: "ok", bytes: PNG });
    downloads.set("file-c", { status: "ok", bytes: WEBP });

    await runAdd(photo("a", { media_group_id: "album" }));
    // 去重排在下载之后：算内容摘要需要字节，三张都会下载。
    expect(downloadedFileIds()).toEqual(["file-a", "file-b", "file-c"]);
    expect(collectedNames()).toEqual([storedName(JPEG, ".jpg"), storedName(PNG, ".png"), storedName(WEBP, ".webp")].sort());
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: texts.addResult({ added: 2, librarySize: 1, existing: 1, invalidDimensions: 0, failed: 0 }), replyToMessageId: 10,
    });
  });

  test("同一张图换个 file_unique_id 转发进来，照样判成已有", async () => {
    mediaGroupImages.set("album", {
      chatId: CHAT_ID,
      items: [
        { fileId: "file-a", fileUniqueId: "a", fileSize: 10 },
        { fileId: "file-a2", fileUniqueId: "a2", fileSize: 10 },
      ],
    });
    downloads.set("file-a", { status: "ok", bytes: JPEG });
    downloads.set("file-a2", { status: "ok", bytes: JPEG });

    await runAdd(photo("a", { media_group_id: "album" }));
    expect(collectedNames()).toEqual([storedName(JPEG, ".jpg")]);
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: texts.addResult({ added: 1, librarySize: 0, existing: 1, invalidDimensions: 0, failed: 0 }), replyToMessageId: 10,
    });
  });

  test("汇总里「本来就有」是收图前图库的张数，与本次跳过的重复张数分开写", async () => {
    for (const name of ["old1.jpg", "old2.png", "old3.webp", "old4.jpg", "old5.jpg", "old6.png", "old7.jpg", "notes.txt", ".h_image-add-x.jpg"]) {
      await Bun.write(`${directory}/${name}`, "x");
    }
    downloads.set("file-a", { status: "ok", bytes: JPEG });

    await runAdd(photo("a"));
    expect(collectedNames()).toEqual([storedName(JPEG, ".jpg")]);
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: "收好啦：新收 1 张，图库里本来就有 7 张，杂鱼♡", replyToMessageId: 10,
    });
    expect(texts.addResult({ added: 2, librarySize: 8, existing: 1, invalidDimensions: 0, failed: 1 })).toBe(
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
    expect(downloadedFileIds()).toEqual(["file-gif", "file-404", "file-err"]);
    expect(readdirSync(directory)).toEqual([]);
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: texts.addResult({ added: 0, librarySize: 0, existing: 0, invalidDimensions: 0, failed: 4 }), replyToMessageId: 10,
    });
    expect(loggerError).toHaveBeenCalledTimes(2);
  });

  test("单张的两段下载超时计为失败并各记一条日志，超限与空文件只计失败", async () => {
    mediaGroupImages.set("album", {
      chatId: CHAT_ID,
      items: [
        { fileId: "file-meta", fileUniqueId: "meta", fileSize: 10 },
        { fileId: "file-slow", fileUniqueId: "slow", fileSize: 10 },
        { fileId: "file-large", fileUniqueId: "large", fileSize: 10 },
        { fileId: "file-empty", fileUniqueId: "empty", fileSize: 10 },
      ],
    });
    downloads.set("file-meta", { status: "metadataTimeout" });
    downloads.set("file-slow", { status: "downloadTimeout" });
    downloads.set("file-large", { status: "tooLarge", observedBytes: 11 });
    downloads.set("file-empty", { status: "empty" });

    await runAdd(photo("meta", { media_group_id: "album" }));
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: texts.addResult({ added: 0, librarySize: 0, existing: 0, invalidDimensions: 0, failed: 4 }), replyToMessageId: 10,
    });
    expect(loggerError.mock.calls.map((call: unknown[]): string => String(call[0]))).toEqual([
      "Failed to download a picture for /h_image add (metadataTimeout).",
      "Failed to download a picture for /h_image add (downloadTimeout).",
    ]);
  });

  test("写盘失败记错误日志并计为失败，同页其余照常写盘", async () => {
    mediaGroupImages.set("album", {
      chatId: CHAT_ID,
      items: [{ fileId: "file-a", fileUniqueId: "a", fileSize: 10 }, { fileId: "file-b", fileUniqueId: "b", fileSize: 10 }],
    });
    // 目标文件名被一个非空目录占着：判存在只认文件，改名覆盖不了非空目录。
    mkdirSync(`${directory}/${storedName(JPEG, ".jpg")}/occupied`, { recursive: true });
    downloads.set("file-a", { status: "ok", bytes: JPEG });
    downloads.set("file-b", { status: "ok", bytes: PNG });

    await runAdd(photo("a", { media_group_id: "album" }));
    expect(readdirSync(directory).sort()).toEqual([storedName(JPEG, ".jpg"), storedName(PNG, ".png")].sort());
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: texts.addResult({ added: 1, librarySize: 0, existing: 0, invalidDimensions: 0, failed: 1 }), replyToMessageId: 10,
    });
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  test("宽高之和超过 10000 或长宽比超过 20 的图不收，回执单独报这一档", async () => {
    // 这两张都过得了字节闸与格式闸，但尺寸不合规：回执单独报尺寸这一档，不收。
    mediaGroupImages.set("album", {
      chatId: CHAT_ID,
      items: [
        { fileId: "file-wide", fileUniqueId: "wide", fileSize: 10 },
        { fileId: "file-skewed", fileUniqueId: "skewed", fileSize: 10 },
        { fileId: "file-ok", fileUniqueId: "ok", fileSize: 10 },
      ],
    });
    downloads.set("file-wide", { status: "ok", bytes: OVERSIZED });
    downloads.set("file-skewed", { status: "ok", bytes: SKEWED });
    downloads.set("file-ok", { status: "ok", bytes: PNG });

    await runAdd(photo("wide", { media_group_id: "album" }));
    expect(collectedNames()).toEqual([storedName(PNG, ".png")]);
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      text: texts.addResult({ added: 1, librarySize: 0, existing: 0, invalidDimensions: 2, failed: 0 }),
      replyToMessageId: 10,
    });
    // 尺寸不合规与「超过字节上限、格式不对或下载失败」分属两档，回执说清是哪一条。
    expect(texts.addResult({ added: 1, librarySize: 0, existing: 0, invalidDimensions: 2, failed: 0 }))
      .not.toBe(texts.addResult({ added: 1, librarySize: 0, existing: 0, invalidDimensions: 0, failed: 2 }));
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("临界值照收：长宽比恰好 20 仍在门槛之内", async () => {
    downloads.set("file-a", { status: "ok", bytes: AT_LIMIT });

    await runAdd(photo("a"));
    expect(collectedNames()).toEqual([storedName(AT_LIMIT, ".png")]);
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      text: texts.addResult({ added: 1, librarySize: 0, existing: 0, invalidDimensions: 0, failed: 0 }),
      replyToMessageId: 10,
    });
  });

  test("图库目录不在时回目录缺失提示", async () => {
    rmSync(directory, { recursive: true, force: true });
    await runAdd(photo("a"));
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.missingDirectory, replyToMessageId: 10 });
    expect(downloadTelegramFileBytes).not.toHaveBeenCalled();
  });

  test("一页内的图同时下载，整页结算并写盘后才开始下一页", async () => {
    mediaGroupImages.set("album", {
      chatId: CHAT_ID,
      items: [
        { fileId: "file-a", fileUniqueId: "a", fileSize: 10 },
        { fileId: "file-b", fileUniqueId: "b", fileSize: 10 },
        { fileId: "file-c", fileUniqueId: "c", fileSize: 10 },
      ],
    });
    downloads.set("file-a", { status: "ok", bytes: JPEG });
    downloads.set("file-b", { status: "ok", bytes: PNG });
    downloads.set("file-c", { status: "ok", bytes: WEBP });
    const gateA: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const gateB: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    downloadGates.set("file-a", gateA.promise);
    downloadGates.set("file-b", gateB.promise);

    await handleHImageCommand(context(photo("a", { media_group_id: "album" })));
    expect(await waitUntil((): boolean => downloadTelegramFileBytes.mock.calls.length === DOWNLOAD_BATCH_SIZE)).toBe(true);
    expect(downloadedFileIds()).toEqual(["file-a", "file-b"]);
    gateA.resolve();
    await Bun.sleep(20);
    // 同页的 b 还没结算：a 不写盘，下一页也不开始，内存里至多一页的图。
    expect(downloadedFileIds()).toEqual(["file-a", "file-b"]);
    expect(collectedNames()).toEqual([]);
    gateB.resolve();
    expect(await drainDeferredCommandRuntime(5_000)).toBe("flushed");
    expect(downloadedFileIds()).toEqual(["file-a", "file-b", "file-c"]);
    expect(collectedNames()).toEqual([storedName(JPEG, ".jpg"), storedName(PNG, ".png"), storedName(WEBP, ".webp")].sort());
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: texts.addResult({ added: 3, librarySize: 0, existing: 0, invalidDimensions: 0, failed: 0 }), replyToMessageId: 10,
    });
  });

  test("总预算耗尽：同页已下载的照常写盘，未结算的与剩下几页记为失败，不记错误日志", async () => {
    mediaGroupImages.set("album", {
      chatId: CHAT_ID,
      items: [
        { fileId: "file-a", fileUniqueId: "a", fileSize: 1 },
        { fileId: "file-b", fileUniqueId: "b", fileSize: 1 },
        { fileId: "file-c", fileUniqueId: "c", fileSize: 1 },
      ],
    });
    downloads.set("file-a", { status: "ok", bytes: JPEG });
    downloadGates.set("file-b", new Promise<void>((): void => {}));
    await runAdd(photo("a", { media_group_id: "album" }));
    expect(downloadedFileIds()).toEqual(["file-a", "file-b"]);
    expect(collectedNames()).toEqual([storedName(JPEG, ".jpg")]);
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: texts.addResult({ added: 1, librarySize: 0, existing: 0, invalidDimensions: 0, failed: 2 }), replyToMessageId: 10,
    });
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("停机取消时静默收场，不回汇总，图库里不留临时文件", async () => {
    hangDownloads = true;
    await handleHImageCommand(context(photo("a")));
    expect(await drainDeferredCommandRuntime(0)).toBe("timedOut");
    await Bun.sleep(10);
    expect(sendCommandMessage).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual([]);
  });

  test("停机取消时这一页已下载的图也不写盘", async () => {
    mediaGroupImages.set("album", {
      chatId: CHAT_ID,
      items: [{ fileId: "file-a", fileUniqueId: "a", fileSize: 1 }, { fileId: "file-b", fileUniqueId: "b", fileSize: 1 }],
    });
    downloads.set("file-a", { status: "ok", bytes: JPEG });
    downloadGates.set("file-b", new Promise<void>((): void => {}));
    await handleHImageCommand(context(photo("a", { media_group_id: "album" })));
    expect(await waitUntil((): boolean => downloadTelegramFileBytes.mock.calls.length === DOWNLOAD_BATCH_SIZE)).toBe(true);
    expect(await drainDeferredCommandRuntime(0)).toBe("timedOut");
    await Bun.sleep(10);
    expect(sendCommandMessage).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual([]);
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("执行器停止接纳时回「稍后再试」", async () => {
    deferredCommandRuntime.current!.accepting = false;
    await handleHImageCommand(context(photo("a")));
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.busy, replyToMessageId: 10 });
  });
});
