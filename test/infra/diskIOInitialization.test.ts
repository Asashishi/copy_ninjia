import { describe, expect, spyOn, test } from "bun:test";
import type { DiskIOMessage, DiskIOReply, LuckDrawDiskMessage, VerificationPersistedReply } from "../../src/types";

const diskIO = await import("../../src/infra/diskIO");
const { superviseWorker } = await import("../../src/libs/supervisedWorker");

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<DiskIOReply>) => void) | null = null;
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

const luckDraw: LuckDrawDiskMessage = {
  type: "luckDraw",
  day: "2026-07-19",
  key: "42",
  label: "大吉",
  fortunePercent: 99,
};

describe("explicit Worker initialization", () => {
  test("imports are inert; init, handshakes, stale guards, and respawn replay are deterministic", async () => {
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(FakeWorker.instances).toHaveLength(0);
      diskIO.initDiskIO();
      diskIO.initDiskIO();
      expect(FakeWorker.instances).toHaveLength(1);
      const first: FakeWorker = FakeWorker.instances[0]!;

      const loadedPromise = diskIO.loadPersistedData(1_000);
      expect(first.messages.at(-1)).toEqual({ type: "load" });
      first.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map([[1, "memory"]]),
        stickerCatalogs: new Map([["pack", "catalog"]]),
        luckDay: null,
        verifications: new Map(),
      } } as MessageEvent<DiskIOReply>);
      expect(await loadedPromise).toMatchObject({
        aiMemories: new Map([[1, "memory"]]),
        stickerCatalogs: new Map([["pack", "catalog"]]),
      });

      const flushPromise = diskIO.flushDiskIO(1_000);
      const flush = first.messages.at(-1)!;
      expect(flush.type).toBe("flush");
      first.onmessage!({ data: { type: "flushed", flushedId: flush.type === "flush" ? flush.flushId : -1 } } as MessageEvent<DiskIOReply>);
      await flushPromise;

      const persisted: VerificationPersistedReply[] = [];
      diskIO.onVerificationPersisted((reply) => { persisted.push(reply); });
      const ack: VerificationPersistedReply = {
        type: "verificationPersisted",
        key: "-1001:42",
        generation: 1,
        revision: 2,
        deleted: true,
      };
      first.onmessage!({ data: ack } as MessageEvent<DiskIOReply>);
      expect(persisted).toEqual([ack]);

      let respawns: number = 0;
      diskIO.onDiskIORespawn(() => {
        respawns++;
        diskIO.postDiskIO(luckDraw);
      });
      first.onerror!({ message: "boom" } as ErrorEvent);
      expect(FakeWorker.instances).toHaveLength(2);
      const second: FakeWorker = FakeWorker.instances[1]!;
      expect(respawns).toBe(1);
      expect(second.messages).toEqual([{ type: "load" }, luckDraw]);

      first.onmessage!({ data: { ...ack, revision: 99 } } as MessageEvent<DiskIOReply>);
      expect(persisted).toEqual([ack]);

      let supervisedConstructed: number = FakeWorker.instances.length;
      const handle = superviseWorker({ url: "fake-worker.ts", label: "fake", giveUpConsequence: "none" });
      expect(FakeWorker.instances.length).toBe(supervisedConstructed);
      handle.init();
      supervisedConstructed++;
      handle.init();
      expect(FakeWorker.instances.length).toBe(supervisedConstructed);
    } finally {
      error.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });
});
