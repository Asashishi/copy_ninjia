/**
 * 仓库根 `performance-result.json` 的共享写入边界。
 *
 * 两套基准各自写入对应节：
 * - `hotPathProfileGate` —— `bun run perf:hot-path-gate -- --write-result`
 * - `fullSuite` —— `bun run perf:full -- --write-doc`
 *
 * 两条命令必须串行运行；写入边界没有文件锁。每次读取完整 JSON，只替换指定节内
 * 的目标字段，再序列化写回；其他字段及 calibration 内容保留。
 * 本模块供全量基准父进程使用，必须与 packages/ 实现模块隔离，不访问部署数据。
 */

import { join } from "node:path";

/** 仓库根被跟踪的性能记录文件；两套基准共用这一份，文件名只在这里出现一次。 */
export const PERFORMANCE_RESULT_PATH: string = join(
  import.meta.dir,
  "..",
  "..",
  "performance-result.json"
);

/** 在基准父进程的模块隔离边界内判断非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** writePerformanceResultEntry 的入参。 */
export interface WritePerformanceResultEntryParams {
  /** 记录文件路径；测试传临时文件。 */
  readonly path: string;
  /** 顶层节名，当前是 `hotPathProfileGate` 或 `fullSuite`。 */
  readonly section: string;
  /** 节内要覆盖的键，当前两侧都是 `lastRun`。 */
  readonly entry: string;
  /** 覆盖写入的值，必须可 JSON 序列化。 */
  readonly value: unknown;
}

/**
 * 替换记录文件中的指定字段，保留其他字段的值并统一序列化。
 *
 * 节不存在时创建；存在但不是对象则直接失败，不猜、不覆盖——那说明这份文件已经
 * 被改坏，静默重建只会把坏掉的地方藏起来。
 */
export async function writePerformanceResultEntry({
  path,
  section,
  entry,
  value,
}: WritePerformanceResultEntryParams): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(path).text());
  } catch (error: unknown) {
    throw new Error(`${path}: could not be read as strict JSON.`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path}: $. must be a JSON object.`);
  }
  const existing: unknown = parsed[section];
  if (existing !== undefined && !isRecord(existing)) {
    throw new Error(`${path}: $.${section} must be an object.`);
  }
  const target: Record<string, unknown> = isRecord(existing) ? existing : {};
  target[entry] = value;
  parsed[section] = target;
  await Bun.write(path, `${JSON.stringify(parsed, null, 2)}\n`);
}
