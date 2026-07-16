/**
 * memory/ai/ 与 memory/luck/ 的启动恢复读取、结构校验与落盘。被
 * diskIOWorker.ts 调用；本文件不持有任何状态，纯函数式的读写辅助——文件
 * 当前的 DayFileState/待写缓冲由调用方在 cache/diskIOWorker.ts 里持有，
 * 按参数传进来。
 *
 * AI 记忆快照是整份覆盖写：先写 <file>.tmp 再 rename，rename 在同一文件
 * 系统内是原子操作，进程如果在这中间被杀（OOM/断电/容器被回收），目标
 * 文件要么是写入前的旧内容，要么是写入后的新内容，不会停在半截的撕裂
 * JSON（同 infra/storage.ts persistStateJson 的原子性理由）——快照本身
 * 有固定上限（AI_MEMORY_HYDRATE_BUFFER_MAX/MAX_SUMMARY_ROUNDS），整份
 * 重写的开销不随时间增长，没有必要为它换成追加写。
 *
 * 每日运势是按位置追加写（见 appendLuckEntries）：entries 只增不改，
 * 一天下来可能攒到不少条，整份重写的开销会随条数线性增长，值得换成只写
 * 增量的追加机制，见 appendOnlyDayFile.ts 的模块头注释；换来的代价是单次
 * 追加不再是"要么全新要么全旧"的原子操作，靠追加机制自带的截断修复兜底
 * 断电风险（与日志文件同一套机制，那边已经这样跑了很久）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AiMemorySnapshot, BufferedMessage, DayFileState, LuckDayCache, LuckDrawRecord, LuckPendingEntry, StickerCatalogEntry, StickerCatalogSnapshot } from "../../types";
import { AI_MEMORY_DIR, CORRUPT_FILE_SUFFIX, LUCK_MEMORY_DIR, STICKER_MEMORY_DIR, TMP_FILE_SUFFIX } from "../../consts/paths";
import { AI_MEMORY_FILE_PATTERN, DAY_FILE_PATTERN, STICKER_CATALOG_FILE_PATTERN } from "../../consts/diskIO";
import { AI_MEMORY_HYDRATE_BUFFER_MAX, MAX_SUMMARY_ROUNDS } from "../../consts/aiChat";
import { formatTokyoTime } from "../../libs/time";
import { appendToDayFile, openDayFile, serializeDayFileEntry } from "./appendOnlyDayFile";

function atomicWriteJson(path: string, value: unknown): void {
  const tmpPath: string = `${path}${TMP_FILE_SUFFIX}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  renameSync(tmpPath, path);
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 删除失败（权限问题等）不影响主流程，下次同样的清理还会再试一次。
  }
}

/** 解析失败的文件重命名隔离，不静默删除——留排查线索（对齐 loadState 的做法）。 */
function quarantine(path: string): void {
  try {
    renameSync(path, `${path}${CORRUPT_FILE_SUFFIX}`);
  } catch (error) {
    console.error(`[diskIOWorker] failed to quarantine ${path}:`, error);
  }
}

function isBufferedMessage(value: unknown): value is BufferedMessage {
  if (!value || typeof value !== "object") return false;
  const v: any = value;
  return typeof v.id === "number" && typeof v.firstName === "string" && typeof v.lastName === "string" && typeof v.text === "string";
}

/** 缓存条目逐字段重建：at 是后加的字段，正常形态是格式化好的东京时间串
 *  （见 types/aiChatWorker.ts）；曾短暂落盘过毫秒数形态，就地转成同一格式；
 *  更早的旧文件没有该字段，补空串（时间未知，转录行会省略时间前缀，见
 *  workers/aiChatWorker.ts 的 formatLine）。 */
function rebuildBufferedMessage(v: BufferedMessage): BufferedMessage {
  const rawAt: unknown = (v as any).at;
  const at: string = typeof rawAt === "string" ? rawAt : typeof rawAt === "number" && rawAt > 0 ? formatTokyoTime(rawAt) : "";
  return { id: v.id, firstName: v.firstName, lastName: v.lastName, text: v.text, at };
}

