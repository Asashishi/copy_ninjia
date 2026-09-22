import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  collectNodeCompatibilityProblems,
  collectNodeImportUsage,
  collectStaleNodeAllowanceProblems,
  collectUnusedNodeAllowanceProblems,
  isRuntimeBuiltinModule,
} from "../../scripts/conventions/nodeCompatibility";
import type { NodeImportUsage } from "../../scripts/conventions/nodeCompatibility";
import {
  PORTABLE_NODE_IMPORTS,
  PRODUCTION_NODE_IMPORTS,
  SCRIPT_NODE_IMPORTS,
  SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS,
  TEST_NODE_IMPORTS,
  TEST_SHARED_NODE_IMPORTS,
  TEST_SYNC_CONTENT_IO_EXEMPTIONS,
} from "../../scripts/conventions/nodeAllowances";
import type { NodeImportAllowance } from "../../scripts/conventions/nodeAllowances";

function source(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe("Node 兼容约定", () => {
  const projectRoot: string = "/project";
  const packagePath: string = "/project/packages/example.ts";

  test("无前缀内建导入、别名与子路径使用同一白名单", () => {
    for (const prefix of ["", "node:"]) {
      expect(collectNodeCompatibilityProblems(projectRoot, packagePath, source(packagePath,
        `import { readFile as read } from "${prefix}fs/promises";`
      ))).toEqual([expect.stringContaining("unreviewed Node compatibility module node:fs/promises")]);
      expect(collectNodeCompatibilityProblems(projectRoot, packagePath, source(packagePath,
        `import { join as combine } from "${prefix}path"; import type { Stats } from "${prefix}fs";`
      ))).toEqual([]);
    }
    expect(collectNodeCompatibilityProblems(projectRoot, packagePath, source(packagePath,
      'import { heapStats } from "bun:jsc"; import { test } from "bun:test"; import pkg from "fs-extra";'
    ))).toEqual([]);
  });

  test("动态导入、require、重导出与 import equals 不能隐藏内建模块", () => {
    const problems = collectNodeCompatibilityProblems(projectRoot, packagePath, source(packagePath,
      'await import("fs/promises"); require("fs"); export { readFile } from "fs"; ' +
      'import fs = require("fs"); export type { Stats } from "fs"; ' +
      'type Stats = import("fs").Stats;'
    ));
    expect(problems).toHaveLength(4);
    expect(problems.every((problem) => problem.includes("node:fs"))).toBeTrue();
  });

  test("process 高精度计时、微任务调度与解构别名都要求审查", () => {
    const problems = collectNodeCompatibilityProblems(projectRoot, packagePath, source(packagePath,
      'process.hrtime.bigint(); process["nextTick"](() => {}); const { nextTick: schedule } = process;'
    ));
    expect(problems).toEqual([
      expect.stringContaining("uses process.hrtime; use Bun.nanoseconds"),
      expect.stringContaining("uses process.nextTick; use queueMicrotask"),
      expect.stringContaining("uses process.nextTick; use queueMicrotask"),
    ]);
  });

  test("原生 timingSafeEqual 使生产与脚本旧白名单失效", () => {
    for (const path of ["/project/packages/libs/luckReceipt.ts", "/project/scripts/example.ts"]) {
      expect(collectNodeCompatibilityProblems(projectRoot, path, source(path,
        'import { timingSafeEqual } from "crypto";'
      ))).toHaveLength(1);
    }
  });

  test("生产白名单只放行已核对模块的命名导入", () => {
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      packagePath,
      source(packagePath, 'import { readFileSync } from "node:fs";\nimport { join } from "node:path";')
    )).toEqual([
      expect.stringContaining("unreviewed Node compatibility module node:fs"),
    ]);

    const atomicPath: string = "/project/packages/libs/atomicFile.ts";
    const problems: readonly string[] = collectNodeCompatibilityProblems(
      projectRoot,
      atomicPath,
      source(atomicPath, 'import * as fs from "node:fs";\nimport { readFile } from "node:fs/promises";\nimport { exec } from "node:child_process";\nconst bytes: Buffer = Buffer.alloc(1);')
    );
    expect(problems).toEqual([
      expect.stringContaining("must not namespace-import node:fs"),
      expect.stringContaining("unreviewed node:fs/promises export readFile"),
      expect.stringContaining("unreviewed Node compatibility module node:child_process"),
      expect.stringContaining("unreviewed Node compatibility global Buffer.alloc"),
    ]);
  });

  test("脚本通用能力与精确同步内容 I/O 豁免分开核对", () => {
    const scriptPath: string = "/project/scripts/example.ts";
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      scriptPath,
      source(scriptPath, 'import { rmSync, symlinkSync } from "node:fs";\nimport { tmpdir } from "node:os";')
    )).toEqual([]);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      packagePath,
      source(packagePath, 'import { rmSync } from "node:fs";\nimport { tmpdir } from "node:os";')
    )).toEqual([
      expect.stringContaining("unreviewed Node compatibility module node:fs"),
      expect.stringContaining("unreviewed Node compatibility module node:os"),
    ]);

    const processIoPath: string = "/project/scripts/perf/fullSuite/processIo.ts";
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      processIoPath,
      source(processIoPath, 'import { readFileSync } from "node:fs";')
    )).toEqual([]);
    // 豁免逐符号生效：同一个文件也拿不到它没登记的 writeFileSync。
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      processIoPath,
      source(processIoPath, 'import { readFileSync, writeFileSync } from "node:fs";')
    )).toEqual([
      expect.stringContaining("unreviewed node:fs export writeFileSync"),
    ]);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      scriptPath,
      source(scriptPath, 'import { readFileSync, writeFileSync } from "node:fs";')
    )).toEqual([
      expect.stringContaining("unreviewed node:fs export readFileSync"),
      expect.stringContaining("unreviewed node:fs export writeFileSync"),
    ]);
  });

  test("测试文件复用脚本通用能力与测试夹具接口，整模块替身、同步内容 I/O 和 Buffer 按文件豁免", () => {
    const testPath: string = "/project/test/example.test.ts";
    const fixtureImports: string =
      'import { cpSync, mkdtempSync, rmSync, statSync } from "node:fs";\n' +
      'import { mkdtemp, lstat } from "node:fs/promises";\n' +
      'import { tmpdir } from "node:os";\nimport { generateKeyPairSync } from "node:crypto";';
    expect(collectNodeCompatibilityProblems(projectRoot, testPath, source(testPath, fixtureImports))).toEqual([]);
    expect(collectNodeCompatibilityProblems(projectRoot, packagePath, source(packagePath, fixtureImports))).toHaveLength(4);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      testPath,
      source(testPath, 'import { arch } from "node:os";\nimport { exec } from "node:child_process";')
    )).toEqual([
      expect.stringContaining("unreviewed node:os export arch"),
      expect.stringContaining("unreviewed Node compatibility module node:child_process"),
    ]);

    const namespaceSource: string = 'import * as fs from "node:fs";';
    expect(collectNodeCompatibilityProblems(projectRoot, testPath, source(testPath, namespaceSource)))
      .toEqual([expect.stringContaining("must not namespace-import node:fs")]);
    const fileAccessPath: string = "/project/test/libs/fileAccess.test.ts";
    expect(collectNodeCompatibilityProblems(projectRoot, fileAccessPath, source(fileAccessPath, namespaceSource)))
      .toEqual([]);

    const preloadEnvPath: string = "/project/test/preloadEnv.ts";
    const contentIoSource: string = 'import { readFileSync, writeFileSync } from "node:fs";';
    expect(collectNodeCompatibilityProblems(projectRoot, preloadEnvPath, source(preloadEnvPath, contentIoSource)))
      .toEqual([]);
    expect(collectNodeCompatibilityProblems(projectRoot, testPath, source(testPath, contentIoSource))).toEqual([
      expect.stringContaining("unreviewed node:fs export readFileSync"),
      expect.stringContaining("unreviewed node:fs export writeFileSync"),
    ]);

    const bufferSource: string = "const bytes: Uint8Array = Buffer.from([1]);";
    const boundedResponsePath: string = "/project/test/libs/boundedResponse.test.ts";
    expect(collectNodeCompatibilityProblems(projectRoot, boundedResponsePath, source(boundedResponsePath, bufferSource)))
      .toEqual([]);
    expect(collectNodeCompatibilityProblems(projectRoot, testPath, source(testPath, bufferSource)))
      .toEqual([expect.stringContaining("unreviewed Node compatibility global Buffer.from")]);
    expect(collectNodeCompatibilityProblems(projectRoot, testPath, source(testPath, "const bun = process.execPath;")))
      .toEqual([expect.stringContaining("uses process.execPath; use Bun.argv")]);
  });

  test("运行时动态 import 与 require 不能绕过静态命名导入核对", () => {
    const problems: readonly string[] = collectNodeCompatibilityProblems(
      projectRoot,
      packagePath,
      source(
        packagePath,
        "type Stats = import(\"node:fs\").Stats;\n" +
        "async function load(): Promise<void> { " +
        "await import(\"node:fs\"); await import(`node:os`); require(\"node:path\"); }"
      )
    );
    expect(problems).toEqual([
      expect.stringContaining("runtime dynamic import of node:fs"),
      expect.stringContaining("runtime dynamic import of node:os"),
      expect.stringContaining("runtime require of node:path"),
    ]);
  });

  test("type-only Node 引用不生成运行时兼容依赖", () => {
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      packagePath,
      source(
        packagePath,
        'import type { Stats } from "node:fs";\ntype FileStats = import("node:fs").Stats;'
      )
    )).toEqual([]);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      packagePath,
      source(packagePath, "type Bytes = Buffer;\nimport type { Buffer as NodeBuffer } from \"node:buffer\";")
    )).toEqual([]);
  });

  test("内联 type 导入与重导出不属于运行时依赖，混合值导出仍检查", (): void => {
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      packagePath,
      source(packagePath, 'import { type Stats } from "node:fs"; export { type Stats } from "fs";')
    )).toEqual([]);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      packagePath,
      source(packagePath, 'export { type Stats, readFileSync } from "node:fs";')
    )).toEqual([expect.stringContaining("unreviewed runtime re-export")]);
  });

  test("Buffer 全局只允许精确文件与方法，属性名不误报，失效豁免必须删除", () => {
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      packagePath,
      source(packagePath, "const size: number = Buffer.byteLength('x');\nconst reference = Buffer;")
    )).toEqual([
      expect.stringContaining("unreviewed Node compatibility global Buffer.byteLength"),
      expect.stringContaining("unreviewed Node compatibility global Buffer"),
    ]);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      packagePath,
      source(packagePath, "const value = { Buffer: 1 };\nvalue.Buffer;")
    )).toEqual([]);

    const jsonBytesPath: string = "/project/packages/libs/jsonBytes.ts";
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      jsonBytesPath,
      source(jsonBytesPath, "const size: number = Buffer.byteLength('x');")
    )).toEqual([]);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      jsonBytesPath,
      source(jsonBytesPath, "const bytes: Uint8Array = Buffer.from('x');")
    )).toEqual([
      expect.stringContaining("unreviewed Node compatibility global Buffer.from"),
    ]);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      jsonBytesPath,
      source(jsonBytesPath, "export const SIZE: number = 1;")
    )).toEqual([
      expect.stringContaining("stale Node compatibility global Buffer allowance"),
    ]);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      jsonBytesPath,
      source(jsonBytesPath, "type Bytes = Buffer;")
    )).toEqual([
      expect.stringContaining("stale Node compatibility global Buffer allowance"),
    ]);
  });

  test("Bun 自带参数向量覆盖 process.argv 与 process.execPath", () => {
    const scriptPath: string = "/project/scripts/example.ts";
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      scriptPath,
      source(scriptPath, "const executable = process.execPath; const args = process.argv;")
    )).toEqual([
      expect.stringContaining("uses process.execPath; use Bun.argv"),
      expect.stringContaining("uses process.argv; use Bun.argv"),
    ]);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      scriptPath,
      source(scriptPath, "const executable = Bun.argv[0]; const args = Bun.argv;")
    )).toEqual([]);
  });
});

