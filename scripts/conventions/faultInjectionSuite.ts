import { existsSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { sourceFilesUnder } from "./sourceAnalysis";

/**
 * `bun run test:fault-injection` 的清单必须覆盖全部持久化 / 停机 / Worker 生命周期用例。
 *
 * 清单手工维护在 `package.json` 里，而它就是这套套件的唯一权威（三份
 * `05-dev-workflow.md` 都写「完整清单见 package.json 的脚本定义」）。漏登记不会让任何
 * 门禁变红，套件却在无声中变窄——合入前跑的那一套不再覆盖新写的落盘或重建用例。
 *
 * 本模块按**测试 harness 归属**给出机器可判的下界：凡 import 下面这几个 harness 的
 * 用例文件都必须出现在清单里。harness 是可靠信号——它们各自装配的正是落盘、启动恢复
 * 与 Worker 重建的替身。归属按**解析后的路径**判定，因此用例文件改名或换目录都照样
 * 认得出来，而同名不同目录的模块不会被误判。
 *
 * 判定只做下界，不禁止清单里出现别的文件：不依赖 harness 的故障注入用例（例如
 * readiness mock 整文件生效的那种）同样该进清单，但没有机器可判的特征，仍由维护者
 * 按 AGENTS.md 的「涉及持久化、停机或 Worker 生命周期」自行判断。
 */

/** 受约束的 harness：模块路径，以及它的使用者为什么属于这套套件。 */
interface FaultInjectionHarness {
  /** 仓库相对路径；缺失即判失败，避免改名后判定静默失效。 */
  readonly path: string;
  /** 该 harness 装配的故障面，用于失败文案。 */
  readonly purpose: string;
}

interface ProjectPackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

/**
 * 判定所依据的 harness 清单。
 *
 * 只收「主题就是持久化 / 停机 / Worker 生命周期」的那几个。刻意不收
 * `verificationEffectsHarness`（验证副作用解释器，主题是踢人与删消息）和
 * `adDetectQueueHarness`（广告判定队列随 isolate 生死、主线程不做镜像，见
 * `packages/cache/workers/antiRaid/adDetect.ts` 的模块头注）：它们不落盘，
 * 进这套套件只会拖长发布前的必跑面而换不到恢复能力。
 */
const FAULT_INJECTION_HARNESSES: readonly FaultInjectionHarness[] = [
  {
    path: "test/helpers/diskIOWorkerHarness.ts",
    purpose: "Disk I/O Worker initialization, backpressure, diagnostic restart and give-up",
  },
  {
    path: "test/helpers/antiRaidMirrorHarness.ts",
    purpose: "Anti-Raid main-thread mirror durability barriers and rebuild recovery",
  },
  {
    path: "test/helpers/blocklistSweepHarness.ts",
    purpose: "blocklist sweep and removal-outbox startup recovery and write-off",
  },
  {
    path: "test/helpers/lifecycleFixture.ts",
    purpose: "application startup and shutdown lifecycle failure injection",
  },
];

/** 静态字符串字面量说明符；模板与动态表达式不参与判定。 */
function literalSpecifier(node: ts.Expression | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/**
 * 取出一个模块里全部模块说明符。
 *
 * 必须同时认静态 `import`/`export … from` 与 `await import("x")`：这批用例里有一半是
 * 先装 `mock.module` 再 `const { … } = await import("../helpers/…")`，只认静态
 * `from` 的话正是漏掉它们。
 *
 * 走 AST 而不是正则：门禁自己的用例文件里就把 harness 路径当**字符串字面量**写在
 * 夹具内容里，按正文扫会把那些夹具误判成真的 import。
 */
function importSpecifiers(source: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier: string | undefined = literalSpecifier(node.moduleSpecifier);
      if (specifier !== undefined) specifiers.push(specifier);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const specifier: string | undefined = literalSpecifier(node.arguments[0]);
      if (specifier !== undefined) specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/**
 * 相对说明符解析成绝对 `.ts` 路径，供与 harness 的真实路径比对。
 *
 * 按**路径**而不是按基名比对：同名不同目录的模块不该被误判成 harness。裸说明符
 * （`bun:test`、`grammy/types`）返回 undefined，直接跳过。
 */
function resolvedSpecifierPath(importerPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const resolved: string = resolve(dirname(importerPath), specifier);
  return extname(resolved) === ".ts" ? resolved : `${resolved}.ts`;
}

/** 核对清单里声明的每条路径都真实存在且只出现一次。 */
function collectListedPathProblems(
  projectRoot: string,
  listed: readonly string[]
): readonly string[] {
  const problems: string[] = [];
  const seen: Set<string> = new Set<string>();
  for (const path of listed) {
    if (seen.has(path)) problems.push(`test:fault-injection lists ${path} more than once`);
    seen.add(path);
    if (!existsSync(join(projectRoot, path))) {
      problems.push(`test:fault-injection lists a file that does not exist: ${path}`);
    }
  }
  return problems;
}

/**
 * 核对 `test:fault-injection` 的清单：声明的路径都存在且不重复，且每个使用受约束
 * harness 的用例文件都已登记。
 */
export async function collectFaultInjectionSuiteProblems(
  projectRoot: string
): Promise<readonly string[]> {
  const manifest: ProjectPackageJson = JSON.parse(
    await Bun.file(join(projectRoot, "package.json")).text()
  ) as ProjectPackageJson;
  const command: string | undefined = manifest.scripts?.["test:fault-injection"];
  if (command === undefined) {
    return ["package.json must define the test:fault-injection script"];
  }
  const listed: readonly string[] = command.split(/\s+/).filter(
    (token: string): boolean => token.endsWith(".test.ts")
  );
  const problems: string[] = [...collectListedPathProblems(projectRoot, listed)];
  const listedSet: ReadonlySet<string> = new Set<string>(listed);
  const requiredModules: Map<string, FaultInjectionHarness> = new Map();
  for (const harness of FAULT_INJECTION_HARNESSES) {
    const harnessPath: string = join(projectRoot, harness.path);
    if (!existsSync(harnessPath)) {
      problems.push(`declared fault-injection harness does not exist: ${harness.path}`);
      continue;
    }
    requiredModules.set(harnessPath, harness);
  }
  const testRoot: string = join(projectRoot, "test");
  if (!existsSync(testRoot)) {
    problems.push("test directory does not exist; the fault-injection suite cannot be verified");
    return problems;
  }
  for (const path of sourceFilesUnder(testRoot)) {
    if (!path.endsWith(".test.ts")) continue;
    const relativePath: string = relative(projectRoot, path);
    if (listedSet.has(relativePath)) continue;
    const source: ts.SourceFile = ts.createSourceFile(
      path,
      await Bun.file(path).text(),
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS
    );
    for (const specifier of importSpecifiers(source)) {
      const resolved: string | undefined = resolvedSpecifierPath(path, specifier);
      if (resolved === undefined) continue;
      const harness: FaultInjectionHarness | undefined = requiredModules.get(resolved);
      if (harness === undefined) continue;
      problems.push(
        `${relativePath} uses ${harness.path} (${harness.purpose}) ` +
        "but is missing from the test:fault-injection script"
      );
      break;
    }
  }
  return problems;
}
