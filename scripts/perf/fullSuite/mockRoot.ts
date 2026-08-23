/**
 * mock 数据根的建立、校验与清理。
 *
 * 全量基准的**全部**落盘只允许发生在仓库根下的 `performance/` 里：部署机上
 * 同一个工作目录里就摆着真实的 `database/`、`memory/`、`state.json` 与
 * `bot.lock`，一次写错目录就是改运维正在用的数据。因此建目录、删目录两侧都
 * 先过 `assertInsidePerformanceMockRoot`，越界一律抛错而不是「尽力而为」。
 *
 * 本文件刻意不 import 任何 `packages/` 下的模块：父进程一旦把生产模块图加载
 * 进来，冷启动那一段就再也测不到真实的模块加载成本了。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  PERFORMANCE_MOCK_ROOT_NAME,
  RUN_ROOT_PREFIX,
  RUNTIME_ROOT_PREFIX,
} from "./constants";

/** 仓库根目录；本文件位于 scripts/perf/fullSuite/ 下，往上跳三级。 */
export const PROJECT_ROOT: string = resolve(import.meta.dir, "..", "..", "..");

/** 全量基准唯一允许写入的 mock 数据根；不进 Git，见仓库 .gitignore。 */
export const PERFORMANCE_MOCK_ROOT: string = join(
  PROJECT_ROOT,
  PERFORMANCE_MOCK_ROOT_NAME
);

/**
 * 运行时数据根允许的最宽权限；与 `RUNTIME_DATA_ROOT_MAX_MODE` 对齐。
 * 显式配置数据根后，生产预检会拒绝比这更宽的目录，mock 根必须同样严格，
 * 否则冷启动那一段量到的是一条生产走不到的分支。
 */
const RUNTIME_ROOT_MODE: number = 0o755;

/** 判定路径是否落在 mock 根内部；软链接与 `..` 逃逸都会在解析后暴露。 */
export function isInsidePerformanceMockRoot(path: string): boolean {
  const resolved: string = resolve(path);
  return resolved === PERFORMANCE_MOCK_ROOT ||
    resolved.startsWith(`${PERFORMANCE_MOCK_ROOT}/`);
}

/** 越界即抛；建目录、删目录两侧共用这一道闸。 */
export function assertInsidePerformanceMockRoot(path: string): void {
  if (!isInsidePerformanceMockRoot(path)) {
    throw new Error(
      `Full performance suite refused to touch ${resolve(path)}; ` +
      `every benchmark file must live under ${PERFORMANCE_MOCK_ROOT}.`
    );
  }
}

/** 建立本次运行独占的目录；同一 mock 根下可以并存多次历史运行的残留。 */
export function createRunRoot(): string {
  mkdirSync(PERFORMANCE_MOCK_ROOT, { recursive: true, mode: RUNTIME_ROOT_MODE });
  return mkdtempSync(join(PERFORMANCE_MOCK_ROOT, RUN_ROOT_PREFIX));
}

/**
 * 建立一轮独占的运行时数据根（充当 `COPY_NINJIA_DATA_ROOT`）。
 *
 * 只建空目录，不建库：SQLite fixture 由 seed 子进程用生产建库/播种入口写，
 * 本文件不碰任何生产模块。
 */
export function createRuntimeRoot(runRoot: string): string {
  assertInsidePerformanceMockRoot(runRoot);
  const runtimeRoot: string = mkdtempSync(join(runRoot, RUNTIME_ROOT_PREFIX));
  return runtimeRoot;
}

/** 判定一个路径是否是本基准建出来的运行时数据根；子进程据此拒绝跑错根。 */
export function isBenchmarkRuntimeRoot(path: string): boolean {
  const resolved: string = resolve(path);
  return isInsidePerformanceMockRoot(resolved) &&
    basename(resolved).startsWith(RUNTIME_ROOT_PREFIX) &&
    basename(dirname(resolved)).startsWith(RUN_ROOT_PREFIX);
}

/** 子进程入口的自检：数据根不是本基准建的就立刻失败，绝不继续写。 */
export function assertBenchmarkRuntimeRoot(path: string): void {
  if (!isBenchmarkRuntimeRoot(path)) {
    throw new Error(
      `${resolve(path)} is not a benchmark runtime data root; ` +
      "refusing to run against a directory this suite did not create."
    );
  }
}

/** 删除 mock 根内的一棵子树；越界时抛错而不是静默跳过。 */
export function removeMockPath(path: string): void {
  assertInsidePerformanceMockRoot(path);
  if (resolve(path) === PERFORMANCE_MOCK_ROOT) {
    throw new Error("Full performance suite never removes the mock root itself.");
  }
  rmSync(path, { recursive: true, force: true });
}
