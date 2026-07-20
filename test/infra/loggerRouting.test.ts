import { describe, expect, spyOn, test } from "bun:test";
import type { DiskIOMessage, DiskIOReply, LogEnvelope } from "../../src/types";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: DiskIOMessage[] = [];

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }

  unref(): void {}

  postMessage(message: DiskIOMessage): void {
    this.messages.push(message);
  }
}

const diskIO = await import("../../src/infra/diskIO");
const { logger } = await import("../../src/infra/logger");

describe("logger persistence routing boundary", () => {
  test("初始化前只写控制台，完整恢复成功后 error 才转投唯一落盘 Worker", async () => {
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const consoleInfo = spyOn(console, "info").mockImplementation(() => {});
    try {
      logger.error("before-lock");
      expect(consoleError).toHaveBeenCalledWith("before-lock");
      expect(FakeWorker.instances).toHaveLength(0);

      diskIO.initDiskIO();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      logger.info("console-only");
      expect(consoleInfo).toHaveBeenCalledWith("console-only");
      expect(worker.messages).toHaveLength(0);

      const loaded = diskIO.loadPersistedData(1_000);
      expect(worker.messages).toEqual([{ type: "load" }]);
      worker.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret: {
          version: 1,
          day: "2026-07-20",
          key: Buffer.alloc(32, 1).toString("base64url"),
        },
        verifications: new Map(),
      } satisfies DiskIOReply } as MessageEvent<DiskIOReply>);
      await loaded;
      worker.messages.length = 0;

      logger.error("after-lock", new Error("persist me"));
      expect(worker.messages).toHaveLength(1);
      const message: DiskIOMessage = worker.messages[0]!;
      expect(message.type).toBe("log");
      const log = message as LogEnvelope;
      expect(log.level).toBe("error");
      expect(log.args[0]).toBe("after-lock");
      expect(log.args[1]).toMatchObject({ name: "Error", message: "persist me" });
    } finally {
      consoleInfo.mockRestore();
      consoleError.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });
});
