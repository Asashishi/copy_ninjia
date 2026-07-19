import { describe, expect, test } from "bun:test";
import { readBoundedResponseBytes, readBoundedResponseText } from "../../src/libs/boundedResponse";
import { chunkedResponse } from "./helpers";

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
});
