/**
 * memory/ai/、memory/stickers/ 与 memory/luck/ 的启动恢复读取、结构校验与落盘。被
 * diskIOWorker.ts 调用；本文件不持有任何状态，纯函数式的读写辅助——文件
 * 当前的 DayFileState/待写缓冲由调用方在 cache/workers/diskIO/ 下的领域 owner 持有，
 * 按参数传进来。
 *
 * AI 记忆快照是整份覆盖写：先写 <file>.tmp、fsync、再 rename，rename 在
 * 同一文件系统内是原子操作，进程如果在这中间被杀（OOM/断电/容器被回收），
 * 目标文件要么是写入前的旧内容，要么是写入后的新内容，不会停在半截的撕裂
 * JSON（同 infra/storage/statePersistence.ts 的原子性理由，fsync 的必要性
 * 见 atomicWriteText 注释）——快照本身有固定上限
 * （AI_MEMORY_HYDRATE_BUFFER_MAX/MAX_SUMMARY_ROUNDS），整份重写的开销
 * 不随时间增长，没有必要为它换成追加写。
 *
 * 每日运势是按位置追加写（见 appendLuckEntries）：entries 只增不改，
 * 一天下来可能攒到不少条，整份重写的开销会随条数线性增长，值得换成只写
 * 增量的追加机制，见 appendOnlyDayFile.ts 的模块头注释；换来的代价是单次
 * 追加不再是"要么全新要么全旧"的原子操作；若断电留下撕裂尾部，下次恢复
 * 保留原始字节并拒绝启动，不能猜测哪条已确认结果可以丢弃。
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { AiMemorySnapshot, BufferedMessage, BufferedReplyReference } from "../../types/aiChat/memory";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { DayFileState, LuckDayCache, LuckDrawRecord, LuckPendingEntry } from "../../types/diskIO/storage";
import type { StickerCatalogEntry, StickerCatalogSnapshot } from "../../types/stickers/catalog";
import type { LuckTier } from "../../types/luckChallenge";
import {
  AI_MEMORY_DIR,
  LUCK_MEMORY_DIR,
  LUCK_RECEIPT_SECRET_PATH,
  STICKER_MEMORY_DIR,
  TMP_FILE_SUFFIX,
} from "../../consts/paths";
import { DAY_FILE_PATTERN } from "../../consts/diskIO/appendOnly";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { AI_MEMORY_FILE_PATTERN } from "../../consts/diskIO/snapshots";
import { AI_MEMORY_HYDRATE_BUFFER_MAX, MAX_SUMMARY_ROUNDS } from "../../consts/aiChat/memory";
import { STICKER_PACK_NAME_PATTERN } from "../../consts/aiChat/stickers";
import { DAILY_LUCK_CACHE_MAX, LUCK_TIERS } from "../../consts/luckChallenge";
import { LUCK_CACHE_KEY_PATTERN } from "../../consts/luckReceipt";
import { appendToDayFile, openDayFile, serializeDayFileEntry } from "./appendOnlyDayFile";
import { atomicWriteTextSync, durableUnlinkSync } from "../../libs/atomicFile";
import { invalidInput, readJsonInput } from "../../libs/inputValidation";
import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "../../libs/record";
import { isCanonicalDateKey } from "../../libs/time";

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

function isAiSpeakerSnapshot(value: unknown): value is Record<string, unknown> & AiSpeakerSnapshot {
  return isPlainRecord(value) &&
    typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id !== 0 &&
    typeof value.firstName === "string" &&
    typeof value.lastName === "string" &&
    (value.username === undefined || typeof value.username === "string");
}

function isBufferedReplyReference(value: unknown): value is BufferedReplyReference {
  return isAiSpeakerSnapshot(value) &&
    hasOnlyKeys(value, ["id", "firstName", "lastName", "username", "messageId", "text", "quote", "forwardedFrom"]) &&
    typeof value.messageId === "number" && Number.isSafeInteger(value.messageId) && value.messageId > 0 &&
    typeof value.text === "string" &&
    (value.quote === undefined || typeof value.quote === "string") &&
    (value.forwardedFrom === undefined || typeof value.forwardedFrom === "string");
}

function isBufferedMessage(value: unknown): value is BufferedMessage {
  return isAiSpeakerSnapshot(value) &&
    hasOnlyKeys(value, ["id", "firstName", "lastName", "username", "messageId", "text", "replyTo", "forwardedFrom", "at"]) &&
    typeof value.messageId === "number" && Number.isSafeInteger(value.messageId) && value.messageId > 0 &&
    typeof value.text === "string" &&
    (value.replyTo === undefined || isBufferedReplyReference(value.replyTo)) &&
    (value.forwardedFrom === undefined || typeof value.forwardedFrom === "string") &&
    typeof value.at === "string";
}

/** 只接受当前 version=1 的完整结构；username/replyTo/forwardedFrom 按业务
 * 语义可选，messageId 等当前格式必填字段缺失时拒绝启动。 */
