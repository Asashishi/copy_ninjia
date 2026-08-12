import { describe, expect, test } from "bun:test";
import { signalWithTimeout } from "../../packages/libs/abortSignal";

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
