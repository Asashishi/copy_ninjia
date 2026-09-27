import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import type { SharedResult } from "../../../packages/libs/sharedResult";
import type { AiTextResult } from "../../../packages/types/aiChat/provider";
import {
  MEDIA_DESCRIPTION_MAX_CONCURRENCY,
  MEDIA_DESCRIPTION_MAX_PENDING,
  MEDIA_DESCRIPTION_CACHE_MAX,
} from "../../../packages/consts/aiChat/media";

const releases: Set<() => void> = new Set<() => void>();
let immediate: boolean = false;
const describeVision: Mock<(request: { readonly signal?: AbortSignal }) => Promise<AiTextResult>> = mock((request: { readonly signal?: AbortSignal }): Promise<AiTextResult> =>
  new Promise<AiTextResult>((resolve: (value: AiTextResult) => void): void => {
    function finish(): void {
      releases.delete(finish);
      request.signal?.removeEventListener("abort", finish);
      resolve(request.signal?.aborted === true ? { ok: false, retryable: false } : { ok: true, text: "描述" });
    }
    if (immediate || request.signal?.aborted === true) finish();
    else {
      releases.add(finish);
      request.signal?.addEventListener("abort", finish, { once: true });
    }
  })
);
mock.module("../../../packages/aiChat/provider", () => ({ mediaAiProvider: () => ({ describeVision }) }));
mock.module("../../../packages/aiChat/ai/voiceTranscription", () => ({ transcribeVoiceUncached: describeVision }));
mock.module("../../../packages/aiChat/ai/telegramImage", () => ({
  downloadTelegramVisionImage: async () => ({ bytes: new Uint8Array([1]), mime: "image/png" }),
}));
const { describeMedia, describeMediaForStickerCatalog } = await import("../../../packages/aiChat/ai/imageDescription");
const { transientDescriptionCache: cache, transientDescriptionTasks } = await import("../../../packages/cache/workers/aiChat/imageDescription");
const { mediaTaskRunner } = await import("../../../packages/cache/workers/aiChat/mediaTasks");
const { resetMediaInputSupport, getMediaInputState, recordMediaInputResult, getMediaInputProbe } =
  await import("../../../packages/cache/workers/aiChat/mediaInputSupport");

function request(key: string, signal?: AbortSignal): Promise<string | null> {
  return describeMedia({ kind: "photo", fileId: key, fileUniqueId: key, voiceMime: undefined, voiceDurationSeconds: 0, signal });
}

async function flush(): Promise<void> {
  for (let index: number = 0; index < 80; index++) await Promise.resolve();
}

beforeEach((): void => {
  immediate = false;
  cache.clear();
  resetMediaInputSupport();
  describeVision.mockClear();
});

afterEach(async (): Promise<void> => {
  immediate = true;
  for (const release of releases) release();
  for (let turn: number = 0; turn < 100 && mediaTaskRunner.activeCount !== 0; turn++) await flush();
  expect(mediaTaskRunner.activeCount).toBe(0);
  expect(mediaTaskRunner.pendingCount).toBe(0);
});

test("冷探测等待有界，取消释放等待位，目录入口使用同一额度", async (): Promise<void> => {
  void request("probe");
  const controllers: AbortController[] = [];
  for (let index: number = 0; index < MEDIA_DESCRIPTION_MAX_PENDING; index++) {
    const controller: AbortController = new AbortController();
    controllers.push(controller);
    void request(`cold-${index}`, controller.signal);
  }
  await flush();
  expect(describeVision).toHaveBeenCalledTimes(1);
  let overflowSettled: boolean = false;
  let overflowResult: string | null | undefined;
  void request("overflow").then((value: string | null): void => {
    overflowResult = value;
    overflowSettled = true;
  });
  await flush();
  expect(overflowSettled).toBeTrue();
  expect(overflowResult).toBeNull();
  expect(cache.has("overflow")).toBeFalse();
  await expect(describeMediaForStickerCatalog("catalog-overflow")).resolves.toEqual({ ok: false, retryable: true });
  controllers[0]!.abort();
  await flush();
  void request("replacement");
  expect(cache.has("replacement")).toBeTrue();
});

test("视觉与语音只各执行一个探测，共享等待额度", async (): Promise<void> => {
  void request("vision-probe");
  void describeMedia({ kind: "voice", fileId: "voice-probe", fileUniqueId: "voice-probe", voiceMime: "audio/ogg", voiceDurationSeconds: 1 });
  for (let index: number = 0; index < MEDIA_DESCRIPTION_MAX_PENDING; index++) void request(`vision-${index}`);
  await flush();
  expect(describeVision).toHaveBeenCalledTimes(2);
  expect(await describeMedia({ kind: "voice", fileId: "voice-overflow", fileUniqueId: "voice-overflow", voiceMime: "audio/ogg", voiceDurationSeconds: 1 })).toBeNull();
  expect(getMediaInputProbe("vision")?.waiterCount).toBe(MEDIA_DESCRIPTION_MAX_PENDING);
  expect(getMediaInputProbe("voice")?.waiterCount).toBe(0);
});

