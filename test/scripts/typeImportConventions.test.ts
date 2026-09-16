import { expect, test } from "bun:test";
import { ESLint } from "eslint";
import type { Linter } from "eslint";

test("源码、脚本与测试均要求独立 import type，并保留 Promise.all 禁用规则", async (): Promise<void> => {
  const eslint: ESLint = new ESLint({
    cwd: `${import.meta.dir}/../..`,
    // 语法夹具不属于项目类型图，只关闭依赖类型信息的规则与解析选项。
    overrideConfig: (await import("typescript-eslint")).default.configs.disableTypeChecked,
  });
  const cases: readonly Readonly<{ source: string; errors: number }>[] = [
    { source: 'import { value, type Shape } from "fixture"; export { value }; export type { Shape };', errors: 1 },
    { source: 'import { type Shape as Alias } from "fixture"; export type { Alias };', errors: 1 },
    { source: 'import { value } from "fixture"; import type { Shape as Alias } from "fixture"; export { value }; export type { Alias };', errors: 0 },
    { source: 'import type * as Shapes from "fixture"; export type { Shapes };', errors: 0 },
    { source: 'import "fixture";', errors: 0 },
    { source: "void Promise.all([]);", errors: 1 },
    { source: "void Promise.allSettled([]);", errors: 0 },
  ];
  for (const filePath of ["packages/typeImportFixture.ts", "scripts/typeImportFixture.ts", "test/typeImportFixture.ts"]) {
    for (const entry of cases) {
      const results: ESLint.LintResult[] = await eslint.lintText(`${entry.source}\n`, { filePath });
      const messages: ESLint.LintResult["messages"] = results[0]!.messages;
      expect(messages.some((message: Linter.LintMessage): boolean => message.fatal === true)).toBeFalse();
      expect(messages.filter((message: Linter.LintMessage): boolean => message.ruleId === "no-restricted-syntax")).toHaveLength(entry.errors);
    }
  }
});
