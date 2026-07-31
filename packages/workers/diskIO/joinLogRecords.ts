/** 入群日志记录的纯校验、折叠、序列化与容量裁剪算法。 */

import { DAY_FILE_JSON_INDENT } from "../../consts/diskIO/appendOnly";
import { DAY_MS } from "../../consts/diskIO/common";
import { JOIN_LOG_SNAPSHOT_CHUNK_BYTES } from "../../consts/diskIO/joinLog";
import type { JoinLogRecord } from "../../types/diskIO/storage";
import { AppendOnlyFileFormatError } from "./appendOnlyDayFile";

/** 与通用追加格式一致的两级缩进，模块初始化一次后供热序列化路径复用。 */
const ENTRY_INDENT: string = " ".repeat(DAY_FILE_JSON_INDENT);
const FIELD_INDENT: string = " ".repeat(DAY_FILE_JSON_INDENT * 2);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJoinLogRecord(value: unknown): value is JoinLogRecord {
  return isRecord(value) &&
    Number.isSafeInteger(value.userId) &&
    (value.userId as number) > 0 &&
    Number.isSafeInteger(value.joinedAt) &&
    (value.joinedAt as number) > 0;
}

/** 严格校验可解析文件的领域 schema；错误结构不得当成空日志覆盖。 */
export function assertJoinLogSchema(
  path: string,
  parsed: unknown
): asserts parsed is Record<string, JoinLogRecord> {
  if (!isRecord(parsed)) {
    throw new AppendOnlyFileFormatError(
      path,
      "must contain a top-level JSON object."
    );
  }
  for (const key in parsed) {
    if (!Object.hasOwn(parsed, key)) continue;
    const value: unknown = parsed[key];
    if (
      !isJoinLogRecord(value) ||
      key !== `${value.joinedAt}:${value.userId}`
    ) {
      throw new AppendOnlyFileFormatError(
        path,
        `contains an invalid join record for key ${key}.`
      );
    }
  }
}

/**
 * 由一个 YYYY-MM-DD 锚点生成包含锚点在内的前 N 个日期。这里只对固定 UTC+9
 * 的东京自然日使用 DAY_MS，不把这套算法推广到有夏令时的时区。
 */
export function recentJoinLogDayKeys(
  day: string,
  count: number
): ReadonlySet<string> {
  const anchorMs: number = Date.parse(`${day}T00:00:00.000Z`);
  const days: Set<string> = new Set<string>();
  for (let offset: number = 0; offset < count; offset++) {
    days.add(
      new Date(anchorMs - offset * DAY_MS).toISOString().slice(0, 10)
    );
  }
  return days;
}

/**
 * 判断目标日是否落在锚点及其之前的 N 个东京自然日内。高频单条写入用此函数，
 * 避免只为一次 contains 判断分配临时 Set。
 */
export function isRecentJoinLogDay(
  candidate: string,
  anchor: string,
  count: number
): boolean {
  const anchorMs: number = Date.parse(`${anchor}T00:00:00.000Z`);
  for (let offset: number = 0; offset < count; offset += 1) {
    const day: string =
      new Date(anchorMs - offset * DAY_MS).toISOString().slice(0, 10);
    if (candidate === day) return true;
  }
  return false;
}

/** 把一个文件中的物理历史条目折叠成每用户最后一次入群。 */
export function latestJoinLogRecords(
  parsed: Readonly<Record<string, JoinLogRecord>>
): Map<number, JoinLogRecord> {
  const latest: Map<number, JoinLogRecord> = new Map();
  for (const key in parsed) {
    if (!Object.hasOwn(parsed, key)) continue;
    const record: JoinLogRecord | undefined = parsed[key];
    if (record === undefined) continue;
    const current: JoinLogRecord | undefined = latest.get(record.userId);
    if (current === undefined || record.joinedAt > current.joinedAt) {
      latest.set(record.userId, record);
    }
  }
  return latest;
}

/**
 * 入群记录只有两个正安全整数，无需为每条记录构造投影对象再调用通用
 * JSON.stringify；字段顺序与当前持久化 schema 固定一致。
 */
export function serializeJoinLogSnapshotEntry(
  record: JoinLogRecord
): string {
  return (
    `${ENTRY_INDENT}"${record.joinedAt}:${record.userId}": {\n` +
    `${FIELD_INDENT}"userId": ${record.userId},\n` +
    `${FIELD_INDENT}"joinedAt": ${record.joinedAt}\n` +
    `${ENTRY_INDENT}}`
  );
}

/** 一条记录在快照中的 UTF-8 字节数，不含前置的 `,\n`。 */
export function joinLogSnapshotEntryBytes(record: JoinLogRecord): number {
  return Buffer.byteLength(serializeJoinLogSnapshotEntry(record));
}

