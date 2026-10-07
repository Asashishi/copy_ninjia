import { inspectOptionalFile, inspectOptionalDirectory } from "../../libs/fileAccess";
/** Owner: Disk I/O Worker。负责待验证日文件的恢复、跨日合并与 compact。 */

import { mkdirSync, readdirSync, renameSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { DAY_FILE_JSON_INDENT, DAY_FILE_PATTERN } from "../../consts/diskIO/appendOnly";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import {
  VERIFICATION_CORRUPT_DAY_FILE_SUFFIX,
  VERIFICATION_FILE_COMPACT_BYTES,
  VERIFICATION_FILE_COMPACT_ENTRIES,
  VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS,
  VERIFICATION_TOP_LEVEL_ENTRY_PATTERN,
} from "../../consts/diskIO/verification";
import { VERIFICATION_MEMORY_DIR } from "../../consts/paths";
import {
  resetVerificationPersistenceCache,
  verificationFileState,
  verificationPriorDayDecodeFailures,
  verificationWorkerCache,
} from "../../cache/workers/diskIO/verification";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import { InputValidationError, invalidInput, readUtf8TextInput } from "../../libs/inputValidation";
import { getDateKey, isCanonicalDateKey } from "../../libs/time";
import type { VerificationSnapshot } from
  "../../types/antiRaid/verification";
import { VERIFICATION_RECORD_CAPACITY } from "../../consts/antiRaid/verification";
import { openValidatedAppendOnlyFile } from "./appendOnlyDayFile";
import {
  decodeVerificationDay,
  storedVerificationSnapshot,
} from "./verificationCodec";
import type { VerificationDayValue } from "./verificationCodec";

interface VerificationDirectoryRecoveryPlan {
  readonly latestPriorDay: string | undefined;
  readonly oldDayNames: string[];
  readonly futureDayCount: number;
}

export interface VerificationRecoveryInspection {
  readonly day: string;
  readonly dir: string;
  readonly recovered: Map<string, VerificationSnapshot>;
  readonly fileState: {
    readonly day: string;
    readonly size: number;
    readonly empty: boolean;
  };
  readonly appendedEntries: number;
  readonly appendedBytes: number;
  readonly directoryPlan: VerificationDirectoryRecoveryPlan;
  readonly shouldCompact: boolean;
}

/** 一轮完成恢复所需的文件名校验、旧日选择和延后清理计划，不提前删除文件。 */
function inspectVerificationDirectory(
  day: string,
  dir: string,
  entries: readonly Dirent<string>[]
): VerificationDirectoryRecoveryPlan {
  let latestPriorDay: string | undefined;
  const oldDayNames: string[] = [];
  let futureDayCount: number = 0;
  for (const entry of entries) {
    const name: string = entry.name;
    if (!name.endsWith(".json")) continue;
    const path: string = join(dir, name);
    if (!entry.isFile()) return invalidInput(path, "$type", "a regular file without symbolic-link indirection");
    const candidate: string | undefined = DAY_FILE_PATTERN.exec(name)?.[1];
    if (candidate === undefined) {
      return invalidInput(path, "$filename", "the canonical <YYYY-MM-DD>.json form");
    }
    if (!isCanonicalDateKey(candidate)) {
      return invalidInput(path, "$filename", "a canonical calendar date");
    }
    if (candidate === day) continue;
    if (candidate > day) {
      futureDayCount++;
      continue;
    }
    oldDayNames.push(name);
    if (latestPriorDay === undefined || candidate > latestPriorDay) {
      latestPriorDay = candidate;
    }
  }
  return { latestPriorDay, oldDayNames, futureDayCount };
}

function assertRecoveredVerificationCapacity(
  records: ReadonlyMap<string, VerificationSnapshot>,
  sourcePath: string
): void {
  if (records.size <= VERIFICATION_RECORD_CAPACITY) return;
  return invalidInput(
    sourcePath,
    "$",
    `a JSON object with at most ${VERIFICATION_RECORD_CAPACITY} active verification records`
  );
}

/**
 * 只删除本目录中明确匹配日期命名、且**严格早于** day 的 JSON，不碰临时文件
 * 或其它资产。从最旧删到最新，中途失败时最新旧日仍是下次恢复的权威基线。
 *
 * 晚于 day 的日文件一律保留，不并进本次恢复；时钟走到那天时它就是当天文件并被正常恢复。
 */
export async function removeOldVerificationDays(
  day: string,
  dir: string = VERIFICATION_MEMORY_DIR
): Promise<void> {
  await applyVerificationDirectoryRecoveryPlan(day, dir, scanVerificationDayFiles(day, dir));
}

/**
 * rollover 与 compact 的独立扫描：只认日期命名的普通文件，未知资产忽略；按 day 分出更早的旧日、
 * 其中最新的一份与晚于 day 的文件数。
 */
function scanVerificationDayFiles(day: string, dir: string): VerificationDirectoryRecoveryPlan {
  let latestPriorDay: string | undefined;
  const oldDayNames: string[] = [];
  let futureDayCount: number = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const candidate: string | undefined = DAY_FILE_PATTERN.exec(entry.name)?.[1];
    if (candidate === undefined || candidate === day) continue;
    if (candidate > day) {
      futureDayCount++;
      continue;
    }
    oldDayNames.push(entry.name);
    if (latestPriorDay === undefined || candidate > latestPriorDay) latestPriorDay = candidate;
  }
  return { latestPriorDay, oldDayNames, futureDayCount };
}