test("冷等待与直接执行器入口共用等待上限，释放探测后全部接纳任务可完成", async (): Promise<void> => {
  const probe: Promise<string | null> = request("probe");
  const coldCount: number = Math.floor(MEDIA_DESCRIPTION_MAX_PENDING / 2);
  for (let index: number = 0; index < coldCount; index++) void request(`cold-${index}`);
  for (let index: number = 0; index < MEDIA_DESCRIPTION_MAX_CONCURRENCY - 1 + MEDIA_DESCRIPTION_MAX_PENDING - coldCount; index++) {
    void mediaTaskRunner.run("interactive", (): Promise<AiTextResult> => describeVision({}));
  }
  await flush();
  expect(mediaTaskRunner.activeCount).toBe(MEDIA_DESCRIPTION_MAX_CONCURRENCY);
  expect(mediaTaskRunner.pendingCount + (getMediaInputProbe("vision")?.waiterCount ?? 0)).toBe(MEDIA_DESCRIPTION_MAX_PENDING);
  expect(await request("cold-overflow")).toBeNull();
  expect(await mediaTaskRunner.run("interactive", (): Promise<AiTextResult> => describeVision({}))).toBeUndefined();
  immediate = true;
  for (const release of releases) release();
  expect(await probe).toBe("描述");
  await flush();
  expect(describeVision).toHaveBeenCalledTimes(MEDIA_DESCRIPTION_MAX_CONCURRENCY + MEDIA_DESCRIPTION_MAX_PENDING);
});

test("反复取消冷等待与同键消费者不累积订阅", async (): Promise<void> => {
  const pending: Promise<string | null> = request("probe");
  await flush();
  const task: SharedResult<string | null> = transientDescriptionTasks.get(pending)!;
  const probe: SharedResult<AiTextResult> = getMediaInputProbe("vision")!;
  for (let index: number = 0; index < 1_000; index++) {
    const consumer: AbortController = new AbortController();
    const same: Promise<string | null> = request("probe", consumer.signal);
    const cold: Promise<string | null> = request(`cancel-${index}`, consumer.signal);
    consumer.abort();
    expect(await same).toBeNull();
    expect(await cold).toBeNull();
    expect(task.waiterCount).toBe(0);
    expect(probe.waiterCount).toBe(0);
  }
  expect(cache.size).toBe(1);
  expect(describeVision).toHaveBeenCalledTimes(1);
});

test("LRU 淘汰后的旧任务取消不得摘除同键新任务", async (): Promise<void> => {
  recordMediaInputResult({ capability: "vision", result: { ok: true, text: "ready" }, attemptState: getMediaInputState("vision") });
  const first: AbortController = new AbortController();
  const old: Promise<string | null> = request("same", first.signal);
  const cached: Promise<string | null> = Promise.resolve("cached");
  for (let index: number = 0; index < MEDIA_DESCRIPTION_CACHE_MAX; index++) cache.set(`cached-${index}`, cached);
  expect(cache.has("same")).toBeFalse();
  const next: Promise<string | null> = request("same");
  await flush();
  first.abort();
  expect(await old).toBeNull();
  expect(cache.peek("same")).toBe(next);
  immediate = true;
  for (const release of releases) release();
  expect(await next).toBe("描述");
  expect(cache.peek("same")).toBe(next);
});

test("满额时完成和在途 LRU 命中只读取一次且不另占额度", async (): Promise<void> => {
  recordMediaInputResult({ capability: "vision", result: { ok: true, text: "ready" }, attemptState: getMediaInputState("vision") });
  cache.set("cached", Promise.resolve("cached"));
  const shared: Promise<string | null> = request("shared");
  for (let index: number = 1; index < MEDIA_DESCRIPTION_MAX_CONCURRENCY + MEDIA_DESCRIPTION_MAX_PENDING; index++) {
    void request(`busy-${index}`);
  }
  await flush();
  const gets: ReturnType<typeof spyOn<typeof cache, "get">> = spyOn(cache, "get");
  const run: ReturnType<typeof spyOn<typeof mediaTaskRunner, "run">> = spyOn(mediaTaskRunner, "run");
  try {
    expect(await request("cached")).toBe("cached");
    expect(request("shared")).toBe(shared);
    expect(gets).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(mediaTaskRunner.activeCount).toBe(MEDIA_DESCRIPTION_MAX_CONCURRENCY);
    expect(mediaTaskRunner.pendingCount).toBe(MEDIA_DESCRIPTION_MAX_PENDING);
    const completed: Promise<string | null> = Promise.resolve("cached");
    for (let index: number = 0; index < MEDIA_DESCRIPTION_CACHE_MAX; index++) cache.set(`completed-${index}`, completed);
    const rejected: Promise<string | null> = request("overflow");
    expect(cache.has("completed-0")).toBeTrue();
    expect(cache.has("overflow")).toBeFalse();
    expect(await rejected).toBeNull();
  } finally {
    gets.mockRestore();
    run.mockRestore();
  }
});
