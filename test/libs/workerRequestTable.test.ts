/** 按 requestId 等 Worker 回执的通用等待表：五条结算路与先登记后投递的顺序。 */

import { describe, expect, jest, mock, test } from "bun:test";
import {
  beginWorkerRequest,
  failAllWorkerRequests,
  settleWorkerRequest,
} from "../../packages/libs/workerRequestTable";
import type { WorkerRequestTable } from "../../packages/types/workerRequest";

function table(): WorkerRequestTable<string> {
  return { waiters: new Map(), counter: { current: 0 } };
}

/** 投递同步抛错时交出的异常；每个用例结束前按需断言。 */
const postErrors: unknown[] = [];
const onPostError = (error: unknown): void => {
  postErrors.push(error);
};

describe("workerRequestTable", () => {
  test("先登记后投递：投递期间同步到达的回执照常结算，迟到的重复回执被丢弃", async () => {
    const requests: WorkerRequestTable<string> = table();
    const result: Promise<string> = beginWorkerRequest({
      table: requests,
      timeoutMs: 1_000,
      post: (requestId: number): boolean => {
        settleWorkerRequest(requests, requestId, "receipt");
        return true;
      },
      onPostError,
      timedOut: "timed out",
      rejected: "rejected",
    });
    expect(await result).toBe("receipt");
    settleWorkerRequest(requests, 1, "late");
    expect(requests.waiters.size).toBe(0);
    expect(requests.counter.current).toBe(1);
  });

  test("超时与调用方取消都撤回 Worker 侧工作，取消后摘掉 signal 监听", async () => {
    jest.useFakeTimers();
    try {
      const requests: WorkerRequestTable<string> = table();
      const cancel = mock((_requestId: number): void => {});
      const timedOut: Promise<string> = beginWorkerRequest({
        table: requests, timeoutMs: 50, post: (): boolean => true, onPostError, cancel, timedOut: "timed out", rejected: "rejected",
      });
      jest.advanceTimersByTime(50);
      expect(await timedOut).toBe("timed out");
      expect(cancel.mock.calls).toEqual([[1]]);

      const controller: AbortController = new AbortController();
      const removed = mock((): void => {});
      const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>): void => {
        removed();
        originalRemove(...args);
      }) as AbortSignal["removeEventListener"];
      const aborted: Promise<string> = beginWorkerRequest({
        table: requests,
        timeoutMs: 1_000,
        post: (): boolean => true,
        onPostError,
        cancel,
        abort: { signal: controller.signal, result: "aborted" },
        timedOut: "timed out",
        rejected: "rejected",
      });
      controller.abort();
      expect(await aborted).toBe("aborted");
      expect(cancel.mock.calls).toEqual([[1], [2]]);
      expect(removed).toHaveBeenCalledTimes(1);
      expect(requests.waiters.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("投递被拒（返回 false 或同步抛错）按 rejected 结算且不撤回；崩溃重建一次结算全部在途等待者", async () => {
    const requests: WorkerRequestTable<string> = table();
    const cancel = mock((_requestId: number): void => {});
    expect(await beginWorkerRequest({
      table: requests, timeoutMs: 1_000, post: (): boolean => false, onPostError, cancel, timedOut: "timed out", rejected: "rejected",
    })).toBe("rejected");
    expect(cancel).not.toHaveBeenCalled();
    // 同步抛错同样按投递被拒结算：异常先交给诊断出口，不 reject，也不留下等到超时的等待者。
    postErrors.length = 0;
    const thrown: Error = new Error("postMessage failed");
    expect(await beginWorkerRequest({
      table: requests,
      timeoutMs: 1_000,
      post: (): boolean => {
        throw thrown;
      },
      onPostError,
      cancel,
      timedOut: "timed out",
      rejected: "rejected",
    })).toBe("rejected");
    expect(postErrors).toEqual([thrown]);
    expect(cancel).not.toHaveBeenCalled();
    expect(requests.waiters.size).toBe(0);

    const first: Promise<string> = beginWorkerRequest({
      table: requests, timeoutMs: 1_000, post: (): boolean => true, onPostError, timedOut: "timed out", rejected: "rejected",
    });
    const second: Promise<string> = beginWorkerRequest({
      table: requests, timeoutMs: 1_000, post: (): boolean => true, onPostError, timedOut: "timed out", rejected: "rejected",
    });
    expect(requests.waiters.size).toBe(2);
    failAllWorkerRequests(requests, "unavailable");
    expect(await first).toBe("unavailable");
    expect(await second).toBe("unavailable");
    expect(requests.waiters.size).toBe(0);
  });
});
