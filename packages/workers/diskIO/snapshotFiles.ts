/** 贴纸与每日运势的严格文件恢复、校验与落盘；AI 上下文由 SQLite 持久化。 */

import { mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { DayFileState, LuckDayCache, LuckDrawRecord, LuckPendingEntry } from "../../types/diskIO/storage";
import type { StickerCatalogSnapshot } from "../../types/stickers/catalog";
import type { LuckTier } from "../../types/luckChallenge";
import {
  LUCK_MEMORY_DIR,
  LUCK_RECEIPT_SECRET_PATH,
  STICKER_MEMORY_DIR,
  TMP_FILE_SUFFIX,
} from "../../consts/paths";
import { DAY_FILE_PATTERN } from "../../consts/diskIO/appendOnly";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { STICKER_PACK_NAME_PATTERN } from "../../consts/aiChat/stickers";
import { DAILY_LUCK_CACHE_MAX, luckTierByLabel } from "../../consts/luckChallenge";
import { LUCK_CACHE_KEY_PATTERN } from "../../consts/luckReceipt";
import {
  appendToDayFile,
  openDayFile,
  openValidatedAppendOnlyFile,
  serializeDayFileEntry,
} from "./appendOnlyDayFile";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import { invalidInput, readJsonInput, readUtf8TextInput } from "../../libs/inputValidation";
import {
  decodeStickerCatalogSnapshot,
} from "../../libs/persistedSnapshotCodec";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import { isCanonicalDateKey } from "../../libs/time";
import { assertFileReadableWritable, inspectOptionalFile, inspectOptionalDirectory } from "../../libs/fileAccess";

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

/** 贴纸目录快照的 inspect 结果：待载入的快照、孤儿快照与 *.tmp 残留三类路径。 */
export interface StickerCatalogRecoveryInspection {
  readonly snapshots: Map<string, string>;
  readonly orphanPaths: readonly string[];
  readonly temporaryPaths: readonly string[];
}

/**
 * 启动恢复的只读阶段：严格校验 memory/stickers/ 下每个贴纸包的目录快照，把它们
 * 归类成待载入快照、孤儿快照与临时文件残留。本函数不写盘、不删除。机制与
 * 其它快照领域基本一致，只是文件名使用 pack short name；多一步 activePacks
 * 对账——config/stickers.json 的白名单已经不包含的包记为孤儿，不载入内存，
 * 也就不会让 aiChat/ai/stickers/catalog.ts 的 getCatalogEntry 继续拿一个已下架包的
 * 旧描述去匹配群友发的贴纸。删除由全域校验成功后的 maintainStickerCatalogFiles
 * 执行。
 * @param activePacks 当前 config/stickers.json 的贴纸包白名单（见
 *   config/stickers.ts），用于判定哪些持久化文件已经是孤儿；null 表示白名单缺省，
 *   全部现存快照照常载入，不判孤儿。
 */
export async function inspectStickerCatalogs(
  activePacks: readonly string[] | null
): Promise<StickerCatalogRecoveryInspection> {
  const activePackSet: Set<string> | null = activePacks === null ? null : new Set(activePacks);
  const result: Map<string, string> = new Map();
  const orphanPaths: string[] = [];
  const temporaryPaths: string[] = [];
  const names: readonly string[] = inspectOptionalDirectory(STICKER_MEMORY_DIR)
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
 *  使用 tmp + fsync + rename，snapshotJson 为源头序列化好的
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
  const names: string[] = inspectOptionalDirectory(LUCK_MEMORY_DIR)
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
  if (!inspectOptionalFile(todayPath)) {
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
