import { logger } from "../../infra/logger";
import type { Sticker, StickerSet } from "@grammyjs/types";
import type { GenerateContentResponse } from "@google/genai";
import { getStickerSet, pickStickerVisionSource } from "./sets";
import { describeMediaForStickerCatalog } from "../imageDescription";
import { requestGeminiResponse } from "../gemini";
import { extractOutputText } from "../utils/geminiResponse";
import { sanitizeInline, truncateAtClauseBoundary } from "../../libs/text";
import { sleep } from "../../libs/sleep";
import { catalogs, dirtyPacks, failedEntries, generatingPacks, packSummaries } from "../../cache/stickers/catalog";
import { transientDescriptionCache } from "../../cache/imageDescription";
import {
  GEMINI_SUMMARY_MODEL,
  SUMMARY_TEMPERATURE,
} from "../../consts/aiChat/memory";
import { STICKER_CATALOG_RETRY_DELAYS_MS, STICKER_PACK_SUMMARY_MAX_CHARS, STICKER_PACK_SUMMARY_MAX_TOKENS } from "../../consts/aiChat/stickers";
import { STICKER_PACK_SUMMARY_PROMPT } from "../../consts/aiChat/prompts/media";
import type { StickerCatalogEntry, StickerCatalogSnapshot } from "../../types/stickers/catalog";
import type { AiStickerCatalogEvent } from "../../types/stickers/protocol";

/**
 * 机器人自己要发的贴纸（config/stickers.json 白名单包）的画面描述目录：
 * file_unique_id -> { emoji, description }，外加一条整包简介（≤200 字，
 * 见 summarizePack）。让 ai/tools/stickers.ts 挑贴纸时能按「画面实际是什么」而非
 * 「作者随手标的 emoji」来判断应景与否；整包简介供两层贴纸工具的第一层
 * （view_sticker_pack）挑包。
 *
 * 生成 + 每次启动的对账：Worker 收到 init 消息后台启动（见
 * ensureStickerCatalogs），对每个包现查一次线上贴纸集合，与持久化目录
 * 双向对比——线上有、目录没有的补（串行逐枚调视觉模型生成，不并发轰
 * Gemini，单次失败退避重试，见 callWithRetry）；目录有、线上已经没有的剪掉（贴纸被移出包/包被整理过，留着只会
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
 * cache/stickers/catalog.ts。本模块是这些原始集合唯一的业务写入方；外部
 * 调用方只能通过本文件导出的查询、恢复与刷盘函数改变目录生命周期。
 */

/** 跑一次贴纸目录的 AI 调用（逐枚视觉解析/整包简介），失败按
 *  STICKER_CATALOG_RETRY_DELAYS_MS 退避重试，间隔用完仍失败返回 null，
 *  由调用方按各自的放弃策略收尾。label 只进英文错误日志，用于定位是
 *  哪个包/哪枚贴纸在抖。 */
async function callWithRetry(label: string, call: () => Promise<string | null>): Promise<string | null> {
  for (let attempt: number = 0; ; attempt++) {
    const result: string | null = await call();
    if (result) return result;
    if (attempt >= STICKER_CATALOG_RETRY_DELAYS_MS.length) return null;
    const delayMs: number = STICKER_CATALOG_RETRY_DELAYS_MS[attempt]!;
    logger.error(`${label} attempt ${attempt + 1} failed; retrying in ${delayMs} ms.`);
    await sleep(delayMs);
  }
}

function getPackMap(pack: string): Map<string, StickerCatalogEntry> {
  let map: Map<string, StickerCatalogEntry> | undefined = catalogs.get(pack);
  if (!map) {
    map = new Map();
    catalogs.set(pack, map);
  }
  return map;
}

/** 把一枚贴纸记进所属包的失败桶（见 cache/stickers/catalog.ts 的 failedEntries）。 */
function markEntryFailed(pack: string, fileUniqueId: string): void {
  let failed: Set<string> | undefined = failedEntries.get(pack);
  if (!failed) {
    failed = new Set();
    failedEntries.set(pack, failed);
  }
  failed.add(fileUniqueId);
}

