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

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { AiMemorySnapshot } from "../../types/aiChat/memory";
import type { DayFileState, LuckDayCache, LuckDrawRecord, LuckPendingEntry } from "../../types/diskIO/storage";
import type { StickerCatalogSnapshot } from "../../types/stickers/catalog";
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
import { STICKER_PACK_NAME_PATTERN } from "../../consts/aiChat/stickers";
import { DAILY_LUCK_CACHE_MAX, luckTierByLabel } from "../../consts/luckChallenge";
import { LUCK_CACHE_KEY_PATTERN } from "../../consts/luckReceipt";
import {
  appendToDayFile,
  openDayFile,
  openValidatedAppendOnlyFile,
  serializeDayFileEntry,
} from "./appendOnlyDayFile";
import { atomicWriteTextSync, durableUnlinkSync } from "../../libs/atomicFile";
import { invalidInput, readJsonInput, readUtf8TextInput } from "../../libs/inputValidation";
import {
  decodeAiMemorySnapshot,
  decodeStickerCatalogSnapshot,
} from "../../libs/persistedSnapshotCodec";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import { isCanonicalDateKey } from "../../libs/time";
import { assertFileReadableWritable } from "../../libs/fileAccess";

/** 清理已确认无用的文件；删除失败保留现场，由下一轮维护重试。 */
async function tryUnlink(path: string): Promise<void> {
  try {
    await Bun.file(path).delete();
  } catch {
    // 删除失败（权限问题等）不影响主流程，下次同样的清理还会再试一次。
  }
}

function assertPersistedFileWritable(path: string): void {
  assertFileReadableWritable(path);
}

export interface AiMemoryRecoveryInspection {
  readonly snapshots: Map<number, string>;
  readonly temporaryPaths: readonly string[];
}

/**
 * 启动 inspect：只读登记 memory/ai/ 下的 *.tmp 残留，并严格校验每个群的
 * 文件名、schema 和容量。任一非法文件都保留原字节并拒绝恢复；成功快照
 * 重新 stringify 成与消息协议同形的 JSON 文本，直接可灌缓存/回 LoadedReply。
 */
