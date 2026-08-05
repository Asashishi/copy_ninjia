import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiTextResult } from "../../../packages/types/aiChat/provider";

const getUrl = mock((): string => "https://download.invalid/photos/file.jpg");
const getFile = mock(async (..._args: unknown[]) => ({ file_path: "photos/file.jpg", getUrl }));
const describeVision = mock(async (..._args: unknown[]): Promise<AiTextResult> => ({
  ok: true,
  text: "一只挥手的猫",
}));
const prepareVisionImage = mock(async (..._args: unknown[]) => ({ bytes: Buffer.from([1, 2, 3]), mime: "image/png" as const }));
const readBoundedResponseBytes = mock(async (..._args: unknown[]) => ({ ok: true as const, bytes: new Uint8Array([1, 2, 3]) }));
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/infra/telegram", () => ({
  bot: { api: { getFile } },
}));
mock.module("../../../packages/aiChat/provider", () => ({
  chatAiProvider: () => ({ name: "test", describeVision }),
}));
mock.module("../../../packages/libs/image", () => ({ prepareVisionImage }));
mock.module("../../../packages/libs/boundedResponse", () => ({ readBoundedResponseBytes }));
mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
}));

const { describeMedia, describeMediaForStickerCatalog } = await import("../../../packages/aiChat/ai/imageDescription");
const { transientDescriptionCache } = await import("../../../packages/cache/workers/aiChat/imageDescription");
const { MEDIA_MAX_DOWNLOAD_BYTES } = await import("../../../packages/consts/aiChat/media");
const originalFetch: typeof fetch = globalThis.fetch;
const fetchMock = mock(async (..._args: unknown[]): Promise<Response> => new Response("image"));

beforeEach(() => {
  transientDescriptionCache.clear();
  for (const mocked of [
    getFile,
    getUrl,
    describeVision,
    prepareVisionImage,
    readBoundedResponseBytes,
    loggerError,
    fetchMock,
  ]) mocked.mockClear();
  getFile.mockImplementation(async () => ({ file_path: "photos/file.jpg", getUrl }));
  getUrl.mockImplementation((): string => "https://download.invalid/photos/file.jpg");
  describeVision.mockImplementation(async (): Promise<AiTextResult> => ({
    ok: true,
    text: "一只挥手的猫",
  }));
  prepareVisionImage.mockImplementation(async () => ({ bytes: Buffer.from([1, 2, 3]), mime: "image/png" as const }));
  readBoundedResponseBytes.mockImplementation(async () => ({ ok: true as const, bytes: new Uint8Array([1, 2, 3]) }));
  fetchMock.mockImplementation(async (): Promise<Response> => new Response("image"));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  transientDescriptionCache.clear();
  globalThis.fetch = originalFetch;
});

describe("Telegram 媒体下载与视觉描述适配层", () => {
  test("成功描述写入按 file_unique_id 合并的 Promise 缓存", async () => {
    const first: Promise<string | null> = describeMedia("sticker", "file-a", "unique-a");
    const second: Promise<string | null> = describeMedia("sticker", "file-b", "unique-a");

    expect(second).toBe(first);
    await expect(first).resolves.toBe("一只挥手的猫");
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://download.invalid/photos/file.jpg", {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(describeVision).toHaveBeenCalledTimes(1);
    const request = describeVision.mock.calls[0]![0] as { prompt: string; image: { mime: string } };
    expect(request.image.mime).toBe("image/png");
    expect(request.prompt).toContain("贴纸");
    expect(transientDescriptionCache.has("unique-a")).toBe(true);
  });

  test("失败结果不负缓存，同一媒体下次重发会重新尝试", async () => {
    describeVision.mockResolvedValueOnce({ ok: false, retryable: false });
    await expect(describeMedia("photo", "file", "retryable")).resolves.toBeNull();
    expect(transientDescriptionCache.has("retryable")).toBe(false);

    await expect(describeMedia("photo", "file", "retryable")).resolves.toBe("一只挥手的猫");
    expect(getFile).toHaveBeenCalledTimes(2);
  });

  test("Telegram 缺 file_path、HTTP 非 2xx 和下载超限均在进入视觉 API 前停止", async () => {
    getFile.mockResolvedValueOnce({} as never);
    await expect(describeMedia("photo", "missing", "u1")).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(describeMedia("photo", "http", "u2")).resolves.toBeNull();

    readBoundedResponseBytes.mockResolvedValueOnce({
      ok: false as const,
      observedBytes: MEDIA_MAX_DOWNLOAD_BYTES + 1,
      reason: "limit" as const,
    } as never);
    await expect(describeMedia("photo", "large", "u3")).resolves.toBeNull();

    expect(prepareVisionImage).not.toHaveBeenCalled();
    expect(describeVision).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledTimes(3);
  });

  test("Telegram 下载重定向失败时不读取响应、不转码也不请求视觉模型", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch() encountered a redirect"));

    await expect(describeMedia("photo", "redirect", "redirect-u")).resolves.toBeNull();

    expect(readBoundedResponseBytes).not.toHaveBeenCalled();
    expect(prepareVisionImage).not.toHaveBeenCalled();
    expect(describeVision).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith("Error loading chat media (kind=photo):", expect.any(TypeError));
  });

  test("不支持的图片、转码后超限和空模型正文均安全降级", async () => {
    prepareVisionImage.mockResolvedValueOnce(null as never);
    await expect(describeMedia("animation", "bad-image", "u4")).resolves.toBeNull();

    prepareVisionImage.mockResolvedValueOnce({
      bytes: Buffer.alloc(MEDIA_MAX_DOWNLOAD_BYTES + 1),
      mime: "image/png" as const,
    });
    await expect(describeMedia("photo", "expanded", "u5")).resolves.toBeNull();

    describeVision.mockResolvedValueOnce({ ok: false, retryable: true });
    await expect(describeMedia("photo", "blank", "u6")).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(2);
  });

  test("Telegram/下载异常不抛出，贴纸目录描述绕过临时缓存", async () => {
    getFile.mockRejectedValueOnce(new Error("getFile failed"));
    await expect(describeMedia("photo", "throw", "u7")).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Error loading chat media (kind=photo):", expect.any(Error));

    await expect(describeMediaForStickerCatalog("catalog-file")).resolves.toEqual({ ok: true, text: "一只挥手的猫" });
    await expect(describeMediaForStickerCatalog("catalog-file")).resolves.toEqual({ ok: true, text: "一只挥手的猫" });
    expect(getFile).toHaveBeenCalledTimes(3);
    expect(transientDescriptionCache.size).toBe(0);
  });
});