/** 启动时（或本 Worker 崩溃重启后）灌入持久化的贴纸目录。只对内存里还没
 *  有数据的包生效——重启后本来就全空，天然成立，不会覆盖掉刚生成的条目。
 *  快照全程以序列化 JSON 文本流转（见 types/stickers/protocol.ts 的
 *  AiStickerCatalogEvent.snapshot），这里是整条管线唯一的解析点；文本只
 *  出自 buildSnapshot 的 stringify 或启动恢复时逐字段重建后的重新
 *  stringify，形状可信，解析失败按防御性丢弃处理。 */
export function hydrateStickerCatalogs(snapshots: Map<string, string>): void {
  for (const [pack, snapshotJson] of snapshots) {
    if (catalogs.has(pack)) continue;
    let snapshot: StickerCatalogSnapshot;
    try {
      snapshot = JSON.parse(snapshotJson) as StickerCatalogSnapshot;
    } catch (error: unknown) {
      logger.error(`Failed to parse hydrated sticker catalog snapshot for pack "${pack}", skipping it:`, error);
      continue;
    }
    catalogs.set(pack, new Map(Object.entries(snapshot.entries)));
    // Worker 重启前或极端 FIFO 竞态下，同一 ID 可能曾以普通群贴纸身份进入
    // 临时缓存；常驻目录恢复后立即移除临时副本，保证只有一个权威来源。
    for (const fileUniqueId of Object.keys(snapshot.entries)) {
      transientDescriptionCache.delete(fileUniqueId);
    }
    if (snapshot.summary) packSummaries.set(pack, snapshot.summary);
  }
}