/**
 * 按计划删除严格早于 day 的旧日文件（从最旧到最新）；有晚于 day 的日文件时只告警、保留。
 * 启动恢复在领域文件全部校验成功后才调用，失败前不会删除任何旧日；rollover 用自己扫出的计划。
 */
async function applyVerificationDirectoryRecoveryPlan(
  day: string,
  dir: string,
  plan: Pick<VerificationDirectoryRecoveryPlan, "oldDayNames" | "futureDayCount">
): Promise<void> {
  if (plan.futureDayCount > 0) {
    console.error(
      `[diskIOWorker] kept ${plan.futureDayCount} verification day file(s) dated after ${day}: ` +
      "the host clock most likely stepped backwards, and these files hold pending " +
      "verifications that this recovery refuses to merge."
    );
  }
  const oldDayNames: string[] = [...plan.oldDayNames].sort();
  for (const name of oldDayNames) await Bun.file(join(dir, name)).delete();
}

/**
 * 严格读取并解码一份旧日文件。内容不是合法 UTF-8 或不是当前格式时计一次连续解码失败并上抛；
 * 同一文件第 VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS 次失败时改名为
 * `<日期>.json` + VERIFICATION_CORRUPT_DAY_FILE_SUFFIX、写一行诊断并返回 null。读盘失败等其它
 * 错误原样上抛，不计数。
 */
async function decodePriorDayOrQuarantine(priorPath: string): Promise<Map<string, VerificationDayValue> | null> {
  let values: Map<string, VerificationDayValue>;
  try {
    values = decodeVerificationDay(priorPath, await readUtf8TextInput(priorPath));
  } catch (error: unknown) {
    // 严格 UTF-8 解码失败抛 TypeError，格式不符抛 InputValidationError。
    if (!(error instanceof InputValidationError) && !(error instanceof TypeError)) throw error;
    const failures: { path: string | null; count: number } = verificationPriorDayDecodeFailures;
    failures.count = failures.path === priorPath ? failures.count + 1 : 1;
    failures.path = priorPath;
    if (failures.count < VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS) throw error;
    failures.path = null;
    failures.count = 0;
    const corruptPath: string = `${priorPath}${VERIFICATION_CORRUPT_DAY_FILE_SUFFIX}`;
    renameSync(priorPath, corruptPath);
    console.error(
      `[diskIOWorker] verification day file ${priorPath} failed to decode ` +
      `${VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS} times in a row; renamed it to ${corruptPath} ` +
      "and the new day continues from the in-memory verification mirror:",
      error
    );
    return null;
  }
  verificationPriorDayDecodeFailures.path = null;
  verificationPriorDayDecodeFailures.count = 0;
  return values;
}

/**
 * 目录里严格早于 day 的最新日文件中仍为 active、而当前镜像已没有的 key。启动恢复把 day 文件当
 * 增量叠在最新旧日之上（见 inspectVerificationDay），旧日文件还没删掉时，compact 产物必须为这些
 * key 写 null tombstone，已删除的记录才不会从旧日复活。最新旧日被 decodePriorDayOrQuarantine
 * 改名为损坏文件后接着看剩下的旧日；没有旧日文件时返回空数组。
 */
async function priorDayTombstoneKeys(day: string, dir: string): Promise<string[]> {
  for (;;) {
    const latestPriorDay: string | undefined = scanVerificationDayFiles(day, dir).latestPriorDay;
    if (latestPriorDay === undefined) return [];
    const values: Map<string, VerificationDayValue> | null =
      await decodePriorDayOrQuarantine(join(dir, `${latestPriorDay}.json`));
    if (values === null) continue;
    const keys: string[] = [];
    for (const [key, value] of values) {
      if (value !== null && !verificationWorkerCache.has(key)) keys.push(key);
    }
    return keys;
  }
}

/**
 * 把当前 active 镜像原子写成指定日期的规范对象；维护路径才整份重写。目录里还留着更早的
 * 日文件时，为其中仍 active、镜像里已删除的 key 追加 null tombstone（见 priorDayTombstoneKeys）。
 */
export async function compactVerificationDay(
  day: string,
  dir: string = VERIFICATION_MEMORY_DIR
): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const compacted: Record<string, unknown> = {};
  for (const [key, snapshot] of verificationWorkerCache) {
    compacted[key] = storedVerificationSnapshot(snapshot);
  }
  const tombstoneKeys: string[] = await priorDayTombstoneKeys(day, dir);
  for (const key of tombstoneKeys) compacted[key] = null;
  const content: string = JSON.stringify(compacted, null, DAY_FILE_JSON_INDENT);
  atomicWriteTextSync(join(dir, `${day}.json`), content, PERSISTED_FILE_MODE);
  const empty: boolean = verificationWorkerCache.size === 0 && tombstoneKeys.length === 0;
  verificationFileState.current = {
    day,
    size: empty ? 0 : Buffer.byteLength(content),
    empty,
  };
  verificationFileState.appendedEntries = 0;
  verificationFileState.appendedBytes = 0;
}