function rebuildAiMemorySnapshot(parsed: unknown): AiMemorySnapshot | null {
  if (!isPlainRecord(parsed)) return null;
  const raw: Record<string, unknown> = parsed;
  if (!hasExactKeys(raw, ["version", "buffer", "summaries", "pendingSummary", "savedAt"])) return null;
  if (raw.version !== 1 || !Array.isArray(raw.buffer) || !raw.buffer.every(isBufferedMessage)) return null;
  if (!Array.isArray(raw.summaries) || !raw.summaries.every((s: unknown): s is string => typeof s === "string")) return null;
  if (raw.buffer.length > AI_MEMORY_HYDRATE_BUFFER_MAX || raw.summaries.length > MAX_SUMMARY_ROUNDS) return null;
  if (raw.pendingSummary !== null && typeof raw.pendingSummary !== "string") return null;
  if (typeof raw.savedAt !== "number" || !Number.isSafeInteger(raw.savedAt) || raw.savedAt < 0) return null;
  const buffer: BufferedMessage[] = raw.buffer;
  const summaries: string[] = raw.summaries;
  const pendingSummary: string | null = raw.pendingSummary;
  const savedAt: number = raw.savedAt;
  return { version: 1, buffer, summaries, pendingSummary, savedAt };
}

/**
 * 启动恢复：建目录、清 memory/ai/ 下的 *.tmp 残留（上次写一半的残留；
 * rename 原子性保证正式文件永远完好），严格校验每个群的文件名、schema 和
 * 容量。任一非法文件都保留原字节并拒绝恢复；成功快照重新 stringify 成与
 * 消息协议同形的 JSON 文本，直接可灌缓存/回 LoadedReply。
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
    const match: RegExpExecArray | null = AI_MEMORY_FILE_PATTERN.exec(name);
    if (!match) {
      if (name.endsWith(".json")) {
        return invalidInput(path, "$filename", "the canonical <chatId>.json form");
      }
      continue;
    }
    const chatIdText: string = match[1]!;
    const chatId: number = Number(chatIdText);
    // 必须原样还原：正则只保证「一串数字」，`-01001234567890.json`、
    // `-1001234567890.json` 这种补零变体都能匹配，
    // Number 后是同一个 key，于是 result.set 互相覆盖，胜者取决于 readdirSync 的
    // 枚举顺序——该群的 AI 记忆静默回退到旧副本，而回写只用 `${chatId}.json`，
    // 补零那份永不被改写或删除，每次重启继续顶替。位数超出安全整数的文件名
    // （1e20 那种）同样在这里挡掉，否则水合出的 key 与任何真实 chatId 都对不上。
    if (!Number.isSafeInteger(chatId) || chatId === 0 || String(chatId) !== chatIdText) {
      return invalidInput(path, "$filename", "the canonical <chatId>.json form with a non-zero safe integer chat ID");
    }
    ensurePersistedFileMode(path);
    const parsed: unknown = readJsonInput(path);
    const snapshot: AiMemorySnapshot | null = rebuildAiMemorySnapshot(parsed);
    if (!snapshot) {
      return invalidInput(path, "$", "the current version=1 AI memory schema within configured capacities");
    }
    result.set(chatId, JSON.stringify(snapshot, null, 2));
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
  return isPlainRecord(value) &&
    hasExactKeys(value, ["emoji", "description"]) &&
    typeof value.emoji === "string" &&
    typeof value.description === "string";
}

/** 只接受当前 version=1 的完整结构；版本变更由部署前手工迁移。 */
function rebuildStickerCatalogSnapshot(parsed: unknown): StickerCatalogSnapshot | null {
  if (!isPlainRecord(parsed)) return null;
  const raw: Record<string, unknown> = parsed;
  if (!hasExactKeys(raw, ["version", "entries", "summary", "savedAt"])) return null;
  if (raw.version !== 1 || !isPlainRecord(raw.entries)) return null;
  if (raw.summary !== null && typeof raw.summary !== "string") return null;
  if (typeof raw.savedAt !== "number" || !Number.isSafeInteger(raw.savedAt) || raw.savedAt < 0) return null;
  // 无原型对象：JSON.parse 会把 `__proto__` 建成普通自有属性，而写进 `{}` 时
  // `entries["__proto__"] = value` 触发的是 Object.prototype 的 setter——改的是这个
  // 对象的原型，条目根本没进去。那张贴纸于是通过校验、被报告为已恢复，却在重新
  // 序列化后的快照里消失：描述永久丢失、catalog.ts 不再匹配得上且没有诊断。
  const entries: Record<string, StickerCatalogEntry> =
    Object.create(null) as Record<string, StickerCatalogEntry>;
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
 * 白名单贴纸包的目录快照。机制与 recoverAiMemories 基本一致，只是文件名
 * 使用 pack short name；多一步 activePacks 对账——config/stickers.json 的白名单
 * 已经不包含的包，其持久化文件视为孤儿，直接删除、不载入内存，既不再占
 * 磁盘空间，也不会让 aiChat/ai/stickers/catalog.ts 的 getCatalogEntry 继续拿一个
 * 已下架包的旧描述去匹配群友发的贴纸。
 * @param activePacks 当前 config/stickers.json 的贴纸包白名单（见
 *   config/stickers.ts），用于判定哪些持久化文件已经是孤儿。
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
    if (!name.endsWith(".json")) continue;
    const pack: string = name.slice(0, -".json".length);
    if (!STICKER_PACK_NAME_PATTERN.test(pack)) {
      return invalidInput(path, "$filename", "the canonical <stickerPackShortName>.json form");
    }
    ensurePersistedFileMode(path);
    if (!activePackSet.has(pack)) {
      // 白名单已经不包含这个包：孤儿文件，清掉，不进 result（不载入内存）。
      tryUnlink(path);
      continue;
    }
    const parsed: unknown = readJsonInput(path);
    const snapshot: StickerCatalogSnapshot | null = rebuildStickerCatalogSnapshot(parsed);
    if (!snapshot) {
      return invalidInput(path, "$", "the current version=1 sticker catalog schema");
    }
    result.set(pack, JSON.stringify(snapshot, null, 2));
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
 * 删除 memory/luck/ 下早于 todayKey 的 YYYY-MM-DD.json；非规范或未来文件拒绝清理。
 */
export function cleanupStaleLuckFiles(todayKey: string): void {
  for (const name of readdirSync(LUCK_MEMORY_DIR)) {
    // 密钥与按日结果同属 luck owner，但由 recoverLuckReceiptSecret 单独严格
    // 校验；这里仅负责按日文件，不能把已登记的固定元数据文件误判成坏日期。
    if (name === basename(LUCK_RECEIPT_SECRET_PATH)) continue;
    const match: RegExpExecArray | null = DAY_FILE_PATTERN.exec(name);
    if (match === null) {
      if (name.endsWith(".json")) {
        return invalidInput(
          join(LUCK_MEMORY_DIR, name),
          "$filename",
          "the canonical <YYYY-MM-DD>.json form"
        );
      }
      continue;
    }
    const day: string = match[1]!;
    const path: string = join(LUCK_MEMORY_DIR, name);
    if (!isCanonicalDateKey(day)) {
      return invalidInput(path, "$filename", "a canonical calendar date");
    }
    if (day > todayKey) {
      return invalidInput(path, "$filename", "a date no later than the current Tokyo day");
    }
    if (day < todayKey) tryUnlink(path);
  }
}

/**
 * 启动恢复：建目录、清 *.tmp 残留（防御性——追加写不产生 .tmp，清一次
 * 挡住外部干预留下的残留）、删除所有非今天的日期文件，只关心今天那份
 * （不存在则返回 null）。先严格校验 JSON、领域 schema 与容量，再接管追加
 * 游标；任何不规范内容都阻止启动并保留原文件，等待人工处理。
 */
export function recoverLuckDay(todayKey: string): LuckDayCache | null {
  mkdirSync(LUCK_MEMORY_DIR, { recursive: true });
  for (const name of readdirSync(LUCK_MEMORY_DIR)) {
    if (name.endsWith(TMP_FILE_SUFFIX)) tryUnlink(join(LUCK_MEMORY_DIR, name));
  }
  const todayPath: string = join(LUCK_MEMORY_DIR, `${todayKey}.json`);
  if (!existsSync(todayPath)) {
    cleanupStaleLuckFiles(todayKey);
    return null;
  }
  const parsed: unknown = readJsonInput(todayPath);
  if (!isPlainRecord(parsed)) {
    return invalidInput(todayPath, "$", "a JSON object keyed by canonical luck cache keys");
  }
  const raw: Record<string, unknown> = parsed;
  if (Object.keys(raw).length > DAILY_LUCK_CACHE_MAX) {
    return invalidInput(todayPath, "$", `at most ${DAILY_LUCK_CACHE_MAX} confirmed luck records`);
  }
  const entries: Map<string, LuckDrawRecord> = new Map();
  for (const [key, value] of Object.entries(raw)) {
    if (!LUCK_CACHE_KEY_PATTERN.test(key)) {
      return invalidInput(todayPath, "$.<key>", "a canonical luck cache key");
    }
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ["label", "fortunePercent"]) ||
      typeof value.label !== "string" ||
      typeof value.fortunePercent !== "number" ||
      !Number.isFinite(value.fortunePercent)
    ) {
      return invalidInput(todayPath, "$.<record>", "exactly { label: string, fortunePercent: finiteNumber }");
    }
    const tier: LuckTier | undefined = LUCK_TIERS.find(
      (candidate: LuckTier): boolean => candidate.label === value.label
    );
    if (tier === undefined) {
      return invalidInput(todayPath, "$.<record>.label", "a current luck tier label");
    }
    const [minimum, maximum]: readonly [number, number] = tier.fortunePercentRange;
    if (value.fortunePercent < minimum || value.fortunePercent > maximum) {
      return invalidInput(todayPath, "$.<record>.fortunePercent", "within the selected tier range");
    }
    entries.set(key, { label: value.label, fortunePercent: value.fortunePercent });
  }
  // 领域 schema 全部通过后才接管追加游标；非规范排版同样 fail-closed。
  openDayFile(LUCK_MEMORY_DIR, todayKey, PERSISTED_FILE_MODE);
  cleanupStaleLuckFiles(todayKey);
  return { day: todayKey, entries };
}

