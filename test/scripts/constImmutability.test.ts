import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type ts from "typescript";
import { collectConstImmutabilityAssertionProblems } from "../../scripts/conventions/constImmutability";
import { createConstsProgram, exportedConstDeclarations } from "../../scripts/conventions/constsProgram";

const PROJECT_ROOT: string = join(import.meta.dir, "..", "..");
const MEMORY_PROMPTS: string = join(PROJECT_ROOT, "packages", "consts", "aiChat", "prompts", "memory.ts");
const TRANSCRIPT_PROMPTS: string = join(PROJECT_ROOT, "packages", "consts", "aiChat", "prompts", "transcript.ts");
const FIXTURE_DIR: string = mkdtempSync(join(tmpdir(), "const-immutability-"));
const FUNCTIONS_FIXTURE: string = join(FIXTURE_DIR, "functions.ts");
await Bun.write(FUNCTIONS_FIXTURE, [
  "export const HANDLERS: Readonly<Record<string, () => void>> = { tick: (): void => {} };",
  "",
].join("\n"));
const PROGRAM: ts.Program = createConstsProgram(PROJECT_ROOT, [MEMORY_PROMPTS, TRANSCRIPT_PROMPTS, FUNCTIONS_FIXTURE]);

afterAll((): void => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

function problemsFor(file: string, assertionSource: string): readonly string[] {
  return collectConstImmutabilityAssertionProblems({
    projectRoot: PROJECT_ROOT,
    checker: PROGRAM.getTypeChecker(),
    declarations: exportedConstDeclarations(PROGRAM, [file]),
    assertionSource,
  });
}

describe("带对象元素的常量表必须有不可变性断言", () => {
  test("断言文件没访问过的对象元素常量逐个报出", () => {
    const problems: readonly string[] = problemsFor(MEMORY_PROMPTS, "");
    expect(problems.some((problem: string): boolean => problem.includes("REPLY_CONTEXT_SECTION_TEXT holds object elements"))).toBeTrue();
  });

  test("紧跟 @ts-expect-error 注释按 NAME. 访问才算已断言；只在 import、普通读取或注释里出现不算", () => {
    const flagged = (assertionSource: string): boolean =>
      problemsFor(MEMORY_PROMPTS, assertionSource).some((problem: string): boolean => problem.includes("REPLY_CONTEXT_SECTION_TEXT"));
    expect(flagged("import { REPLY_CONTEXT_SECTION_TEXT } from \"x\";")).toBeTrue();
    expect(flagged("expect(REPLY_CONTEXT_SECTION_TEXT.referenceMemory.header).toBeString();")).toBeTrue();
    expect(flagged("// @ts-expect-error REPLY_CONTEXT_SECTION_TEXT.referenceMemory 只读\nconst x = 1;")).toBeTrue();
    expect(flagged("// @ts-expect-error 只读\nREPLY_CONTEXT_SECTION_TEXT.referenceMemory.header = \"x\";")).toBeFalse();
    expect(flagged("  // @ts-expect-error 只读；多行说明\n  // 接着写第二行。\n  REPLY_CONTEXT_SECTION_TEXT.referenceMemory.header = \"x\";")).toBeFalse();
  });

  test("正则元素与只含函数值的表不要求对象断言", () => {
    expect(problemsFor(TRANSCRIPT_PROMPTS, "").some((problem: string): boolean => problem.includes("SELF_ACTION_TAG_PATTERNS"))).toBeFalse();
    expect(problemsFor(FUNCTIONS_FIXTURE, "")).toEqual([]);
  });
});
