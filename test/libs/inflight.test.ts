import { describe, expect, test } from "bun:test";
import { settleInflight, trackInflight } from "../../src/libs/inflight";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("inflight tracker", () => {
  test("settle 会等待被较新请求掩盖不了的所有旧请求", async () => {
    const inflight = new Set<Promise<unknown>>();
    const older = deferred();
    const newer = deferred();
    trackInflight(inflight, older.promise);
    trackInflight(inflight, newer.promise);

    let settled = false;
    const waiting = settleInflight(inflight).then(() => {
      settled = true;
    });

    newer.resolve();
    await newer.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(inflight.size).toBe(1);

    older.resolve();
    await waiting;
    expect(settled).toBe(true);
    expect(inflight.size).toBe(0);
  });
});