test("getBuiltinModule 的直接调用与字面量下标都进入静态导入门禁", (): void => {
  for (const expression of ["process.getBuiltinModule", 'process["getBuiltinModule"]', 'globalThis["process"][`getBuiltinModule`]']) {
    const path: string = "/project/packages/example.ts";
    for (const module of ["fs", "node:fs", "path"]) {
      expect(collectNodeCompatibilityProblems("/project", path, source(path, `${expression}("${module}");`)))
        .toEqual([expect.stringContaining("unreviewed runtime process.getBuiltinModule")]);
    }
  }
});

test("globalThis.Buffer 和字面量下标复用方法白名单", (): void => {
  for (const expression of ["Buffer", "globalThis.Buffer", 'globalThis["Buffer"]', "globalThis[`Buffer`]"]) {
    for (const method of [".byteLength", '["byteLength"]', "[`byteLength`]"]) {
      const path: string = "/project/packages/libs/jsonBytes.ts";
      expect(collectNodeCompatibilityProblems("/project", path, source(path, `${expression}${method}("x");`))).toEqual([]);
      const unknown: string = "/project/packages/example.ts";
      expect(collectNodeCompatibilityProblems("/project", unknown, source(unknown, `${expression}${method}("x");`)))
        .toEqual([expect.stringContaining("global Buffer.byteLength")]);
    }
    const path: string = "/project/packages/libs/jsonBytes.ts";
    expect(collectNodeCompatibilityProblems("/project", path, source(path, `${expression}.from("x");`)))
      .toEqual([expect.stringContaining("global Buffer.from")]);
  }
  const path: string = "/project/packages/example.ts";
  expect(collectNodeCompatibilityProblems("/project", path, source(path, "const x = { Buffer: 1 }; x.Buffer; type B = typeof globalThis.Buffer;"))).toEqual([]);
});

