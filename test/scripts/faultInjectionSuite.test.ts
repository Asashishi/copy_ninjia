/**
 * `test:fault-injection` 清单门禁：清单是这套套件的唯一权威，漏登记不会让别的门禁
 * 变红，只会让合入前跑的那一套无声变窄。这里钉住五条判据：真实仓库现状必须干净、
 * 声明路径必须存在且不重复、使用受约束边界的用例必须登记（含 `await import()`
 * 形态）、限定导出的边界只在取用这些导出或无法确定取用范围时要求登记、边界自身
 * 改名后判定必须失败而不是静默放过。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { collectFaultInjectionSuiteProblems, FAULT_INJECTION_BOUNDARIES } from "../../scripts/conventions/faultInjectionSuite";

const roots: string[] = [];

interface FixtureOptions {
  /** `test:fault-injection` 声明的路径；`undefined` 表示整条脚本缺失。 */
  readonly listed?: readonly string[];
  /** 额外写出的用例文件：路径 -> 文件内容。 */
  readonly tests?: Readonly<Record<string, string>>;
  /** 不写出的 harness 基名，用于覆盖「harness 改名」那条。 */
  readonly omitHarnesses?: readonly string[];
}

async function fixture({
  listed = [],
  tests = {},
  omitHarnesses = [],
}: FixtureOptions = {}): Promise<string> {
  const root: string = mkdtempSync(join(tmpdir(), "fault-injection-check-"));
  roots.push(root);
  const scripts: Record<string, string> = {};
  if (listed !== undefined) {
    scripts["test:fault-injection"] = `bun test --isolate ${listed.join(" ")}`;
  }
  await Bun.write(join(root, "package.json"), JSON.stringify({ scripts }));
  for (const harness of FAULT_INJECTION_BOUNDARIES) {
    if (omitHarnesses.includes(basename(harness.path, ".ts"))) continue;
    await Bun.write(join(root, harness.path), "export const marker: number = 1;\n");
  }
  for (const [path, source] of Object.entries(tests)) {
    await Bun.write(join(root, path), source);
  }
  return root;
}

