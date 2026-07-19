/**
 * memory/ai/、memory/stickers/ 与 memory/luck/ 的启动恢复读取、结构校验与落盘。被
 * diskIOWorker.ts 调用；本文件不持有任何状态，纯函数式的读写辅助——文件
 * 当前的 DayFileState/待写缓冲由调用方在 cache/diskIO/ 下的领域 owner 持有，
 * 按参数传进来。
 *
 * AI 记忆快照是整份覆盖写：先写 <file>.tmp、fsync、再 rename，rename 在
 * 同一文件系统内是原子操作，进程如果在这中间被杀（OOM/断电/容器被回收），
 * 目标文件要么是写入前的旧内容，要么是写入后的新内容，不会停在半截的撕裂
 * JSON（同 infra/storage/stateStore.ts 的原子性理由，fsync 的必要性
 * 见 atomicWriteText 注释）——快照本身有固定上限
 * （AI_MEMORY_HYDRATE_BUFFER_MAX/MAX_SUMMARY_ROUNDS），整份重写的开销
 * 不随时间增长，没有必要为它换成追加写。
 *
 * 每日运势是按位置追加写（见 appendLuckEntries）：entries 只增不改，
 * 一天下来可能攒到不少条，整份重写的开销会随条数线性增长，值得换成只写
 * 增量的追加机制，见 appendOnlyDayFile.ts 的模块头注释；换来的代价是单次
 * 追加不再是"要么全新要么全旧"的原子操作，靠追加机制自带的截断修复兜底
 * 断电风险（与日志文件同一套机制，那边已经这样跑了很久）。
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AiMemorySnapshot, BufferedMessage } from "../../types/aiChat/memory";
import type { DayFileState, LuckDayCache, LuckDrawRecord, LuckPendingEntry } from "../../types/diskIO/storage";
import type { StickerCatalogEntry, StickerCatalogSnapshot } from "../../types/stickers/catalog";
import { AI_MEMORY_DIR, CORRUPT_FILE_SUFFIX, LUCK_MEMORY_DIR, STICKER_MEMORY_DIR, TMP_FILE_SUFFIX } from "../../consts/paths";
import { DAY_FILE_PATTERN } from "../../consts/diskIO/appendOnly";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { AI_MEMORY_FILE_PATTERN, STICKER_CATALOG_FILE_PATTERN } from "../../consts/diskIO/snapshots";
import { AI_MEMORY_HYDRATE_BUFFER_MAX, MAX_SUMMARY_ROUNDS } from "../../consts/aiChat/memory";
import { appendToDayFile, openDayFile, serializeDayFileEntry } from "./appendOnlyDayFile";
import { atomicWriteTextSync, durableUnlinkSync } from "../../libs/atomicFile";

/**
 * tmp + fsync + rename 的原子覆盖写。rename 前的 fsync 不能省：rename 只
 * 保证目录项切换原子，不保证数据块已落盘——断电时改名可能已提交而数据还
 * 在页缓存里，目标文件变成空文件/半截内容，恰好是这套机制要防的事（进程
 * 被杀不经过这个风险，只有断电经过）。content 是快照序列化好的 JSON 文本，
 * 序列化在源头（aiChatWorker 侧）只做一次，这里原样写入。
 */
function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 删除失败（权限问题等）不影响主流程，下次同样的清理还会再试一次。
  }
}

function ensurePersistedFileMode(path: string): void {
  if ((statSync(path).mode & 0o777) !== PERSISTED_FILE_MODE) chmodSync(path, PERSISTED_FILE_MODE);
}

