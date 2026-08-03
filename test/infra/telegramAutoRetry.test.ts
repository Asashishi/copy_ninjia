import { describe, expect, mock, test } from "bun:test";
import { autoRetry } from "@grammyjs/auto-retry";
import { HttpError } from "grammy";
import type { ApiCallFn, Transformer } from "grammy";

const SEND_MESSAGE_PAYLOAD = { chat_id: -1001, text: "test" } as const;
const RETRY_OPTIONS = {
  maxRetryAttempts: 3,
  maxDelaySeconds: 5,
  rethrowHttpErrors: true,
} as const;

describe("Telegram autoRetry 网络边界", () => {
  test("rethrowHttpErrors 让第一次网络错误立即返回调用方", async () => {
    const networkError: HttpError = new HttpError("offline", new Error("offline"));
    const previous = mock(async (..._args: unknown[]): Promise<never> => {
      throw networkError;
    }) as unknown as ApiCallFn;
    const transformer: Transformer = autoRetry(RETRY_OPTIONS);

    await expect(
      transformer(previous, "sendMessage", SEND_MESSAGE_PAYLOAD)
    ).rejects.toBe(networkError);
    expect(previous).toHaveBeenCalledTimes(1);
  });

  test("429 与 5xx 仍分别执行三次有限重试", async () => {
    const originalSetTimeout: typeof setTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((
      callback: (...args: unknown[]) => void,
      delay?: number
    ): ReturnType<typeof setTimeout> => {
      delays.push(delay ?? 0);
      queueMicrotask((): void => callback());
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const rateLimitedResponse = {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 0 },
      } as const;
      const rateLimitedCall = mock(
        async (..._args: unknown[]): Promise<typeof rateLimitedResponse> =>
          rateLimitedResponse
      ) as unknown as ApiCallFn;
      const serverErrorResponse = {
        ok: false,
        error_code: 500,
        description: "Internal Server Error",
        parameters: {},
      } as const;
      const serverErrorCall = mock(
        async (..._args: unknown[]): Promise<typeof serverErrorResponse> =>
          serverErrorResponse
      ) as unknown as ApiCallFn;
      const transformer: Transformer = autoRetry(RETRY_OPTIONS);

      await transformer(rateLimitedCall, "sendMessage", SEND_MESSAGE_PAYLOAD);
      await transformer(serverErrorCall, "sendMessage", SEND_MESSAGE_PAYLOAD);

      expect(rateLimitedCall).toHaveBeenCalledTimes(4);
      expect(serverErrorCall).toHaveBeenCalledTimes(4);
      expect(delays).toEqual([0, 0, 0, 0, 3_000, 6_000, 12_000, 24_000]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("abort 会终止 retry_after 等待", async () => {
    const rateLimitedResponse = {
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 5 },
    } as const;
    const previous = mock(
      async (..._args: unknown[]): Promise<typeof rateLimitedResponse> =>
        rateLimitedResponse
    ) as unknown as ApiCallFn;
    const transformer: Transformer = autoRetry(RETRY_OPTIONS);
    const controller: AbortController = new AbortController();
    const request: ReturnType<Transformer> = transformer(
      previous,
      "sendMessage",
      SEND_MESSAGE_PAYLOAD,
      controller.signal as unknown as Parameters<Transformer>[3]
    );
    const abortTimer: ReturnType<typeof setTimeout> = setTimeout(
      (): void => controller.abort(),
      0
    );

    try {
      await expect(request).rejects.toThrow("Request aborted while waiting between retries");
      expect(previous).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(abortTimer);
    }
  });
});
