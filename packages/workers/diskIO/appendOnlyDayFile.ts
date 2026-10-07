/**
 * 通用的"JSON 对象文件、末尾追加"落盘机制：文件内容始终是一个顶层
 * JSON 对象 { "key1": value1, "key2": value2, ... }，新增条目不整文件重写，
 * 而是覆写文件结尾的「\n}」两字节、按位置追加，写入量只与本批条数有关，
 * 与文件大小无关。调用方是 diskIO/logFiles.ts（日志）、diskIO/snapshotFiles.ts 的
 * appendLuckEntries（每日运势）、diskIO/verificationWrites.ts（待验证）、
 * diskIO/joinLogWrites.ts（入群日志）、diskIO/adSampleFile.ts（广告样本）与
 * diskIO/aiCacheFile.ts（AI 用量统计）；
 * 调用方各自负责 key/value 怎么序列化、
 * 多久 flush 一次、保留策略等领域逻辑，这里只管字节层面的
 * 打开、探测与追加；截断修复只供调用方显式选择的诊断材料和日志使用。
 *
 * 两层 API：openAppendOnlyFile/appendToAppendOnlyFile 直接按完整路径操作；
 * openDayFile/appendToDayFile 是它们在 `<dir>/<day>.json` 命名约定上的薄封装，
 * 供按天滚动的领域使用。日志与 AI 用量统计的只读探测共用
 * inspectRepairableAppendOnlyFile（允许在内存里裁掉撕裂的末尾残片）；
 * openValidatedAppendOnlyFile 接管已由领域 codec 严格校验过的文件。
 */

import { closeSync, fsyncSync, ftruncateSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppendOnlyFileState, DayFileState } from "../../types/diskIO/storage";
import { DAY_FILE_JSON_INDENT } from "../../consts/diskIO/appendOnly";
import { atomicWriteTextSync, writeBufferFullySync } from "../../libs/atomicFile";
import type { SyncBufferWriter } from "../../libs/atomicFile";
import { readUtf8TextInput } from "../../libs/inputValidation";
import { isPlainRecord } from "../../libs/record";
import { inspectOptionalFile } from "../../libs/fileAccess";
import { toErrorOr } from "../../libs/errorMessage";

const UTF8_ENCODER: TextEncoder = new TextEncoder();
/** 追加前文件结尾的两字节；回滚撕裂的追加时原位写回。 */
const APPEND_ONLY_TAIL: Uint8Array = UTF8_ENCODER.encode("\n}");

// serializeDayFileEntry 的 slice(2, -2) 依赖 stringify 输出多行形态
// （indent 为 0 时输出单行），启动即断言。
if (DAY_FILE_JSON_INDENT < 1) {
  throw new Error("DAY_FILE_JSON_INDENT must be >= 1: serializeDayFileEntry relies on multi-line JSON.stringify output");
}

export type SyncFile = (fd: number) => void;

export interface OpenValidatedAppendOnlyFileOptions {
  /** 已由领域 codec 严格校验过的目标路径。 */
  readonly path: string;
  /** 与领域校验使用同一轮读取取得的原始文本。 */
  readonly content: string;
  /** 顶层对象是否没有自有条目；由领域校验过程顺带给出。 */
  readonly empty: boolean;
}

/** 目标文件不是可安全追记的当前格式；调用方必须阻止写入并安排人工恢复。 */
export class AppendOnlyFileFormatError extends Error {
  constructor(path: string, reason: string) {
    super(`${path} ${reason}`);
    this.name = "AppendOnlyFileFormatError";
  }
}

/**
 * 打开（或接管）一个追加型 JSON 对象文件并校验其可追加性。文件不存在或为
 * 空对象视作空文件；内容合法但结尾形态不符时，repair=true 才按标准格式重写一次，
 * 否则抛 AppendOnlyFileFormatError；解析失败时默认保留原始字节并抛错，只有
 * repair=true 才尝试 repairTruncatedAppendOnlyContent 裁掉末尾残片。顶层不是普通对象
 * 或无法修复时同样拒绝。
 * 裁尾修复与排版规范化经 atomicWriteTextSync 以 tmp + fsync + rename 整份
 * 原子替换；追记热路径（appendToAppendOnlyFile / appendToDayFile 向非空文件
 * 追加）按位置写入。
 * size 一律以 fs.statSync 读到的物理文件大小为准。完整扫描只发生在打开/恢复阶段，
 * 追记热路径为 O(1)。
 * @param repair 是否显式允许裁掉末尾残片或规范化排版；默认 false。只写诊断
 *   材料和日志可选择 true，运行时权威状态必须保持 false。
 */