describe("Node 兼容登记的陈旧条目", () => {
  test("仓库现有登记全部指向真实文件", () => {
    expect(collectStaleNodeAllowanceProblems(process.cwd())).toEqual([]);
  });

  test("登记指向已删除文件时逐表报出", () => {
    const problems: readonly string[] = collectStaleNodeAllowanceProblems("/nonexistent-root");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining("PRODUCTION_NODE_IMPORTS retains an allowance for a file that no longer exists"),
      expect.stringContaining("SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS retains an allowance for a file that no longer exists"),
      expect.stringContaining("PRODUCTION_BUFFER_GLOBALS retains an allowance for a file that no longer exists"),
      expect.stringContaining("SCRIPT_BUFFER_GLOBALS retains an allowance for a file that no longer exists"),
    ]));
  });
});

describe("运行时内建模块识别", () => {
  test("Bun 自有模块与带或不带 node: 前缀的 Node 内建模块（含子路径）都由运行时提供", (): void => {
    for (const name of [
      "bun", "bun:test", "bun:sqlite", "bun:jsc",
      "fs", "node:fs", "fs/promises", "node:fs/promises", "path", "crypto", "child_process",
    ]) expect(isRuntimeBuiltinModule(name)).toBeTrue();
  });

  test("npm 包、相对路径与名字近似的第三方包都不算内建模块", (): void => {
    for (const name of [
      "typescript", "grammy", "@grammyjs/runner", "bun-types", "@types/bun",
      "fs-extra", "node-fetch", "./fs", "../bun",
    ]) expect(isRuntimeBuiltinModule(name)).toBeFalse();
  });
});

