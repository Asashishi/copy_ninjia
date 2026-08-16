import type { DiskIOMessage, DiskIOReply } from "../../packages/types/diskIO";
import type { LuckReceiptSecret } from "../../packages/types/diskIO/storage";

/** Disk I/O 主线程桥测试共用的无副作用 Worker 替身。 */
export class FakeDiskIOWorker {
  static readonly instances: FakeDiskIOWorker[] = [];
  onmessage: ((event: MessageEvent<DiskIOReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: DiskIOMessage[] = [];
  readonly rejectedTypes: Set<DiskIOMessage["type"]> = new Set<DiskIOMessage["type"]>();
  terminated: boolean = false;

  constructor(readonly url: string) {
    FakeDiskIOWorker.instances.push(this);
  }

  unref(): void {}

  postMessage(message: DiskIOMessage): void {
    if (this.rejectedTypes.has(message.type)) throw new Error(`rejected ${message.type}`);
    this.messages.push(message);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

/** 恢复握手使用的固定运势密钥。 */
export const TEST_LUCK_RECEIPT_SECRET: LuckReceiptSecret = {
  version: 1,
  day: "2026-07-19",
  key: Buffer.alloc(32, 7).toString("base64url"),
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
