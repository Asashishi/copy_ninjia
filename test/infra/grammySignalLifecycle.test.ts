import { expect, spyOn, test } from "bun:test";
import { Api } from "grammy";

for (const outcome of ["success", "api-error", "network-error"] as const) {
  test(`真实 grammY 请求 ${outcome} 后释放共享取消监听器`, async (): Promise<void> => {
    const api: Api = new Api("123:fixture", { fetch: async (): Promise<Response> => {
      if (outcome === "network-error") throw new Error("network fixture");
      return new Response(JSON.stringify(outcome === "success"
        ? { ok: true, result: [] }
        : { ok: false, error_code: 429, description: "fixture flood", parameters: { retry_after: 1 } }));
    } });
    const controller: AbortController = new AbortController();
    const add: ReturnType<typeof spyOn<AbortSignal, "addEventListener">> = spyOn(controller.signal, "addEventListener");
    const remove: ReturnType<typeof spyOn<AbortSignal, "removeEventListener">> = spyOn(controller.signal, "removeEventListener");
    try {
      for (let index: number = 0; index < 64; index++) {
        const task: Promise<unknown> = api.getUpdates({}, controller.signal as unknown as Parameters<Api["getUpdates"]>[1]);
        if (outcome === "success") expect(await task).toEqual([]);
        else await expect(task).rejects.toThrow();
      }
      expect(add).toHaveBeenCalledTimes(64);
      expect(remove.mock.calls).toEqual(add.mock.calls);
      expect(controller.signal.aborted).toBeFalse();
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
}

test("真实 grammY 在途请求仍传播取消并移除监听器", async (): Promise<void> => {
  const started: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  const api: Api = new Api("123:fixture", { fetch: async (_url: unknown, init?: Readonly<{ signal?: unknown }>): Promise<Response> => {
    const signal: AbortSignal = init!.signal as AbortSignal;
    return new Promise<Response>((_resolve: (value: Response | PromiseLike<Response>) => void, reject: (reason?: unknown) => void): void => {
      signal.addEventListener("abort", (): void => reject(new DOMException("fixture abort", "AbortError")), { once: true });
      started.resolve();
    });
  } });
  const controller: AbortController = new AbortController();
  const remove: ReturnType<typeof spyOn<AbortSignal, "removeEventListener">> = spyOn(controller.signal, "removeEventListener");
  try {
    const task: Promise<unknown> = api.getUpdates({}, controller.signal as unknown as Parameters<Api["getUpdates"]>[1]);
    await started.promise;
    controller.abort();
    await expect(task).rejects.toThrow();
    expect(remove).toHaveBeenCalled();
  } finally {
    remove.mockRestore();
  }
});
