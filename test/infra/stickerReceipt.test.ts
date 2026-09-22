import { expect, test } from "bun:test";
import { diskIORuntime } from "../../packages/cache/main/diskIO";
import { initDiskIO, loadPersistedData, onStickerCatalogPersisted, terminateDiskIO } from "../../packages/infra/diskIO";
import type { StickerCatalogPersistedReply, DiskIOReply } from "../../packages/types/diskIO/replies";
import { emitSuccessfulDiskIOLoad, FakeDiskIOWorker, installFakeDiskIOWorker } from "../helpers/diskIOWorkerHarness";

test("贴纸 durable 回执只来自当前 Worker，终止后的旧代不能释放镜像", async (): Promise<void> => {
  const restore: () => void = installFakeDiskIOWorker();
  const listeners: ((reply: StickerCatalogPersistedReply) => void)[] = [...diskIORuntime.stickerCatalogPersistedListeners];
  const seen: StickerCatalogPersistedReply[] = [];
  try {
    initDiskIO();
    const worker: FakeDiskIOWorker = FakeDiskIOWorker.instances[0]!;
    const loading: ReturnType<typeof loadPersistedData> = loadPersistedData(1_000);
    emitSuccessfulDiskIOLoad(worker);
    await loading;
    onStickerCatalogPersisted((reply: StickerCatalogPersistedReply): void => { seen.push(reply); });
    const reply: StickerCatalogPersistedReply = { type: "stickerCatalogPersisted", pack: "pack", revision: 3 };
    worker.onmessage!({ data: reply } as MessageEvent<DiskIOReply>);
    expect(seen).toEqual([reply]);
    await terminateDiskIO();
    worker.onmessage!({ data: reply } as MessageEvent<DiskIOReply>);
    expect(seen).toEqual([reply]);
  } finally {
    await terminateDiskIO();
    diskIORuntime.stickerCatalogPersistedListeners.splice(0, diskIORuntime.stickerCatalogPersistedListeners.length, ...listeners);
    restore();
  }
});
