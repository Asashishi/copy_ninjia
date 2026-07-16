import { logger } from "../infra/logger";
import type { Sticker, StickerSet } from "@grammyjs/types";
import { getStickerSet, pickStickerVisionSource } from "./stickerSets";
import { describeMedia } from "./imageDescription";
import { catalogs, dirtyPacks, failedEntries, generatingPacks } from "../cache/stickerCatalog";
import type { AiStickerCatalogEvent, StickerCatalogEntry, StickerCatalogSnapshot } from "../types";

/**
 * 机器人自己要发的贴纸（config/stickers.json 白名单包）的画面描述目录：
 * file_unique_id -> { emoji, description }。让 ai/stickers.ts 挑贴纸时能
 * 按「画面实际是什么」而非「作者随手标的 emoji」来判断应景与否。
 *
 * 生成 + 每次启动的对账：Worker 收到 init 消息后台启动（见
 * ensureStickerCatalogs），对每个包现查一次线上贴纸集合，与持久化目录
 * 双向对比——线上有、目录没有的补（串行逐枚调视觉模型生成，不并发轰
 * Gemini）；目录有、线上已经没有的剪掉（贴纸被移出包/包被整理过，留着只会
 * 让 getCatalogEntry 对一枚发不出去的贴纸给出「有效」描述）。查线上失败
 * 时整包跳过、不补也不剪，保留现状等下次启动重试——不能把「拉取失败」
 * 误判成「包被清空了」进而把好端端的目录铲掉。
 *
 * 有更新（补或剪）就标 dirty；aiChatWorker.ts 定期把 dirty 包上报给主
 * 线程，经 diskIOWorker 落盘到 memory/stickers/<pack>.json，重启后由
 * hydrateStickerCatalogs 灌回、已有描述的贴纸不重新生成。整包级别的对账
 * （白名单里整个移除了某个包）不在这里——那是启动读盘时的事，见
 * workers/diskIO/snapshotFiles.ts 的 recoverStickerCatalogs。
 *
 * 内存态（catalogs/dirtyPacks/failedEntries/generatingPacks）见
 * cache/stickerCatalog.ts。
 */

function getPackMap(pack: string): Map<string, StickerCatalogEntry> {
  let map: Map<string, StickerCatalogEntry> | undefined = catalogs.get(pack);
  if (!map) {
    map = new Map();
    catalogs.set(pack, map);
  }
  return map;
}

/** 启动时（或本 Worker 崩溃重启后）灌入持久化的贴纸目录。只对内存里还没
 *  有数据的包生效——重启后本来就全空，天然成立，不会覆盖掉刚生成的条目。 */
export function hydrateStickerCatalogs(snapshots: Map<string, StickerCatalogSnapshot>): void {
  for (const [pack, snapshot] of snapshots) {
    if (catalogs.has(pack)) continue;
    catalogs.set(pack, new Map(Object.entries(snapshot.entries)));
  }
}

/** 按贴纸自身的 file_unique_id 跨包合并查找目录条目——群聊里群友发的贴纸
 *  若恰好来自白名单包，直接复用已生成的描述，省一次视觉调用。 */
export function getCatalogEntry(fileUniqueId: string): StickerCatalogEntry | undefined {
  for (const map of catalogs.values()) {
    const entry: StickerCatalogEntry | undefined = map.get(fileUniqueId);
    if (entry) return entry;
  }
  return undefined;
}

function buildSnapshot(pack: string): StickerCatalogSnapshot {
  return { version: 1, entries: Object.fromEntries(getPackMap(pack)), savedAt: Date.now() };
}

/** 把所有 dirty 包的目录快照上报出去（进而经主线程转投 diskIOWorker 落盘），
 *  随后清空 dirty 标记。用回调而不是直接 self.postMessage，避免本模块跟
 *  worker 全局绑死（同 ai/stickers.ts 用 onSent 回调的理由）。 */
export function flushDirtyStickerCatalogs(post: (event: AiStickerCatalogEvent) => void): void {
  if (dirtyPacks.size === 0) return;
  for (const pack of dirtyPacks) {
    post({ type: "stickerCatalog", pack, snapshot: buildSnapshot(pack) });
  }
  dirtyPacks.clear();
}

/**
 * 后台生成/对账白名单各包的贴纸目录：现查一次线上贴纸集合，双向比对
 * persisted 目录——缺的补（串行逐枚调视觉模型生成，避免并发轰炸 Gemini）、
 * 多余的剪（见 generatePackCatalog）。fire-and-forget，调用方（Worker 收到
 * init 消息时）不等待；同一个包已在对账/生成中则跳过，重复调用（如 Worker
 * 崩溃重启后重放 init）天然幂等。
 */
export function ensureStickerCatalogs(packs: string[]): void {
  for (const pack of packs) {
    if (generatingPacks.has(pack)) continue;
    generatingPacks.add(pack);
    void generatePackCatalog(pack).finally(() => generatingPacks.delete(pack));
  }
}

/**
 * 对账单个包：线上有、目录没有的补；目录有、线上已经没有的剪（贴纸被移出
 * 包/包被整理过，留着只会让 getCatalogEntry 对一枚发不出去的贴纸给出
 * 「有效」描述，属于陈旧数据）。
 *
 * 查线上（getStickerSet）失败返回 null——与「包确实没有任何贴纸」这种
 * 现实中不会出现的情形是两回事，必须严格区分：失败就整包跳过、不补也
 * 不剪，保留现状等下次启动重试，绝不能把网络失败误判成「贴纸都被删了」
 * 进而清空一个好端端的目录。
 *
 * 导出仅为可测试性（单测需要等它跑完才能断言 catalogs 的最终状态，
 * ensureStickerCatalogs 是 fire-and-forget 的公开入口，拿不到这个句柄）；
 * 生产代码路径统一走 ensureStickerCatalogs。
 */
export async function generatePackCatalog(pack: string): Promise<void> {
  try {
    const set: StickerSet | null = await getStickerSet(pack);
    if (!set) return;

    const map: Map<string, StickerCatalogEntry> = getPackMap(pack);
    const liveIds: Set<string> = new Set(set.stickers.map((sticker: Sticker) => sticker.file_unique_id));
    for (const fileUniqueId of map.keys()) {
      if (!liveIds.has(fileUniqueId)) {
        map.delete(fileUniqueId);
        dirtyPacks.add(pack);
      }
    }

    for (const sticker of set.stickers) {
      if (map.has(sticker.file_unique_id) || failedEntries.has(sticker.file_unique_id)) continue;

      const source: { fileId: string; fileUniqueId: string } | null = pickStickerVisionSource(sticker);
      if (!source) {
        failedEntries.add(sticker.file_unique_id);
        continue;
      }
      const description: string | null = await describeMedia("sticker", source.fileId, source.fileUniqueId);
      if (!description) {
        failedEntries.add(sticker.file_unique_id);
        continue;
      }
      map.set(sticker.file_unique_id, { emoji: sticker.emoji ?? "", description });
      dirtyPacks.add(pack);
    }
  } catch (error: unknown) {
    logger.error(`Error reconciling sticker catalog for pack "${pack}":`, error);
  }
}
