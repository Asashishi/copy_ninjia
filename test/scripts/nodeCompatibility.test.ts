import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { collectNodeCompatibilityProblems } from "../../scripts/conventions/nodeCompatibility";

function source(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe("Node 兼容约定", () => {
  const projectRoot: string = "/project";
  const packagePath: string = "/project/packages/example.ts";

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

  test("Buffer 全局只允许精确文件，属性名不误报，失效豁免必须删除", () => {
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      packagePath,
      source(packagePath, "const size: number = Buffer.byteLength('x');\nconst reference = Buffer;")
    )).toEqual([
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
});
