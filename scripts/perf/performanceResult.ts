/**
 * 仓库根 `performance-result.json` 的共享写入边界。
 *
 * 两套基准各写自己那一节，互不相识：
 * - `hotPathProfileGate` —— `bun run perf:hot-path-gate -- --write-result`
 * - `fullSuite` —— `bun run perf:full -- --write-doc`
 *
 * 它们在不同进程、不同时刻运行，所以写入一律「读整份 → 只换自己那一格 → 整份
 * 写回」，绝不按解析结果重建文档。重建会把另一节连同 `calibration` 下那些给人
 * 看的长段说明一起抹掉——那些说明在任何一方的解析结果里都不存在。
 *
 * 「不同时刻」是前提而非保障：这里没有文件锁，两侧真同时写会后写者覆盖先写者
 * 那一格。两条命令都是发布期手动执行、且全量基准要跑几分钟，AGENTS.md 也要求
 * 它别和 `bun run check` 连着跑，因此没有为此引入锁——真要并发，代价是丢一次
 * 记录，重跑即可，不会损坏文件结构。
 *
 * 本模块**不 import `packages/` 下的任何实现模块**。全量基准的父进程要 import
 * 它，而那个进程按 AGENTS.md「全量性能基准」的约定必须与生产模块完全隔离——正
 * 因为隔离，它自己没有能力写到真实数据根。下面那个三行的 plain-record 判断是为
 * 这条隔离重写的，不是忘了复用 `packages/libs/record`。
 */

import { join } from "node:path";

/** 仓库根被跟踪的性能记录文件；两套基准共用这一份，文件名只在这里出现一次。 */
export const PERFORMANCE_RESULT_PATH: string = join(
  import.meta.dir,
  "..",
  "..",
  "performance-result.json"
);

/** 非数组对象判断；见文件头注为什么不复用 packages/libs/record。 */
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
 * 覆盖记录文件里的一格，其余内容一个字节都不动。
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