/** 某个白名单包的整包简介；还没生成出来（或生成失败）返回 undefined。 */
export function getPackSummary(pack: string): string | undefined {
  return packSummaries.get(pack);
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

/** 把一个包的目录序列化成可落盘的快照 JSON 文本。stringify 只在这里做
 *  一次，此后全程以字符串流转（理由与格式约定同 workers/aiChatWorker.ts
 *  的 buildMemorySnapshot）。 */
function buildSnapshot(pack: string): string {
  const snapshot: StickerCatalogSnapshot = { version: 1, entries: Object.fromEntries(getPackMap(pack)), summary: packSummaries.get(pack) ?? null, savedAt: Date.now() };
  return JSON.stringify(snapshot, null, 2);
}

/** 把所有 dirty 包的目录快照上报出去（进而经主线程转投 diskIOWorker 落盘），
 *  随后清空 dirty 标记。用回调而不是直接 self.postMessage，避免本模块跟
 *  worker 全局绑死（同 ai/tools/stickers.ts 用 onSent 回调的理由）。 */
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
export function ensureStickerCatalogs(packs: readonly string[]): void {
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
    let entriesChanged: boolean = false;
    for (const fileUniqueId of map.keys()) {
      if (!liveIds.has(fileUniqueId)) {
        map.delete(fileUniqueId);
        // 对账删除必须同时清掉这枚贴纸可能在目录生成前留下的临时描述，
        // 否则消息记录紧接着可能从临时 LRU 缓存读回已经失效的旧值——现行
        // 缓存没有 TTL（见 cache/imageDescription.ts），不删会一直错到被
        // 容量淘汰为止。
        transientDescriptionCache.delete(fileUniqueId);
        entriesChanged = true;
        dirtyPacks.add(pack);
      }
    }
    // 失败记录同样按线上集合剪枝：贴纸被移出包后，它的失败记录留着只会
    // 白占内存（该 id 不会再出现在补齐循环里），一并清掉。
    const failed: Set<string> | undefined = failedEntries.get(pack);
    if (failed) {
      for (const fileUniqueId of failed) {
        if (!liveIds.has(fileUniqueId)) failed.delete(fileUniqueId);
      }
      if (failed.size === 0) failedEntries.delete(pack);
    }

    for (const sticker of set.stickers) {
      if (map.has(sticker.file_unique_id) || failedEntries.get(pack)?.has(sticker.file_unique_id)) continue;

      const source: { fileId: string; fileUniqueId: string } | null = pickStickerVisionSource(sticker);
      if (!source) {
        markEntryFailed(pack, sticker.file_unique_id);
        continue;
      }
      // 白名单目录是常驻权威缓存，不把新条目再塞进 MEDIA_DESCRIPTION_CACHE_MAX
      // 项的临时 LRU 媒体缓存；否则既挤占临时额度，也可能在对账删除后短暂
      // 读到旧描述。
      const description: string | null = await callWithRetry(
        `Sticker catalog description (pack "${pack}", sticker ${sticker.file_unique_id})`,
        () => describeMediaForStickerCatalog(source.fileId)
      );
      if (!description) {
        markEntryFailed(pack, sticker.file_unique_id);
        continue;
      }
      map.set(sticker.file_unique_id, { emoji: sticker.emoji ?? "", description });
      transientDescriptionCache.delete(sticker.file_unique_id);
      entriesChanged = true;
      dirtyPacks.add(pack);
    }

    // 整包简介：包内容有增删（简介可能过时）或者还没有简介（首次生成/上次
    // 生成失败）时（重）生成一条。退避重试用完仍失败则不清掉旧简介——
    // 略过时的简介好过没有，下次启动对账再补。
    if (map.size > 0 && (entriesChanged || !packSummaries.has(pack))) {
      const summary: string | null = await callWithRetry(
        `Sticker pack summary (pack "${pack}")`,
        () => summarizePack(set.title, [...map.values()].map(formatEntryForSummary))
      );
      if (summary) {
        packSummaries.set(pack, summary);
        dirtyPacks.add(pack);
      } else {
        logger.error(`Failed to generate pack summary for sticker pack "${pack}" after retries; layer-1 sticker tool will show a placeholder until next reconcile.`);
      }
    }
  } catch (error: unknown) {
    logger.error(`Error reconciling sticker catalog for pack "${pack}":`, error);
  }
}

/** 目录条目转喂给整包简介模型的一行：情绪 emoji 元数据（如有）在前、画面
 *  描述在后——emoji 是作者标注的情绪意图，能帮总结模型把情绪清单列得更准。 */
function formatEntryForSummary(entry: StickerCatalogEntry): string {
  return entry.emoji ? `${entry.emoji} ${entry.description}` : entry.description;
}

/**
 * 调 Gemini 把一个包内全部贴纸的画面描述（带情绪 emoji 元数据）压缩成一条
 * 整包简介（≤200 字，供两层贴纸工具的第一层挑包用，措辞要求见
 * STICKER_PACK_SUMMARY_PROMPT）。走与冷消息压缩相同的中性总结模型；
 * 产出压成单行并按子句边界截断。失败返回 null（已由 requestGeminiResponse 记日志）。
 */
async function summarizePack(title: string, descriptions: string[]): Promise<string | null> {
  const data: GenerateContentResponse | null = await requestGeminiResponse(
    {
      model: GEMINI_SUMMARY_MODEL,
      contents: [{ role: "user", parts: [{ text: `贴纸包「${title}」内每枚贴纸的画面描述：\n${descriptions.join("\n")}` }] }],
      config: {
        systemInstruction: STICKER_PACK_SUMMARY_PROMPT,
        temperature: SUMMARY_TEMPERATURE,
        maxOutputTokens: STICKER_PACK_SUMMARY_MAX_TOKENS,
      },
    },
    "Gemini sticker pack summary API"
  );
  if (!data) return null;
  const sanitized: string = sanitizeInline(extractOutputText(data));
  if (!sanitized) return null;
  return truncateAtClauseBoundary(sanitized, STICKER_PACK_SUMMARY_MAX_CHARS);
}