describe("Node 兼容 import 使用记录", () => {
  test("只记录运行期具名与命名空间 import，按原导出名归一并补齐 node: 前缀", (): void => {
    const path: string = "/project/test/example.test.ts";
    expect(collectNodeImportUsage("/project", path, source(path,
      'import { mkdtempSync as makeTemp, rmSync } from "fs";\n' +
      'import { type Stats, statSync } from "node:fs";\n' +
      'import type { Dirent } from "node:fs";\n' +
      'import fs, { existsSync } from "node:fs";\n' +
      'import * as os from "node:os";\n' +
      'import { readdir } from "fs/promises";\n' +
      'import path from "node:path";\n' +
      'import "node:crypto";\n' +
      'import { test } from "bun:test";\n' +
      'import ts from "typescript";\n' +
      'import { helper } from "./helper";\n' +
      'const lazy = await import("node:child_process");\n'
    ))).toEqual([
      { relativePath: "test/example.test.ts", moduleName: "node:fs", imported: "mkdtempSync" },
      { relativePath: "test/example.test.ts", moduleName: "node:fs", imported: "rmSync" },
      { relativePath: "test/example.test.ts", moduleName: "node:fs", imported: "statSync" },
      { relativePath: "test/example.test.ts", moduleName: "node:fs", imported: "existsSync" },
      { relativePath: "test/example.test.ts", moduleName: "node:os", imported: "*" },
      { relativePath: "test/example.test.ts", moduleName: "node:fs/promises", imported: "readdir" },
    ]);
  });

  test("没有 Node 兼容 import 的文件记录为空", (): void => {
    const path: string = "/project/scripts/example.ts";
    expect(collectNodeImportUsage("/project", path, source(path,
      'import { heapStats } from "bun:jsc";\nimport ts from "typescript";\nexport const VALUE: number = 1;'
    ))).toEqual([]);
  });
});

