import { expect, test } from "bun:test";
import type { createFlushBarrier } from "../../packages/libs/flushBarrier";
import type { createKeyedSerialTaskRunner } from "../../packages/libs/keyedSerialTaskRunner";
import type { createLatestValueRunner } from "../../packages/libs/latestValueRunner";
import type { createPrioritizedBoundedTaskRunner } from "../../packages/libs/prioritizedBoundedTaskRunner";
import type { ReadonlyLruCache } from "../../packages/libs/lruCache";
import type { superviseWorker } from "../../packages/infra/supervisedWorker";
import type { registerHandlers } from "../../packages/app/registerHandlers";
import type { runAcknowledgedUpdateBatches } from "../../packages/app/updateRunner";
import type { createOwnerSettler } from "../../packages/app/lifecycle/shutdown";
import type { startChatActionHeartbeat } from "../../packages/aiChat/ai/chatActionHeartbeat";
import type { createStickerSendLock } from "../../packages/aiChat/ai/stickers/sendLock";
import type { FlushResult } from "../../packages/types/lifecycle";

/** 类型断言只放在不调用的闭包内；typecheck 检查赋值错误，测试不创建或改写运行时句柄。 */
test("异步队列与 flush 句柄的方法不可替换", (): void => {
  const check = (handles: {
    readonly barrier: ReturnType<typeof createFlushBarrier>;
    readonly keyed: ReturnType<typeof createKeyedSerialTaskRunner<number>>;
    readonly latest: ReturnType<typeof createLatestValueRunner<string>>;
    readonly prioritized: ReturnType<typeof createPrioritizedBoundedTaskRunner>;
  }): void => {
    // @ts-expect-error flush 等待入口只读。
    handles.barrier.begin = (): Promise<FlushResult> => Promise.resolve("failed");
    // @ts-expect-error 单条回执结算入口只读。
    handles.barrier.settle = (): boolean => false;
    // @ts-expect-error 批量结算入口只读。
    handles.barrier.settleAll = (): void => {};
    // @ts-expect-error 在途计数读取入口只读。
    handles.barrier.pendingCount = (): number => 0;
    // @ts-expect-error 分组串行任务入口只读。
    handles.keyed.run = (): Promise<void> => Promise.resolve();
    // @ts-expect-error 最新值提交入口只读。
    handles.latest.push = (): Promise<void> => Promise.resolve();
    // @ts-expect-error 有界优先级任务入口只读，保留泛型结果。
    handles.prioritized.run = <T>(): Promise<T | undefined> => Promise.resolve(undefined);
    // @ts-expect-error 活跃任务计数只读。
    handles.prioritized.activeCount = 0;
    // @ts-expect-error 待执行任务计数只读。
    handles.prioritized.pendingCount = 0;
    // @ts-expect-error 后台待执行任务计数只读。
    handles.prioritized.backgroundPendingCount = 0;
  };
  expect(check).toBeDefined();
});

test("Worker 与应用生命周期句柄的方法不可替换", (): void => {
  const check = (handles: {
    readonly worker: ReturnType<typeof superviseWorker>;
    readonly registration: ReturnType<typeof registerHandlers>;
    readonly runner: ReturnType<typeof runAcknowledgedUpdateBatches>;
    readonly settler: ReturnType<typeof createOwnerSettler>;
  }): void => {
    // @ts-expect-error Worker 初始化入口只读。
    handles.worker.init = (): void => {};
    // @ts-expect-error Worker 投递入口只读。
    handles.worker.post = (): boolean => false;
    // @ts-expect-error Worker 终止入口只读。
    handles.worker.terminate = (): Promise<void> => Promise.resolve();
    // @ts-expect-error update 确认边界读取入口只读。
    handles.registration.getLastSeenUpdateId = (): number => 0;
    // @ts-expect-error runner 停止入口只读。
    handles.runner.stop = (): Promise<void> => Promise.resolve();
    // @ts-expect-error runner 任务读取入口只读。
    handles.runner.task = (): Promise<void> => Promise.resolve();
    // @ts-expect-error runner 活跃计数读取入口只读。
    handles.runner.size = (): number => 0;
    // @ts-expect-error update 失败标记读取入口只读。
    handles.runner.hasFailedUpdate = (): boolean => false;
    // @ts-expect-error 活跃 update 取消入口只读。
    handles.runner.abortActive = (): number => 0;
    // @ts-expect-error owner flush 结算入口只读。
    handles.settler.flush = (): Promise<FlushResult> => Promise.resolve("failed");
    // @ts-expect-error owner 门控结算入口只读。
    handles.settler.gate = (): Promise<boolean> => Promise.resolve(false);
    // @ts-expect-error owner 终止结算入口只读。
    handles.settler.terminate = (): Promise<FlushResult> => Promise.resolve("failed");
  };
  expect(check).toBeDefined();
});

test("AI 心跳与贴纸发送锁句柄的方法不可替换", (): void => {
  const check = (handles: {
    readonly heartbeat: ReturnType<typeof startChatActionHeartbeat>;
    readonly stickerLock: ReturnType<typeof createStickerSendLock>;
  }): void => {
    // @ts-expect-error 心跳挡位读取入口只读。
    handles.heartbeat.current = (): "idle" => "idle";
    // @ts-expect-error 心跳挡位切换入口只读。
    handles.heartbeat.set = (): void => {};
    // @ts-expect-error 心跳排空入口只读。
    handles.heartbeat.settle = (): Promise<void> => Promise.resolve();
    // @ts-expect-error 心跳停止入口只读。
    handles.heartbeat.stop = (): Promise<void> => Promise.resolve();
    // @ts-expect-error 贴纸锁占位入口只读。
    handles.stickerLock.tryAcquire = (): boolean => false;
    // @ts-expect-error 贴纸锁释放入口只读。
    handles.stickerLock.release = (): void => {};
  };
  expect(check).toBeDefined();
});

test("LRU 只读视图的查询与迭代入口不可替换", (): void => {
  const check = (view: ReadonlyLruCache<number, string>): void => {
    // @ts-expect-error 缓存大小只读。
    view.size = 0;
    // @ts-expect-error 存在性查询入口只读。
    view.has = (): boolean => false;
    // @ts-expect-error 命中读取入口只读。
    view.get = (): undefined => undefined;
    // @ts-expect-error 无副作用读取入口只读。
    view.peek = (): undefined => undefined;
    // @ts-expect-error 主键迭代入口只读。
    view.keys = (): IterableIterator<number> => [][Symbol.iterator]();
    // @ts-expect-error 继承的条目迭代入口同样只读。
    view[Symbol.iterator] = (): IterableIterator<readonly [number, string]> => [][Symbol.iterator]();
  };
  expect(check).toBeDefined();
});
