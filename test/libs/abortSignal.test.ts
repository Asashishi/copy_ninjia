import { describe, expect, test } from "bun:test";
import {
  raceAbort,
  raceAbortOrThrow,
  signalWithTimeout,
} from "../../packages/libs/abortSignal";
import { deferred } from "./helpers";

describe("AbortSignal 组合", () => {
  test("调用方取消会立即传播到组合信号", () => {
    const controller: AbortController = new AbortController();
    const signal: AbortSignal = signalWithTimeout(controller.signal, 60_000);

    expect(signal.aborted).toBeFalse();
    controller.abort("caller invalidated");

    expect(signal.aborted).toBeTrue();
    expect(signal.reason).toBe("caller invalidated");
  });

  test("省略调用方信号时仍由独立超时预算取消", async () => {
    const first: AbortSignal = signalWithTimeout(undefined, 1);
    await new Promise<void>((resolve: () => void): void => {
      first.addEventListener("abort", resolve, { once: true });
    });

    const second: AbortSignal = signalWithTimeout(undefined, 60_000);
    expect(first.aborted).toBeTrue();
    expect(first.reason).toBeInstanceOf(DOMException);
    expect(first.reason.name).toBe("TimeoutError");
    expect(second.aborted).toBeFalse();
  });
});

describe("raceAbortOrThrow 独占任务等待", () => {
  test("缺省 signal 时原样返回 Promise，成功与失败都不改写", async () => {
    const fulfilled: Promise<string> = Promise.resolve("ok");
    expect(raceAbortOrThrow(fulfilled)).toBe(fulfilled);
    expect(await fulfilled).toBe("ok");

    const failure: Error = new Error("failed");
    const rejected: Promise<string> = Promise.reject(failure);
    await expect(raceAbortOrThrow(rejected, new AbortController().signal)).rejects.toBe(failure);

    const invalidRejected: Promise<string> = Promise.reject("invalid rejection");
    await expect(raceAbortOrThrow(invalidRejected, new AbortController().signal))
      .rejects.toMatchObject({
        message: "Abortable task rejected with a non-Error value.",
        cause: "invalid rejection",
      });
  });

  test("已中止的 signal 立即拒绝并保留 reason 对象", async () => {
    const controller: AbortController = new AbortController();
    const reason: Error = new Error("caller invalidated");
    const taskFailure: Error = new Error("late SDK failure");
    controller.abort(reason);

    await expect(raceAbortOrThrow(Promise.reject(taskFailure), controller.signal))
      .rejects.toBe(reason);

    const invalidController: AbortController = new AbortController();
    invalidController.abort("invalid reason");
    await expect(raceAbortOrThrow(Promise.resolve("late result"), invalidController.signal))
      .rejects.toMatchObject({
        message: "AbortSignal was aborted with a non-Error reason.",
        cause: "invalid reason",
      });
  });

  test("底层任务不监听 signal 时，上层仍在中止时结束等待", async () => {
    const gate = deferred();
    const underlying: Promise<string> = gate.promise.then((): string => "late result");
    const controller: AbortController = new AbortController();
    const reason: Error = new Error("caller invalidated");
    const waiting: Promise<string> = raceAbortOrThrow(underlying, controller.signal);

    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);

    gate.resolve();
    expect(await underlying).toBe("late result");
  });
});

describe("raceAbort 共享等待", () => {
  const CANCELLED = { kind: "cancelled" } as const;
  const REJECTED = { kind: "rejected" } as const;

  test("省略 signal 时原样返回同一个 Promise，不额外包一层", () => {
    const shared: Promise<string> = Promise.resolve("ok");

    expect(raceAbort(shared, { cancelled: "x", rejected: "y" })).toBe(shared);
  });

  test("取消只结束本次等待：共享 Promise 照常结算，其余等待者拿到真实结果", async () => {
    const gate = deferred();
    const shared: Promise<string> = gate.promise.then((): string => "共享结果");
    const first: AbortController = new AbortController();
    const second: AbortController = new AbortController();

    const cancelledWait: Promise<string> = raceAbort(shared, {
      signal: first.signal,
      cancelled: "取消",
      rejected: "失败",
    });
    const liveWait: Promise<string> = raceAbort(shared, {
      signal: second.signal,
      cancelled: "取消",
      rejected: "失败",
    });

    first.abort();
    expect(await cancelledWait).toBe("取消");

    gate.resolve();
    expect(await liveWait).toBe("共享结果");
    expect(await shared).toBe("共享结果");
  });

  test("reject 与取消归到各自的值，且按对象身份原样交回", async () => {
    const failing: Promise<typeof CANCELLED | typeof REJECTED> =
      Promise.reject(new Error("boom"));
    const controller: AbortController = new AbortController();

    // 调用方靠对象身份区分「被取消」与「底层失败」，包一层新对象就会破坏判定。
    expect(await raceAbort(failing, {
      signal: controller.signal,
      cancelled: CANCELLED,
      rejected: REJECTED,
    })).toBe(REJECTED);

    const cancelledController: AbortController = new AbortController();
    const pending: Promise<typeof CANCELLED | typeof REJECTED> =
      new Promise<typeof CANCELLED | typeof REJECTED>((): void => {});
    const wait: Promise<typeof CANCELLED | typeof REJECTED> = raceAbort(pending, {
      signal: cancelledController.signal,
      cancelled: CANCELLED,
      rejected: REJECTED,
    });
    cancelledController.abort();
    expect(await wait).toBe(CANCELLED);
  });

  test("钩子顺序固定为 onSettle → onCancel，取消与正常结算各走一次 onSettle", async () => {
    const order: string[] = [];
    const gate = deferred();
    const controller: AbortController = new AbortController();

    const wait: Promise<string> = raceAbort(gate.promise.then((): string => "done"), {
      signal: controller.signal,
      cancelled: "取消",
      rejected: "失败",
      onSettle: (): void => { order.push("settle"); },
      onCancel: (): void => { order.push("cancel"); },
    });
    controller.abort();
    expect(await wait).toBe("取消");
    // 引用计数必须先释放，onCancel 才能读到「本等待者已离场」之后的真实计数。
    expect(order).toEqual(["settle", "cancel"]);

    gate.resolve();
    const settled = deferred();
    const normal: Promise<string> = raceAbort(settled.promise.then((): string => "done"), {
      signal: new AbortController().signal,
      cancelled: "取消",
      rejected: "失败",
      onSettle: (): void => { order.push("settle-normal"); },
      onCancel: (): void => { order.push("cancel-normal"); },
    });
    settled.resolve();
    expect(await normal).toBe("done");
    expect(order).toEqual(["settle", "cancel", "settle-normal"]);
  });

  test("传入已 abort 的 signal 时立即回退，并同样走过两个钩子", async () => {
    const controller: AbortController = new AbortController();
    controller.abort();
    const order: string[] = [];
    let started: boolean = false;
    const shared: Promise<string> = Promise.resolve().then((): string => {
      started = true;
      return "共享结果";
    });

    expect(await raceAbort(shared, {
      signal: controller.signal,
      cancelled: "取消",
      rejected: "失败",
      onSettle: (): void => { order.push("settle"); },
      onCancel: (): void => { order.push("cancel"); },
    })).toBe("取消");
    expect(order).toEqual(["settle", "cancel"]);
    // 共享工作不受这次等待影响，仍然自己跑完。
    expect(await shared).toBe("共享结果");
    expect(started).toBeTrue();
  });
});