/** 共享登记表及其作用域内的一个代表文件。 */
const SHARED_TABLES: readonly (readonly [string, Readonly<Record<string, NodeImportAllowance>>, string])[] = [
  ["PORTABLE_NODE_IMPORTS", PORTABLE_NODE_IMPORTS, "packages/example.ts"],
  ["SCRIPT_NODE_IMPORTS", SCRIPT_NODE_IMPORTS, "scripts/example.ts"],
  ["TEST_SHARED_NODE_IMPORTS", TEST_SHARED_NODE_IMPORTS, "test/example.test.ts"],
];

/** 逐文件登记表；使用记录必须落在登记的那个文件上。 */
const PER_FILE_TABLES: readonly (readonly [string, Readonly<Record<string, Readonly<Record<string, NodeImportAllowance>>>>])[] = [
  ["PRODUCTION_NODE_IMPORTS", PRODUCTION_NODE_IMPORTS],
  ["TEST_NODE_IMPORTS", TEST_NODE_IMPORTS],
  ["SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS", SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS],
  ["TEST_SYNC_CONTENT_IO_EXEMPTIONS", TEST_SYNC_CONTENT_IO_EXEMPTIONS],
];

/** 按真实登记表合成「每条登记恰好被用到一次」的使用记录；通配登记记成 `*`。 */
function completeUsage(): NodeImportUsage[] {
  const usage: NodeImportUsage[] = [];
  const push = (relativePath: string, moduleName: string, allowance: NodeImportAllowance): void => {
    const symbols: readonly string[] = allowance.symbols === "*" ? ["*"] : allowance.symbols;
    for (const imported of symbols) usage.push({ relativePath, moduleName, imported });
  };
  for (const [, entries, relativePath] of SHARED_TABLES) {
    for (const [moduleName, allowance] of Object.entries(entries)) push(relativePath, moduleName, allowance);
  }
  for (const [, entries] of PER_FILE_TABLES) {
    for (const [relativePath, modules] of Object.entries(entries)) {
      for (const [moduleName, allowance] of Object.entries(modules)) push(relativePath, moduleName, allowance);
    }
  }
  return usage;
}

/** 从完整记录里去掉命中谓词的条目，模拟对应 import 已被删除。 */
function usageWithout(predicate: (entry: NodeImportUsage) => boolean): NodeImportUsage[] {
  return completeUsage().filter((entry: NodeImportUsage): boolean => !predicate(entry));
}

