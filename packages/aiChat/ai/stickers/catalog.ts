import { logger } from "../../../infra/logger";
import type { Sticker, StickerSet } from "@grammyjs/types";
import { getStickerSet } from "./sets";
import { pickStickerVisionSource } from "./describe";
import { describeMediaForStickerCatalog } from "../imageDescription";
import { summaryAiProvider } from "../../provider";
import { sanitizeInline, truncateAtClauseBoundary } from "../../../libs/text";
import { sleep } from "../../../libs/sleep";
import { isPlainRecord } from "../../../libs/record";
import {
  catalogs,
  dirtyPacks,
  failedEntries,
  generatingPacks,
  packSummaries,
  stickerCatalogRetryState,
} from "../../../cache/workers/aiChat/stickers/catalog";
import { transientDescriptionCache } from "../../../cache/workers/aiChat/imageDescription";
import { invalidateStickerMenu } from "../../../cache/workers/aiChat/stickers/menu";
import {
  STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS,
  STICKER_CATALOG_RETRY_DELAYS_MS,
  STICKER_CATALOG_RETRY_INTERVAL_MS,
  STICKER_PACK_SUMMARY_ERROR_LABEL,
  STICKER_PACK_SUMMARY_MAX_CHARS,
} from "../../../consts/aiChat/stickers";
import { STICKER_PACK_SUMMARY_PROMPT } from "../../../consts/aiChat/prompts/media";
import type { StickerCatalogEntry, StickerCatalogSnapshot } from "../../../types/stickers/catalog";
import type { AiStickerCatalogEvent } from "../../../types/stickers/protocol";
import type { AiTextResult } from "../../../types/aiChat/provider";

function isStickerCatalogSnapshot(value: unknown): value is StickerCatalogSnapshot {
  if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.entries)) return false;
  if (value.summary !== null && typeof value.summary !== "string") return false;
  if (typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt)) return false;
  return Object.values(value.entries).every((entry: unknown): boolean =>
    isPlainRecord(entry) && typeof entry.emoji === "string" && typeof entry.description === "string"
  );
}

/**
 * 机器人自己要发的贴纸（config/stickers.json 白名单包）的画面描述目录：
 * file_unique_id -> { emoji, description }，外加一条整包简介（≤200 字，
 * 见 summarizePack）。让 aiChat/ai/tools/stickers.ts 挑贴纸时能按「画面实际是什么」而非
 * 「作者随手标的 emoji」来判断应景与否；整包简介供两层贴纸工具的第一层
 * （view_sticker_pack）挑包。
 *
 * 生成 + 每次启动的对账：Worker 收到 init 消息后台启动（见
 * ensureStickerCatalogs），对每个包现查一次线上贴纸集合，与持久化目录
 * 双向对比——线上有、目录没有的补（串行逐枚调视觉模型生成，不并发轰
 * 视觉模型，单次失败退避重试，见 callWithRetry）；目录有、线上已经没有的剪掉（贴纸被移出包/包被整理过，留着只会
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
 * cache/workers/aiChat/stickers/catalog.ts。本模块是这些原始集合唯一的业务写入方；外部
 * 调用方只能通过本文件导出的查询、恢复与刷盘函数改变目录生命周期。
 */

/** 跑一次贴纸目录的 AI 调用（逐枚视觉解析/整包简介）。只有下载/排队失败，
 * 或 HTTP 成功但模型结果不可用时，才按 STICKER_CATALOG_RETRY_DELAYS_MS
 * 重新采样；SDK 已耗尽 HTTP 重试的请求立即停止，避免乘法重试。 */