/** 逐字段白名单重建（对齐 infra/storage.ts loadState 的做法），未知字段自然甩掉。 */
function rebuildAiMemorySnapshot(parsed: unknown): AiMemorySnapshot | null {
  if (!parsed || typeof parsed !== "object") return null;
  const raw: any = parsed;
  const buffer: BufferedMessage[] = Array.isArray(raw.buffer)
    ? raw.buffer.filter(isBufferedMessage).map(rebuildBufferedMessage).slice(-AI_MEMORY_HYDRATE_BUFFER_MAX)
    : [];
  const summaries: string[] = Array.isArray(raw.summaries)
    ? raw.summaries.filter((s: unknown): s is string => typeof s === "string").slice(-MAX_SUMMARY_ROUNDS)
    : [];
  const pendingSummary: string | null = typeof raw.pendingSummary === "string" ? raw.pendingSummary : null;
  const savedAt: number = typeof raw.savedAt === "number" ? raw.savedAt : Date.now();
  return { version: 1, buffer, summaries, pendingSummary, savedAt };
}

/**
 * 启动恢复：建目录、清 memory/ai/ 下的 *.tmp 残留（上次写一半的残留；
 * rename 原子性保证正式文件永远完好），校验/重建每个群的快照。文件名
 * 不是整数（chatId）的跳过；JSON.parse 失败的隔离为 .corrupt 并记日志。
 */
export function recoverAiMemories(): Map<number, AiMemorySnapshot> {
  mkdirSync(AI_MEMORY_DIR, { recursive: true });
  const result: Map<number, AiMemorySnapshot> = new Map();
  for (const name of readdirSync(AI_MEMORY_DIR)) {
    const path: string = join(AI_MEMORY_DIR, name);
    if (name.endsWith(TMP_FILE_SUFFIX)) {
      tryUnlink(path);
      continue;
    }
    const match = AI_MEMORY_FILE_PATTERN.exec(name);
    if (!match) continue; // 非 <chatId>.json 形态（含 .corrupt 隔离文件），跳过不动
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      quarantine(path);
      console.error(`[diskIOWorker] AI memory file ${name} failed to parse, quarantined as .corrupt:`, error);
      continue;
    }
    const snapshot: AiMemorySnapshot | null = rebuildAiMemorySnapshot(parsed);
    if (snapshot) result.set(Number(match[1]), snapshot);
  }
  return result;
}

/**
 * 覆盖式写入某群的 AI 记忆快照（tmp + rename 原子落盘）。目录正常总已由
 * recoverAiMemories（启动恢复）建好；这里仍重建一次（recursive 下已存在
 * 时是廉价的空操作）防御外部干预（比如运行期间该目录被手动删除）——否则
 * 一旦目录消失，写入会持续 ENOENT 失败且没有谁会重新把它建回来。
 */
export function writeAiMemoryFile(chatId: number, snapshot: AiMemorySnapshot): void {
  mkdirSync(AI_MEMORY_DIR, { recursive: true });
  atomicWriteJson(join(AI_MEMORY_DIR, `${chatId}.json`), snapshot);
}

function isStickerCatalogEntry(value: unknown): value is StickerCatalogEntry {
  if (!value || typeof value !== "object") return false;
  const v: any = value;
  return typeof v.emoji === "string" && typeof v.description === "string";
}

/** 逐字段白名单重建（对齐 rebuildAiMemorySnapshot），未知字段自然甩掉；
 *  entries 里结构不对的条目丢弃（当前进程会把它当缺失重新生成，不做迁移）。 */
function rebuildStickerCatalogSnapshot(parsed: unknown): StickerCatalogSnapshot | null {
  if (!parsed || typeof parsed !== "object") return null;
  const raw: any = parsed;
  const entries: Record<string, StickerCatalogEntry> = {};
  if (raw.entries && typeof raw.entries === "object") {
    for (const [fileUniqueId, value] of Object.entries(raw.entries)) {
      if (isStickerCatalogEntry(value)) entries[fileUniqueId] = value;
    }
  }
  const savedAt: number = typeof raw.savedAt === "number" ? raw.savedAt : Date.now();
  return { version: 1, entries, savedAt };
}

