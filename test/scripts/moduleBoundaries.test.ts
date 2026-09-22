/**
 * 四条「谁能依赖谁」的门禁（scripts/conventions/moduleBoundaries.ts）。
 * 真实仓库当前全部合规，因此这里逐条造违规样本，确认它们能被拦下。
 */

import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  collectEnvironmentAccessProblems,
  collectFullSuiteImportProblems,
  collectInfraLayeringProblems,
  collectStatesPurityProblems,
} from "../../scripts/conventions/moduleBoundaries";

const PROJECT_ROOT: string = "/project";

function params(relativePath: string, text: string): {
  projectRoot: string;
  path: string;
  source: ts.SourceFile;
} {
  const path: string = `${PROJECT_ROOT}/${relativePath}`;
  return {
    projectRoot: PROJECT_ROOT,
    path,
    source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
}

describe("环境变量读取边界", () => {
  test("两个边界文件之外读 process.env / Bun.env 一律拦下", () => {
    expect(collectEnvironmentAccessProblems(params(
      "packages/libs/example.ts",
      "const value = process.env.HOME;"
    ))).toEqual([expect.stringContaining("reads process.env")]);
    expect(collectEnvironmentAccessProblems(params(
      "packages/libs/example.ts",
      'const value = Bun.env["HOME"];'
    ))).toEqual([expect.stringContaining("reads Bun.env")]);
  });

  test("consts/paths.ts 与 consts/environment.ts 放行", () => {
    for (const file of ["packages/consts/paths.ts", "packages/consts/environment.ts"]) {
      expect(collectEnvironmentAccessProblems(params(file, "const v = process.env.HOME;"))).toEqual([]);
    }
  });

  test("同名属性不误伤：别的对象上的 env 不算", () => {
    expect(collectEnvironmentAccessProblems(params(
      "packages/libs/example.ts",
      "const value = options.env.HOME; const spawn = { env: {} };"
    ))).toEqual([]);
  });
});

describe("packages/states 纯度", () => {
  test("只允许 consts、libs、types 与同目录模块", () => {
    expect(collectStatesPurityProblems(params(
      "packages/states/example.ts",
      'import { A } from "../consts/x";\nimport { B } from "../libs/y";\n' +
      'import type { C } from "../types/z";\nimport { D } from "./other";'
    ))).toEqual([]);
  });

  test("缓存、infra 与 Worker 桥一律拦下", () => {
    const problems = collectStatesPurityProblems(params(
      "packages/states/example.ts",
      'import { logger } from "../infra/logger";\nimport { cache } from "../cache/main/x";\n' +
      'import { post } from "../antiRaid/workerBridge/controller";'
    ));
    expect(problems).toHaveLength(3);
    expect(problems.every((problem: string): boolean => problem.includes("may only depend on"))).toBeTrue();
  });

  test("纯类型引用被擦除，不算运行期依赖", () => {
    expect(collectStatesPurityProblems(params(
      "packages/states/example.ts",
      'import type { ChatState } from "../types/chatState";\nimport type { Api } from "../infra/telegram";'
    ))).toEqual([]);
  });
});

describe("infra 不得向上依赖业务层", () => {
  test("命令、AI、Anti-Raid 与 Worker 一律拦下", () => {
    const problems = collectInfraLayeringProblems(params(
      "packages/infra/example.ts",
      'import { a } from "../commands/x";\nimport { b } from "../aiChat/workerBridge";\n' +
      'import { c } from "../antiRaid/adDetect";\nimport { d } from "../workers/aiChat/x";'
    ));
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain("inject the dependency instead");
  });

  test("落盘诊断出口是唯一豁免", () => {
    expect(collectInfraLayeringProblems(params(
      "packages/infra/diskIO/host.ts",
      'import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";'
    ))).toEqual([]);
  });

  test("同层与更低层照常放行", () => {
    expect(collectInfraLayeringProblems(params(
      "packages/infra/example.ts",
      'import { a } from "./logger";\nimport { b } from "../libs/x";\nimport { c } from "../cache/main/y";'
    ))).toEqual([]);
  });
});

describe("全量基准的 import 边界", () => {
  test("父进程与非夹具模块只能取常量或类型", () => {
    expect(collectFullSuiteImportProblems(params(
      "scripts/perf/fullSuite/sections.ts",
      'import { X } from "../../../packages/consts/qa";\n' +
      'import type { Y } from "../../../packages/infra/joinLog";'
    ))).toEqual([]);
    expect(collectFullSuiteImportProblems(params(
      "scripts/perf/fullSuite.ts",
      'import { recordJoinLog } from "../../packages/infra/joinLog";'
    ))).toEqual([expect.stringContaining("may only import packages/consts/")]);
  });

  test("五个夹具模块可以调生产入口", () => {
    for (const file of ["chain", "coldStart", "fixture", "seed", "storage"]) {
      expect(collectFullSuiteImportProblems(params(
        `scripts/perf/fullSuite/${file}.ts`,
        'import { recordJoinLog } from "../../../packages/infra/joinLog";'
      ))).toEqual([]);
    }
  });

  test("fullSuite 之外的脚本不受本规则约束", () => {
    expect(collectFullSuiteImportProblems(params(
      "scripts/perf/joinLog.ts",
      'import { recordJoinLog } from "../../packages/infra/joinLog";'
    ))).toEqual([]);
  });
});
