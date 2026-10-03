import { describe, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";
import { Api } from "grammy";
import type { Transformer } from "grammy";
import type { ApiResponse } from "grammy/types";
import { telegramSignal } from "../../packages/libs/telegramSignal";

interface CapturedRequest {
  method: string;
  payload: unknown;
  signal: unknown;
}

describe("Bun 取消信号与 grammY 参数边界", (): void => {
  test("有无信号均保留 SDK 请求载荷，原生信号保持身份", async (): Promise<void> => {
    const fetchMock: Mock<() => Promise<never>> = mock(async (): Promise<never> => { throw new Error("Unexpected outbound request"); });
    const api: Api = new Api("1:fixture", { fetch: fetchMock });
    const controller: AbortController = new AbortController();
    const requests: CapturedRequest[] = [];
    api.config.use(async (...[, method, payload, signal]: Parameters<Transformer>): Promise<ApiResponse<never>> => {
      requests.push({ method, payload, signal });
      return { ok: true, result: true as never };
    });

    for (const signal of [undefined, controller.signal]) {
      await api.getChat(-1001, telegramSignal(signal));
      await api.sendMessage(-1001, "fixture", { message_thread_id: 7 }, telegramSignal(signal));
      await api.getUpdates({ offset: 1 }, telegramSignal(signal));
      await api.getMe(telegramSignal(signal));
    }

    expect(requests).toHaveLength(8);
    expect(requests.slice(0, 4).map((request: CapturedRequest): [string, unknown] => [request.method, request.payload]))
      .toEqual(requests.slice(4).map((request: CapturedRequest): [string, unknown] => [request.method, request.payload]));
    expect(requests.slice(0, 4).every((request: CapturedRequest): boolean => request.signal === undefined)).toBeTrue();
    expect(requests.slice(4).every((request: CapturedRequest): boolean => request.signal === controller.signal)).toBeTrue();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("原生 abort 会终止 SDK 在途请求边界", async (): Promise<void> => {
    const fetchMock: Mock<() => Promise<never>> = mock(async (): Promise<never> => { throw new Error("Unexpected outbound request"); });
    const api: Api = new Api("1:fixture", { fetch: fetchMock });
    const controller: AbortController = new AbortController();
    const cancelled: Error = new Error("fixture cancelled");
    const started: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    api.config.use((...[, , , signal]: Parameters<Transformer>): Promise<never> => new Promise<never>((
      _resolve: PromiseWithResolvers<never>["resolve"],
      reject: PromiseWithResolvers<never>["reject"]
    ): void => {
      signal?.addEventListener("abort", (): void => reject(cancelled), { once: true });
      started.resolve();
    }));

    const request: Promise<unknown> = api.getChat(-1001, telegramSignal(controller.signal));
    const outcome: Promise<unknown> = request.catch((error: unknown): unknown => error);
    await started.promise;
    controller.abort();
    expect(await outcome).toBe(cancelled);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
