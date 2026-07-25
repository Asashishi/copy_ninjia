import type { FlushResult } from "../types/lifecycle";

interface PendingFlush {
  resolve: (result: FlushResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface FlushBarrier {
  /** 建立一次等待；post 返回 false 或同步抛错时立即按 failed 结算。 */
  begin: (post: (id: number) => boolean | void, timeoutMs?: number) => Promise<FlushResult>;
  /** 结算指定回执；迟到或重复回执返回 false 且不产生副作用。 */
  settle: (id: number, result: FlushResult) => boolean;
  /** Worker 崩溃/终止时一次性结算所有在途等待。 */
  settleAll: (result: FlushResult) => void;
  /** 仅供故障日志和测试观察，不暴露 resolver 所有权。 */
  pendingCount: () => number;
}

export interface CreateFlushBarrierParams {
  timeoutMs: number;
}

/**
 * Worker flush / mailbox barrier 的统一握手原语。等待项在 post 之前登记，
 * 因而同步回执也不会丢失；所有完成路径都先从 Map 删除并清 timer，再 resolve，
 * 让超时、迟到回执与崩溃结算之间保持 exactly-once。
 */
export function createFlushBarrier(options: CreateFlushBarrierParams): FlushBarrier {
  const pending: Map<number, PendingFlush> = new Map();
  let nextId: number = 1;

  function settle(id: number, result: FlushResult): boolean {
    const entry: PendingFlush | undefined = pending.get(id);
    if (entry === undefined) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  }

  return {
    begin: (post: (id: number) => boolean | void, timeoutMs: number | undefined = options.timeoutMs): Promise<FlushResult> => {
      const id: number = nextId++;
      return new Promise((resolve: (value: FlushResult | PromiseLike<FlushResult>) => void): void => {
        const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
          settle(id, "timedOut");
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        try {
          if (post(id) === false) settle(id, "failed");
        } catch {
          settle(id, "failed");
        }
      });
    },
    settle,
    settleAll: (result: FlushResult): void => {
      for (const id of [...pending.keys()]) settle(id, result);
    },
    pendingCount: (): number => pending.size,
  };
}