describe("Node 兼容登记的反向核对", () => {
  test("每条登记都有使用者时不报问题", (): void => {
    expect(collectUnusedNodeAllowanceProblems(completeUsage())).toEqual([]);
  });

  test("没有任何使用记录时七张登记表的每一条都报为无人使用", (): void => {
    const problems: readonly string[] = collectUnusedNodeAllowanceProblems([]);
    expect(problems).toHaveLength(completeUsage().length);
    for (const [table, entries] of [...SHARED_TABLES, ...PER_FILE_TABLES]) {
      if (Object.keys(entries).length === 0) continue;
      expect(problems).toContainEqual(expect.stringContaining(`${table} retains an unused allowance`));
    }
  });

  test("共享通配登记只要作用域内还有一处使用就保留", (): void => {
    const usage: NodeImportUsage[] = usageWithout(
      (entry: NodeImportUsage): boolean => entry.moduleName === "node:path"
    );
    expect(collectUnusedNodeAllowanceProblems(usage)).toEqual([
      "PORTABLE_NODE_IMPORTS retains an unused allowance for node:path",
    ]);
    // PORTABLE 的作用域覆盖全部文件：脚本里的一处具名使用即可满足。
    expect(collectUnusedNodeAllowanceProblems([
      ...usage,
      { relativePath: "scripts/example.ts", moduleName: "node:path", imported: "join" },
    ])).toEqual([]);
  });

  test("共享逐符号登记按作用域核对，别的作用域里的同名使用不算数", (): void => {
    const usage: NodeImportUsage[] = usageWithout((entry: NodeImportUsage): boolean =>
      entry.relativePath.startsWith("test/") && entry.moduleName === "node:os" && entry.imported === "tmpdir");
    const unused: readonly string[] = [
      "TEST_SHARED_NODE_IMPORTS retains an unused allowance: node:os export tmpdir",
    ];
    expect(collectUnusedNodeAllowanceProblems(usage)).toEqual(unused);
    for (const relativePath of ["scripts/example.ts", "packages/example.ts"]) {
      expect(collectUnusedNodeAllowanceProblems([
        ...usage,
        { relativePath, moduleName: "node:os", imported: "tmpdir" },
      ])).toEqual(unused);
    }
    expect(collectUnusedNodeAllowanceProblems([
      ...usage,
      { relativePath: "test/other.test.ts", moduleName: "node:os", imported: "tmpdir" },
    ])).toEqual([]);
  });

  test("逐文件逐符号豁免只认登记的那个文件", (): void => {
    const processIoPath: string = "scripts/perf/fullSuite/processIo.ts";
    const usage: NodeImportUsage[] = usageWithout((entry: NodeImportUsage): boolean =>
      entry.relativePath === processIoPath && entry.imported === "readFileSync");
    const unused: readonly string[] = [
      `SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS retains an unused allowance for ${processIoPath}: node:fs export readFileSync`,
    ];
    expect(collectUnusedNodeAllowanceProblems(usage)).toEqual(unused);
    expect(collectUnusedNodeAllowanceProblems([
      ...usage,
      { relativePath: "scripts/perf/fullSuite/other.ts", moduleName: "node:fs", imported: "readFileSync" },
    ])).toEqual(unused);
  });

  test("逐文件通配豁免在该文件不再 import 模块时报出，任意一处使用即可保留", (): void => {
    const fileAccessPath: string = "test/libs/fileAccess.test.ts";
    const usage: NodeImportUsage[] = usageWithout((entry: NodeImportUsage): boolean =>
      entry.relativePath === fileAccessPath && entry.moduleName === "node:fs");
    expect(collectUnusedNodeAllowanceProblems(usage)).toEqual([
      `TEST_NODE_IMPORTS retains an unused allowance for ${fileAccessPath}: node:fs`,
    ]);
    // 使用记录直接取自 collectNodeImportUsage 的解析结果，与门禁里的串联方式一致。
    const absolutePath: string = `/project/${fileAccessPath}`;
    for (const text of ['import * as fs from "node:fs";', 'import { statSync } from "fs";']) {
      expect(collectUnusedNodeAllowanceProblems([
        ...usage,
        ...collectNodeImportUsage("/project", absolutePath, source(absolutePath, text)),
      ])).toEqual([]);
    }
  });
});