/** 解析失败的文件重命名隔离，不静默删除——留排查线索（对齐 loadState 的做法）。 */
function quarantine(path: string): void {
  try {
    renameSync(path, `${path}${CORRUPT_FILE_SUFFIX}`);
  } catch (error) {
    console.error(`[diskIOWorker] failed to quarantine ${path}:`, error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBufferedMessage(value: unknown): value is BufferedMessage {
  return isRecord(value) &&
    typeof value.id === "number" && Number.isFinite(value.id) &&
    typeof value.firstName === "string" &&
    typeof value.lastName === "string" &&
    (value.username === undefined || typeof value.username === "string") &&
    typeof value.text === "string" &&
    typeof value.at === "string";
}

/** 只接受当前 version=1 的完整结构；username 是向后兼容的可选扩展，旧条目
 * 没有它也合法，不需要改版本或迁移旧文件。其余版本变更由部署前手工迁移。 */
function rebuildAiMemorySnapshot(parsed: unknown): AiMemorySnapshot | null {
  if (!isRecord(parsed)) return null;
  const raw: Record<string, unknown> = parsed;
  if (raw.version !== 1 || !Array.isArray(raw.buffer) || !raw.buffer.every(isBufferedMessage)) return null;
  if (!Array.isArray(raw.summaries) || !raw.summaries.every((s: unknown) => typeof s === "string")) return null;
  if (raw.pendingSummary !== null && typeof raw.pendingSummary !== "string") return null;
  if (typeof raw.savedAt !== "number" || !Number.isFinite(raw.savedAt)) return null;
  const buffer: BufferedMessage[] = raw.buffer.slice(-AI_MEMORY_HYDRATE_BUFFER_MAX);
  const summaries: string[] = raw.summaries.slice(-MAX_SUMMARY_ROUNDS);
  const pendingSummary: string | null = raw.pendingSummary;
  const savedAt: number = raw.savedAt;
  return { version: 1, buffer, summaries, pendingSummary, savedAt };
}

/**
 * 启动恢复：建目录、清 memory/ai/ 下的 *.tmp 残留（上次写一半的残留；
 * rename 原子性保证正式文件永远完好），校验/重建每个群的快照。文件名
 * 不是整数（chatId）的跳过；JSON.parse 失败的隔离为 .corrupt 并记日志。
 * 返回值与消息协议同形态——重建通过的快照重新 stringify 成 JSON 文本
 * （逐字段重建会甩掉未知字段/裁掉超限条目，不能把磁盘原文原样透传），
 * 直接可灌缓存/回 LoadedReply。每包一次的重新序列化只发生在启动时。
 */
export function recoverAiMemories(): Map<number, string> {
  mkdirSync(AI_MEMORY_DIR, { recursive: true });
  const result: Map<number, string> = new Map();
  for (const name of readdirSync(AI_MEMORY_DIR)) {
    const path: string = join(AI_MEMORY_DIR, name);
    if (name.endsWith(TMP_FILE_SUFFIX)) {
      tryUnlink(path);
      continue;
    }
    const match = AI_MEMORY_FILE_PATTERN.exec(name);
    if (!match) continue; // 非 <chatId>.json 形态（含 .corrupt 隔离文件），跳过不动
    ensurePersistedFileMode(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      quarantine(path);
      console.error(`[diskIOWorker] AI memory file ${name} failed to parse, quarantined as .corrupt:`, error);
      continue;
    }
    const snapshot: AiMemorySnapshot | null = rebuildAiMemorySnapshot(parsed);
    if (!snapshot) {
      throw new Error(`AI memory file ${name} does not match the current version=1 schema; migrate it manually before starting the bot`);
    }
    result.set(Number(match[1]), JSON.stringify(snapshot, null, 2));
  }
  return result;
}

/**
 * 覆盖式写入某群的 AI 记忆快照（tmp + fsync + rename 原子落盘）。
 * snapshotJson 是源头序列化好的 JSON 文本，原样写入。目录正常总已由
 * recoverAiMemories（启动恢复）建好；这里仍重建一次（recursive 下已存在
 * 时是廉价的空操作）防御外部干预（比如运行期间该目录被手动删除）——否则
 * 一旦目录消失，写入会持续 ENOENT 失败且没有谁会重新把它建回来。
 */
export function writeAiMemoryFile(chatId: number, snapshotJson: string): void {
  mkdirSync(AI_MEMORY_DIR, { recursive: true });
  atomicWriteTextSync(join(AI_MEMORY_DIR, `${chatId}.json`), snapshotJson, PERSISTED_FILE_MODE);
}

export function deleteAiMemoryFile(chatId: number): void {
  mkdirSync(AI_MEMORY_DIR, { recursive: true });
  durableUnlinkSync(join(AI_MEMORY_DIR, `${chatId}.json`));
}

function isStickerCatalogEntry(value: unknown): value is StickerCatalogEntry {
  return isRecord(value) && typeof value.emoji === "string" && typeof value.description === "string";
}

/** 只接受当前 version=1 的完整结构；版本变更由部署前手工迁移。 */
function rebuildStickerCatalogSnapshot(parsed: unknown): StickerCatalogSnapshot | null {
  if (!isRecord(parsed)) return null;
  const raw: Record<string, unknown> = parsed;
  if (raw.version !== 1 || !isRecord(raw.entries)) return null;
  if (raw.summary !== null && typeof raw.summary !== "string") return null;
  if (typeof raw.savedAt !== "number" || !Number.isFinite(raw.savedAt)) return null;
  const entries: Record<string, StickerCatalogEntry> = {};
  for (const [fileUniqueId, value] of Object.entries(raw.entries)) {
    if (!isStickerCatalogEntry(value)) return null;
    entries[fileUniqueId] = value;
  }
  const summary: string | null = raw.summary;
  const savedAt: number = raw.savedAt;
  return { version: 1, entries, summary, savedAt };
}

/**
 * 启动恢复：建目录、清 memory/stickers/ 下的 *.tmp 残留，校验/重建每个
 * 白名单贴纸包的目录快照。机制与 recoverAiMemories 基本一致（tmp+rename
 * 原子写、解析失败隔离为 .corrupt），只是文件名形态不同（pack short name
 * 而非 chatId）；多一步 activePacks 对账——config/stickers.json 的白名单
 * 已经不包含的包，其持久化文件视为孤儿，直接删除、不载入内存，既不再占
 * 磁盘空间，也不会让 ai/stickers/catalog.ts 的 getCatalogEntry 继续拿一个
 * 已下架包的旧描述去匹配群友发的贴纸。
 * @param activePacks 当前 config/stickers.json 的贴纸包白名单（见
 *   ai/stickers/config.ts），用于判定哪些持久化文件已经是孤儿。
 */
export function recoverStickerCatalogs(activePacks: readonly string[]): Map<string, string> {
  mkdirSync(STICKER_MEMORY_DIR, { recursive: true });
  const activePackSet: Set<string> = new Set(activePacks);
  const result: Map<string, string> = new Map();
  for (const name of readdirSync(STICKER_MEMORY_DIR)) {
    const path: string = join(STICKER_MEMORY_DIR, name);
    if (name.endsWith(TMP_FILE_SUFFIX)) {
      tryUnlink(path);
      continue;
    }
    const match = STICKER_CATALOG_FILE_PATTERN.exec(name);
    if (!match) continue; // 非 <pack>.json 形态（含 .corrupt 隔离文件），跳过不动
    ensurePersistedFileMode(path);
    const pack: string = match[1]!;
    if (!activePackSet.has(pack)) {
      // 白名单已经不包含这个包：孤儿文件，清掉，不进 result（不载入内存）。
      tryUnlink(path);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      quarantine(path);
      console.error(`[diskIOWorker] sticker catalog file ${name} failed to parse, quarantined as .corrupt:`, error);
      continue;
    }
    const snapshot: StickerCatalogSnapshot | null = rebuildStickerCatalogSnapshot(parsed);
    if (snapshot) result.set(pack, JSON.stringify(snapshot, null, 2));
    else console.error(`[diskIOWorker] sticker catalog file ${name} does not match the current version=1 schema; migrate it manually`);
  }
  return result;
}

/** 覆盖式写入某个白名单贴纸包的目录快照（tmp + fsync + rename 原子落盘），
 *  机制与 writeAiMemoryFile 完全一致，snapshotJson 同为源头序列化好的
 *  JSON 文本。 */
export function writeStickerCatalogFile(pack: string, snapshotJson: string): void {
  mkdirSync(STICKER_MEMORY_DIR, { recursive: true });
  atomicWriteTextSync(join(STICKER_MEMORY_DIR, `${pack}.json`), snapshotJson, PERSISTED_FILE_MODE);
}

/**
 * 删除 memory/luck/ 下所有非 todayKey 的 YYYY-MM-DD.json（只存一天，过期
 * 即删）。.corrupt 隔离文件不匹配这个模式，不受影响，永久保留供排查。
 */
export function cleanupStaleLuckFiles(todayKey: string): void {
  for (const name of readdirSync(LUCK_MEMORY_DIR)) {
    const match = DAY_FILE_PATTERN.exec(name);
    if (match && match[1] !== todayKey) {
      tryUnlink(join(LUCK_MEMORY_DIR, name));
    }
  }
}

/**
 * 启动恢复：建目录、清 *.tmp 残留（防御性——追加写不产生 .tmp，清一次
 * 挡住外部干预留下的残留）、删除所有非今天的日期文件，只关心今天那份
 * （不存在则返回 null）。读取前必须先经 openDayFile 校验/修复：启动恢复
 * 本身就是本次运行第一次碰这份文件，不能假设追加路径已经先打开过它。
 * 修复后仍解析失败才视为真正损坏并隔离为 .corrupt。
 */
export function recoverLuckDay(todayKey: string): LuckDayCache | null {
  mkdirSync(LUCK_MEMORY_DIR, { recursive: true });
  for (const name of readdirSync(LUCK_MEMORY_DIR)) {
    if (name.endsWith(TMP_FILE_SUFFIX)) tryUnlink(join(LUCK_MEMORY_DIR, name));
  }
  cleanupStaleLuckFiles(todayKey);

  const todayPath: string = join(LUCK_MEMORY_DIR, `${todayKey}.json`);
  if (!existsSync(todayPath)) return null;
  let parsed: unknown;
  try {
    openDayFile(LUCK_MEMORY_DIR, todayKey, PERSISTED_FILE_MODE);
    parsed = JSON.parse(readFileSync(todayPath, "utf8"));
  } catch (error) {
    quarantine(todayPath);
    console.error(`[diskIOWorker] luck file ${todayKey}.json failed to parse, quarantined as .corrupt:`, error);
    return null;
  }
  if (!isRecord(parsed)) return null;
  const raw: Record<string, unknown> = parsed;
  const entries: Map<string, LuckDrawRecord> = new Map();
  for (const [key, value] of Object.entries(raw)) {
    // entries 里结构不对的条目丢弃（结构性校验，不假设未来档位表长什么样），
    // 当天重抽，见 types/diskIO.ts 的 LuckDayFile 注释。
    if (!isRecord(value)) continue;
    if (typeof value.label === "string" && typeof value.fortunePercent === "number" && Number.isFinite(value.fortunePercent)) {
      entries.set(key, { label: value.label, fortunePercent: value.fortunePercent });
    }
  }
  return { day: todayKey, entries };
}

/**
 * 把一批新确认的运势条目追加到当天文件末尾（按位置追加，不整文件重写，
 * 机制见 appendOnlyDayFile.ts）。fileState 由调用方（cache/diskIO/luck.ts）
 * 持有并传入：为 null 或 day 对不上（本次运行第一次写、
 * 或刚跨天）时，先探测/接管一次对应日期的文件。pending 为空是防御性早退
 * ——调用方按 dirty 判断只在非空时才会调用，这里不该真的走到。
 */
export function appendLuckEntries(day: string, fileState: { current: DayFileState | null }, pending: LuckPendingEntry[]): void {
  if (pending.length === 0) return;
  mkdirSync(LUCK_MEMORY_DIR, { recursive: true });
  if (fileState.current?.day !== day) {
    fileState.current = openDayFile(LUCK_MEMORY_DIR, day, PERSISTED_FILE_MODE);
  }
  const chunk: string = pending.map((entry) => serializeDayFileEntry(entry.key, entry.record)).join(",\n");
  appendToDayFile(LUCK_MEMORY_DIR, fileState.current, chunk, PERSISTED_FILE_MODE);
}
