/**
 * mock 数据根的建立、校验与清理。
 *
 * 全量基准的**全部**落盘只允许发生在仓库根下的 `performance/` 里：部署机上
 * 同一个工作目录里就摆着真实的 `database/`、`memory/`、`state.json` 与
 * `bot.lock`，一次写错目录就是改运维正在用的数据。因此建目录、删目录两侧都
 * 先过 `assertInsidePerformanceMockRoot`，越界一律抛错而不是「尽力而为」。
 *
 * 本文件只从 `packages/` import 纯常量：父进程一旦把生产实现模块图加载进来，
 * 冷启动那一段就再也测不到真实的模块加载成本了。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { copyFixtureTree } from "../../fixtures/copyTree";
import {
  BENCHMARK_AGENT_API_KEY,
  BENCHMARK_BOT_TOKEN,
  BENCHMARK_CONFIG_ROOT_NAME,
  PERFORMANCE_MOCK_ROOT_NAME,
  RUN_ROOT_PREFIX,
  RUNTIME_ROOT_PREFIX,
} from "./constants";
import { AGENT_API_KEY_PLACEHOLDERS } from
  "../../../packages/consts/agent";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from
  "../../../packages/consts/telegram";

/** 仓库根目录；本文件位于 scripts/perf/fullSuite/ 下，往上跳三级。 */
export const PROJECT_ROOT: string = resolve(import.meta.dir, "..", "..", "..");

/** 全量基准唯一允许写入的 mock 数据根；不进 Git，见仓库 .gitignore。 */
export const PERFORMANCE_MOCK_ROOT: string = join(
  PROJECT_ROOT,
  PERFORMANCE_MOCK_ROOT_NAME
);

/** 受版本控制的配置示例只作为模板读取，基准子进程不直接加载其中的占位凭据。 */
const CONFIG_EXAMPLE_ROOT: string = join(PROJECT_ROOT, "config_example");

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
 * 在单次运行目录内建立可被严格解析的隔离配置副本。
 *
 * 示例文件必须保留面向部署者的占位值，因此只在 mock 根内替换凭据。出站能力仍
 * 由 `scripts/perf/outboundGuard.ts` 截断；这份配置只让基准走过与生产一致的启动
 * 校验和客户端装配路径。
 */
export async function createBenchmarkConfigRoot(runRoot: string): Promise<string> {
  assertInsidePerformanceMockRoot(runRoot);
  const configRoot: string = join(runRoot, BENCHMARK_CONFIG_ROOT_NAME);
  await copyFixtureTree(CONFIG_EXAMPLE_ROOT, configRoot);

  const agentPath: string = join(configRoot, "agent.json");
  let agentConfig: string = await Bun.file(agentPath).text();
  for (const placeholder of AGENT_API_KEY_PLACEHOLDERS) {
    agentConfig = agentConfig.replaceAll(placeholder, BENCHMARK_AGENT_API_KEY);
  }
  if (AGENT_API_KEY_PLACEHOLDERS.some(
    (placeholder: string): boolean => agentConfig.includes(placeholder)
  )) {
    throw new Error(
      "Benchmark Agent configuration still contains placeholder credentials."
    );
  }
  await Bun.write(agentPath, agentConfig, { mode: 0o600 });

  const telegramPath: string = join(configRoot, "telegram.json");
  const telegramConfig: string = (await Bun.file(telegramPath).text()).replaceAll(
    TELEGRAM_BOT_TOKEN_PLACEHOLDER,
    BENCHMARK_BOT_TOKEN
  );
  if (telegramConfig.includes(TELEGRAM_BOT_TOKEN_PLACEHOLDER)) {
    throw new Error(
      "Benchmark Telegram configuration still contains a placeholder token."
    );
  }
  await Bun.write(telegramPath, telegramConfig, { mode: 0o600 });
  return configRoot;
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
