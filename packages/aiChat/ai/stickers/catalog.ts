import { logger } from "../../../infra/logger";
import { getStickerConfig } from "../../../config/stickers";
import type { Sticker, StickerSet } from "grammy/types";
import { getStickerSet } from "./sets";
import { pickStickerVisionSource } from "./describe";
import { describeMediaForStickerCatalog } from "../imageDescription";
import { summaryAiProvider } from "../../provider";
import { invalidInput } from "../../../libs/inputValidation";
import { parseStickerCatalogSnapshot } from "../../../libs/persistedSnapshotCodec";
import { sanitizeInline, truncateAtClauseBoundary } from "../../../libs/text";
import { sleep } from "../../../libs/sleep";
import {
  catalogs,
  dirtyPacks,
  failedEntries,
  generatingPacks,
  packSummaries,
  stickerCatalogRetryState,
} from "../../../cache/workers/aiChat/stickers/catalog";
import { transientDescriptionCache } from "../../../cache/workers/aiChat/imageDescription";
import { aiChatWorkerAbortController } from "../../../cache/workers/aiChat/worker";
import { invalidateStickerMenu } from "../../../cache/workers/aiChat/stickers/menu";
import {
  STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS,
  STICKER_CATALOG_RETRY_DELAYS_MS,
  STICKER_CATALOG_RETRY_INTERVAL_MS,
  STICKER_PACK_NAME_PATTERN,
  STICKER_PACK_SUMMARY_ERROR_LABEL,
  STICKER_PACK_SUMMARY_MAX_CHARS,
} from "../../../consts/aiChat/stickers";
import { STICKER_PACK_SUMMARY_PROMPT } from "../../../consts/aiChat/prompts/media";
import type { StickerCatalogEntry, StickerCatalogSnapshot } from "../../../types/stickers/catalog";
import type { AiStickerCatalogEvent } from "../../../types/stickers/protocol";
import type { AiTextResult } from "../../../types/aiChat/provider";

interface ParsedStickerCatalog {
  readonly pack: string;
  readonly snapshot: StickerCatalogSnapshot;
}

/**
 * 机器人自己要发的贴纸（config/dynamic/stickers.json 白名单包）的画面描述目录：
 * file_unique_id -> { emoji, description }，外加一条整包简介（≤200 字，
 * 见 summarizePack）。让 aiChat/ai/tools/stickers.ts 挑贴纸时能按「画面实际是什么」而非
 * 「作者随手标的 emoji」来判断应景与否；整包简介供两层贴纸工具的第一层
 * （view_sticker_pack）挑包。
 *
 * init、配置重载与维护重试通过 ensureStickerCatalogs 启动包级对账，
 * getStickerSet 提供当前缓存或线上拉取的集合。目录缺失的贴纸串行生成描述，
 * 已移出集合的条目剪枝；集合拉取失败时整包跳过、不补也不剪。
 *
 * 有更新（补或剪）就标 dirty；aiChatWorker.ts 定期把 dirty 包上报给主
 * 线程，经 diskIOWorker 落盘到 memory/stickers/<pack>.json，重启后由
 * hydrateStickerCatalogs 灌回、已有描述的贴纸不重新生成。退出白名单的内存目录
 * 由 pruneStickerCatalogs 清理，目录文件由 Disk I/O 启动恢复时对账；
 * 生命周期约束见 docs/cn/04-invariants.md。
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
  call: () => Promise<AiTextResult>,
  signal: AbortSignal
): Promise<string | null> {
  for (let attempt: number = 0; ; attempt++) {
    if (signal.aborted) return null;
    const result: AiTextResult = await call();
    if (signal.aborted) return null;
    if (result.ok) return result.text;
    if (!result.retryable || attempt >= STICKER_CATALOG_RETRY_DELAYS_MS.length) return null;
    const delayMs: number = STICKER_CATALOG_RETRY_DELAYS_MS[attempt]!;
    logger.error(`${label} attempt ${attempt + 1} returned no usable text; resampling in ${delayMs} ms.`);
    await sleep(delayMs, signal);
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
 *  stringify。整批先使用与 Disk I/O 相同的严格 decoder 校验，任一项非法都
 *  让 Worker 失败，不能把协议损坏解释成缺少目录后继续运行。 */
