import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiTextResult } from "../../../packages/types/aiChat/provider";
import type { TelegramWorkerDownloadFileResult } from "../../../packages/types/telegramWorker";

const downloadTelegramFileFromMain = mock(async (..._args: unknown[]): Promise<TelegramWorkerDownloadFileResult> => ({
  status: "ok" as const,
  bytes: new Uint8Array([1, 2, 3]),
}));
const describeVision = mock(async (..._args: unknown[]): Promise<AiTextResult> => ({
  ok: true,
  text: "一只挥手的猫",
}));
const prepareVisionImage = mock(async (..._args: unknown[]) => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" as const }));
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/infra/telegram/workerClient", () => ({
  downloadTelegramFileFromMain,
}));
mock.module("../../../packages/aiChat/provider", () => ({
  mediaAiProvider: () => ({ name: "google", describeVision }),
}));
mock.module("../../../packages/infra/image", () => ({ prepareVisionImage }));
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
const {
  mediaInputProbeCache,
  mediaInputSupportCache,
} = await import("../../../packages/cache/workers/aiChat/mediaInputSupport");
const { MEDIA_MAX_DOWNLOAD_BYTES } = await import("../../../packages/consts/aiChat/media");
beforeEach(() => {
  transientDescriptionCache.clear();
  mediaInputProbeCache.current = null;
  mediaInputSupportCache.current = null;
  for (const mocked of [
    downloadTelegramFileFromMain,
    describeVision,
    prepareVisionImage,
    loggerError,
  ]) mocked.mockClear();
  downloadTelegramFileFromMain.mockImplementation(async (): Promise<TelegramWorkerDownloadFileResult> => ({
    status: "ok" as const,
    bytes: new Uint8Array([1, 2, 3]),
  }));
  describeVision.mockImplementation(async (): Promise<AiTextResult> => ({
    ok: true,
    text: "一只挥手的猫",
  }));
  prepareVisionImage.mockImplementation(async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" as const }));
});

afterEach(() => {
  transientDescriptionCache.clear();
  mediaInputProbeCache.current = null;
  mediaInputSupportCache.current = null;
});

describe("Telegram 媒体下载与视觉描述适配层", () => {
  test("成功描述写入按 file_unique_id 合并的 Promise 缓存", async () => {
    const first: Promise<string | null> = describeMedia({ kind: "sticker", fileId: "file-a", fileUniqueId: "unique-a", voiceMime: undefined, voiceDurationSeconds: 0 });
    const second: Promise<string | null> = describeMedia({ kind: "sticker", fileId: "file-b", fileUniqueId: "unique-a", voiceMime: undefined, voiceDurationSeconds: 0 });

    expect(second).toBe(first);
    await expect(first).resolves.toBe("一只挥手的猫");
    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(1);
    expect(downloadTelegramFileFromMain).toHaveBeenCalledWith({
      fileId: "file-a",
      purpose: "vision",
      signal: expect.any(AbortSignal),
    });
    expect(describeVision).toHaveBeenCalledTimes(1);
    const request = describeVision.mock.calls[0]![0] as { prompt: string; image: { mime: string } };
    expect(request.image.mime).toBe("image/png");
    expect(request.prompt).toContain("贴纸");
    expect(transientDescriptionCache.has("unique-a")).toBe(true);
  });

  test("同一媒体的一个消费者取消不会中止仍有消费者使用的共享请求", async () => {
    const firstController: AbortController = new AbortController();
    const secondController: AbortController = new AbortController();
    const resultControl: { resolve: ((result: AiTextResult) => void) | null } = {
      resolve: null,
    };
    let markStarted: (() => void) | null = null;
    const started: Promise<void> = new Promise<void>((resolve: () => void): void => {
      markStarted = resolve;
    });
    const requestSignal: { current: AbortSignal | null } = { current: null };
    describeVision.mockImplementationOnce((...args: unknown[]): Promise<AiTextResult> => {
      const request: { signal?: AbortSignal } = args[0] as { signal?: AbortSignal };
      requestSignal.current = request.signal ?? null;
      markStarted?.();
      return new Promise<AiTextResult>((
        resolve: (result: AiTextResult) => void
      ): void => {
        resultControl.resolve = resolve;
      });
    });

    const first: Promise<string | null> = describeMedia({
      kind: "photo",
      fileId: "shared-a",
      fileUniqueId: "shared-unique",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
      signal: firstController.signal,
    });
    const second: Promise<string | null> = describeMedia({
      kind: "photo",
      fileId: "shared-b",
      fileUniqueId: "shared-unique",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
      signal: secondController.signal,
    });

    await started;
    firstController.abort();
    await expect(first).resolves.toBeNull();
    expect(requestSignal.current?.aborted).toBeFalse();
    resultControl.resolve?.({ ok: true, text: "共享描述" });
    await expect(second).resolves.toBe("共享描述");
    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(1);
  });

  test("最后一个消费者取消：中止共享请求，并摘除注定为 null 的缓存条目", async () => {
    // 支持度预置为已确认，避开首次探测那条路，把用例聚焦在引用计数与缓存摘除上。
    mediaInputSupportCache.current = {
      vision: { support: "supported", transientFailures: 0, nextProbeAt: 0 },
      voice: { support: "unknown", transientFailures: 0, nextProbeAt: 0 },
    };
    const controller: AbortController = new AbortController();
    const requestSignal: { current: AbortSignal | null } = { current: null };
    let markStarted: (() => void) | null = null;
    const started: Promise<void> = new Promise<void>((resolve: () => void): void => {
      markStarted = resolve;
    });
    describeVision.mockImplementationOnce((...args: unknown[]): Promise<AiTextResult> => {
      const request: { signal?: AbortSignal } = args[0] as { signal?: AbortSignal };
      requestSignal.current = request.signal ?? null;
      markStarted?.();
      return new Promise<AiTextResult>((): void => {});
    });

    const only: Promise<string | null> = describeMedia({
      kind: "photo",
      fileId: "lone-a",
      fileUniqueId: "lone-unique",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
      signal: controller.signal,
    });
    await started;
    expect(transientDescriptionCache.has("lone-unique")).toBe(true);

    controller.abort();
    await expect(only).resolves.toBeNull();
    // 引用计数归零才中止底层请求——这正是计数机制存在的理由。
    expect(requestSignal.current?.aborted).toBeTrue();
    // 中止的同时摘掉条目：底层请求要到回卷完才把 pending 结算成 null，这段窗口里
    // 另一个聊天带着存活的 signal 进来会命中它、挂到一个已中止的任务上，从此永远
    // 拿到与自身取消无关的 null。
    expect(transientDescriptionCache.has("lone-unique")).toBe(false);

    const laterController: AbortController = new AbortController();
    await expect(describeMedia({
      kind: "photo",
      fileId: "lone-b",
      fileUniqueId: "lone-unique",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
      signal: laterController.signal,
    })).resolves.toBe("一只挥手的猫");
    expect(describeVision).toHaveBeenCalledTimes(2);
  });

  test("成功返回之后才取消：这次观测仍要记成模态可用", async () => {
    // 模态尚无结论，这次调用同时是首次探测。
    expect(mediaInputSupportCache.current).toBeNull();
    const controller: AbortController = new AbortController();
    describeVision.mockImplementationOnce(async (): Promise<AiTextResult> => {
      // 供应商已经给出结论，之后调用方那一轮回复才失效。
      controller.abort();
      return { ok: true, text: "迟到但成功" };
    });

    await expect(describeMedia({
      kind: "photo",
      fileId: "late-ok",
      fileUniqueId: "late-ok-unique",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
      signal: controller.signal,
    })).resolves.toBeNull();

    // 文本可以丢，观测不能丢：连结论一起丢掉会让 support 永远停在 unknown，之后
    // 每份媒体都退回「只放行一个探测」的串行路径，频繁失效的聊天永远学不会端点。
    expect(mediaInputSupportCache.current?.vision.support).toBe("supported");
    expect(mediaInputSupportCache.current?.vision.nextProbeAt).toBe(0);
  });

  test("失败结果不负缓存，同一媒体下次重发会重新尝试", async () => {
    describeVision.mockResolvedValueOnce({ ok: false, retryable: false });
    await expect(describeMedia({ kind: "photo", fileId: "file", fileUniqueId: "retryable", voiceMime: undefined, voiceDurationSeconds: 0 })).resolves.toBeNull();
    expect(transientDescriptionCache.has("retryable")).toBe(false);

    await expect(describeMedia({ kind: "photo", fileId: "file", fileUniqueId: "retryable", voiceMime: undefined, voiceDurationSeconds: 0 })).resolves.toBe("一只挥手的猫");
    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(2);
  });

  test("首次请求确认视觉输入不受支持后，本进程不再下载或请求后续图片", async () => {
    describeVision.mockResolvedValueOnce({ ok: false, retryable: false, mediaFailure: "unsupported" });
    await expect(describeMedia({
      kind: "photo",
      fileId: "probe-file",
      fileUniqueId: "probe-unique",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    })).resolves.toBeNull();
    expect(mediaInputSupportCache.current?.vision.support).toBe("unsupported");

    const skipped: Promise<string | null> = describeMedia({
      kind: "sticker",
      fileId: "skipped-file",
      fileUniqueId: "skipped-unique",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    });
    const skippedAgain: Promise<string | null> = describeMedia({
      kind: "photo",
      fileId: "another-skipped-file",
      fileUniqueId: "another-skipped-unique",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    });
    expect(skippedAgain).toBe(skipped);
    await expect(skipped).resolves.toBeNull();
    // 复述已有结论，不带 mediaFailure：这不是一次新的真实调用。
    await expect(describeMediaForStickerCatalog("catalog-skipped")).resolves.toEqual({
      ok: false,
      retryable: false,
    });
    expect(transientDescriptionCache.has("skipped-unique")).toBe(false);
    expect(transientDescriptionCache.has("another-skipped-unique")).toBe(false);
    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(1);
    expect(describeVision).toHaveBeenCalledTimes(1);
  });

  test("并发冷启动只放行一个视觉探测，成功后等待者才进入各自请求", async () => {
    const probeControl: { resolve: ((result: AiTextResult) => void) | null } = { resolve: null };
    let markProbeStarted: (() => void) | null = null;
    const probeStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      markProbeStarted = resolve;
    });
    describeVision.mockImplementationOnce((): Promise<AiTextResult> =>
      new Promise<AiTextResult>((resolve: (result: AiTextResult) => void): void => {
        probeControl.resolve = resolve;
        markProbeStarted?.();
      })
    );

    const first: Promise<string | null> = describeMedia({
      kind: "photo",
      fileId: "probe-a",
      fileUniqueId: "probe-unique-a",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    });
    await probeStarted;
    const second: Promise<string | null> = describeMedia({
      kind: "photo",
      fileId: "probe-b",
      fileUniqueId: "probe-unique-b",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    });
    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(1);
    expect(describeVision).toHaveBeenCalledTimes(1);

    probeControl.resolve?.({ ok: true, text: "首个探测成功" });
    await expect(first).resolves.toBe("首个探测成功");
    await expect(second).resolves.toBe("一只挥手的猫");
    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(2);
    expect(describeVision).toHaveBeenCalledTimes(2);
    expect(mediaInputProbeCache.current?.vision).toBeNull();
  });

  test("并发冷启动探测明确不支持时，等待者不下载自己的媒体", async () => {
    const probeControl: { resolve: ((result: AiTextResult) => void) | null } = { resolve: null };
    let markProbeStarted: (() => void) | null = null;
    const probeStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      markProbeStarted = resolve;
    });
    describeVision.mockImplementationOnce((): Promise<AiTextResult> =>
      new Promise<AiTextResult>((resolve: (result: AiTextResult) => void): void => {
        probeControl.resolve = resolve;
        markProbeStarted?.();
      })
    );

    const first: Promise<string | null> = describeMedia({
      kind: "photo",
      fileId: "unsupported-a",
      fileUniqueId: "unsupported-unique-a",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    });
    await probeStarted;
    const second: Promise<string | null> = describeMedia({
      kind: "photo",
      fileId: "unsupported-b",
      fileUniqueId: "unsupported-unique-b",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    });
    probeControl.resolve?.({ ok: false, retryable: false, mediaFailure: "unsupported" });

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(1);
    expect(describeVision).toHaveBeenCalledTimes(1);
    expect(mediaInputSupportCache.current?.vision.support).toBe("unsupported");
  });

  test("端点 404/405 记成配置错误：停止后续请求，并只记一次可定位的诊断", async () => {
    describeVision.mockResolvedValueOnce({ ok: false, retryable: false, mediaFailure: "misconfigured" });
    await expect(describeMedia({
      kind: "photo",
      fileId: "misconfigured-file",
      fileUniqueId: "misconfigured-unique",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    })).resolves.toBeNull();
    expect(mediaInputSupportCache.current?.vision.support).toBe("misconfigured");
    // 诊断要指向 config/agent.json 的 media 段，而不是含糊地说模型没这项能力。
    const diagnostics: string[] = loggerError.mock.calls.map((call: unknown[]): string => String(call[0]));
    expect(diagnostics.filter((line: string): boolean => line.includes("$.agent.media"))).toHaveLength(1);

    await expect(describeMedia({
      kind: "photo",
      fileId: "after-misconfigured",
      fileUniqueId: "after-misconfigured-unique",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    })).resolves.toBeNull();
    // 不再下载、不再请求，也不再刷第二条诊断。
    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(1);
    expect(describeVision).toHaveBeenCalledTimes(1);
    expect(diagnostics.filter((line: string): boolean => line.includes("$.agent.media"))).toHaveLength(1);
  });

  test("瞬时失败按次数指数退避：退避期内不下载，到期后重新探测且成功即清零", async () => {
    describeVision.mockResolvedValueOnce({ ok: false, retryable: false, mediaFailure: "transient" });
    await expect(describeMedia({
      kind: "photo",
      fileId: "transient-a",
      fileUniqueId: "transient-unique-a",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    })).resolves.toBeNull();
    const afterFirst = mediaInputSupportCache.current!.vision;
    // 瞬时故障不构成能力结论：结论仍是未知，只是压上了退避。
    expect(afterFirst.support).toBe("unknown");
    expect(afterFirst.transientFailures).toBe(1);
    expect(afterFirst.nextProbeAt).toBeGreaterThan(Date.now());

    await expect(describeMedia({
      kind: "photo",
      fileId: "transient-b",
      fileUniqueId: "transient-unique-b",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    })).resolves.toBeNull();
    // 退避期内既不下载也不请求，更不留下注定为 null 的缓存条目。
    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(1);
    expect(describeVision).toHaveBeenCalledTimes(1);
    expect(transientDescriptionCache.has("transient-unique-b")).toBe(false);

    // 第二次瞬时失败的退避必须比第一次长（指数增长）。
    mediaInputSupportCache.current = { vision: { ...afterFirst, nextProbeAt: 0 }, voice: afterFirst };
    describeVision.mockResolvedValueOnce({ ok: false, retryable: false, mediaFailure: "transient" });
    await describeMedia({ kind: "photo", fileId: "transient-c", fileUniqueId: "transient-unique-c", voiceMime: undefined, voiceDurationSeconds: 0 });
    const afterSecond = mediaInputSupportCache.current!.vision;
    expect(afterSecond.transientFailures).toBe(2);
    expect(afterSecond.nextProbeAt - Date.now()).toBeGreaterThan(afterFirst.nextProbeAt - Date.now());

    // 退避到期后重新探测；一次成功即清空计数与退避。
    mediaInputSupportCache.current = { vision: { ...afterSecond, nextProbeAt: 0 }, voice: afterSecond };
    await expect(describeMedia({ kind: "photo", fileId: "recovered", fileUniqueId: "recovered-unique", voiceMime: undefined, voiceDurationSeconds: 0 }))
      .resolves.toBe("一只挥手的猫");
    expect(mediaInputSupportCache.current?.vision).toEqual({
      support: "supported",
      transientFailures: 0,
      nextProbeAt: 0,
    });
  });

  test("墙钟回拨让退避落到过远的未来时立即放行，不把模态锁死", async () => {
    mediaInputSupportCache.current = {
      vision: {
        support: "unknown",
        transientFailures: 1,
        // 任何一档退避都不可能排到一天之后：只可能是系统时钟往回拨了。
        nextProbeAt: Date.now() + 24 * 60 * 60_000,
      },
      voice: { support: "unknown", transientFailures: 0, nextProbeAt: 0 },
    };

    await expect(describeMedia({
      kind: "photo",
      fileId: "rollback",
      fileUniqueId: "rollback-unique",
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    })).resolves.toBe("一只挥手的猫");
    expect(describeVision).toHaveBeenCalledTimes(1);
  });

  test("单份坏媒体不推进退避，也不改变模态结论", async () => {
    // 下载失败与「HTTP 成功但正文为空」都是这一份自己的问题：不带 mediaFailure。
    downloadTelegramFileFromMain.mockRejectedValueOnce(new Error("getFile failed"));
    await expect(describeMedia({ kind: "photo", fileId: "bad-a", fileUniqueId: "bad-unique-a", voiceMime: undefined, voiceDurationSeconds: 0 })).resolves.toBeNull();
    describeVision.mockResolvedValueOnce({ ok: false, retryable: true });
    await expect(describeMedia({ kind: "photo", fileId: "bad-b", fileUniqueId: "bad-unique-b", voiceMime: undefined, voiceDurationSeconds: 0 })).resolves.toBeNull();

    expect(mediaInputSupportCache.current?.vision).toEqual({
      support: "unknown",
      transientFailures: 0,
      nextProbeAt: 0,
    });
    // 没有退避，下一份媒体照常下载并请求。
    await expect(describeMedia({ kind: "photo", fileId: "good", fileUniqueId: "good-unique", voiceMime: undefined, voiceDurationSeconds: 0 }))
      .resolves.toBe("一只挥手的猫");
  });

  test("Telegram 缺 file_path、HTTP 非 2xx 和下载超限均在进入视觉 API 前停止", async () => {
    downloadTelegramFileFromMain.mockResolvedValueOnce({ status: "missingPath" });
    await expect(describeMedia({ kind: "photo", fileId: "missing", fileUniqueId: "u1", voiceMime: undefined, voiceDurationSeconds: 0 })).resolves.toBeNull();

    downloadTelegramFileFromMain.mockResolvedValueOnce({ status: "httpError", httpStatus: 404 });
    await expect(describeMedia({ kind: "photo", fileId: "http", fileUniqueId: "u2", voiceMime: undefined, voiceDurationSeconds: 0 })).resolves.toBeNull();

    downloadTelegramFileFromMain.mockResolvedValueOnce({
      status: "tooLarge",
      observedBytes: MEDIA_MAX_DOWNLOAD_BYTES + 1,
    });
    await expect(describeMedia({ kind: "photo", fileId: "large", fileUniqueId: "u3", voiceMime: undefined, voiceDurationSeconds: 0 })).resolves.toBeNull();

    expect(prepareVisionImage).not.toHaveBeenCalled();
    expect(describeVision).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledTimes(3);
  });

  test("Telegram 下载重定向失败时不读取响应、不转码也不请求视觉模型", async () => {
    downloadTelegramFileFromMain.mockRejectedValueOnce(new TypeError("fetch() encountered a redirect"));

    await expect(describeMedia({ kind: "photo", fileId: "redirect", fileUniqueId: "redirect-u", voiceMime: undefined, voiceDurationSeconds: 0 })).resolves.toBeNull();

    expect(prepareVisionImage).not.toHaveBeenCalled();
    expect(describeVision).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith("Error loading chat media (kind=photo):", expect.any(TypeError));
  });

  test("不支持的图片、转码后超限和空模型正文均安全降级", async () => {
    prepareVisionImage.mockResolvedValueOnce(null as never);
    await expect(describeMedia({ kind: "animation", fileId: "bad-image", fileUniqueId: "u4", voiceMime: undefined, voiceDurationSeconds: 0 })).resolves.toBeNull();

    prepareVisionImage.mockResolvedValueOnce({
      bytes: new Uint8Array(MEDIA_MAX_DOWNLOAD_BYTES + 1),
      mime: "image/png" as const,
    });
    await expect(describeMedia({ kind: "photo", fileId: "expanded", fileUniqueId: "u5", voiceMime: undefined, voiceDurationSeconds: 0 })).resolves.toBeNull();

    describeVision.mockResolvedValueOnce({ ok: false, retryable: true });
    await expect(describeMedia({ kind: "photo", fileId: "blank", fileUniqueId: "u6", voiceMime: undefined, voiceDurationSeconds: 0 })).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(2);
  });

  test("Telegram/下载异常不抛出，贴纸目录描述绕过临时缓存", async () => {
    downloadTelegramFileFromMain.mockRejectedValueOnce(new Error("getFile failed"));
    await expect(describeMedia({ kind: "photo", fileId: "throw", fileUniqueId: "u7", voiceMime: undefined, voiceDurationSeconds: 0 })).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Error loading chat media (kind=photo):", expect.any(Error));

    await expect(describeMediaForStickerCatalog("catalog-file")).resolves.toEqual({ ok: true, text: "一只挥手的猫" });
    await expect(describeMediaForStickerCatalog("catalog-file")).resolves.toEqual({ ok: true, text: "一只挥手的猫" });
    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(3);
    expect(transientDescriptionCache.size).toBe(0);
  });

  test("语音走转写那条实现，绝不进视觉转码与视觉 API", async () => {
    // 这里的桩供应商只实现了 describeVision（等价于切到 OpenAI 的部署），因此
    // 转写不可用、结果为 null；要断言的是**路由**：语音一次都不碰 sharp 转码和
    // 视觉接口，而不是它这次能不能识别出来。
    await expect(describeMedia({
      kind: "voice",
      fileId: "voice-file",
      fileUniqueId: "voice-unique",
      voiceMime: "audio/ogg",
      voiceDurationSeconds: 9,
    })).resolves.toBeNull();

    expect(prepareVisionImage).not.toHaveBeenCalled();
    expect(describeVision).not.toHaveBeenCalled();
    // 能力缺席时连下载都不该发生：先问能不能转写，再决定要不要拉字节。
    expect(downloadTelegramFileFromMain).not.toHaveBeenCalled();
    // 失败不负缓存，同一条语音下次重发会重新尝试（与视觉那条同一口径）。
    expect(transientDescriptionCache.has("voice-unique")).toBe(false);
  });

  test("语音与视觉共用同一份 file_unique_id 去重缓存与执行器", async () => {
    const first: Promise<string | null> = describeMedia({
      kind: "voice",
      fileId: "voice-a",
      fileUniqueId: "shared-unique",
      voiceMime: "audio/ogg",
      voiceDurationSeconds: 9,
    });
    const second: Promise<string | null> = describeMedia({
      kind: "voice",
      fileId: "voice-b",
      fileUniqueId: "shared-unique",
      voiceMime: "audio/ogg",
      voiceDurationSeconds: 9,
    });

    // 同一份媒体只解析一次：两次调用拿到的是同一个 pending，而不是两条并行的
    // 下载 + 模型请求（键空间不冲突，file_unique_id 本就是 Telegram 全局唯一）。
    expect(second).toBe(first);
    await first;
  });
});
