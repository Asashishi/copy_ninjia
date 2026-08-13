import { describe, expect, mock, test } from "bun:test";

const { getStickerSet } = await import("../../../../packages/aiChat/ai/stickers/sets");
const { failedPacks, inflightStickerSets, stickerSetCache } = await import("../../../../packages/cache/workers/aiChat/stickers/sets");
const { aiChatWorkerAbortController } = await import("../../../../packages/cache/workers/aiChat/worker");

describe("aiChat/ai/stickers/sets getStickerSet 失败恢复", () => {
  test("瞬时失败只在负缓存窗口内拦截，过期后同一进程会重新请求并恢复", async () => {
    const pack = "retryable_pack";
    const expected: any = { name: pack, title: "Retryable", sticker_type: "regular", stickers: [] };
    let calls = 0;
    const api = {
      getStickerSet: mock(async (): Promise<any> => {
        calls++;
        if (calls === 1) throw new Error("temporary network failure");
        return expected;
      }),
    };

    try {
      expect(await getStickerSet(pack, api)).toBeNull();
      expect(calls).toBe(1);
      expect(failedPacks.get(pack)).toBeGreaterThan(Date.now());

      // 负缓存仍有效时不重复轰 Telegram。
      expect(await getStickerSet(pack, api)).toBeNull();
      expect(calls).toBe(1);

      // 模拟窗口到期：无需重启进程即可重新请求并转为正缓存。
      failedPacks.set(pack, Date.now() - 1);
      expect(await getStickerSet(pack, api)).toBe(expected);
      expect(calls).toBe(2);
      expect(failedPacks.has(pack)).toBe(false);
      expect(stickerSetCache.get(pack)).toBe(expected);
    } finally {
      failedPacks.delete(pack);
      stickerSetCache.delete(pack);
    }
  });

  test("缓存未命中时并发调用合并成一次请求，settle 后不留在途登记", async () => {
    const pack = "coalesced_pack";
    const expected: any = { name: pack, title: "Coalesced", sticker_type: "regular", stickers: [] };
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const api = {
      getStickerSet: mock(async (): Promise<any> => {
        calls++;
        await gate;
        return expected;
      }),
    };

    try {
      const first = getStickerSet(pack, api);
      const second = getStickerSet(pack, api);
      expect(inflightStickerSets.has(pack)).toBe(true);
      release();
      expect(await first).toBe(expected);
      expect(await second).toBe(expected);
      expect(calls).toBe(1);
      expect(inflightStickerSets.has(pack)).toBe(false);
    } finally {
      failedPacks.delete(pack);
      stickerSetCache.delete(pack);
    }
  });

  test("注入的 api 同步抛出时不留下永不摘除的已 settle 在途条目", async () => {
    const pack = "sync_throw_pack";
    const expected: any = { name: pack, title: "Recovered", sticker_type: "regular", stickers: [] };
    let calls = 0;
    // 线程还没 installTelegramApi 时 currentTelegramApi() 就是内联抛：整段 IIFE
    // 在第一个 await 之前跑完，登记与摘除的先后顺序一旦反了，条目就永远留着。
    const api = {
      getStickerSet: mock((): Promise<any> => {
        calls++;
        if (calls === 1) throw new Error("Telegram API is not installed on this thread.");
        return Promise.resolve(expected);
      }),
    };

    try {
      expect(await getStickerSet(pack, api)).toBeNull();
      expect(inflightStickerSets.has(pack)).toBe(false);

      // 负缓存到期后必须能真正重试；留着那个 resolved-null 的话，这个包会在
      // Worker 余生里静默缺席，而且不再报第二次错。
      failedPacks.set(pack, Date.now() - 1);
      expect(await getStickerSet(pack, api)).toBe(expected);
      expect(calls).toBe(2);
      expect(inflightStickerSets.has(pack)).toBe(false);
    } finally {
      failedPacks.delete(pack);
      stickerSetCache.delete(pack);
      inflightStickerSets.delete(pack);
    }
  });

  test("Worker 停机取消 Telegram 请求不写失败负缓存", async () => {
    const pack: string = "cancelled_pack";
    const previousWorker: AbortController = aiChatWorkerAbortController.current;
    const controller: AbortController = new AbortController();
    aiChatWorkerAbortController.current = controller;
    const receivedSignal: { current: AbortSignal | null } = { current: null };
    const api = {
      getStickerSet: mock((_pack: string, signal?: AbortSignal): Promise<any> => {
        receivedSignal.current = signal ?? null;
        return new Promise<any>((
          _resolve: (value: any) => void,
          reject: (reason?: unknown) => void
        ): void => {
          signal?.addEventListener("abort", (): void => reject(signal.reason), { once: true });
        });
      }),
    };

    try {
      // 共享请求绑的是 Worker 信号，不是任一调用方的 signal。
      const request: Promise<any> = getStickerSet(pack, api);
      await Promise.resolve();
      expect(receivedSignal.current).toBe(controller.signal);
      controller.abort(new DOMException("worker stopped", "AbortError"));
      expect(await request).toBeNull();
      expect(failedPacks.has(pack)).toBeFalse();
      expect(inflightStickerSets.has(pack)).toBeFalse();
    } finally {
      aiChatWorkerAbortController.current = previousWorker;
      failedPacks.delete(pack);
      stickerSetCache.delete(pack);
      inflightStickerSets.delete(pack);
    }
  });

  test("API 忽略 Worker 停机并迟到成功时不回写正缓存", async () => {
    const pack: string = "cancelled_late_success_pack";
    const expected: any = {
      name: pack,
      title: "Cancelled late success",
      sticker_type: "regular",
      stickers: [],
    };
    const previousWorker: AbortController = aiChatWorkerAbortController.current;
    const controller: AbortController = new AbortController();
    aiChatWorkerAbortController.current = controller;
    let release!: (set: any) => void;
    const api = {
      getStickerSet: mock((): Promise<any> => new Promise<any>((
        resolve: (set: any) => void
      ): void => {
        release = resolve;
      })),
    };

    try {
      const waiting: Promise<any> = getStickerSet(pack, api);
      const underlying: Promise<any> = inflightStickerSets.get(pack)!;
      controller.abort(new DOMException("worker stopped", "AbortError"));

      release(expected);
      expect(await underlying).toBeNull();
      expect(await waiting).toBeNull();
      expect(stickerSetCache.has(pack)).toBeFalse();
      expect(failedPacks.has(pack)).toBeFalse();
      expect(inflightStickerSets.has(pack)).toBeFalse();
    } finally {
      aiChatWorkerAbortController.current = previousWorker;
      failedPacks.delete(pack);
      stickerSetCache.delete(pack);
      inflightStickerSets.delete(pack);
    }
  });

  test("一个调用方取消只结束它自己的等待，共享请求照常服务其余等待者", async () => {
    // 回归用例：共享请求一旦绑到「恰好第一个到达」的调用方 signal 上，那个调用方
    // 取消就会连正缓存回写一起作废，signal 仍存活的其余等待者只能拿到 null，并把
    // 它当成「这个包不可用」。
    const pack: string = "shared_wait_pack";
    const expected: any = {
      name: pack,
      title: "Shared wait",
      sticker_type: "regular",
      stickers: [],
    };
    const first: AbortController = new AbortController();
    const second: AbortController = new AbortController();
    let release!: (set: any) => void;
    const api = {
      getStickerSet: mock((): Promise<any> => new Promise<any>((
        resolve: (set: any) => void
      ): void => {
        release = resolve;
      })),
    };

    try {
      const waitingFirst: Promise<any> = getStickerSet(pack, api, first.signal);
      const waitingSecond: Promise<any> = getStickerSet(pack, api, second.signal);
      first.abort(new DOMException("reply invalidated", "AbortError"));

      expect(await waitingFirst).toBeNull();
      release(expected);
      expect(await waitingSecond).toBe(expected);
      expect(stickerSetCache.get(pack)).toBe(expected);
      expect(api.getStickerSet).toHaveBeenCalledTimes(1);
      expect(failedPacks.has(pack)).toBeFalse();
      expect(inflightStickerSets.has(pack)).toBeFalse();
    } finally {
      failedPacks.delete(pack);
      stickerSetCache.delete(pack);
      inflightStickerSets.delete(pack);
    }
  });
});