export async function openAppendOnlyFile(
  path: string,
  mode?: number,
  repair: boolean = false
): Promise<AppendOnlyFileState> {
  const state: AppendOnlyFileState = { size: 0, empty: true };
  if (!inspectOptionalFile(path)) return state;
  // mode 只用于首次创建；已有文件保留部署方权限，inspectOptionalFile 确认当前进程可读写。
  const content: string = await readUtf8TextInput(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // repair=false 的领域在这里停止，原样保留字节交给人工。
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
    atomicWriteTextSync(path, repaired, mode);
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
    // 只规范排版，不保留原文件的键序（JSON.parse 已把整数索引形态的键提前）；
    // 调用方不得把这条路径当作键顺序稳定性保证。
    atomicWriteTextSync(path, JSON.stringify(parsed, null, DAY_FILE_JSON_INDENT), mode);
  }
  state.size = statSync(path).size;
  state.empty = false;
  return state;
}

/** inspectRepairableAppendOnlyFile 的只读探测结果。 */
export interface RepairableAppendOnlyInspection<T> {
  /** 领域 decode 对（修复后的）解析结果给出的值。 */
  readonly decoded: T;
  /** 需要原子发布的裁尾或规范排版文本；无需重写时为 null。 */
  readonly rewriteContent: string | null;
  /** 发布后可追加的游标：size 取重写文本或物理文件大小。 */
  readonly state: AppendOnlyFileState;
}

/**
 * 只读探测一个允许自愈的追加型 JSON 对象文件（诊断日志与 AI 缓存用量共用）：解析失败时
 * 在内存里经 repairTruncatedAppendOnlyContent 裁掉撕裂的末尾残片；领域 decode 在任何通用
 * 格式化之前严格校验解析结果，非法时抛错、原字节不变；非空且结尾不规范时预计算规范排版。
 * 整份文件只读一遍、不写盘；文件不存在时返回 null。
 */
export async function inspectRepairableAppendOnlyFile<T>(
  path: string,
  decode: (parsed: unknown) => T
): Promise<RepairableAppendOnlyInspection<T> | null> {
  if (!inspectOptionalFile(path)) return null;
  const content: string = await readUtf8TextInput(path);
  let parsed: unknown;
  let rewriteContent: string | null = null;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    rewriteContent = repairTruncatedAppendOnlyContent(content);
    if (rewriteContent === null) {
      throw new AppendOnlyFileFormatError(path, "could not be parsed or repaired.");
    }
    parsed = JSON.parse(rewriteContent) as unknown;
  }
  const decoded: T = decode(parsed);
  const empty: boolean = Object.keys(parsed as Record<string, unknown>).length === 0;
  if (!empty && rewriteContent === null && !content.endsWith("\n}")) {
    rewriteContent = JSON.stringify(parsed, null, DAY_FILE_JSON_INDENT);
  }
  return {
    decoded,
    rewriteContent,
    state: {
      size: empty
        ? 0
        : rewriteContent === null
          ? (await Bun.file(path).stat()).size
          : Buffer.byteLength(rewriteContent),
      empty,
    },
  };
}

/**
 * 接管已经由领域 codec 严格解析、校验过的追加文件。
 *
 * 调用方必须把同一轮读取的 content 与空对象结论一起传入；本函数只复核通用的
 * 规范结尾、物理大小和权限，不再把同一份 JSON 解析第二次。不存在时仍按
 * openAppendOnlyFile 的空文件语义返回，外部并发删除不会让旧游标被接管。
 * 该入口不提供 repair：需要裁尾的异常文件走 openAppendOnlyFile。
 */
