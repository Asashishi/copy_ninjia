/** Owner: Disk I/O Worker。负责待验证日文件的恢复、跨日合并与 compact。 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
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
import { getTokyoDateKey } from "../../libs/time";
import type { VerificationSnapshot } from "../../types/antiRaid";
import { openDayFile } from "./appendOnlyDayFile";
import {
  decodeVerificationDay,
  storedVerificationSnapshot,
} from "./verificationCodec";
import type { VerificationDayValue } from "./verificationCodec";

function latestPriorVerificationDay(day: string, dir: string): string | undefined {
  let latest: string | undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match: RegExpExecArray | null = DAY_FILE_PATTERN.exec(entry.name);
    const candidate: string | undefined = match?.[1];
    if (
      candidate === undefined ||
      candidate >= day ||
      (latest !== undefined && candidate <= latest)
    ) {
      continue;
    }
    latest = candidate;
  }
  return latest;
}

/**
 * 只删除本目录中明确匹配日期命名的旧 JSON，不碰临时文件或其它资产。
 * 从最旧删到最新：若中途失败，最新旧日仍是下次恢复的权威基线。
 */
export function removeOldVerificationDays(
  day: string,
  dir: string = VERIFICATION_MEMORY_DIR
): void {
  const oldDays: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !DAY_FILE_PATTERN.test(entry.name) ||
      entry.name === `${day}.json`
    ) continue;
    oldDays.push(entry.name);
  }
  oldDays.sort();
  for (const name of oldDays) unlinkSync(join(dir, name));
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
  atomicWriteTextSync(
    join(dir, `${day}.json`),
    JSON.stringify(compacted, null, DAY_FILE_JSON_INDENT),
    PERSISTED_FILE_MODE
  );
  verificationFileState.current = openDayFile(dir, day, PERSISTED_FILE_MODE);
  verificationFileState.appendedEntries = 0;
  verificationFileState.appendedBytes = 0;
}

/** 启动恢复东京当天；若停机跨日，先合并最新旧日并原子发布，再清理旧日。 */
export function recoverVerificationDay(
  day: string = getTokyoDateKey(),
  dir: string = VERIFICATION_MEMORY_DIR
): Map<string, VerificationSnapshot> {
  mkdirSync(dir, { recursive: true });
  resetVerificationPersistenceCache();

  const path: string = join(dir, `${day}.json`);
  const priorDay: string | undefined = latestPriorVerificationDay(day, dir);
  if (priorDay !== undefined) {
    const priorPath: string = join(dir, `${priorDay}.json`);
    // 旧日是唯一恢复来源时必须严格解码；损坏时保留新旧文件并拒绝启动。
    const priorValues: Map<string, VerificationDayValue> =
      decodeVerificationDay(priorPath, readFileSync(priorPath, "utf8"));
    const merged: Map<string, VerificationSnapshot> = new Map();
    for (const [key, value] of priorValues) {
      if (value !== null) merged.set(key, value);
    }

    if (existsSync(path)) {
      let currentContent: string = readFileSync(path, "utf8");
      try {
        JSON.parse(currentContent);
      } catch {
        verificationFileState.current = openDayFile(
          dir,
          day,
          PERSISTED_FILE_MODE
        );
        currentContent = readFileSync(path, "utf8");
      }
      const currentValues: Map<string, VerificationDayValue> =
        decodeVerificationDay(path, currentContent);
      // 新日是更晚的权威增量；null tombstone 必须压过旧日 active。
      for (const [key, value] of currentValues) {
        if (value === null) merged.delete(key);
        else merged.set(key, value);
      }
    }

    for (const [key, snapshot] of merged) {
      verificationWorkerCache.set(key, snapshot);
    }
    try {
      compactVerificationDay(day, dir);
      removeOldVerificationDays(day, dir);
    } catch (error: unknown) {
      resetVerificationPersistenceCache();
      throw error;
    }
    return new Map(verificationWorkerCache);
  }

  if (!existsSync(path)) {
    verificationFileState.current = openDayFile(dir, day, PERSISTED_FILE_MODE);
    removeOldVerificationDays(day, dir);
    return new Map();
  }

  let content: string = readFileSync(path, "utf8");
  try {
    JSON.parse(content);
  } catch {
    // 仅对字节级尾部截断沿用通用修复；修复不了仍由下次 parse fail closed。
    verificationFileState.current = openDayFile(dir, day, PERSISTED_FILE_MODE);
    content = readFileSync(path, "utf8");
    JSON.parse(content);
  }
  const recovered: Map<string, VerificationSnapshot> = new Map();
  for (const [key, value] of decodeVerificationDay(path, content)) {
    if (value !== null) recovered.set(key, value);
  }

  for (const [key, snapshot] of recovered) {
    verificationWorkerCache.set(key, snapshot);
  }
  verificationFileState.current ??= openDayFile(dir, day, PERSISTED_FILE_MODE);
  removeOldVerificationDays(day, dir);

  verificationFileState.appendedEntries =
    content.match(VERIFICATION_TOP_LEVEL_ENTRY_PATTERN)?.length ?? 0;
  verificationFileState.appendedBytes = verificationFileState.current.size;
  if (
    verificationFileState.appendedEntries >= VERIFICATION_FILE_COMPACT_ENTRIES ||
    verificationFileState.appendedBytes >= VERIFICATION_FILE_COMPACT_BYTES
  ) {
    compactVerificationDay(day, dir);
  }
  return new Map(verificationWorkerCache);
}
