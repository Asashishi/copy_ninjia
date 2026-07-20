/**
 * 通用的"按天 JSON 对象文件、末尾追加"落盘机制：文件内容始终是一个顶层
 * JSON 对象 { "key1": value1, "key2": value2, ... }，新增条目不整文件重写，
 * 而是覆写文件结尾的「\n}」两字节、按位置追加，写入量只与本批条数有关，
 * 与文件大小无关。原是 loggerWorker.ts 专属逻辑，现抽成通用机制，调用方
 * 是 diskIO/logFiles.ts（日志）、diskIO/snapshotFiles.ts 的
 * appendLuckEntries（每日运势）与 diskIO/verificationFiles.ts（待验证）；
 * 调用方各自负责 key/value 怎么序列化、
 * 多久 flush 一次、保留策略等领域逻辑，这里只管字节层面的
 * 打开/探测/追加/损坏修复。
 */

import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { DayFileState } from "../../types/diskIO/storage";
import { DAY_FILE_JSON_INDENT } from "../../consts/diskIO/appendOnly";
import { atomicWriteTextSync } from "../../libs/atomicFile";

// serializeDayFileEntry 的 slice(2, -2) 依赖 stringify 输出是多行形态
// （indent 为 0 时输出单行，掐头去尾会切进内容本身）；启动即断言，不让
// 一次误改常量静默产出坏文件。
if (DAY_FILE_JSON_INDENT < 1) {
  throw new Error("DAY_FILE_JSON_INDENT must be >= 1: serializeDayFileEntry relies on multi-line JSON.stringify output");
}

/** repairTruncated 用来识别"一条完整记录的收尾行"，必须与 openDayFile/
 *  serializeDayFileEntry 的 JSON.stringify 缩进宽度保持一致，见
 *  DAY_FILE_JSON_INDENT 注释。 */
const ENTRY_LINE_INDENT: string = " ".repeat(DAY_FILE_JSON_INDENT);

export interface SyncWriteRequest {
  fd: number;
  buffer: Buffer;
  offset: number;
  length: number;
  position: number;
}

export type SyncBufferWriter = (request: SyncWriteRequest) => number;
export type SyncFile = (fd: number) => void;

const nodeWriteBuffer: SyncBufferWriter = ({ fd, buffer, offset, length, position }) =>
  writeSync(fd, buffer, offset, length, position);

/** write(2) 允许成功但只写一部分；只有整段 Buffer 落下才算 append 成功。 */
export function writeBufferFully(
  fd: number,
  buffer: Buffer,
  options: { position: number; write?: SyncBufferWriter }
): void {
  const write: SyncBufferWriter = options.write ?? nodeWriteBuffer;
  let offset: number = 0;
  while (offset < buffer.length) {
    const written: number = write({
      fd,
      buffer,
      offset,
      length: buffer.length - offset,
      position: options.position + offset,
    });
    if (!Number.isSafeInteger(written) || written <= 0 || written > buffer.length - offset) {
      throw new Error(`Short write made no valid progress (${written} byte(s) reported).`);
    }
    offset += written;
  }
}

/**
 * 整份文件重写用：tmp + fsync + rename（同文件系统内原子操作），避免这类
 * 维护性重写被杀一半留下撕裂 JSON（同 snapshotFiles.ts atomicWriteText 的
 * 理由，fsync 的必要性见其注释）。只用在 openDayFile 的两处维护性重写上——
 * 真正的热路径 appendToDayFile 仍是位置写，其非原子性是刻意的性能取舍，
 * 靠 repairTruncated 兜底，见下方注释。
 */
function atomicRewrite(path: string, content: string, mode?: number): void {
  atomicWriteTextSync(path, content, mode);
}

/**
 * 打开（或接管）某天的文件并校验其可追加性。文件不存在或为空对象视作
 * 空文件；内容合法但结尾形态不符（比如被人手动编辑过）就按标准格式重写
 * 一次；解析失败（断电等原因导致结尾写了一半）先尝试 repairTruncated
 * 裁掉末尾残片修复，实在修不好才放弃旧内容从头开始。size 一律以
 * fs.statSync 读到的物理文件大小为准，不信任内存里算出来的字节数。
 */