async function callWithRetry(
  label: string,
  call: () => Promise<AiTextResult>
): Promise<string | null> {
  for (let attempt: number = 0; ; attempt++) {
    const result: AiTextResult = await call();
    if (result.ok) return result.text;
    if (!result.retryable || attempt >= STICKER_CATALOG_RETRY_DELAYS_MS.length) return null;
    const delayMs: number = STICKER_CATALOG_RETRY_DELAYS_MS[attempt]!;
    logger.error(`${label} attempt ${attempt + 1} returned no usable text; resampling in ${delayMs} ms.`);
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

/** 把一枚贴纸记进所属包的失败桶，并压上负缓存到期时刻（见
 *  cache/workers/aiChat/stickers/catalog.ts 的 failedEntries）。 */
function markEntryFailed(pack: string, fileUniqueId: string): void {
  let failed: Map<string, number> | undefined = failedEntries.get(pack);
  if (!failed) {
    failed = new Map();
    failedEntries.set(pack, failed);
  }
  failed.set(fileUniqueId, Date.now() + STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS);
}

/**
 * 这枚贴纸的失败记录是否还在退避期内。已经到期的顺手清掉，让本轮对账当场就能
 * 重描——这正是整包描述失败后目录能自愈的那一步，见 failedEntries 的头注。
 */
function isEntryFailureActive(pack: string, fileUniqueId: string): boolean {
  const failed: Map<string, number> | undefined = failedEntries.get(pack);
  if (failed === undefined) return false;
  const retryAt: number | undefined = failed.get(fileUniqueId);
  if (retryAt === undefined) return false;
  if (Date.now() < retryAt) return true;
  failed.delete(fileUniqueId);
  if (failed.size === 0) failedEntries.delete(pack);
  return false;
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
    try {
      const parsed: unknown = JSON.parse(snapshotJson);
      if (!isStickerCatalogSnapshot(parsed)) throw new Error("unexpected sticker catalog snapshot shape");
      const snapshot: StickerCatalogSnapshot = parsed;
      catalogs.set(pack, new Map(Object.entries(snapshot.entries)));
      invalidateStickerMenu();
      // Worker 重启前或极端 FIFO 竞态下，同一 ID 可能曾以普通群贴纸身份进入
      // 临时缓存；常驻目录恢复后立即移除临时副本，保证只有一个权威来源。
      for (const fileUniqueId of Object.keys(snapshot.entries)) {
        transientDescriptionCache.delete(fileUniqueId);
      }
      if (snapshot.summary) packSummaries.set(pack, snapshot.summary);
    } catch (error: unknown) {
      logger.error(`Failed to hydrate sticker catalog snapshot for pack "${pack}", skipping it:`, error);
      continue;
    }
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
 *  worker 全局绑死（同 aiChat/ai/tools/stickers.ts 用 onSent 回调的理由）。 */
export function flushDirtyStickerCatalogs(post: (event: AiStickerCatalogEvent) => void): void {
  if (dirtyPacks.size === 0) return;
  for (const pack of dirtyPacks) {
    post({ type: "stickerCatalog", pack, snapshot: buildSnapshot(pack) });
  }
  dirtyPacks.clear();
}

/**
 * 后台生成/对账白名单各包的贴纸目录：现查一次线上贴纸集合，双向比对
 * persisted 目录——缺的补（串行逐枚调视觉模型生成，避免并发轰炸供应商）、
 * 多余的剪（见 generatePackCatalog）。fire-and-forget，调用方（Worker 收到
 * init 消息时）不等待；同一个包已在对账/生成中则跳过，重复调用（如 Worker
 * 崩溃重启后重放 init）天然幂等。
 */
export function ensureStickerCatalogs(packs: readonly string[]): void {
  for (const pack of packs) {
    if (generatingPacks.has(pack)) continue;
    const task: Promise<void> = generatePackCatalog(pack).finally((): void => {
      if (generatingPacks.get(pack) === task) generatingPacks.delete(pack);
    });
    generatingPacks.set(pack, task);
  }
}

/**
 * 等待所有已经启动的目录生成任务结算。调用前 Worker 必须停止 init 与维护推力；
 * 循环取快照是为了覆盖当前任务结算回调前已经登记的后续任务。
 */
export async function drainStickerCatalogTasks(): Promise<void> {
  while (generatingPacks.size > 0) {
    await Promise.allSettled([...generatingPacks.values()]);
  }
}

/**
 * 维护节拍上的补账：把还没建起来的包再对账一次。
 *
 * `ensureStickerCatalogs` 生产路径上只有 Worker 收到 init 那一次调用，而
 * `generatePackCatalog` 在 `getStickerSet` 失败时是整包放弃的——首次部署
 * （memory/stickers/ 为空）撞上一次几秒的网络抖动，`catalogs` 就永久为空：
 * `buildStickerPackMenu` 每个包都在「没有贴纸」处丢掉，view_sticker_pack 与
 * send_sticker 两个工具对所有回复返回 null，而 systemd 托管的进程可能几周都
 * 不重启。整包简介缺失同理——那条日志自己写着「等下次对账」，可下次对账
 * 在改这里之前根本不存在。
 *
 * 只挑「目录为空或没有简介」的包重试：正常跑起来之后这里每轮都是一次
 * O(包数) 的判空，不打任何请求（贴纸集合在本进程内是无 TTL 缓存）。
 * @param now 注入时钟，便于测试。
 */
export function retryIncompleteStickerCatalogs(packs: readonly string[], now: number = Date.now()): void {
  // 0 表示本进程还没在这条路上试过（init 那次不算）：第一个维护节拍就补一次，
  // 不等满一个间隔——启动时整包失败的话，那一个间隔全程两个贴纸工具都是废的。
  if (
    stickerCatalogRetryState.lastAttemptAt !== 0 &&
    now - stickerCatalogRetryState.lastAttemptAt < STICKER_CATALOG_RETRY_INTERVAL_MS
  ) {
    return;
  }
  const incomplete: string[] = packs.filter((pack: string): boolean =>
    (catalogs.get(pack)?.size ?? 0) === 0 || !packSummaries.has(pack));
  if (incomplete.length === 0) return;
  stickerCatalogRetryState.lastAttemptAt = now;
  ensureStickerCatalogs(incomplete);
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
    const liveIds: Set<string> = new Set(set.stickers.map((sticker: Sticker): string => sticker.file_unique_id));
    let entriesChanged: boolean = false;
    for (const fileUniqueId of map.keys()) {
      if (!liveIds.has(fileUniqueId)) {
        map.delete(fileUniqueId);
        // 对账删除必须同时清掉这枚贴纸可能在目录生成前留下的临时描述，
        // 否则消息记录紧接着可能从临时 LRU 缓存读回已经失效的旧值——现行
        // 缓存没有 TTL（见 cache/workers/aiChat/imageDescription.ts），不删会一直错到被
        // 容量淘汰为止。
        transientDescriptionCache.delete(fileUniqueId);
        entriesChanged = true;
        dirtyPacks.add(pack);
        invalidateStickerMenu();
      }
    }
    // 失败记录同样按线上集合剪枝：贴纸被移出包后，它的失败记录留着只会
    // 白占内存（该 id 不会再出现在补齐循环里），一并清掉。
    const failed: Map<string, number> | undefined = failedEntries.get(pack);
    if (failed) {
      for (const fileUniqueId of failed.keys()) {
        if (!liveIds.has(fileUniqueId)) failed.delete(fileUniqueId);
      }
      if (failed.size === 0) failedEntries.delete(pack);
    }

    for (const sticker of set.stickers) {
      if (map.has(sticker.file_unique_id) || isEntryFailureActive(pack, sticker.file_unique_id)) continue;

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
        (): Promise<AiTextResult> => describeMediaForStickerCatalog(source.fileId)
      );
      if (!description) {
        markEntryFailed(pack, sticker.file_unique_id);
        continue;
      }
      map.set(sticker.file_unique_id, { emoji: sticker.emoji ?? "", description });
      transientDescriptionCache.delete(sticker.file_unique_id);
      entriesChanged = true;
      dirtyPacks.add(pack);
      invalidateStickerMenu();
    }

    // 整包简介：包内容有增删（简介可能过时）或者还没有简介（首次生成/上次
    // 生成失败）时（重）生成一条。退避重试用完仍失败则不清掉旧简介——
    // 略过时的简介好过没有，下次启动对账再补。
    if (map.size > 0 && (entriesChanged || !packSummaries.has(pack))) {
      const summary: string | null = await callWithRetry(
        `Sticker pack summary (pack "${pack}")`,
        (): Promise<AiTextResult> => summarizePack(set.title, [...map.values()].map(formatEntryForSummary))
      );
      if (summary) {
        packSummaries.set(pack, summary);
        dirtyPacks.add(pack);
        invalidateStickerMenu();
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
 * 调当前供应商把一个包内全部贴纸的画面描述（带情绪 emoji 元数据）压缩成一条
 * 整包简介（≤200 字，供两层贴纸工具的第一层挑包用，措辞要求见
 * STICKER_PACK_SUMMARY_PROMPT）。走与冷消息压缩相同的中性总结模型；
 * 产出压成单行并按子句边界截断；结果同时声明业务层是否允许重新采样。
 */
async function summarizePack(title: string, descriptions: string[]): Promise<AiTextResult> {
  return summaryAiProvider().generateText({
    purpose: "stickerPackSummary",
    systemPrompt: STICKER_PACK_SUMMARY_PROMPT,
    userContent: `贴纸包「${title}」内每枚贴纸的画面描述：\n${descriptions.join("\n")}`,
    errorLabel: STICKER_PACK_SUMMARY_ERROR_LABEL,
    normalize: (text: string): string => {
      const sanitized: string = sanitizeInline(text);
      return sanitized ? truncateAtClauseBoundary(sanitized, STICKER_PACK_SUMMARY_MAX_CHARS) : "";
    },
  });
}
