import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { collectNodeCompatibilityProblems } from "../../scripts/conventions/nodeCompatibility";

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

    const backupPath: string = "/project/scripts/migration/backup.ts";
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      backupPath,
      source(backupPath, 'import { readFileSync, writeFileSync } from "node:fs";')
    )).toEqual([]);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      scriptPath,
      source(scriptPath, 'import { readFileSync, writeFileSync } from "node:fs";')
    )).toEqual([
      expect.stringContaining("unreviewed node:fs export readFileSync"),
      expect.stringContaining("unreviewed node:fs export writeFileSync"),
    ]);
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