/** 计算分块快照的准确 UTF-8 字节数，不构造与群规模等长的字符串。 */
export function measureJoinLogSnapshotBytes(
  latestByUser: ReadonlyMap<number, JoinLogRecord>
): number {
  if (latestByUser.size === 0) return Buffer.byteLength("{}");
  let bytes: number = Buffer.byteLength("{\n\n}");
  let index: number = 0;
  for (const record of latestByUser.values()) {
    if (index > 0) bytes += Buffer.byteLength(",\n");
    bytes += joinLogSnapshotEntryBytes(record);
    index += 1;
  }
  return bytes;
}

/**
 * 按 Map 的稳定迭代顺序生成可直接写盘的 JSON 分块。只持有当前块与当前记录，
 * 不创建 values 数组、投影对象或整文件字符串。
 */
export function* joinLogSnapshotChunks(
  latestByUser: ReadonlyMap<number, JoinLogRecord>
): Generator<string, void, undefined> {
  if (latestByUser.size === 0) {
    yield "{}";
    return;
  }
  let chunk: string = "{\n";
  let chunkBytes: number = Buffer.byteLength(chunk);
  let index: number = 0;
  for (const record of latestByUser.values()) {
    const prefix: string = index === 0 ? "" : ",\n";
    const fragment: string =
      prefix + serializeJoinLogSnapshotEntry(record);
    const fragmentBytes: number = Buffer.byteLength(fragment);
    if (
      chunkBytes > 0 &&
      chunkBytes + fragmentBytes > JOIN_LOG_SNAPSHOT_CHUNK_BYTES
    ) {
      yield chunk;
      chunk = fragment;
      chunkBytes = fragmentBytes;
    } else {
      chunk += fragment;
      chunkBytes += fragmentBytes;
    }
    index += 1;
  }
  yield `${chunk}\n}`;
}

function compareRecordAge(
  records: ReadonlyMap<number, JoinLogRecord>,
  leftUserId: number,
  rightUserId: number
): number {
  const left: JoinLogRecord = records.get(leftUserId)!;
  const right: JoinLogRecord = records.get(rightUserId)!;
  return left.joinedAt - right.joinedAt || leftUserId - rightUserId;
}

/** 在“待淘汰的最旧记录”最大堆中上浮一个 user id。 */
function siftOldestSelectionUp(
  heap: number[],
  records: ReadonlyMap<number, JoinLogRecord>
): void {
  let index: number = heap.length - 1;
  while (index > 0) {
    const parent: number = Math.floor((index - 1) / 2);
    if (compareRecordAge(records, heap[index]!, heap[parent]!) <= 0) return;
    const value: number = heap[index]!;
    heap[index] = heap[parent]!;
    heap[parent] = value;
    index = parent;
  }
}

/** 根替换后下沉，保持根是已选最旧集合中相对最新的一条。 */
function siftOldestSelectionDown(
  heap: number[],
  records: ReadonlyMap<number, JoinLogRecord>
): void {
  let index: number = 0;
  while (true) {
    const left: number = index * 2 + 1;
    if (left >= heap.length) return;
    const right: number = left + 1;
    let newerChild: number = left;
    if (
      right < heap.length &&
      compareRecordAge(records, heap[right]!, heap[left]!) > 0
    ) {
      newerChild = right;
    }
    if (
      compareRecordAge(records, heap[newerChild]!, heap[index]!) <= 0
    ) {
      return;
    }
    const value: number = heap[index]!;
    heap[index] = heap[newerChild]!;
    heap[newerChild] = value;
    index = newerChild;
  }
}

/**
 * 原地只保留 joinedAt 最新的 capacity 个成员。
 * 只分配 overflow 个 user id；常规批次溢出至多为单批 300 项，不再复制和排序
 * 整张 25 万项 Map。恢复异常超大旧文件时仍受文件本身规模约束，但不会制造
 * 第二份完整记录对象。
 * @returns 被裁掉的记录数；容量降级只在极端高基数群日触发。
 */
export function trimJoinLogRecordsToCapacity(
  records: Map<number, JoinLogRecord>,
  capacity: number,
  onEvict?: (record: JoinLogRecord) => void
): number {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError(
      "Join log record capacity must be a positive safe integer."
    );
  }
  const overflow: number = records.size - capacity;
  if (overflow <= 0) return 0;
  const oldestUserIds: number[] = [];
  for (const userId of records.keys()) {
    if (oldestUserIds.length < overflow) {
      oldestUserIds.push(userId);
      siftOldestSelectionUp(oldestUserIds, records);
      continue;
    }
    if (compareRecordAge(records, userId, oldestUserIds[0]!) >= 0) {
      continue;
    }
    oldestUserIds[0] = userId;
    siftOldestSelectionDown(oldestUserIds, records);
  }
  for (const userId of oldestUserIds) {
    const record: JoinLogRecord = records.get(userId)!;
    onEvict?.(record);
    records.delete(userId);
  }
  return overflow;
}