export function openDayFile(dir: string, day: string, mode?: number): DayFileState {
  const path: string = join(dir, `${day}.json`);
  const state: DayFileState = { day, size: 0, empty: true };
  if (!existsSync(path)) return state;
  // 调用方显式要求 mode 时，接管旧文件也修正曾被严格 umask
  // 收紧的权限。日志路径不传 mode，保持原有部署权限策略。
  // 已经是 0644 时不无条件 chmod：共享部署中文件可能由另一账号
  // 所有，虽然当前账号可读写，对相同 mode 做 chmod 仍会 EPERM。
  if (mode !== undefined && (statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
  const content: string = readFileSync(path, "utf8");
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Object.keys(parsed).length === 0) return state;
    if (!content.endsWith("\n}")) {
      atomicRewrite(path, JSON.stringify(parsed, null, DAY_FILE_JSON_INDENT), mode);
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
    // 与上面"解析成功"分支同样的空对象判断不能漏掉：文件若恰好在写入
    // 第一条记录之前被杀（物理内容只有一个 "{"），repairTruncated 补一个
    // 收尾括号就能修复成语义为空的 "{}"——如果这里不做同样的检查、无条件
    // 标 empty:false，下一次追加会误判成"非空、按位置追加"，从这份只有
    // 几字节的文件中间写入，产出打头带逗号的非法 JSON；这个坏文件下次
    // 重启又会因为找不到 `${ENTRY_LINE_INDENT}},` 这样的行边界而修复失败
    // 被放弃（物理文件却不会被清空），直到再下一次追加触发 writeFileSync
    // 整份覆写，才把这段本可挽救的数据永久冲掉。
    const repairedParsed: unknown = JSON.parse(repaired);
    const repairedIsEmpty: boolean =
      repairedParsed !== null && typeof repairedParsed === "object" && Object.keys(repairedParsed).length === 0;
    atomicRewrite(path, repaired, mode);
    state.size = statSync(path).size;
    state.empty = repairedIsEmpty;
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
  const entryClosingLine: string = `${ENTRY_LINE_INDENT}}`;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] !== `${entryClosingLine},`) continue;
    lines[i] = entryClosingLine;
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
export function appendToDayFile({
  dir,
  state,
  chunk,
  mode,
  write = nodeWriteBuffer,
  sync = fsyncSync,
}: {
  dir: string;
  state: DayFileState;
  chunk: string;
  mode?: number;
  /** 仅供故障注入测试；生产使用 node:fs writeSync。 */
  write?: SyncBufferWriter;
  /** 仅供故障注入测试；生产在成功回执前 fsync 当前批次。 */
  sync?: SyncFile;
}): void {
  const path: string = join(dir, `${state.day}.json`);
  if (state.empty) {
    const content: string = `{\n${chunk}\n}`;
    // 首条也走原子替换；传入 mode 时临时文件会在 rename 前
    // fchmod，不会因进程 umask 而暴露权限不符合要求的目标。
    atomicRewrite(path, content, mode);
    state.size = Buffer.byteLength(content);
    state.empty = false;
    return;
  }
  const data: Buffer = Buffer.from(`,\n${chunk}\n}`, "utf8");
  const fd: number = openSync(path, "r+");
  let failure: unknown = null;
  try {
    writeBufferFully(fd, data, { position: state.size - 2, write });
    // write/close 只保证字节进入内核页缓存；验证 persisted 与统一 flushed
    // 回执承诺的是断电后仍可恢复，因此每个已合并批次在成功返回前只 sync 一次。
    sync(fd);
  } catch (error: unknown) {
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (error: unknown) {
    failure ??= error;
  }
  if (failure !== null) {
    // 可能已有前缀落盘，旧 size 与物理文件都不再可信。fd 已关闭后重新
    // 探测并尽力裁掉残片；绝不能按完整 data 的长度推进游标。
    const recovered: DayFileState = openDayFile(dir, state.day, mode);
    state.size = recovered.size;
    state.empty = recovered.empty;
    throw failure instanceof Error ? failure : new Error("Append failed with a non-Error value.");
  }
  state.size = state.size - 2 + data.length;
}

/**
 * 把单条记录序列化成顶层对象里的一段文本（含 DAY_FILE_JSON_INDENT 缩进、
 * 不含前后逗号），与 JSON.stringify(整个对象, null, DAY_FILE_JSON_INDENT)
 * 中该条目的形态完全一致。实现上借单条目对象的 stringify 结果，掐掉外层的
 * 「{\n」和「\n}」——这两处各固定 2 个字符（左花括号+换行、换行+右花括号），
 * 与缩进宽度本身无关，缩进改多宽这里都不用跟着变。
 */
export function serializeDayFileEntry(key: string, value: unknown): string {
  return JSON.stringify({ [key]: value }, null, DAY_FILE_JSON_INDENT).slice(2, -2);
}
