/**
 * 通用的"JSON 对象文件、末尾追加"落盘机制：文件内容始终是一个顶层
 * JSON 对象 { "key1": value1, "key2": value2, ... }，新增条目不整文件重写，
 * 而是覆写文件结尾的「\n}」两字节、按位置追加，写入量只与本批条数有关，
 * 与文件大小无关。调用方是 diskIO/logFiles.ts（日志）、diskIO/snapshotFiles.ts 的
 * appendLuckEntries（每日运势）、diskIO/verificationWrites.ts（待验证）、
 * diskIO/joinLogFiles.ts（入群日志）与 diskIO/adSampleFile.ts（广告样本）；
 * 调用方各自负责 key/value 怎么序列化、
 * 多久 flush 一次、保留策略等领域逻辑，这里只管字节层面的
 * 打开、探测与追加；截断修复只供调用方显式选择的诊断材料和日志使用。
 *
 * 两层 API：openAppendOnlyFile/appendToAppendOnlyFile 直接按完整路径操作，
 * 供入群日志等固定路径文件使用；openDayFile/appendToDayFile 是它们在
 * `<dir>/<day>.json` 命名约定上的薄封装，供按天滚动的三个领域使用。
 */

import { closeSync, existsSync, fsyncSync, openSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { AppendOnlyFileState, DayFileState } from "../../types/diskIO/storage";
import { DAY_FILE_JSON_INDENT } from "../../consts/diskIO/appendOnly";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import { readUtf8TextInput } from "../../libs/inputValidation";
import { isPlainRecord } from "../../libs/record";
import { assertFileReadableWritable } from "../../libs/fileAccess";

// serializeDayFileEntry 的 slice(2, -2) 依赖 stringify 输出是多行形态
// （indent 为 0 时输出单行，掐头去尾会切进内容本身）；启动即断言，不让
// 一次误改常量静默产出坏文件。
if (DAY_FILE_JSON_INDENT < 1) {
  throw new Error("DAY_FILE_JSON_INDENT must be >= 1: serializeDayFileEntry relies on multi-line JSON.stringify output");
}

export interface SyncWriteRequest {
  fd: number;
  buffer: Buffer;
  offset: number;
  length: number;
  position: number;
}

export type SyncBufferWriter = (request: SyncWriteRequest) => number;
export type SyncFile = (fd: number) => void;

export interface OpenValidatedAppendOnlyFileOptions {
  /** 已由领域 codec 严格校验过的目标路径。 */
  readonly path: string;
  /** 与领域校验使用同一轮读取取得的原始文本。 */
  readonly content: string;
  /** 顶层对象是否没有自有条目；由领域校验过程顺带给出。 */
  readonly empty: boolean;
}

export interface WriteBufferFullyParams {
  position: number;
  write?: SyncBufferWriter;
}

/** 目标文件不是可安全追记的当前格式；调用方必须阻止写入并安排人工恢复。 */
export class AppendOnlyFileFormatError extends Error {
  constructor(path: string, reason: string) {
    super(`${path} ${reason}`);
    this.name = "AppendOnlyFileFormatError";
  }
}

const nodeWriteBuffer: SyncBufferWriter = ({ fd, buffer, offset, length, position }: SyncWriteRequest): number =>
  writeSync(fd, buffer, offset, length, position);

/** write(2) 允许成功但只写一部分；只有整段 Buffer 落下才算 append 成功。 */
function writeBufferFully(
  fd: number,
  buffer: Buffer,
  { position, write = nodeWriteBuffer }: WriteBufferFullyParams
): void {
  let offset: number = 0;
  while (offset < buffer.length) {
    const written: number = write({
      fd,
      buffer,
      offset,
      length: buffer.length - offset,
      position: position + offset,
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
 * 是否允许裁掉末尾残片由调用方按数据权威性显式选择，见下方注释。
 */
function atomicRewrite(path: string, content: string, mode?: number): void {
  atomicWriteTextSync(path, content, mode);
}

/**
 * 打开（或接管）一个追加型 JSON 对象文件并校验其可追加性。文件不存在或为
 * 空对象视作空文件；内容合法但结尾形态不符（比如被人手动编辑过）就按标准
 * 格式重写一次；解析失败时默认保留原始字节并抛错，只有 repair=true 才尝试
 * repairTruncated 裁掉末尾残片。顶层不是普通对象或无法修复时同样拒绝。
 * size 一律以 fs.statSync 读到的物理文件大小为准，不信任内存里算出来的
 * 字节数。完整扫描只发生在打开/恢复阶段，成功后的追记热路径仍为 O(1)。
 * @param repair 是否显式允许裁掉末尾残片或规范化排版；默认 false。只写诊断
 *   材料和日志可选择 true，运行时权威状态必须保持 false。
 */
export async function openAppendOnlyFile(
  path: string,
  mode?: number,
  repair: boolean = false
): Promise<AppendOnlyFileState> {
  const state: AppendOnlyFileState = { size: 0, empty: true };
  if (!existsSync(path)) return state;
  // mode 只用于首次创建。已有文件保留部署方权限，并在接管阶段显式确认
  // 当前进程可读写；不能靠目录 rename 权限绕过文件本身的只读策略。
  assertFileReadableWritable(path);
  const content: string = await readUtf8TextInput(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 不允许自愈的领域在这里就停：repairTruncated 是「裁掉末尾残片」，
    // 对黑名单而言等同于静默解除拉黑，必须原样保留字节交给人工。
    if (!repair) {
      throw new AppendOnlyFileFormatError(path, "could not be parsed; refusing to repair this file.");
    }
    const repaired: string | null = repairTruncatedAppendOnlyContent(content);
    if (repaired === null) {
      throw new AppendOnlyFileFormatError(path, "could not be parsed or repaired.");
    }
    const repairedParsed: unknown = JSON.parse(repaired);
    if (!isPlainRecord(repairedParsed)) {
      throw new AppendOnlyFileFormatError(path, "must contain a top-level JSON object.");
    }
    atomicRewrite(path, repaired, mode);
    state.size = statSync(path).size;
    state.empty = Object.keys(repairedParsed).length === 0;
    return state;
  }
  if (!isPlainRecord(parsed)) {
    throw new AppendOnlyFileFormatError(path, "must contain a top-level JSON object.");
  }
  if (Object.keys(parsed).length === 0) return state;
  if (!content.endsWith("\n}")) {
    if (!repair) {
      throw new AppendOnlyFileFormatError(
        path,
        "must use the canonical append-only JSON object formatting."
      );
    }
    // 只规范排版，不承诺保留原文件的键序：JSON.parse 建出来的普通对象已经把
    // 「整数索引形态」的键提到最前，源文本的顺序在这一步就没了。这条路径只在
    // 文件被手工编辑过（结尾形态不符）时触发，属异常态的一次性归一；调用方
    // 不得把这条修复路径当作键顺序稳定性保证。
    atomicRewrite(path, JSON.stringify(parsed, null, DAY_FILE_JSON_INDENT), mode);
  }
  state.size = statSync(path).size;
  state.empty = false;
  return state;
}

/**
 * 接管已经由领域 codec 严格解析、校验过的追加文件。
 *
 * 调用方必须把同一轮读取的 content 与空对象结论一起传入；本函数只复核通用的
 * 规范结尾、物理大小和权限，不再把同一份 JSON 解析第二次。不存在时仍按
 * openAppendOnlyFile 的空文件语义返回，外部并发删除不会让旧游标被接管。
 * 该入口不提供 repair：需要裁尾的异常文件仍必须走 openAppendOnlyFile，避免
 * 绕开修复后的领域复核。
 */
export function openValidatedAppendOnlyFile({
  path,
  content,
  empty,
}: OpenValidatedAppendOnlyFileOptions): AppendOnlyFileState {
  const state: AppendOnlyFileState = { size: 0, empty: true };
  if (!existsSync(path)) return state;
  assertFileReadableWritable(path);
  if (empty) return state;
  if (!content.endsWith("\n}")) {
    throw new AppendOnlyFileFormatError(
      path,
      "must use the canonical append-only JSON object formatting."
    );
  }
  state.size = statSync(path).size;
  state.empty = false;
  return state;
}

/** openAppendOnlyFile 在 `<dir>/<day>.json` 命名约定上的薄封装（按天滚动的三个领域用）。 */
export async function openDayFile(
  dir: string,
  day: string,
  mode?: number
): Promise<DayFileState> {
  return { day, ...await openAppendOnlyFile(join(dir, `${day}.json`), mode) };
}

/** 构造并复核一个顶层成员边界候选；成功时交出可直接原子发布的完整文本。 */
function repairCandidateAt(
  content: string,
  boundaries: readonly number[],
  boundaryIndex: number
): string | null {
  const candidate: string = `${content.slice(0, boundaries[boundaryIndex])}\n}`;
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * 修复被截断的追加型文件：先试着直接补一个「\n}」收尾（只是丢了最后的收尾
 * 括号这种最常见情况）；不行的话，结构化扫描字符串转义与括号深度，找出
 * 顶层对象成员之间的逗号。最后一个这类逗号之前就是最后一条完整记录，值
 * 无论是对象、数组还是 null 等基础类型都适用；裁掉其后的撕裂记录、补上
 * 「\n}」并以 JSON.parse 复核。
 * @returns 修复后的完整 JSON 文本；所有候选都无效时返回 null，表示无法修复
 *   ——调用方（openAppendOnlyFile）据此抛 AppendOnlyFileFormatError 阻止写入并原样
 *   保留字节，等待人工恢复，绝不从空文件重新开始覆盖原数据。
 * @see ../../../docs/cn/04-invariants.md
 */
export function repairTruncatedAppendOnlyContent(content: string): string | null {
  const withClosingBrace: string = `${content}\n}`;
  try {
    JSON.parse(withClosingBrace);
    return withClosingBrace;
  } catch {
    // 继续尝试裁掉末尾残片。
  }
  const boundaries: number[] = [];
  let depth: number = 0;
  let inString: boolean = false;
  let escaped: boolean = false;
  for (let i: number = 0; i < content.length; i++) {
    const char: string = content[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
    } else if (char === "," && depth === 1) {
      boundaries.push(i);
    }
  }

  if (boundaries.length === 0) return null;
  // 尾部撕裂是常见情况，先只试最后一个完整成员边界。
  const last: string | null = repairCandidateAt(content, boundaries, boundaries.length - 1);
  if (last !== null) return last;

  // 顶层边界候选具有「前缀有效、后缀无效」的单调性：某个边界之前一旦已有
  // 非法 token，之后追加完整的 `, member` 不可能改正更早的语法；反过来，损坏
  // 发生前的所有完整成员前缀都可独立补 `}` 解析。因此对最后一个有效前缀二分，
  // 避免早期损坏时从文件尾反复 slice + parse 退化为 O(n²)。
  let low: number = 0;
  let high: number = boundaries.length - 2;
  let best: string | null = null;
  while (low <= high) {
    const middle: number = low + Math.floor((high - low) / 2);
    const candidate: string | null = repairCandidateAt(content, boundaries, middle);
    if (candidate === null) {
      high = middle - 1;
    } else {
      best = candidate;
      low = middle + 1;
    }
  }
  return best;
}

export interface AppendToAppendOnlyFileParams {
  path: string;
  state: AppendOnlyFileState;
  chunk: string;
  mode?: number;
  /** 追加失败后重新探测文件时是否允许自愈；语义同 openAppendOnlyFile。 */
  repair?: boolean;
  /** 仅供故障注入测试；生产使用 node:fs writeSync。 */
  write?: SyncBufferWriter;
  /** 仅供故障注入测试；生产在成功回执前 fsync 当前批次。 */
  sync?: SyncFile;
}

export interface AppendToDayFileParams extends Omit<AppendToAppendOnlyFileParams, "path" | "state"> {
  dir: string;
  state: DayFileState;
}

/** 把一段已序列化好的条目文本追加到文件末尾（覆写结尾的「\n}」）。 */
export async function appendToAppendOnlyFile({
  path,
  state,
  chunk,
  mode,
  repair = false,
  write = nodeWriteBuffer,
  sync = fsyncSync,
}: AppendToAppendOnlyFileParams): Promise<void> {
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
    // 探测并尽力裁掉残片；绝不能按完整 data 的长度推进游标。不允许自愈的
    // 领域这里会再抛一次，调用方据此把游标作废、条目留在缓冲里等人工恢复。
    const recovered: AppendOnlyFileState = await openAppendOnlyFile(path, mode, repair);
    state.size = recovered.size;
    state.empty = recovered.empty;
    throw failure instanceof Error ? failure : new Error("Append failed with a non-Error value.");
  }
  state.size = state.size - 2 + data.length;
}

/** appendToAppendOnlyFile 在 `<dir>/<day>.json` 命名约定上的薄封装。 */
export async function appendToDayFile({
  dir,
  state,
  ...rest
}: AppendToDayFileParams): Promise<void> {
  await appendToAppendOnlyFile({ path: join(dir, `${state.day}.json`), state, ...rest });
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
