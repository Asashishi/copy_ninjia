/**
 * 依赖声明门禁：项目源码的运行期裸导入必须由根 manifest 直接声明。钉住四条判据：
 * 未声明的包（含只经传递依赖提升的包）必须报出、已声明包的子路径归到所属包名、
 * 运行时内建模块与纯类型引用不参与判定、真实仓库现状必须干净。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import {
  collectUndeclaredDependencyProblems,
  packageNameOf,
  readDeclaredPackages,
} from "../../scripts/conventions/manifestDependencies";
import { sourceFilesUnder } from "../../scripts/conventions/sourceAnalysis";

const PROJECT_ROOT: string = "/project";
const FIXTURE_PATH: string = "/project/scripts/example.ts";
const DECLARED: ReadonlySet<string> = new Set<string>(["grammy", "@grammyjs/runner", "drizzle-orm", "typescript"]);
const roots: string[] = [];

function problemsOf(text: string, declaredPackages: ReadonlySet<string> = DECLARED): readonly string[] {
  return collectUndeclaredDependencyProblems({
    projectRoot: PROJECT_ROOT,
    path: FIXTURE_PATH,
    source: ts.createSourceFile(FIXTURE_PATH, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    declaredPackages,
  });
}

afterEach((): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("依赖声明门禁", (): void => {
  test.each([
    ["grammy", "grammy"],
    ["grammy/types", "grammy"],
    ["drizzle-orm/bun-sqlite/migrator", "drizzle-orm"],
    ["@grammyjs/runner", "@grammyjs/runner"],
    ["@scope/pkg/deep/path", "@scope/pkg"],
    ["./local", undefined],
    ["../packages/libs/text", undefined],
    ["/absolute/module", undefined],
    ["bun", undefined],
    ["bun:test", undefined],
    ["node:fs", undefined],
    ["fs", undefined],
    ["fs/promises", undefined],
  ] as const)("说明符 %s 归到包 %s", (specifier, expected) => {
    expect(packageNameOf(specifier)).toBe(expected);
  });

  test.each([
    'import { familySync } from "detect-libc";',
    'import libc from "detect-libc";',
    'import "detect-libc";',
    'const { familySync } = await import("detect-libc");',
    'const libc = require("detect-libc");',
    'export { familySync } from "detect-libc";',
    'import { familySync, type Family } from "detect-libc";',
  ])("未声明的运行期包引用必须报出：%s", (source) => {
    expect(problemsOf(source)).toEqual([
      "scripts/example.ts:1 imports detect-libc at runtime, " +
      "but detect-libc is not declared in package.json dependencies or devDependencies",
    ]);
  });

  test("作用域包按前两段报出，行号指向引用处", () => {
    expect(problemsOf('import { a } from "grammy";\nimport { b } from "@scope/pkg/sub";\n')).toEqual([
      "scripts/example.ts:2 imports @scope/pkg/sub at runtime, " +
      "but @scope/pkg is not declared in package.json dependencies or devDependencies",
    ]);
  });

  test.each([
    'import { Bot } from "grammy";',
    'import type { Update } from "grammy/types";',
    'import { run } from "@grammyjs/runner";',
    'import { sqliteTable } from "drizzle-orm/sqlite-core";',
    'import type { Family } from "detect-libc";',
    'import { type Family } from "detect-libc";',
    'export type { Family } from "detect-libc";',
    'import { join } from "node:path";',
    'import { readFileSync } from "fs";',
    'import { expect } from "bun:test";',
    'import { heapStats } from "bun:jsc";',
    'import { helper } from "./helper";',
    'const fixture: string = "import { x } from \\"detect-libc\\";";',
  ])("已声明包、内建模块、纯类型引用与字符串夹具不报：%s", (source) => {
    expect(problemsOf(source)).toEqual([]);
  });

  test("manifest 同时读取 dependencies 与 devDependencies，缺节按空处理", async (): Promise<void> => {
    const root: string = mkdtempSync(join(tmpdir(), "manifest-dependencies-"));
    roots.push(root);
    await Bun.write(join(root, "package.json"), JSON.stringify({
      dependencies: { grammy: "^1.0.0" },
      devDependencies: { "detect-libc": "^2.1.2" },
    }));
    expect([...await readDeclaredPackages(root)].sort()).toEqual(["detect-libc", "grammy"]);
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "empty" }));
    expect([...await readDeclaredPackages(root)]).toEqual([]);
  });

  test("回归用例：构建脚本的 detect-libc 缺少直接声明时报出", async (): Promise<void> => {
    const projectRoot: string = process.cwd();
    const path: string = join(projectRoot, "scripts", "build.ts");
    const declared: Set<string> = new Set<string>(await readDeclaredPackages(projectRoot));
    expect(declared.has("detect-libc")).toBeTrue();
    declared.delete("detect-libc");
    const source: ts.SourceFile = ts.createSourceFile(
      path, await Bun.file(path).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS
    );
    expect(collectUndeclaredDependencyProblems({ projectRoot, path, source, declaredPackages: declared })).toEqual([
      expect.stringContaining("scripts/build.ts:4 imports detect-libc at runtime, but detect-libc is not declared"),
    ]);
  });

  test("真实仓库的运行期裸导入全部由根 manifest 直接声明", async (): Promise<void> => {
    const projectRoot: string = process.cwd();
    const declaredPackages: ReadonlySet<string> = await readDeclaredPackages(projectRoot);
    const paths: readonly string[] = [
      join(projectRoot, "index.ts"),
      ...sourceFilesUnder(join(projectRoot, "packages")),
      ...sourceFilesUnder(join(projectRoot, "scripts")),
      ...sourceFilesUnder(join(projectRoot, "test")),
    ];
    const problems: string[] = [];
    for (const path of paths) {
      const source: ts.SourceFile = ts.createSourceFile(
        path, await Bun.file(path).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS
      );
      problems.push(...collectUndeclaredDependencyProblems({ projectRoot, path, source, declaredPackages }));
    }
    expect(problems).toEqual([]);
  });
});