/**
 * 启动恢复：建目录、清 memory/stickers/ 下的 *.tmp 残留，校验/重建每个
 * 白名单贴纸包的目录快照。机制与 recoverAiMemories 基本一致（tmp+rename
 * 原子写、解析失败隔离为 .corrupt），只是文件名形态不同（pack short name
 * 而非 chatId）；多一步 activePacks 对账——config/stickers.json 的白名单
 * 已经不包含的包，其持久化文件视为孤儿，直接删除、不载入内存，既不再占
 * 磁盘空间，也不会让 ai/stickerCatalog.ts 的 getCatalogEntry 继续拿一个
 * 已下架包的旧描述去匹配群友发的贴纸。
 * @param activePacks 当前 config/stickers.json 的贴纸包白名单（见
 *   ai/stickerConfig.ts），用于判定哪些持久化文件已经是孤儿。
 */
export function recoverStickerCatalogs(activePacks: string[]): Map<string, StickerCatalogSnapshot> {
  mkdirSync(STICKER_MEMORY_DIR, { recursive: true });
  const activePackSet: Set<string> = new Set(activePacks);
  const result: Map<string, StickerCatalogSnapshot> = new Map();
  for (const name of readdirSync(STICKER_MEMORY_DIR)) {
    const path: string = join(STICKER_MEMORY_DIR, name);
    if (name.endsWith(TMP_FILE_SUFFIX)) {
      tryUnlink(path);
      continue;
    }
    const match = STICKER_CATALOG_FILE_PATTERN.exec(name);
    if (!match) continue; // 非 <pack>.json 形态（含 .corrupt 隔离文件），跳过不动
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
    if (snapshot) result.set(pack, snapshot);
  }
  return result;
}

/** 覆盖式写入某个白名单贴纸包的目录快照（tmp + rename 原子落盘），机制与
 *  writeAiMemoryFile 完全一致。 */
export function writeStickerCatalogFile(pack: string, snapshot: StickerCatalogSnapshot): void {
  mkdirSync(STICKER_MEMORY_DIR, { recursive: true });
  atomicWriteJson(join(STICKER_MEMORY_DIR, `${pack}.json`), snapshot);
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
 * （不存在则返回 null）。今天那份解析失败（真正损坏，而不是可修复的截断
 * ——截断修复已经在本次运行第一次 openDayFile 时做过一轮，这里读到的
 * 要么是完整文件、要么已经被修过）就隔离为 .corrupt。
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
    parsed = JSON.parse(readFileSync(todayPath, "utf8"));
  } catch (error) {
    quarantine(todayPath);
    console.error(`[diskIOWorker] luck file ${todayKey}.json failed to parse, quarantined as .corrupt:`, error);
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw: any = parsed;
  const entries: Map<string, LuckDrawRecord> = new Map();
  for (const [key, value] of Object.entries(raw)) {
    // entries 里结构不对的条目丢弃（结构性校验，不假设未来档位表长什么样），
    // 当天重抽，见 types/diskIO.ts 的 LuckDayFile 注释。
    if (!value || typeof value !== "object") continue;
    const v: any = value;
    if (typeof v.label === "string" && typeof v.fortunePercent === "number") {
      entries.set(key, { label: v.label, fortunePercent: v.fortunePercent });
    }
  }
  return { day: todayKey, entries };
}

/**
 * 把一批新确认的运势条目追加到当天文件末尾（按位置追加，不整文件重写，
 * 机制见 appendOnlyDayFile.ts）。fileState 由调用方（cache/diskIOWorker.ts
 * 的 luckFileState）持有并传入：为 null 或 day 对不上（本次运行第一次写、
 * 或刚跨天）时，先探测/接管一次对应日期的文件。pending 为空是防御性早退
 * ——调用方按 dirty 判断只在非空时才会调用，这里不该真的走到。
 */
export function appendLuckEntries(day: string, fileState: { current: DayFileState | null }, pending: LuckPendingEntry[]): void {
  if (pending.length === 0) return;
  mkdirSync(LUCK_MEMORY_DIR, { recursive: true });
  if (fileState.current === null || fileState.current.day !== day) {
    fileState.current = openDayFile(LUCK_MEMORY_DIR, day);
  }
  const chunk: string = pending.map((entry) => serializeDayFileEntry(entry.key, entry.record)).join(",\n");
  appendToDayFile(LUCK_MEMORY_DIR, fileState.current, chunk);
}