export async function inspectAiMemories(): Promise<AiMemoryRecoveryInspection> {
  const result: Map<number, string> = new Map();
  const temporaryPaths: string[] = [];
  const names: readonly string[] = existsSync(AI_MEMORY_DIR)
    ? readdirSync(AI_MEMORY_DIR)
    : [];
  for (const name of names) {
    const path: string = join(AI_MEMORY_DIR, name);
    if (name.endsWith(TMP_FILE_SUFFIX)) {
      temporaryPaths.push(path);
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
    if (!isTelegramGroupChatId(chatId) || String(chatId) !== chatIdText) {
      return invalidInput(
        path,
        "$filename",
        "the canonical <chatId>.json form with a negative safe integer Telegram group or channel ID"
      );
    }
    assertPersistedFileWritable(path);
    const parsed: unknown = await readJsonInput(path);
    const snapshot: AiMemorySnapshot = decodeAiMemorySnapshot(parsed, path);
    result.set(chatId, JSON.stringify(snapshot, null, 2));
  }
  return { snapshots: result, temporaryPaths };
}

/** 全域校验成功后清理本轮 inspect 识别出的 AI 临时文件。 */
export async function maintainAiMemoryFiles(
  inspection: AiMemoryRecoveryInspection
): Promise<void> {
  mkdirSync(AI_MEMORY_DIR, { recursive: true });
  for (const path of inspection.temporaryPaths) await tryUnlink(path);
}

/**
 * 覆盖式写入某群的 AI 记忆快照（tmp + fsync + rename 原子落盘）。
 * snapshotJson 是源头序列化好的 JSON 文本，原样写入。目录正常总已由
 * 启动 maintenance 建好；这里仍重建一次（recursive 下已存在
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
export interface StickerCatalogRecoveryInspection {
  readonly snapshots: Map<string, string>;
  readonly orphanPaths: readonly string[];
  readonly temporaryPaths: readonly string[];
}

export async function inspectStickerCatalogs(
  activePacks: readonly string[] | null
): Promise<StickerCatalogRecoveryInspection> {
  const activePackSet: Set<string> | null = activePacks === null ? null : new Set(activePacks);
  const result: Map<string, string> = new Map();
  const orphanPaths: string[] = [];
  const temporaryPaths: string[] = [];
  const names: readonly string[] = existsSync(STICKER_MEMORY_DIR)
    ? readdirSync(STICKER_MEMORY_DIR)
    : [];
  for (const name of names) {
    const path: string = join(STICKER_MEMORY_DIR, name);
    if (name.endsWith(TMP_FILE_SUFFIX)) {
      temporaryPaths.push(path);
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const pack: string = name.slice(0, -".json".length);
    if (!STICKER_PACK_NAME_PATTERN.test(pack)) {
      return invalidInput(path, "$filename", "the canonical <stickerPackShortName>.json form");
    }
    assertPersistedFileWritable(path);
    const parsed: unknown = await readJsonInput(path);
    const snapshot: StickerCatalogSnapshot = decodeStickerCatalogSnapshot(parsed, path);
    if (activePackSet !== null && !activePackSet.has(pack)) {
      orphanPaths.push(path);
      continue;
    }
    result.set(pack, JSON.stringify(snapshot, null, 2));
  }
  return { snapshots: result, orphanPaths, temporaryPaths };
}

/** 全域校验成功后清理临时文件与已退出白名单的严格合法快照。 */
export async function maintainStickerCatalogFiles(
  inspection: StickerCatalogRecoveryInspection
): Promise<void> {
  mkdirSync(STICKER_MEMORY_DIR, { recursive: true });
  for (const path of inspection.temporaryPaths) await tryUnlink(path);
  for (const path of inspection.orphanPaths) await tryUnlink(path);
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
function inspectStaleLuckFiles(
  todayKey: string,
  names: readonly string[]
): readonly string[] {
  const stalePaths: string[] = [];
  for (const name of names) {
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
    if (day < todayKey) stalePaths.push(path);
  }
  return stalePaths;
}

export async function cleanupStaleLuckFiles(
  todayKey: string,
  names: readonly string[] = readdirSync(LUCK_MEMORY_DIR)
): Promise<void> {
  for (const path of inspectStaleLuckFiles(todayKey, names)) await tryUnlink(path);
}

export interface LuckFileStateHolder {
  current: DayFileState | null;
}

export interface LuckDayRecoveryInspection {
  readonly day: string;
  readonly cache: LuckDayCache | null;
  readonly fileState: DayFileState | null;
  readonly names: readonly string[];
  readonly temporaryPaths: readonly string[];
}

/**
 * 启动恢复：建目录、清 *.tmp 残留（防御性——追加写不产生 .tmp，清一次
 * 挡住外部干预留下的残留）、删除所有非今天的日期文件，只关心今天那份
 * （不存在则返回 null）。先严格校验 JSON、领域 schema 与容量，再接管追加
 * 游标；任何不规范内容都阻止启动并保留原文件，等待人工处理。
 */
export async function inspectLuckDay(
  todayKey: string
): Promise<LuckDayRecoveryInspection> {
  const names: string[] = existsSync(LUCK_MEMORY_DIR)
    ? readdirSync(LUCK_MEMORY_DIR)
    : [];
  const temporaryPaths: string[] = [];
  for (const name of names) {
    if (name.endsWith(TMP_FILE_SUFFIX)) {
      temporaryPaths.push(join(LUCK_MEMORY_DIR, name));
    }
  }
  inspectStaleLuckFiles(todayKey, names);
  const todayPath: string = join(LUCK_MEMORY_DIR, `${todayKey}.json`);
  if (!await Bun.file(todayPath).exists()) {
    return { day: todayKey, cache: null, fileState: null, names, temporaryPaths };
  }
  let content: string;
  let parsed: unknown;
  try {
    content = await readUtf8TextInput(todayPath);
    parsed = JSON.parse(content) as unknown;
  } catch {
    return invalidInput(todayPath, "$", "a readable valid JSON document");
  }
  if (!isPlainRecord(parsed)) {
    return invalidInput(todayPath, "$", "a JSON object keyed by canonical luck cache keys");
  }
  const raw: Record<string, unknown> = parsed;
  let entryCount: number = 0;
  const entries: Map<string, LuckDrawRecord> = new Map();
  let failurePath: string | null = null;
  let failureExpected: string = "";
  for (const key in raw) {
    if (!Object.hasOwn(raw, key)) continue;
    entryCount++;
    // 容量错误按既有口径优先于任意记录错误；记住首个领域错误但继续完成计数。
    if (failurePath !== null) continue;
    const value: unknown = raw[key];
    if (!LUCK_CACHE_KEY_PATTERN.test(key)) {
      failurePath = "$.<key>";
      failureExpected = "a canonical luck cache key";
      continue;
    }
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ["label", "fortunePercent"]) ||
      typeof value.label !== "string" ||
      typeof value.fortunePercent !== "number" ||
      !Number.isFinite(value.fortunePercent)
    ) {
      failurePath = "$.<record>";
      failureExpected = "exactly { label: string, fortunePercent: finiteNumber }";
      continue;
    }
    const tier: LuckTier | undefined = luckTierByLabel(value.label);
    if (tier === undefined) {
      failurePath = "$.<record>.label";
      failureExpected = "a current luck tier label";
      continue;
    }
    const [minimum, maximum]: readonly [number, number] = tier.fortunePercentRange;
    if (value.fortunePercent < minimum || value.fortunePercent > maximum) {
      failurePath = "$.<record>.fortunePercent";
      failureExpected = "within the selected tier range";
      continue;
    }
    entries.set(key, { label: value.label, fortunePercent: value.fortunePercent });
  }
  if (entryCount > DAILY_LUCK_CACHE_MAX) {
    return invalidInput(todayPath, "$", `at most ${DAILY_LUCK_CACHE_MAX} confirmed luck records`);
  }
  if (failurePath !== null) return invalidInput(todayPath, failurePath, failureExpected);
  // 领域 schema 全部通过后才接管追加游标；非规范排版同样 fail-closed。
  const opened: DayFileState = {
    day: todayKey,
    ...openValidatedAppendOnlyFile({
      path: todayPath,
      content,
      empty: entryCount === 0,
    }),
  };
  return {
    day: todayKey,
    cache: { day: todayKey, entries },
    fileState: opened,
    names,
    temporaryPaths,
  };
}

