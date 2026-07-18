import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSON_API_ERROR_LOG_MAX_CHARS, JSON_API_MAX_RESPONSE_BYTES } from "../../src/consts/httpFetch";

const loggerError = mock((..._args: unknown[]): void => {});
mock.module("../../src/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error: loggerError },
}));

const { fetchJsonWithTimeout } = await import("../../src/libs/httpFetch");
const realFetch: typeof fetch = globalThis.fetch;

function installFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = handler as typeof fetch;
}

function chunkedResponse(chunks: readonly Uint8Array[], init?: ResponseInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    init
  );
}

describe("fetchJsonWithTimeout", () => {
  beforeEach(() => loggerError.mockClear());

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("正常 JSON 在流式读取完成后解析，并把调用方 init 与超时 signal 合并", async () => {
    const encoder = new TextEncoder();
    let receivedInit: RequestInit | undefined;
    installFetch(async (_input, init): Promise<Response> => {
      receivedInit = init;
      return chunkedResponse([encoder.encode("{\"ok\":"), encoder.encode("true}")]);
    });

    await expect(fetchJsonWithTimeout("https://example.test/data", { headers: { accept: "application/json" } }, 1000, "Example API"))
      .resolves.toEqual({ ok: true });
    expect(receivedInit?.headers).toEqual({ accept: "application/json" });
    expect(receivedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("Content-Length 已声明超限时提前拒绝成功响应", async () => {
    installFetch(async (): Promise<Response> => new Response("{}", {
      headers: { "content-length": String(JSON_API_MAX_RESPONSE_BYTES + 1) },
    }));

    expect(await fetchJsonWithTimeout("https://example.test/large", {}, 1000, "Large API")).toBeNull();
    expect(loggerError).toHaveBeenCalledWith(
      `Large API response exceeded ${JSON_API_MAX_RESPONSE_BYTES} bytes (observed ${JSON_API_MAX_RESPONSE_BYTES + 1}).`
    );
  });

  test("缺失 Content-Length 的流式成功响应也在累计越界时停止", async () => {
    installFetch(async (): Promise<Response> => chunkedResponse([
      new Uint8Array(JSON_API_MAX_RESPONSE_BYTES),
      new Uint8Array([1]),
    ]));

    expect(await fetchJsonWithTimeout("https://example.test/stream", {}, 1000, "Stream API")).toBeNull();
    expect(loggerError).toHaveBeenCalledWith(
      `Stream API response exceeded ${JSON_API_MAX_RESPONSE_BYTES} bytes (observed ${JSON_API_MAX_RESPONSE_BYTES + 1}).`
    );
  });

  test("非 2xx 正文先按字节读取，再把日志预览截断到固定字符数", async () => {
    const body = "x".repeat(JSON_API_ERROR_LOG_MAX_CHARS + 200);
    installFetch(async (): Promise<Response> => new Response(body, { status: 502 }));

    expect(await fetchJsonWithTimeout("https://example.test/error", {}, 1000, "Error API")).toBeNull();
    expect(loggerError).toHaveBeenCalledWith(`Error API error: 502 ${"x".repeat(JSON_API_ERROR_LOG_MAX_CHARS)}…`);
  });

  test("非法 JSON 和读取中断统一返回 null 并记录异常", async () => {
    installFetch(async (): Promise<Response> => new Response("not-json"));
    expect(await fetchJsonWithTimeout("https://example.test/invalid", {}, 1000, "Invalid API")).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);

    loggerError.mockClear();
    installFetch(async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>({
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        controller.error(new Error("stream broke"));
      },
    })));
    expect(await fetchJsonWithTimeout("https://example.test/broken", {}, 1000, "Broken API")).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  test("超时会 abort 在途 fetch，清理后返回 null", async () => {
    installFetch((_input, init): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));

    expect(await fetchJsonWithTimeout("https://example.test/slow", {}, 5, "Slow API")).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
