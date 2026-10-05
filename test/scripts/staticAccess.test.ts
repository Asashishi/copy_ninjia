import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { collectEnvironmentAccessProblems } from "../../scripts/conventions/moduleBoundaries";
import type { ModuleBoundaryParams } from "../../scripts/conventions/moduleBoundaries";
import { collectNodeCompatibilityProblems } from "../../scripts/conventions/nodeCompatibility";

const PROJECT_ROOT: string = "/project";
const PACKAGE_PATH: string = `${PROJECT_ROOT}/packages/libs/example.ts`;

function params(text: string, path: string = PACKAGE_PATH): ModuleBoundaryParams {
  return {
    projectRoot: PROJECT_ROOT,
    path,
    source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
}

function nodeProblems(text: string): readonly string[] {
  const input: ModuleBoundaryParams = params(text);
  return collectNodeCompatibilityProblems(input.projectRoot, input.path, input.source);
}

describe("process 原生替换入口的静态访问", () => {
  for (const owner of ["process", "globalThis.process", 'globalThis["process"]', "globalThis[`process`]"]) {
    for (const access of [".argv", '["argv"]', "[`argv`]"]) {
      test(`${owner}${access} 进入同一替换边界`, (): void => {
        expect(nodeProblems(`${owner}${access};`)).toEqual([
          expect.stringContaining("uses process.argv; use Bun.argv"),
        ]);
      });
    }
  }

  for (const statement of [
    "const { argv } = process;",
    "const { argv: args } = globalThis.process;",
    'const { "argv": args } = globalThis["process"];',
    "const { [`argv`]: args } = globalThis[`process`];",
    "function take({ argv } = process) {}",
    "({ argv } = globalThis.process);",
    "({ [`argv`]: args } = process);",
  ]) {
    test(`具名直接解构：${statement}`, (): void => {
      expect(nodeProblems(statement)).toEqual([
        expect.stringContaining("uses process.argv; use Bun.argv"),
      ]);
    });
  }

  test("解构中的多个受控属性逐项报告，execPath 指向参数向量首项", (): void => {
    expect(nodeProblems("const { execPath: executable, hrtime: timer, nextTick: schedule } = globalThis.process;"))
      .toEqual([
        expect.stringContaining("uses process.execPath; use Bun.argv[0]"),
        expect.stringContaining("uses process.hrtime; use Bun.nanoseconds"),
        expect.stringContaining("uses process.nextTick; use queueMicrotask"),
      ]);
  });

  test("括号与类型断言仍然访问同一全局对象", (): void => {
    expect(nodeProblems("((globalThis).process as Process).argv; (process satisfies Process)[`execPath`]; process!.nextTick;"))
      .toEqual([
        expect.stringContaining("uses process.argv; use Bun.argv"),
        expect.stringContaining("uses process.execPath; use Bun.argv[0]"),
        expect.stringContaining("uses process.nextTick; use queueMicrotask"),
      ]);
  });

  test("普通对象、类型位置、合法 Bun 参数与动态属性不属于直接 process 属性", (): void => {
    expect(nodeProblems(
      "options.process.argv; options[`process`][`argv`]; const { argv } = options; " +
      "type Args = typeof globalThis.process.argv; type Shape = { process: { argv: string[] } }; " +
      "Bun.argv; Bun.argv[0]; process.cwd(); process[key]; process[`arg${suffix}`]; " +
      "const { ...rest } = process; const { [key]: dynamic } = process;"
    )).toEqual([]);
  });
});

describe("环境变量读取的静态访问", () => {
  for (const owner of ["process", "Bun"]) {
    for (const reference of [owner, `globalThis.${owner}`, `globalThis["${owner}"]`, `globalThis[\`${owner}\`]`]) {
      for (const access of [".env", '["env"]', "[`env`]"]) {
        test(`${reference}${access} 读取仍受边界约束`, (): void => {
          expect(collectEnvironmentAccessProblems(params(`${reference}${access}.HOME;`)))
            .toEqual([expect.stringContaining(`reads ${owner}.env`)]);
        });
      }
    }
    for (const statement of [
      `const { env } = ${owner};`,
      `const { env: values } = globalThis.${owner};`,
      `const { [\`env\`]: values } = globalThis["${owner}"];`,
      `const { env: { HOME } } = ${owner};`,
      `function take({ env } = ${owner}) {}`,
      `({ env } = globalThis.${owner});`,
      `({ [\`env\`]: values } = ${owner});`,
    ]) {
      test(`具名环境解构：${statement}`, (): void => {
        expect(collectEnvironmentAccessProblems(params(statement)))
          .toEqual([expect.stringContaining(`reads ${owner}.env`)]);
      });
    }
  }

  test("括号与类型断言中的 env 访问仍受边界约束", (): void => {
    expect(collectEnvironmentAccessProblems(params(
      "((globalThis).process as Process)[`env`]; (Bun satisfies BunType).env; (<Process>process).env;"
    ))).toEqual([
      expect.stringContaining("reads process.env"),
      expect.stringContaining("reads Bun.env"),
      expect.stringContaining("reads process.env"),
    ]);
  });

  test("两个合法环境边界放行全部直接访问与解构语法", (): void => {
    const text: string =
      "process[`env`]; globalThis.process.env; Bun[\"env\"]; " +
      "const { env } = globalThis.Bun; ({ env } = globalThis[`process`]);";
    for (const relativePath of ["packages/consts/paths.ts", "packages/consts/environment.ts"]) {
      expect(collectEnvironmentAccessProblems(params(text, `${PROJECT_ROOT}/${relativePath}`))).toEqual([]);
    }
  });

  test("普通对象、类型查询、动态属性与非 env 全局属性不误报", (): void => {
    expect(collectEnvironmentAccessProblems(params(
      "options.env.HOME; options.process.env; options.Bun[`env`]; const { env } = options; " +
      "({ env } = options); const config = { env: {} }; function take({ env } = options) {} " +
      "type ProcessEnv = typeof globalThis.process.env; type BunEnv = typeof Bun.env; " +
      "type Shape = { process: { env: string } }; process.cwd(); Bun.argv; process[key]; " +
      "Bun[`en${suffix}`]; const { ...rest } = Bun; const { [key]: dynamic } = process;"
    ))).toEqual([]);
  });
});