/** 全域校验成功后创建目录，并清理临时文件与过期日文件。 */
export async function maintainLuckDay(
  todayKey: string,
  inspection: LuckDayRecoveryInspection
): Promise<void> {
  mkdirSync(LUCK_MEMORY_DIR, { recursive: true });
  for (const path of inspection.temporaryPaths) await tryUnlink(path);
  await cleanupStaleLuckFiles(todayKey, inspection.names);
}

/** 单领域恢复入口；跨域启动编排使用 inspect/adopt/maintenance 三阶段 API。 */
export async function recoverLuckDay(
  todayKey: string,
  fileState?: LuckFileStateHolder
): Promise<LuckDayCache | null> {
  const inspection: LuckDayRecoveryInspection = await inspectLuckDay(todayKey);
  await maintainLuckDay(todayKey, inspection);
  if (fileState !== undefined) fileState.current = inspection.fileState;
  return inspection.cache;
}

/**
 * 把一批新确认的运势条目追加到当天文件末尾（按位置追加，不整文件重写，
 * 机制见 appendOnlyDayFile.ts）。fileState 由调用方（cache/workers/diskIO/luck.ts）
 * 持有并传入：为 null 或 day 对不上（本次运行第一次写、
 * 或刚跨天）时，先探测/接管一次对应日期的文件。pending 为空是防御性早退
 * ——调用方按 dirty 判断只在非空时才会调用，这里不该真的走到。
 */
export async function appendLuckEntries(
  day: string,
  fileState: LuckFileStateHolder,
  pending: LuckPendingEntry[]
): Promise<void> {
  if (pending.length === 0) return;
  mkdirSync(LUCK_MEMORY_DIR, { recursive: true });
  if (fileState.current?.day !== day) {
    fileState.current = await openDayFile(LUCK_MEMORY_DIR, day, PERSISTED_FILE_MODE);
  }
  const chunk: string = pending.map((entry: LuckPendingEntry): string => serializeDayFileEntry(entry.key, entry.record)).join(",\n");
  await appendToDayFile({
    dir: LUCK_MEMORY_DIR,
    state: fileState.current,
    chunk,
    mode: PERSISTED_FILE_MODE,
  });
}