export function hydrateStickerCatalogs(snapshots: Map<string, string>): void {
  const parsedCatalogs: ParsedStickerCatalog[] = [];
  for (const [pack, snapshotJson] of snapshots) {
    if (!STICKER_PACK_NAME_PATTERN.test(pack)) {
      return invalidInput(
        "Sticker catalog hydrate payload",
        "$.catalogs.<key>",
        "a canonical sticker pack short name"
      );
    }
    const snapshot: StickerCatalogSnapshot = parseStickerCatalogSnapshot(
      snapshotJson,
      `Sticker catalog hydrate payload for pack ${pack}`
    );
    parsedCatalogs.push({ pack, snapshot });
  }
  for (const { pack, snapshot } of parsedCatalogs) {
    if (catalogs.has(pack)) continue;
    catalogs.set(pack, new Map(Object.entries(snapshot.entries)));
    invalidateStickerMenu();
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
 *  一次，此后全程以字符串流转（格式约定同 workers/aiChatWorker.ts
 *  的 buildMemorySnapshot）。 */
function buildSnapshot(pack: string): string {
  const snapshot: StickerCatalogSnapshot = { version: 1, entries: Object.fromEntries(getPackMap(pack)), summary: packSummaries.get(pack) ?? null, savedAt: Date.now() };
  return JSON.stringify(snapshot, null, 2);
}

/** 上报所有 dirty 包的快照，由主线程转投 Disk I/O Worker；全部上报成功后清空
 *  dirty 标记并剪枝已退出白名单的目录。回调抛错时保留标记，供后续重新上报。 */
export function flushDirtyStickerCatalogs(post: (event: AiStickerCatalogEvent) => void): void {
  if (dirtyPacks.size === 0) return;
  for (const pack of dirtyPacks) {
    post({ type: "stickerCatalog", pack, snapshot: buildSnapshot(pack) });
  }
  dirtyPacks.clear();
  pruneStickerCatalogs(getStickerConfig().packs);
}

/**
 * 后台生成/对账白名单各包的贴纸目录：通过 getStickerSet 取得集合，
 * 缺项串行生成、多余条目剪枝。调用方不等待；同包已有任务时跳过，
 * 任务结算后按当前白名单重试清理。取消与停机约束见 docs/cn/04-invariants.md。
 */
export function ensureStickerCatalogs(packs: readonly string[]): void {
  const signal: AbortSignal = aiChatWorkerAbortController.current.signal;
  for (const pack of packs) {
    if (generatingPacks.has(pack)) continue;
    const task: Promise<void> = generatePackCatalog(pack, signal).finally((): void => {
      if (generatingPacks.get(pack) === task) generatingPacks.delete(pack);
      pruneStickerCatalogs(getStickerConfig().packs);
    });
    generatingPacks.set(pack, task);
  }
}

/** 已退出白名单、无生成任务且无待上报快照的包可以释放。 */
function isStalePack(pack: string, active: ReadonlySet<string>): boolean {
  return !active.has(pack) && !generatingPacks.has(pack) && !dirtyPacks.has(pack);
}

/**
 * 按新的白名单剪掉已下架包的目录、简介与失败记录；生成中及待上报包继续保留。
 * 热重载替换 config/dynamic/stickers.json 后由 workers/aiChat/configReload.ts 调用，维护节拍
 * （workers/aiChatWorker.ts）再兜一次。剪掉任何东西都让贴纸菜单失效。
 *
 * 生成与上报责任结束后，getCatalogEntry 不再复用已下架包的目录。
 * 不删 memory/stickers/<pack>.json：文件对账由下一次 Disk I/O 启动恢复执行。
 * 已释放的包在同一进程内重新加入时，由生成任务重新建立目录。
 *
 * 任务结算、快照上报后立即重试清理；维护节拍再核对一次。
 */
export function pruneStickerCatalogs(activePacks: readonly string[]): void {
  const active: ReadonlySet<string> = new Set(activePacks);
  let dropped: boolean = false;
  for (const pack of catalogs.keys()) {
    if (!isStalePack(pack, active)) continue;
    catalogs.delete(pack);
    dropped = true;
  }
  for (const pack of packSummaries.keys()) {
    if (isStalePack(pack, active)) packSummaries.delete(pack);
  }
  for (const pack of failedEntries.keys()) {
    if (isStalePack(pack, active)) failedEntries.delete(pack);
  }
  if (dropped) invalidateStickerMenu();
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
 * 维护节拍按重试间隔选择目录为空、简介缺失或单枚失败负缓存到期的包。
 * 复用 ensureStickerCatalogs 的包级并发去重；完整且无失败记录的包不请求出站。
 * 缺项由目录生成循环按既有 TTL 补齐，取消与持久化约束见 docs/cn/04-invariants.md。
 * @param now 注入时钟，便于测试。
 */
export function retryIncompleteStickerCatalogs(packs: readonly string[], now: number = Date.now()): void {
  // 0 表示尚无维护重试，第一个节拍可立即接纳；init 生成不占用维护重试间隔。
  if (
    stickerCatalogRetryState.lastAttemptAt !== 0 &&
    now - stickerCatalogRetryState.lastAttemptAt < STICKER_CATALOG_RETRY_INTERVAL_MS
  ) {
    return;
  }
  const incomplete: string[] = packs.filter((pack: string): boolean => {
    if ((catalogs.get(pack)?.size ?? 0) === 0 || !packSummaries.has(pack)) return true;
    const failed: ReadonlyMap<string, number> | undefined = failedEntries.get(pack);
    if (failed !== undefined) {
      for (const retryAt of failed.values()) {
        if (now >= retryAt) return true;
      }
    }
    return false;
  });
  if (incomplete.length === 0) return;
  stickerCatalogRetryState.lastAttemptAt = now;
  ensureStickerCatalogs(incomplete);
}

/**
 * 对账单个包：线上有、目录没有的补；目录有、线上已经没有的剪（贴纸被移出
 * 包/包被整理过，留着只会让 getCatalogEntry 对一枚发不出去的贴纸给出
 * 「有效」描述，属于陈旧数据）。
 *
 * getStickerSet 失败返回 null 时整包跳过，不补也不剪；后续 init、配置重载或
 * 维护节拍选中该包时可再次对账。失败返回值不能当作空集合参与剪枝。
 *
 * 导出仅为可测试性（单测需要等它跑完才能断言 catalogs 的最终状态，
 * ensureStickerCatalogs 是 fire-and-forget 的公开入口，拿不到这个句柄）；
 * 生产代码路径统一走 ensureStickerCatalogs。
 */
export async function generatePackCatalog(pack: string, signal: AbortSignal = aiChatWorkerAbortController.current.signal): Promise<void> {
  try {
    const set: StickerSet | null = await getStickerSet(pack, undefined, signal);
    if (!set || signal.aborted) return;

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
      if (signal.aborted) return;
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
        (): Promise<AiTextResult> => describeMediaForStickerCatalog(source.fileId, signal),
        signal
      );
      if (signal.aborted) return;
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

    // 包内容有增删或缺少简介时生成整包简介；失败保留已有简介，缺失简介由维护节拍重试。
    if (map.size > 0 && (entriesChanged || !packSummaries.has(pack))) {
      const summary: string | null = await callWithRetry(
        `Sticker pack summary (pack "${pack}")`,
        (): Promise<AiTextResult> => summarizePack(set.title, [...map.values()].map(formatEntryForSummary), signal),
        signal
      );
      if (signal.aborted) return;
      if (summary) {
        packSummaries.set(pack, summary);
        dirtyPacks.add(pack);
        invalidateStickerMenu();
      } else {
        logger.error(`Failed to generate pack summary for sticker pack "${pack}" after retries; layer-1 sticker tool will show a placeholder until next reconcile.`);
      }
    }
  } catch (error: unknown) {
    if (signal.aborted) return;
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
async function summarizePack(
  title: string,
  descriptions: string[],
  signal: AbortSignal
): Promise<AiTextResult> {
  return summaryAiProvider().generateText({
    purpose: "stickerPackSummary",
    systemPrompt: STICKER_PACK_SUMMARY_PROMPT,
    userContent: `贴纸包「${title}」内每枚贴纸的画面描述：\n${descriptions.join("\n")}`,
    signal,
    errorLabel: STICKER_PACK_SUMMARY_ERROR_LABEL,
    normalize: (text: string): string => {
      const sanitized: string = sanitizeInline(text);
      return sanitized ? truncateAtClauseBoundary(sanitized, STICKER_PACK_SUMMARY_MAX_CHARS) : "";
    },
  });
}