/** 启动第一阶段：只读校验配置时区的当天及最新旧日，构造接管与维护计划。 */
export async function inspectVerificationDay(
  day: string = getDateKey(),
  dir: string = VERIFICATION_MEMORY_DIR
): Promise<VerificationRecoveryInspection> {
  const entries: readonly Dirent<string>[] = inspectOptionalDirectory(dir)
    ? readdirSync(dir, { withFileTypes: true })
    : [];
  const directoryPlan: VerificationDirectoryRecoveryPlan = inspectVerificationDirectory(
    day,
    dir,
    entries
  );

  const path: string = join(dir, `${day}.json`);
  const priorDay: string | undefined = directoryPlan.latestPriorDay;
  const recovered: Map<string, VerificationSnapshot> = new Map();
  let currentContent: string | null = null;
  let decodedEntryCount: number = 0;
  const currentFileExists: boolean = inspectOptionalFile(path);
  if (priorDay !== undefined) {
    const priorPath: string = join(dir, `${priorDay}.json`);
    // 旧日是唯一恢复来源时必须严格解码；损坏时保留新旧文件并拒绝启动。
    const priorValues: Map<string, VerificationDayValue> =
      decodeVerificationDay(priorPath, await readUtf8TextInput(priorPath));
    for (const [key, value] of priorValues) {
      if (value !== null) recovered.set(key, value);
    }

    if (currentFileExists) {
      currentContent = await readUtf8TextInput(path);
      const currentValues: Map<string, VerificationDayValue> =
        decodeVerificationDay(path, currentContent);
      decodedEntryCount = currentValues.size;
      // 新日是更晚的权威增量；null tombstone 必须压过旧日 active。
      for (const [key, value] of currentValues) {
        if (value === null) recovered.delete(key);
        else recovered.set(key, value);
      }
    }

    assertRecoveredVerificationCapacity(
      recovered,
      currentFileExists ? path : priorPath
    );
  } else if (currentFileExists) {
    currentContent = await readUtf8TextInput(path);
    const decoded: Map<string, VerificationDayValue> =
      decodeVerificationDay(path, currentContent);
    decodedEntryCount = decoded.size;
    for (const [key, value] of decoded) {
      if (value !== null) recovered.set(key, value);
    }
    assertRecoveredVerificationCapacity(recovered, path);
  }

  const fileState: VerificationRecoveryInspection["fileState"] = currentContent === null
    ? { day, size: 0, empty: true }
    : {
      day,
      ...openValidatedAppendOnlyFile({
        path,
        content: currentContent,
        empty: decodedEntryCount === 0,
      }),
    };
  const appendedEntries: number = currentContent?.match(
    VERIFICATION_TOP_LEVEL_ENTRY_PATTERN
  )?.length ?? 0;
  return {
    day,
    dir,
    recovered,
    fileState,
    appendedEntries,
    appendedBytes: fileState.size,
    directoryPlan,
    shouldCompact: priorDay !== undefined ||
      appendedEntries >= VERIFICATION_FILE_COMPACT_ENTRIES ||
      fileState.size >= VERIFICATION_FILE_COMPACT_BYTES,
  };
}

/** 全域 inspect 成功后整体发布 verification owner 与追加游标。 */
export function adoptVerificationDay(
  inspection: VerificationRecoveryInspection
): Map<string, VerificationSnapshot> {
  resetVerificationPersistenceCache();
  for (const [key, snapshot] of inspection.recovered) {
    verificationWorkerCache.set(key, snapshot);
  }
  verificationFileState.current = inspection.fileState;
  verificationFileState.appendedEntries = inspection.appendedEntries;
  verificationFileState.appendedBytes = inspection.appendedBytes;
  return verificationWorkerCache;
}

/** 启动成功后执行 compact 与旧日清理；compact 失败时不删除恢复基线。 */
export async function maintainVerificationDay(
  inspection: VerificationRecoveryInspection
): Promise<void> {
  try {
    mkdirSync(inspection.dir, { recursive: true });
    if (inspection.shouldCompact) {
      await compactVerificationDay(inspection.day, inspection.dir);
    }
    await applyVerificationDirectoryRecoveryPlan(
      inspection.day,
      inspection.dir,
      inspection.directoryPlan
    );
  } catch (error: unknown) {
    // 原子 rename 成功、目录 fsync 失败时目标文件可能已经发布；丢掉旧游标，
    // 下一次写先按磁盘现状重新 compact。
    verificationFileState.current = null;
    verificationFileState.appendedEntries = 0;
    verificationFileState.appendedBytes = 0;
    throw error;
  }
}
