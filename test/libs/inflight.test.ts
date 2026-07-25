import { describe, expect, test } from "bun:test";
import { settleInflight, trackInflight } from "../../packages/libs/inflight";
import { deferred } from "./helpers";

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

  test("某个请求 reject 不会让 settle 提前返回，仍等其余在途请求落定", async () => {
    const inflight = new Set<Promise<unknown>>();
    const pending = deferred();
    const failing = Promise.reject(new Error("boom"));
    trackInflight(inflight, failing).catch(() => {});
    trackInflight(inflight, pending.promise);

    let settled = false;
    const waiting = settleInflight(inflight).then(() => {
      settled = true;
    });

    // reject 已经发生，若 settle 用的是 Promise.all 会在这里提前失败返回。
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(inflight.size).toBe(1);

    pending.resolve();
    await waiting;
    expect(settled).toBe(true);
    expect(inflight.size).toBe(0);
  });
});
