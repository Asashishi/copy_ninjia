import { describe, expect, test } from "bun:test";
import { readBoundedResponseBytes, readBoundedResponseText } from "../../packages/libs/boundedResponse";
import { chunkedResponse } from "./helpers";
import { BOUNDED_RESPONSE_CHUNK_THRESHOLD, BOUNDED_RESPONSE_COALESCE_BYTES } from "../../packages/consts/streams";

describe("bounded response reader", () => {
  test("combines chunks up to and including the limit", async () => {
    const result = await readBoundedResponseBytes(chunkedResponse([new Uint8Array([1, 2]), new Uint8Array([3])]), 3);
    expect(result).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
  });

  test("rejects a declared oversized body before consuming it", async () => {
    const result = await readBoundedResponseBytes(chunkedResponse([new Uint8Array([1])], { headers: { "content-length": "100" } }), 10);
    expect(result).toEqual({ ok: false, reason: "too-large", observedBytes: 100 });
  });

  test("rejects a streaming body that exceeds a missing or false length header", async () => {
    const result = await readBoundedResponseBytes(chunkedResponse([new Uint8Array(4), new Uint8Array(4)], { headers: { "content-length": "1" } }), 5);
    expect(result).toEqual({ ok: false, reason: "too-large", observedBytes: 8 });
  });

  test("decodes bounded text and validates the limit argument", async () => {
    expect(await readBoundedResponseText(new Response("测试"), 6)).toBe("测试");
    expect(() => readBoundedResponseBytes(new Response(""), -1)).toThrow("maxBytes");
  });

  test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("invalid byte limit %s rejects before consuming the body", async (limit: number): Promise<void> => {
    const response: Response = new Response("unread");
    await expect(readBoundedResponseBytes(response, limit)).rejects.toBeInstanceOf(RangeError);
    expect(response.bodyUsed).toBe(false);
    await response.body?.cancel();
  });

  test("empty bodies and zero-length chunks preserve a zero-byte limit", async (): Promise<void> => {
    for (const response of [new Response(null), chunkedResponse([new Uint8Array(), new Uint8Array()])]) {
      expect(await readBoundedResponseBytes(response, 0)).toEqual({ ok: true, bytes: new Uint8Array() });
      expect(response.body?.locked ?? false).toBe(false);
    }
  });

  test("a single Buffer chunk returns an independent byte array", async (): Promise<void> => {
    const input: Uint8Array = Buffer.from([1, 2, 3]);
    const result: Awaited<ReturnType<typeof readBoundedResponseBytes>> = await readBoundedResponseBytes(chunkedResponse([input]), input.byteLength);
    input.fill(0);
    expect(result).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
  });

  test("coarse blocks followed by fine fragments preserve the complete prefix", async (): Promise<void> => {
    const chunks: Uint8Array[] = Array.from({ length: BOUNDED_RESPONSE_CHUNK_THRESHOLD }, (_: unknown, index: number): Uint8Array => new Uint8Array(BOUNDED_RESPONSE_COALESCE_BYTES).fill(index));
    for (let index: number = 0; index < BOUNDED_RESPONSE_CHUNK_THRESHOLD * 2; index++) chunks.push(new Uint8Array([index]));
    const expected: ArrayBuffer = Bun.concatArrayBuffers(chunks);
    const result: Awaited<ReturnType<typeof readBoundedResponseBytes>> = await readBoundedResponseBytes(chunkedResponse(chunks), expected.byteLength);
    expect(result).toEqual({ ok: true, bytes: new Uint8Array(expected) });
  });

  test("mixed fragments and views preserve byte order and return independent storage", async (): Promise<void> => {
    const sizes: readonly number[] = [1, 65_535, 0, 65_536, 7, 65_537, 0, 3];
    const chunks: Uint8Array[] = [];
    let length: number = 0;
    for (const size of sizes) {
      const backing: Uint8Array = new Uint8Array(size + 16).fill(chunks.length + 1);
      chunks.push(backing.subarray(8, size + 8));
      length += size;
    }
    const expected: Uint8Array = Bun.concatArrayBuffers(chunks, length, true);
    const response: Response = chunkedResponse(chunks, { headers: { "content-length": "1" } });
    const result: Awaited<ReturnType<typeof readBoundedResponseBytes>> = await readBoundedResponseBytes(response, length);
    expect(result).toEqual({ ok: true, bytes: expected });
    for (const chunk of chunks) chunk.fill(0);
    expect(result).toEqual({ ok: true, bytes: expected });
    expect(response.body?.locked).toBe(false);
  });

  test.each([false, true])("oversize cancellation rejection=%s preserves the refusal and releases the reader", async (rejectCancel: boolean): Promise<void> => {
    let cancelled: number = 0;
    const response: Response = new Response(new ReadableStream<Uint8Array>({
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        controller.enqueue(new Uint8Array(4));
      },
      cancel(): void {
        cancelled++;
        if (rejectCancel) throw new Error("fixture cancellation rejected");
      },
    }));
    expect(await readBoundedResponseBytes(response, 6)).toEqual({ ok: false, reason: "too-large", observedBytes: 8 });
    expect(cancelled).toBe(1);
    expect(response.body?.locked).toBe(false);
  });

  test("declared oversize cancels even when cancellation rejects", async (): Promise<void> => {
    let cancelled: number = 0;
    const response: Response = new Response(new ReadableStream<Uint8Array>({
      cancel(): never { cancelled++; throw new Error("fixture cancellation rejected"); },
    }), { headers: { "content-length": "10" } });
    expect(await readBoundedResponseBytes(response, 2)).toEqual({ ok: false, reason: "too-large", observedBytes: 10 });
    expect(cancelled).toBe(1);
    expect(response.body?.locked).toBe(false);
  });

  test("stream failure after partial data propagates the original error and releases the lock", async (): Promise<void> => {
    const failure: Error = new Error("fixture stream failure");
    let reads: number = 0;
    const response: Response = new Response(new ReadableStream<Uint8Array>({
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]));
        else controller.error(failure);
      },
    }));
    await expect(readBoundedResponseBytes(response, 10)).rejects.toBe(failure);
    expect(response.body?.locked).toBe(false);
  });

  test.each([-1, 0, 1, 32])("aggregation boundary offset %s retains exact bytes and independent output", async (offset: number): Promise<void> => {
    const chunks: Uint8Array[] = Array.from({ length: BOUNDED_RESPONSE_CHUNK_THRESHOLD + offset }, (_: unknown, index: number): Uint8Array => new Uint8Array([index, index + 1]));
    const expected: Uint8Array = Bun.concatArrayBuffers(chunks, chunks.length * 2, true);
    const result: Awaited<ReturnType<typeof readBoundedResponseBytes>> = await readBoundedResponseBytes(chunkedResponse(chunks), expected.length);
    for (const chunk of chunks) chunk.fill(0);
    expect(result).toEqual({ ok: true, bytes: expected });
  });

  test.each(["overflow", "error"])("aggregation releases the response after %s", async (ending: string): Promise<void> => {
    const count: number = BOUNDED_RESPONSE_CHUNK_THRESHOLD + 2;
    const failure: Error = new Error("fixture fragmented stream failure");
    let remaining: number = count;
    let cancelled: number = 0;
    const response: Response = new Response(new ReadableStream<Uint8Array>({
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        if (remaining-- > 0) controller.enqueue(new Uint8Array([1]));
        else if (ending === "error") controller.error(failure);
        else controller.enqueue(new Uint8Array([2]));
      },
      cancel(): never { cancelled++; throw new Error("fixture cancel failure"); },
    }));
    if (ending === "error") await expect(readBoundedResponseBytes(response, count)).rejects.toBe(failure);
    else expect(await readBoundedResponseBytes(response, count)).toEqual({ ok: false, reason: "too-large", observedBytes: count + 1 });
    expect(cancelled).toBe(ending === "overflow" ? 1 : 0);
    expect(response.body?.locked).toBe(false);
  });
});
