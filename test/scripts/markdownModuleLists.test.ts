import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectMarkdownModuleListProblems,
  collectSourceDirectories,
} from "../../scripts/conventions/markdownModuleLists";

const temporaryRoots: string[] = [];

afterEach((): void => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * 临时仓库：packages/infra/interact/ 与 scripts/perf/ 各自唯一，
 * `shared/` 在两个位置重名。
 */
async function projectFixture(): Promise<string> {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-module-lists-"));
  temporaryRoots.push(root);
  for (const file of [
    "packages/infra/interact/present.ts",
    "packages/infra/interact/other.ts",
    "packages/a/shared/one.ts",
    "packages/b/shared/two.ts",
    "scripts/perf/bench.ts",
  ]) await Bun.write(join(root, file), "export {};\n");
  mkdirSync(join(root, "test", "empty"), { recursive: true });
  return root;
}

/** 以源码根收集目录，与门禁的调用方式一致。 */
function sourceDirectories(root: string): readonly string[] {
  return collectSourceDirectories([join(root, "packages"), join(root, "scripts"), join(root, "test")]);
}

/** 写入一份文档并跑目录清单核对。 */
async function problemsFor(root: string, markdown: string): Promise<readonly string[]> {
  const path: string = join(root, "docs", "map.md");
  await Bun.write(path, markdown);
  return collectMarkdownModuleListProblems(root, path, sourceDirectories(root));
}

describe("源码目录收集", () => {
  test("递归返回各源码根下的全部目录，不含文件与根本身", async (): Promise<void> => {
    const root: string = await projectFixture();
    expect([...sourceDirectories(root)].sort()).toEqual([
      join(root, "packages", "a"),
      join(root, "packages", "a", "shared"),
      join(root, "packages", "b"),
      join(root, "packages", "b", "shared"),
      join(root, "packages", "infra"),
      join(root, "packages", "infra", "interact"),
      join(root, "scripts", "perf"),
      join(root, "test", "empty"),
    ].sort());
  });

  test("源码根不存在时直接抛错", async (): Promise<void> => {
    const root: string = await projectFixture();
    expect((): void => { collectSourceDirectories([join(root, "missing")]); }).toThrow();
  });
});

describe("文档目录清单核对", () => {
  test("清单点名的文件都存在时不报问题", async (): Promise<void> => {
    const root: string = await projectFixture();
    expect(await problemsFor(root,
      "- `interact/`（`present.ts`、`other.ts`）\n- `perf/` (`bench.ts`)\n"
    )).toEqual([]);
  });

  test("全角与半角括号里点名的已删除文件都按行报出", async (): Promise<void> => {
    const root: string = await projectFixture();
    expect(await problemsFor(root,
      "# Map\n\n- `interact/`（`present.ts`、`removed.ts`）\n- `perf/` (`gone.ts`)\n"
    )).toEqual([
      "docs/map.md:3 lists removed.ts under interact/, but packages/infra/interact/removed.ts does not exist",
      "docs/map.md:4 lists gone.ts under perf/, but scripts/perf/gone.ts does not exist",
    ]);
  });

  test("括号内嵌套括号仍按配对范围核对", async (): Promise<void> => {
    const root: string = await projectFixture();
    expect(await problemsFor(root, "- `interact/`（`present.ts`（依赖 `missing.ts`））\n")).toEqual([
      "docs/map.md:1 lists missing.ts under interact/, but packages/infra/interact/missing.ts does not exist",
    ]);
  });

  test("目录名重名或解析不到、括号不配对、占位符与非 .ts 条目一律放过", async (): Promise<void> => {
    const root: string = await projectFixture();
    expect(await problemsFor(root, [
      "- `shared/`（`missing.ts`）",
      "- `unknown/`（`missing.ts`）",
      "- `interact/`（`<domain>.ts`、`README.md`、`missing.json`）",
      "- `interact/` 目录下另见（`missing.ts`）",
      "- `interact/`（`missing.ts`",
    ].join("\n"))).toEqual([]);
  });

  test("代码块里的示例清单不参与核对，行号仍按原文计算", async (): Promise<void> => {
    const root: string = await projectFixture();
    expect(await problemsFor(root,
      "```md\n- `interact/`（`example.ts`）\n```\n- `interact/`（`removed.ts`）\n"
    )).toEqual([
      "docs/map.md:4 lists removed.ts under interact/, but packages/infra/interact/removed.ts does not exist",
    ]);
  });
});