afterEach((): void => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("fault-injection 清单门禁", (): void => {
  test.each([
    'import { marker } from "../../packages/workers/aiChat/replyDelivery";',
    'const { marker } = await import("../../packages/workers/aiChat/replyDelivery");',
    'export { marker } from "../../packages/workers/aiChat/replyDelivery";',
    'import {} from "../../packages/workers/aiChat/replyDelivery";',
    'export {} from "../../packages/workers/aiChat/replyDelivery";',
    'import marker, { type Shape } from "../../packages/workers/aiChat/replyDelivery";',
    'export { marker, type Shape } from "../../packages/workers/aiChat/replyDelivery";',
  ])("直接使用生产生命周期边界必须登记：%s", async (source) => {
    const path: string = "test/infra/direct.test.ts";
    const root: string = await fixture({ tests: { [path]: source } });
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([
      expect.stringContaining(`${path} uses packages/workers/aiChat/replyDelivery.ts`),
    ]);
  });

  test.each([
    'import type { marker } from "../../packages/workers/aiChat/replyDelivery";',
    'import { type marker } from "../../packages/workers/aiChat/replyDelivery";',
    'export type { marker } from "../../packages/workers/aiChat/replyDelivery";',
    'export { type marker } from "../../packages/workers/aiChat/replyDelivery";',
    'import { marker } from "./support/replyDelivery";',
  ])("纯类型与同名其它模块不扩大专项：%s", async (source) => {
    const root: string = await fixture({ tests: { "test/infra/types.test.ts": source } });
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([]);
  });

  const wholeModuleBoundaries: string[] = FAULT_INJECTION_BOUNDARIES
    .filter((entry): boolean => entry.path.startsWith("packages/") && entry.exports === undefined)
    .map((entry): string => entry.path);

  test.each(wholeModuleBoundaries)("每个整模块生产边界：漏登记失败、补登记通过、纯类型引用不收：%s", async (boundary) => {
    const path: string = "test/unit/boundary.test.ts";
    const specifier: string = `../../${boundary.slice(0, -".ts".length)}`;
    const valueImport: string = `const { marker } = await import("${specifier}");\nexport const used: number = marker;\n`;

    const missing: string = await fixture({ tests: { [path]: valueImport } });
    expect(await collectFaultInjectionSuiteProblems(missing)).toEqual([
      expect.stringContaining(`${path} uses ${boundary}`),
    ]);
    const listed: string = await fixture({ listed: [path], tests: { [path]: valueImport } });
    expect(await collectFaultInjectionSuiteProblems(listed)).toEqual([]);
    const typeOnly: string = await fixture({
      tests: { [path]: `import type { marker } from "${specifier}";\nexport type Used = typeof marker;\n` },
    });
    expect(await collectFaultInjectionSuiteProblems(typeOnly)).toEqual([]);
  });

  test.each([
    'import { drainPendingMessageDeletions } from "../../packages/infra/telegram/actions";',
    'import { sendMessage, flushPendingMessageDeletions as flush } from "../../packages/infra/telegram/actions";',
    'import * as actions from "../../packages/infra/telegram/actions";\nawait actions.drainPendingMessageDeletions(0);',
    'const actions = await import("../../packages/infra/telegram/actions");\nactions.flushPendingMessageDeletions();',
    'const actions = await import("../../packages/infra/telegram/actions");\nawait actions["drainPendingMessageDeletions"](0);',
    'const actions = await import("../../packages/infra/telegram/actions");\nregister(actions);',
    'const actions = await import("../../packages/infra/telegram/actions");\nmock.module("x", () => actions);',
    'const { flushPendingMessageDeletions: flush } = await import("../../packages/infra/telegram/actions");',
    'const { sendMessage, ...rest } = await import("../../packages/infra/telegram/actions");',
    'export * from "../../packages/infra/telegram/actions";',
    'void import("../../packages/infra/telegram/actions").then((loaded) => loaded);',
  ])("限定导出的边界：取用停机导出或无法确定取用范围时必须登记：%s", async (source) => {
    const path: string = "test/infra/deletion.test.ts";
    const root: string = await fixture({ tests: { [path]: source } });
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([
      expect.stringContaining(`${path} uses packages/infra/telegram/actions.ts`),
    ]);
  });

  test.each([
    'import { sendMessage, deleteMessageAfter } from "../../packages/infra/telegram/actions";',
    'import { resetPendingMessageDeletions } from "../../packages/infra/telegram/actions/messageLifecycle";',
    'const { deleteMessageWithOutcome } = await import("../../packages/infra/telegram/actions/messageLifecycle");',
    'import "../../packages/infra/telegram/actions";',
    'import type { drainPendingMessageDeletions } from "../../packages/infra/telegram/actions";',
    'import { type drainPendingMessageDeletions, sendMessage } from "../../packages/infra/telegram/actions";',
    'export { sendMessage } from "../../packages/infra/telegram/actions";',
    'import * as actions from "../../packages/infra/telegram/actions";',
    'const telegram = await import("../../packages/infra/telegram/actions");\nmock.module("x", () => ({ ...telegram, sendMessage }));',
    'import * as actions from "../../packages/infra/telegram/actions";\nactions.sendMessage();\ntype Api = typeof actions;',
    'const actions = await import("../../packages/infra/telegram/actions");\nconst other = { actions: 1 };\nvoid other.actions;',
  ])("限定导出的边界：只取用其它导出时不扩大专项：%s", async (source) => {
    const root: string = await fixture({ tests: { "test/infra/other.test.ts": source } });
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([]);
  });

  test("目录入口按 index.ts 解析：取用停机导出必须登记，只取其它导出不扩大专项", async (): Promise<void> => {
    const path: string = "test/infra/entry.test.ts";
    const missing: string = await fixture({
      tests: { [path]: 'import { drainPendingMessageDeletions } from "../../packages/infra/telegram";\n' },
    });
    expect(await collectFaultInjectionSuiteProblems(missing)).toEqual([
      expect.stringContaining(`${path} uses packages/infra/telegram/index.ts`),
    ]);
    const unrelated: string = await fixture({
      tests: { [path]: 'import { sendMessage } from "../../packages/infra/telegram";\n' },
    });
    expect(await collectFaultInjectionSuiteProblems(unrelated)).toEqual([]);
  });

  test("限定导出的叶子边界：漏登记失败，补登记后不再报告", async (): Promise<void> => {
    const path: string = "test/infra/welcome.test.ts";
    const tests: Readonly<Record<string, string>> = {
      [path]: 'const { drainPendingMessageDeletions } = await import("../../packages/infra/telegram/actions/messageLifecycle");\n',
    };
    const missing: string = await fixture({ tests });
    expect(await collectFaultInjectionSuiteProblems(missing)).toEqual([
      expect.stringContaining(`${path} uses packages/infra/telegram/actions/messageLifecycle.ts`),
    ]);
    const listed: string = await fixture({ listed: [path], tests });
    expect(await collectFaultInjectionSuiteProblems(listed)).toEqual([]);
  });

  test("真实仓库的清单已覆盖全部受约束 harness 的使用者", async (): Promise<void> => {
    expect(await collectFaultInjectionSuiteProblems(process.cwd())).toEqual([]);
  });

  test("缺少 test:fault-injection 脚本时失败", async (): Promise<void> => {
    const root: string = mkdtempSync(join(tmpdir(), "fault-injection-check-"));
    roots.push(root);
    await Bun.write(join(root, "package.json"), JSON.stringify({ scripts: {} }));
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([
      "package.json must define the test:fault-injection script",
    ]);
  });

  test("声明了不存在的路径时失败", async (): Promise<void> => {
    const root: string = await fixture({ listed: ["test/infra/gone.test.ts"] });
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([
      "test:fault-injection lists a file that does not exist: test/infra/gone.test.ts",
    ]);
  });

  test("同一路径声明两次时失败", async (): Promise<void> => {
    const path: string = "test/infra/dup.test.ts";
    const root: string = await fixture({
      listed: [path, path],
      tests: { [path]: "export const marker: number = 1;\n" },
    });
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([
      `test:fault-injection lists ${path} more than once`,
    ]);
  });

  test("静态 import 与 await import 两种 harness 使用形态都必须登记", async (): Promise<void> => {
    const staticPath: string = "test/infra/static.test.ts";
    const dynamicPath: string = "test/workers/antiRaid/dynamic.test.ts";
    const root: string = await fixture({
      listed: [],
      tests: {
        [staticPath]: 'import { marker } from "../helpers/diskIOWorkerHarness";\nexport const used: number = marker;\n',
        [dynamicPath]: 'const { marker } = await import("../../helpers/antiRaidMirrorHarness");\nexport const used: number = marker;\n',
      },
    });
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([
      expect.stringContaining(`${staticPath} uses test/helpers/diskIOWorkerHarness.ts`),
      expect.stringContaining(`${dynamicPath} uses test/helpers/antiRaidMirrorHarness.ts`),
    ]);
  });

  test("已登记的 harness 使用者不再报告", async (): Promise<void> => {
    const path: string = "test/infra/listed.test.ts";
    const root: string = await fixture({
      listed: [path],
      tests: {
        [path]: 'const { marker } = await import("../helpers/blocklistSweepHarness");\nexport const used: number = marker;\n',
      },
    });
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([]);
  });

  test("harness 被改名或删除时判定失败，不静默放过", async (): Promise<void> => {
    const root: string = await fixture({ omitHarnesses: ["lifecycleFixture"] });
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([
      "declared fault-injection boundary does not exist: test/helpers/lifecycleFixture.ts",
    ]);
  });

  test("同名不同目录的模块不算 harness 使用者", async (): Promise<void> => {
    const path: string = "test/infra/lookalike.test.ts";
    const root: string = await fixture({
      listed: [],
      tests: {
        "test/infra/support/diskIOWorkerHarness.ts": "export const marker: number = 2;\n",
        [path]: 'import { marker } from "./support/diskIOWorkerHarness";\nexport const used: number = marker;\n',
      },
    });
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([]);
  });

  test("裸说明符不参与判定", async (): Promise<void> => {
    const path: string = "test/infra/bare.test.ts";
    const root: string = await fixture({
      listed: [],
      tests: {
        [path]: 'import { expect } from "bun:test";\nexport const used: unknown = expect;\n',
      },
    });
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([]);
  });

  test("test 目录缺失时报告而不是抛错", async (): Promise<void> => {
    const root: string = mkdtempSync(join(tmpdir(), "fault-injection-check-"));
    roots.push(root);
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ scripts: { "test:fault-injection": "bun test --isolate" } })
    );
    expect(await collectFaultInjectionSuiteProblems(root)).toEqual([
      ...FAULT_INJECTION_BOUNDARIES.map((entry): string => `declared fault-injection boundary does not exist: ${entry.path}`),
      "test directory does not exist; the fault-injection suite cannot be verified",
    ]);
  });
});