export function openValidatedAppendOnlyFile({
  path,
  content,
  empty,
}: OpenValidatedAppendOnlyFileOptions): AppendOnlyFileState {
  const state: AppendOnlyFileState = { size: 0, empty: true };
  if (!inspectOptionalFile(path)) return state;
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

/** openAppendOnlyFile 在 `<dir>/<day>.json` 命名约定上的薄封装（每日运势 snapshotFiles.ts 使用）。 */
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
 *   ——调用方（openAppendOnlyFile）据此抛 AppendOnlyFileFormatError 阻止写入，
 *   原样保留字节等待人工恢复。
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
  // 非法 token，之后追加完整的 `, member` 不会改正更早的语法；损坏发生前的
  // 所有完整成员前缀都可独立补 `}` 解析。因此对最后一个有效前缀二分。
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

/**
 * 把一段已序列化好的条目文本追加到文件末尾（覆写结尾的「\n}」）。写入或 fsync
 * 失败时先在原 fd 上回滚到追加前的字节，回滚成功则 state 不变、原样抛出追加错误；
 * 回滚失败才按 repair 重新探测，探测也失败时抛出含两者的 AggregateError。
 */
export async function appendToAppendOnlyFile({
  path,
  state,
  chunk,
  mode,
  repair = false,
  write,
  sync = fsyncSync,
}: AppendToAppendOnlyFileParams): Promise<void> {
  if (state.empty) {
    const content: string = `{\n${chunk}\n}`;
    // 首条也走原子替换；传入 mode 时临时文件在 rename 前 fchmod。
    atomicWriteTextSync(path, content, mode);
    state.size = Buffer.byteLength(content);
    state.empty = false;
    return;
  }
  const data: Uint8Array = UTF8_ENCODER.encode(`,\n${chunk}\n}`);
  const fd: number = openSync(path, "r+");
  let failure: unknown = null;
  let restored: boolean = false;
  try {
    writeBufferFullySync(fd, data, { position: state.size - 2, write });
    // 每个已合并批次在成功返回前只 sync 一次（persisted 与统一 flushed 回执承诺断电后可恢复）。
    sync(fd);
  } catch (error: unknown) {
    failure = error;
    restored = restoreAppendTail(fd, state.size, { write, sync });
  }
  try {
    closeSync(fd);
  } catch (error: unknown) {
    failure ??= error;
  }
  if (failure !== null) {
    const appendFailure: Error = toErrorOr(failure, "Append failed with a non-Error value.");
    // 已在原 fd 上回滚并 fsync：文件与 state 都停在追加前，原样抛出追加错误。
    if (restored) throw appendFailure;
    // 回滚失败或 close 失败：旧 size 与物理文件都不再可信。fd 已关闭后重新探测；
    // 允许自愈的领域裁掉残片，游标不按完整 data 的长度推进。不允许自愈的领域探测
    // 再失败时，调用方据此作废游标、条目留在缓冲里等人工恢复。
    let recovered: AppendOnlyFileState;
    try {
      recovered = await openAppendOnlyFile(path, mode, repair);
    } catch (error: unknown) {
      throw new AggregateError(
        [appendFailure, error],
        `${path} append failed and could not be restored.`,
        { cause: error }
      );
    }
    state.size = recovered.size;
    state.empty = recovered.empty;
    throw appendFailure;
  }
  state.size = state.size - 2 + data.length;
}

interface RestoreAppendTailOptions {
  write: SyncBufferWriter | undefined;
  sync: SyncFile;
}

/**
 * 追加失败后在仍打开的 fd 上把文件恢复成追加前的字节：截回追加前的 size，
 * 在原结尾位置写回「\n}」并 fsync。任一步失败返回 false，由调用方重新探测。
 */
function restoreAppendTail(fd: number, size: number, { write, sync }: RestoreAppendTailOptions): boolean {
  try {
    ftruncateSync(fd, size);
    writeBufferFullySync(fd, APPEND_ONLY_TAIL, { position: size - 2, write });
    sync(fd);
    return true;
  } catch (_error: unknown) {
    return false;
  }
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
 * 中该条目的形态完全一致。实现上借单条目对象的 stringify 结果，掐掉外层各固定
 * 2 个字符的「{\n」和「\n}」，与缩进宽度无关。
 */
export function serializeDayFileEntry(key: string, value: unknown): string {
  return JSON.stringify({ [key]: value }, null, DAY_FILE_JSON_INDENT).slice(2, -2);
}
