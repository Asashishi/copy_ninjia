import type { DiskIOMessage, DiskIOReply } from "../../packages/types/diskIO";
import type { LuckReceiptSecret } from "../../packages/types/diskIO/storage";

/**
 * `terminate()` 的三种结局。
 *
 * `throwSync` 与 `reject` 不能合并：宿主对这两种失败各写了一条捕获路径
 * （`try/catch` 包住调用本身，`.catch` 接住返回的 promise），把 `terminate`
 * 写成 `async` 只到得了后者。
 */
export type FakeDiskIOTerminateBehavior = "resolve" | "reject" | "throwSync";

/** Disk I/O 主线程桥测试共用的无副作用 Worker 替身。 */
export class FakeDiskIOWorker {
  static readonly instances: FakeDiskIOWorker[] = [];
  /**
   * 预置给**下一个**被构造的替身的拒收类型与 terminate 结局。
   *
   * 自愈路径在 `recoverDiskIOWorker` 里同步 `new Worker()` 之后立刻投 `load`，
   * 调用方拿不到那个实例、也没有插手的时机。要让新代际在握手第一步就失败，
   * 只能在构造前把配置放在这里。构造后即复位，不会漏给再下一个实例。
   */
  static nextRejectedTypes: readonly DiskIOMessage["type"][] = [];
  static nextTerminateBehavior: FakeDiskIOTerminateBehavior = "resolve";

  onmessage: ((event: MessageEvent<DiskIOReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: DiskIOMessage[] = [];
  readonly rejectedTypes: Set<DiskIOMessage["type"]> = new Set<DiskIOMessage["type"]>();
  terminated: boolean = false;
  terminateBehavior: FakeDiskIOTerminateBehavior;

  constructor(readonly url: string) {
    for (const type of FakeDiskIOWorker.nextRejectedTypes) this.rejectedTypes.add(type);
    this.terminateBehavior = FakeDiskIOWorker.nextTerminateBehavior;
    FakeDiskIOWorker.nextRejectedTypes = [];
    FakeDiskIOWorker.nextTerminateBehavior = "resolve";
    FakeDiskIOWorker.instances.push(this);
  }

  unref(): void {}

  postMessage(message: DiskIOMessage): void {
    if (this.rejectedTypes.has(message.type)) throw new Error(`rejected ${message.type}`);
    this.messages.push(message);
  }

  /** 刻意不写成 `async`：`throwSync` 要在调用点同步抛出，async 只会返回拒绝的 promise。 */
  terminate(): Promise<number> {
    this.terminated = true;
    if (this.terminateBehavior === "throwSync") {
      throw new Error("terminate failed synchronously");
    }
    if (this.terminateBehavior === "reject") {
      return Promise.reject(new Error("terminate rejected"));
    }
    return Promise.resolve(0);
  }
}

/** 换上替身构造器并清空上一轮实例；返回还原函数，务必在 finally 里调用。 */
export function installFakeDiskIOWorker(): () => void {
  const original: typeof Worker = globalThis.Worker;
  FakeDiskIOWorker.instances.length = 0;
  FakeDiskIOWorker.nextRejectedTypes = [];
  FakeDiskIOWorker.nextTerminateBehavior = "resolve";
  globalThis.Worker = FakeDiskIOWorker as unknown as typeof Worker;
  return (): void => {
    globalThis.Worker = original;
    FakeDiskIOWorker.instances.length = 0;
    FakeDiskIOWorker.nextRejectedTypes = [];
    FakeDiskIOWorker.nextTerminateBehavior = "resolve";
  };
}

/** 取该替身收到的最后一条指定类型消息；没有就是用例前提没成立，直接抛。 */
export function lastDiskIOMessage<TType extends DiskIOMessage["type"]>(
  worker: FakeDiskIOWorker,
  type: TType
): Extract<DiskIOMessage, { type: TType }> {
  const message: DiskIOMessage | undefined = worker.messages.findLast(
    (candidate: DiskIOMessage): boolean => candidate.type === type
  );
  if (message?.type !== type) throw new Error(`missing ${type} message`);
  return message as Extract<DiskIOMessage, { type: TType }>;
}

/** 恢复握手使用的固定运势密钥。 */
export const TEST_LUCK_RECEIPT_SECRET: LuckReceiptSecret = {
  version: 1,
  day: "2026-07-19",
  key: new Uint8Array(32).fill(7).toBase64({ alphabet: "base64url", omitPadding: true }),
};

/** 向指定替身投递一份最小成功恢复载荷。 */
export function emitSuccessfulDiskIOLoad(worker: FakeDiskIOWorker): void {
  worker.onmessage!({ data: {
    type: "loaded",
    aiMemories: new Map(),
    stickerCatalogs: new Map(),
    luckDay: null,
    luckReceiptSecret: TEST_LUCK_RECEIPT_SECRET,
    verifications: new Map(),
    pendingBlockedRemovals: new Map(),
    blocklistEntryCount: 0,
    whitelistEntryCount: 0,
  } } as MessageEvent<DiskIOReply>);
}

/** 回执最新一条 `ensureLuckSecret` 请求；不带 secret 即为失败回执。 */
export function emitDiskIOLuckSecretReply(
  worker: FakeDiskIOWorker,
  payload: { secret?: LuckReceiptSecret; error?: string } = { secret: TEST_LUCK_RECEIPT_SECRET }
): void {
  const request: Extract<DiskIOMessage, { type: "ensureLuckSecret" }> =
    lastDiskIOMessage(worker, "ensureLuckSecret");
  worker.onmessage!({ data: {
    type: "luckSecret",
    requestId: request.requestId,
    ...payload,
  } } as MessageEvent<DiskIOReply>);
}

/**
 * 让当前代际崩溃，并返回自愈建出的下一个替身。
 *
 * 恢复握手的分支几乎都要求「先有一个正在恢复的代际」，而那个代际只能由一次
 * 崩溃产生；把这一步收在这里，用例才不用各自记住 `onerror` 之后去
 * `instances` 的哪一格取新实例。
 */
export function crashDiskIOWorker(
  worker: FakeDiskIOWorker,
  message: string = "boom"
): FakeDiskIOWorker {
  const before: number = FakeDiskIOWorker.instances.length;
  worker.onerror!({ message } as ErrorEvent);
  const next: FakeDiskIOWorker | undefined = FakeDiskIOWorker.instances[before];
  if (next === undefined) throw new Error("crash did not spawn a replacement Worker");
  return next;
}
