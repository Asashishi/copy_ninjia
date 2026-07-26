import { describe, expect, spyOn, test } from "bun:test";
import type { DiskIOMessage, DiskIOReply, LogEnvelope } from "../../packages/types";

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

const diskIO = await import("../../packages/infra/diskIO");
const { logger } = await import("../../packages/infra/logger");

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
        blockedUsers: new Map(),
        pendingBlockedRemovals: new Map(),
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

  test("字符串参数与 Error 可枚举字段里的敏感值都被脱敏后才进控制台与落盘", () => {
    const token: string = process.env.TELEGRAM_BOT_TOKEN!;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      // 字符串走的是不经 JSON 往返的快路径；对象/Error 仍走序列化后整份脱敏。
      logger.error(`download failed: https://api.telegram.org/file/bot${token}/photo.jpg`);
      const stringArg: unknown = consoleError.mock.calls.at(-1)![0];
      expect(stringArg).toBe("download failed: https://api.telegram.org/file/bot[REDACTED]/photo.jpg");
      expect(String(stringArg)).not.toContain(token);

      const failure = Object.assign(new Error("fetch failed"), {
        path: `https://api.telegram.org/file/bot${token}/photo.jpg`,
      });
      logger.error("boom", failure);
      const errorArg = consoleError.mock.calls.at(-1)![1] as { path: string; message: string };
      expect(errorArg.message).toBe("fetch failed");
      expect(errorArg.path).toBe("https://api.telegram.org/file/bot[REDACTED]/photo.jpg");
      expect(JSON.stringify(errorArg)).not.toContain(token);
    } finally {
      consoleError.mockRestore();
    }
  });
});
