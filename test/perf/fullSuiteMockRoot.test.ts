import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PERFORMANCE_MOCK_ROOT,
  PROJECT_ROOT,
  assertBenchmarkRuntimeRoot,
  assertInsidePerformanceMockRoot,
  createBenchmarkConfigRoot,
  createRunRoot,
  createRuntimeRoot,
  isBenchmarkRuntimeRoot,
  isInsidePerformanceMockRoot,
  removeMockPath,
} from "../../scripts/perf/fullSuite/mockRoot";
import { isBenchmarkMockRoot } from "../../scripts/perf/identityDatabase/roots";
import { MOCK_ROOT_PREFIX } from "../../scripts/perf/identityDatabase/constants";
import {
  parseAdDetectAgentConfig,
  parseAgentDeploymentConfig,
} from "../../packages/config/agent";
import { parseTelegramConfig } from "../../packages/config/telegramInput";

describe("全量基准的 mock 根边界", () => {
  test("mock 根只覆盖仓库下的 performance/", () => {
    expect(PERFORMANCE_MOCK_ROOT).toBe(join(PROJECT_ROOT, "performance"));
    expect(isInsidePerformanceMockRoot(PERFORMANCE_MOCK_ROOT)).toBe(true);
    expect(isInsidePerformanceMockRoot(join(PERFORMANCE_MOCK_ROOT, "run-a", "runtime-b")))
      .toBe(true);
  });

  test("真实部署数据根与同名兄弟目录一律不算 mock 根", () => {
    expect(isInsidePerformanceMockRoot(PROJECT_ROOT)).toBe(false);
    expect(isInsidePerformanceMockRoot(join(PROJECT_ROOT, "database"))).toBe(false);
    expect(isInsidePerformanceMockRoot(join(PROJECT_ROOT, "memory"))).toBe(false);
    expect(isInsidePerformanceMockRoot(`${PERFORMANCE_MOCK_ROOT}-other`)).toBe(false);
    expect(isInsidePerformanceMockRoot(join(PERFORMANCE_MOCK_ROOT, "..", "config")))
      .toBe(false);
  });

  test("越界路径在建删两侧都抛错，且从不删除 mock 根本身", () => {
    expect((): void => assertInsidePerformanceMockRoot(join(PROJECT_ROOT, "config")))
      .toThrow("every benchmark file must live under");
    expect((): void => removeMockPath(join(PROJECT_ROOT, "memory")))
      .toThrow("every benchmark file must live under");
    expect((): void => removeMockPath(PERFORMANCE_MOCK_ROOT))
      .toThrow("never removes the mock root itself");
  });

  test("运行时数据根必须是 performance/run-*/runtime-* 这一层", () => {
    expect(isBenchmarkRuntimeRoot(join(PERFORMANCE_MOCK_ROOT, "run-a", "runtime-b")))
      .toBe(true);
    expect(isBenchmarkRuntimeRoot(join(PERFORMANCE_MOCK_ROOT, "run-a")))
      .toBe(false);
    expect(isBenchmarkRuntimeRoot(join(PERFORMANCE_MOCK_ROOT, "other", "runtime-b")))
      .toBe(false);
    expect(isBenchmarkRuntimeRoot(PROJECT_ROOT)).toBe(false);
    expect((): void => assertBenchmarkRuntimeRoot(PROJECT_ROOT))
      .toThrow("is not a benchmark runtime data root");
  });
});

/**
 * 下面两条用例调用的是真会建目录的入口，落点只能是仓库根的 `performance/`：
 * `assertInsidePerformanceMockRoot` 把全量基准的写入钉死在这一个常量上（见
 * scripts/perf/fullSuite/mockRoot.ts），把根改成可注入的参数就等于把「只写这里」
 * 这条不变量交回给调用方，而那正是这个模块存在的理由。因此不改生产签名，改为
 * 在这里记下运行前的现场：mock 根本来不存在时，跑完把它整个撤掉，工作树不留痕。
 */
const mockRootExistedBeforeTests: boolean = existsSync(PERFORMANCE_MOCK_ROOT);

afterAll((): void => {
  // removeMockPath 拒绝删除 mock 根本身（那是给基准用的保护），所以这里直接调
  // node:fs。用 rmdirSync 而不是递归删除：每条用例都在 finally 里撤掉自己那棵
  // run-* 子树，跑完这层理应是空的；万一同一时刻真有一次全量基准在写，非空目录
  // 会让 rmdirSync 抛错而不是把人家的运行目录连锅端走。
  if (mockRootExistedBeforeTests || !existsSync(PERFORMANCE_MOCK_ROOT)) return;
  if (readdirSync(PERFORMANCE_MOCK_ROOT).length === 0) {
    rmdirSync(PERFORMANCE_MOCK_ROOT);
  }
});

describe("mock 根的建立与清理", () => {
  test("隔离配置副本替换占位凭据并通过生产严格解析", async (): Promise<void> => {
    const runRoot: string = createRunRoot();
    try {
      const configRoot: string = await createBenchmarkConfigRoot(runRoot);
      const telegramDocument: unknown = await Bun.file(
        join(configRoot, "telegram.json")
      ).json();
      const agentDocument: Readonly<{
        agent?: Readonly<{ ad_detect?: unknown }>;
      }> = await Bun.file(
        join(configRoot, "agent.json")
      ).json();
      expect((): unknown => parseTelegramConfig(
        telegramDocument,
        "benchmark/telegram.json"
      )).not.toThrow();
      expect((): unknown => parseAgentDeploymentConfig(
        agentDocument.agent,
        "benchmark/agent.json"
      )).not.toThrow();
      expect((): unknown => parseAdDetectAgentConfig(
        agentDocument.agent?.ad_detect,
        "benchmark/agent.json"
      )).not.toThrow();
    } finally {
      removeMockPath(runRoot);
    }
  });

  test("建出的运行时数据根落在 mock 根内，删除后不留痕", () => {
    const runRoot: string = createRunRoot();
    try {
      expect(isInsidePerformanceMockRoot(runRoot)).toBe(true);
      const runtimeRoot: string = createRuntimeRoot(runRoot);
      expect(isBenchmarkRuntimeRoot(runtimeRoot)).toBe(true);
      expect(existsSync(runtimeRoot)).toBe(true);
      removeMockPath(runtimeRoot);
      expect(existsSync(runtimeRoot)).toBe(false);
    } finally {
      removeMockPath(runRoot);
    }
  });

  test("拿 mock 根之外的目录当运行目录时拒绝建根", () => {
    expect((): string => createRuntimeRoot(join(PROJECT_ROOT, "memory")))
      .toThrow("every benchmark file must live under");
  });
});

describe("身份基准 mock 根的两种形态", () => {
  test("系统临时目录下的独立运行形态仍然接受", () => {
    const root: string = mkdtempSync(join(tmpdir(), MOCK_ROOT_PREFIX));
    try {
      expect(isBenchmarkMockRoot(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("全量基准的 performance/run-* 形态也接受，其它一律拒绝", () => {
    expect(isBenchmarkMockRoot(join(PERFORMANCE_MOCK_ROOT, "run-a"))).toBe(true);
    expect(isBenchmarkMockRoot(join(PERFORMANCE_MOCK_ROOT, "other"))).toBe(false);
    expect(isBenchmarkMockRoot(join(tmpdir(), "unrelated"))).toBe(false);
    expect(isBenchmarkMockRoot(PROJECT_ROOT)).toBe(false);
  });
});
