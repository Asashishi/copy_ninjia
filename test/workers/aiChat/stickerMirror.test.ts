import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { diskIOStub } from "../../helpers/diskIOMock";
import { latestStickerCatalogs } from "../../../packages/cache/main/aiChat";
import { pendingStickerCatalogRevisions } from "../../../packages/cache/main/stickers";
import { adoptStickerConfig, getStickerConfig } from "../../../packages/config/stickers";
import type { DiskBusinessMessage, DiskIORespawnListener } from "../../../packages/types/diskIO/messages";
import type { StickerCatalogPersistedReply } from "../../../packages/types/diskIO/replies";
import type * as StickerMirror from "../../../packages/aiChat/stickerMirror";

const posts: DiskBusinessMessage[] = [];
let receipt: (reply: StickerCatalogPersistedReply) => void;
let replay: DiskIORespawnListener;
mock.module("../../../packages/infra/diskIO", (): unknown => diskIOStub({
  postDiskIO: (message: DiskBusinessMessage): boolean => { posts.push(message); return true; },
  onStickerCatalogPersisted: (callback: typeof receipt): void => { receipt = callback; },
  onDiskIORespawn: (owner: string, _priority: number, callback: DiskIORespawnListener): void => {
    if (owner === "AI memory") replay = callback;
  },
}));
const { activeStickerCatalogs, mirrorStickerCatalog, pruneStickerCatalogMirror }: typeof StickerMirror = await import("../../../packages/aiChat/stickerMirror");
await import("../../../packages/aiChat/memoryMirror");
const previousConfig: ReturnType<typeof getStickerConfig> = getStickerConfig();

beforeEach((): void => {
  posts.length = 0;
  latestStickerCatalogs.clear();
  pendingStickerCatalogRevisions.clear();
  adoptStickerConfig({ packs: ["pack_a"] });
});
afterEach((): void => {
  latestStickerCatalogs.clear();
  pendingStickerCatalogRevisions.clear();
  adoptStickerConfig(previousConfig);
});

function acknowledge(pack: string, revision: number = pendingStickerCatalogRevisions.get(pack)!): void {
  receipt({ type: "stickerCatalogPersisted", pack, revision });
}

test("白名单过滤保留镜像顺序，不随配置顺序改变跨包描述的优先级", (): void => {
  latestStickerCatalogs.set("pack_b", "second");
  latestStickerCatalogs.set("retired", "removed");
  latestStickerCatalogs.set("pack_a", "first");
  adoptStickerConfig({ packs: ["pack_a", "pack_b"] });
  expect([...activeStickerCatalogs()]).toEqual([["pack_b", "second"], ["pack_a", "first"]]);
  expect([...latestStickerCatalogs.keys()]).toEqual(["pack_b", "retired", "pack_a"]);
});

test("退出配置的待写快照仅向 Disk I/O 重放，durable 后释放", async (): Promise<void> => {
  mirrorStickerCatalog("pack_a", "snapshot");
  const revision: number = pendingStickerCatalogRevisions.get("pack_a")!;
  adoptStickerConfig({ packs: [] });
  pruneStickerCatalogMirror([]);
  expect(latestStickerCatalogs.size).toBe(1);
  expect(activeStickerCatalogs().size).toBe(0);
  const replayed: DiskBusinessMessage[] = [];
  expect(await replay({
    post: (message: DiskBusinessMessage): boolean => { replayed.push(message); return true; },
    ensureLuckReceiptSecret: async (): Promise<never> => { throw new Error("Unexpected request"); },
  })).toBeTrue();
  expect(replayed).toEqual([{ type: "stickerCatalog", pack: "pack_a", snapshot: "snapshot", revision }]);
  acknowledge("pack_a");
  expect(latestStickerCatalogs.size).toBe(0);
  expect(pendingStickerCatalogRevisions.size).toBe(0);
});

test("旧回执不能释放较新快照；移除并重加不复用编号", (): void => {
  mirrorStickerCatalog("pack_a", "old");
  const old: number = pendingStickerCatalogRevisions.get("pack_a")!;
  mirrorStickerCatalog("pack_a", "new");
  const current: number = pendingStickerCatalogRevisions.get("pack_a")!;
  adoptStickerConfig({ packs: [] });
  acknowledge("pack_a", old);
  expect(latestStickerCatalogs.get("pack_a")).toBe("new");
  expect(pendingStickerCatalogRevisions.get("pack_a")).toBe(current);
  acknowledge("pack_a", current);
  adoptStickerConfig({ packs: ["pack_a"] });
  mirrorStickerCatalog("pack_a", "returned");
  acknowledge("pack_a", current);
  expect(pendingStickerCatalogRevisions.get("pack_a")).toBeGreaterThan(current);
  acknowledge("pack_a");
  expect(activeStickerCatalogs().get("pack_a")).toBe("returned");
  adoptStickerConfig({ packs: [] });
  pruneStickerCatalogMirror([]);
  expect(latestStickerCatalogs.size).toBe(0);
});

test("配置轮换与迟到快照结算后镜像不积累历史包", (): void => {
  for (let index: number = 0; index < 100; index++) {
    const pack: string = `pack_${index}`;
    adoptStickerConfig({ packs: [pack] });
    pruneStickerCatalogMirror([pack]);
    mirrorStickerCatalog(pack, "snapshot");
    acknowledge(pack);
    expect(latestStickerCatalogs.size).toBe(1);
    expect(pendingStickerCatalogRevisions.size).toBe(0);
  }
  mirrorStickerCatalog("late_pack", "late");
  acknowledge("late_pack");
  expect(latestStickerCatalogs.size).toBe(1);
});
