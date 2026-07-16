/**
 * 通用的"按天 JSON 对象文件、末尾追加"落盘机制：文件内容始终是一个顶层
 * JSON 对象 { "key1": value1, "key2": value2, ... }，新增条目不整文件重写，
 * 而是覆写文件结尾的「\n}」两字节、按位置追加，写入量只与本批条数有关，
 * 与文件大小无关。原是 loggerWorker.ts 专属逻辑，现抽成通用机制，调用方
 * 是 diskIO/logFiles.ts（日志）与 diskIO/snapshotFiles.ts 的
 * appendLuckEntries（每日运势）；调用方各自负责 key/value 怎么序列化、
 * 多久 flush 一次、保留策略等领域逻辑，这里只管字节层面的
 * 打开/探测/追加/损坏修复。
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { DayFileState } from "../../types";
import { TMP_FILE_SUFFIX } from "../../consts/paths";

/**
 * 整份文件重写用：tmp + rename（同文件系统内原子操作），避免这类维护性重写
 * 被杀一半留下撕裂 JSON（同 snapshotFiles.ts atomicWriteJson 的理由）。只用
 * 在 openDayFile 的两处维护性重写上——真正的热路径 appendToDayFile 仍是
 * 位置写，其非原子性是刻意的性能取舍，靠 repairTruncated 兜底，见下方注释。
 */
function atomicRewrite(path: string, content: string): void {
  const tmpPath: string = `${path}${TMP_FILE_SUFFIX}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path);
}

/**
 * 打开（或接管）某天的文件并校验其可追加性。文件不存在或为空对象视作
 * 空文件；内容合法但结尾形态不符（比如被人手动编辑过）就按标准格式重写
 * 一次；解析失败（断电等原因导致结尾写了一半）先尝试 repairTruncated
 * 裁掉末尾残片修复，实在修不好才放弃旧内容从头开始。size 一律以
 * fs.statSync 读到的物理文件大小为准，不信任内存里算出来的字节数。
 */
export function openDayFile(dir: string, day: string): DayFileState {
  const path: string = join(dir, `${day}.json`);
  const state: DayFileState = { day, size: 0, empty: true };
  if (!existsSync(path)) return state;
  const content: string = readFileSync(path, "utf8");
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Object.keys(parsed).length === 0) return state;
    if (!content.endsWith("\n}")) {
      atomicRewrite(path, JSON.stringify(parsed, null, 2));
    }
    state.size = statSync(path).size;
    state.empty = false;
    return state;
  } catch {
    // 解析失败，尝试修复后再决定是否放弃。
  }
  const repaired: string | null = repairTruncated(content);
  if (repaired === null) return state;
  try {
    atomicRewrite(path, repaired);
    state.size = statSync(path).size;
    state.empty = false;
  } catch {
    // 写回修复内容也失败，只能从空文件重新开始，不让调用方崩掉。
  }
  return state;
}

/**
 * 修复被截断的日文件：先试着直接补一个「\n}」收尾（只是丢了最后的收尾
 * 括号这种最常见情况）；不行的话，从末尾往前找最后一行完整的「  },」
 * （某条记录的收尾且后面还有别的记录），裁掉它之后的乱码残片，去掉这行的
 * 逗号再补上「\n}」。两种都拼不出合法 JSON 就返回 null，交给调用方从空
 * 文件重新开始。
 */
function repairTruncated(content: string): string | null {
  const withClosingBrace: string = `${content}\n}`;
  try {
    JSON.parse(withClosingBrace);
    return withClosingBrace;
  } catch {
    // 继续尝试裁掉末尾残片。
  }
  const lines: string[] = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] !== "  },") continue;
    lines[i] = "  }";
    const candidate: string = `${lines.slice(0, i + 1).join("\n")}\n}`;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // 这一行也不构成合法边界（理论上不该发生），继续往前找。
    }
  }
  return null;
}

/** 把一段已序列化好的条目文本追加到某天的文件末尾（覆写结尾的「\n}」）。 */
export function appendToDayFile(dir: string, state: DayFileState, chunk: string): void {
  const path: string = join(dir, `${state.day}.json`);
  if (state.empty) {
    const content: string = `{\n${chunk}\n}`;
    writeFileSync(path, content);
    state.size = Buffer.byteLength(content);
    state.empty = false;
    return;
  }
  const data: string = `,\n${chunk}\n}`;
  const fd: number = openSync(path, "r+");
  try {
    writeSync(fd, data, state.size - 2, "utf8");
  } finally {
    closeSync(fd);
  }
  state.size = state.size - 2 + Buffer.byteLength(data);
}

/**
 * 把单条记录序列化成顶层对象里的一段文本（含 2 空格缩进、不含前后逗号），
 * 与 JSON.stringify(整个对象, null, 2) 中该条目的形态完全一致。实现上借
 * 单条目对象的 stringify 结果，掐掉外层的「{\n」和「\n}」。
 */
export function serializeDayFileEntry(key: string, value: unknown): string {
  return JSON.stringify({ [key]: value }, null, 2).slice(2, -2);
}