/**
 * 把一批新确认的运势条目追加到当天文件末尾（按位置追加，不整文件重写，
 * 机制见 appendOnlyDayFile.ts）。fileState 由调用方（cache/workers/diskIO/luck.ts）
 * 持有并传入：为 null 或 day 对不上（本次运行第一次写、
 * 或刚跨天）时，先探测/接管一次对应日期的文件。pending 为空是防御性早退
 * ——调用方按 dirty 判断只在非空时才会调用，这里不该真的走到。
 */
export interface LuckFileStateHolder {
  current: DayFileState | null;
}

export function appendLuckEntries(day: string, fileState: LuckFileStateHolder, pending: LuckPendingEntry[]): void {
  if (pending.length === 0) return;
  mkdirSync(LUCK_MEMORY_DIR, { recursive: true });
  if (fileState.current?.day !== day) {
    fileState.current = openDayFile(LUCK_MEMORY_DIR, day, PERSISTED_FILE_MODE);
  }
  const chunk: string = pending.map((entry: LuckPendingEntry): string => serializeDayFileEntry(entry.key, entry.record)).join(",\n");
  appendToDayFile({
    dir: LUCK_MEMORY_DIR,
    state: fileState.current,
    chunk,
    mode: PERSISTED_FILE_MODE,
  });
}
