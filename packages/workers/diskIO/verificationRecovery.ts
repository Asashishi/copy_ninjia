/** Owner: Disk I/O Worker。负责待验证日文件的恢复、跨日合并与 compact。 */

import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { DAY_FILE_JSON_INDENT, DAY_FILE_PATTERN } from "../../consts/diskIO/appendOnly";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import {
  VERIFICATION_FILE_COMPACT_BYTES,
  VERIFICATION_FILE_COMPACT_ENTRIES,
  VERIFICATION_TOP_LEVEL_ENTRY_PATTERN,
} from "../../consts/diskIO/verification";
import { VERIFICATION_MEMORY_DIR } from "../../consts/paths";
import {
  resetVerificationPersistenceCache,
  verificationFileState,
  verificationWorkerCache,
} from "../../cache/workers/diskIO/verification";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import { invalidInput, readUtf8TextInput } from "../../libs/inputValidation";
import { getTokyoDateKey, isCanonicalDateKey } from "../../libs/time";
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
    if (!entry.isFile()) continue;
    const name: string = entry.name;
    if (!name.endsWith(".json")) continue;
    const path: string = join(dir, name);
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
 * 或其它资产。从最旧删到最新：若中途失败，最新旧日仍是下次恢复的权威基线。
 *
 * 晚于 day 的日文件一律保留：恢复目录计划明确拒绝把它们并进本次恢复，删掉就
 * 等于把一整天的待验证记录未读丢弃——宿主时钟快于真实时间（VM 恢复、NTP
 * 同步前启动）时写出的那份就是这种文件。
 * 留着它不会常驻：时钟走到那天时，它自己就是当天文件并被正常恢复。
 */
export function removeOldVerificationDays(
  day: string,
  dir: string = VERIFICATION_MEMORY_DIR
): void {
  removeOldVerificationDaysFromEntries(
    day,
    dir,
    readdirSync(dir, { withFileTypes: true })
  );
}

/** rollover 独立扫描时只规划严格日期文件；未知资产仍按既有语义忽略。 */
function removeOldVerificationDaysFromEntries(
  day: string,
  dir: string,
  entries: readonly Dirent<string>[]
): void {
  const oldDays: string[] = [];
  let futureDays: number = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const candidate: string | undefined = DAY_FILE_PATTERN.exec(entry.name)?.[1];
    if (candidate === undefined || candidate === day) continue;
    if (candidate > day) {
      futureDays++;
      continue;
    }
    oldDays.push(entry.name);
  }
  if (futureDays > 0) {
    console.error(
      `[diskIOWorker] kept ${futureDays} verification day file(s) dated after ${day}: ` +
      "the host clock most likely stepped backwards, and these files hold pending " +
      "verifications that this recovery refuses to merge."
    );
  }
  oldDays.sort();
  for (const name of oldDays) unlinkSync(join(dir, name));
}

/** 在领域文件全部校验成功后应用预先计算的计划；失败前不会删除任何旧日。 */
function applyVerificationDirectoryRecoveryPlan(
  day: string,
  dir: string,
  plan: VerificationDirectoryRecoveryPlan
): void {
  if (plan.futureDayCount > 0) {
    console.error(
      `[diskIOWorker] kept ${plan.futureDayCount} verification day file(s) dated after ${day}: ` +
      "the host clock most likely stepped backwards, and these files hold pending " +
      "verifications that this recovery refuses to merge."
    );
  }
  const oldDayNames: string[] = [...plan.oldDayNames].sort();
  for (const name of oldDayNames) unlinkSync(join(dir, name));
}

/** 把当前 active 镜像原子写成指定日期的规范对象；维护路径才整份重写。 */
export function compactVerificationDay(
  day: string,
  dir: string = VERIFICATION_MEMORY_DIR
): void {
  mkdirSync(dir, { recursive: true });
  const compacted: Record<string, unknown> = {};
  for (const [key, snapshot] of verificationWorkerCache) {
    compacted[key] = storedVerificationSnapshot(snapshot);
  }
  const content: string = JSON.stringify(compacted, null, DAY_FILE_JSON_INDENT);
  atomicWriteTextSync(join(dir, `${day}.json`), content, PERSISTED_FILE_MODE);
  const empty: boolean = verificationWorkerCache.size === 0;
  verificationFileState.current = {
    day,
    size: empty ? 0 : Buffer.byteLength(content),
    empty,
  };
  verificationFileState.appendedEntries = 0;
  verificationFileState.appendedBytes = 0;
}

/** 启动第一阶段：只读校验东京当天及最新旧日，构造接管与维护计划。 */
export async function inspectVerificationDay(
  day: string = getTokyoDateKey(),
  dir: string = VERIFICATION_MEMORY_DIR
): Promise<VerificationRecoveryInspection> {
  const entries: readonly Dirent<string>[] = existsSync(dir)
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
  const currentFileExists: boolean = await Bun.file(path).exists();
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
export function maintainVerificationDay(
  inspection: VerificationRecoveryInspection
): void {
  try {
    mkdirSync(inspection.dir, { recursive: true });
    if (inspection.shouldCompact) {
      compactVerificationDay(inspection.day, inspection.dir);
    }
    applyVerificationDirectoryRecoveryPlan(
      inspection.day,
      inspection.dir,
      inspection.directoryPlan
    );
  } catch (error: unknown) {
    // 原子 rename 成功、目录 fsync 失败时调用方会收到异常，但目标文件可能已经
    // 发布；丢掉旧游标，下一次写先按磁盘现状重新 compact，不能沿错误 offset 追加。
    verificationFileState.current = null;
    verificationFileState.appendedEntries = 0;
    verificationFileState.appendedBytes = 0;
    throw error;
  }
}
