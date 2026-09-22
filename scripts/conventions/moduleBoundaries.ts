import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { runtimeModuleReferences } from "./sourceAnalysis";

/**
 * 逐文件判定几条「谁能依赖谁」的硬边界：读取环境变量的唯一入口、
 * `packages/states/` 的纯度、`infra` 不得向上依赖业务层，以及全量基准父进程与
 * 非夹具模块的 import 约束。环境变量入口与全量基准 import 约束写在 AGENTS.md，
 * `states/` 纯度与 `infra` 依赖方向见 docs/cn/04-invariants.md；判定细节以本文件
 * 各规则的常量与 JSDoc 为准。
 *
 * 四条规则都只看 AST，不解析模块图：它们约束的是**这一个文件写了什么 import**，
 * 与运行期是否真的走到无关。
 */

/** 逐文件边界规则的公共入参。 */
export interface ModuleBoundaryParams {
  readonly projectRoot: string;
  /** 被检查文件的绝对路径。 */
  readonly path: string;
  /** 该文件唯一一次解析得到的 AST。 */
  readonly source: ts.SourceFile;
}

/** 节点所在行号（1 起）。 */
function lineOf(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

/** 允许读取 `process.env` / `Bun.env` 的两个边界文件，相对仓库根。 */
const ENVIRONMENT_BOUNDARY_FILES: readonly string[] = [
  "packages/consts/paths.ts",
  "packages/consts/environment.ts",
];

/**
 * `process.env` 与 `Bun.env` 的读取边界。
 *
 * 环境变量名集中在 consts/environment.ts，env 派生配置集中在 consts/paths.ts；
 * 任何别处再读一次，部署路径就有了第二个真相来源，而测试的隔离数据根注入只对
 * 那两个文件生效。`Bun.env` 与 `process.env` 指向同一份环境，必须一起拦。
 */
export function collectEnvironmentAccessProblems({
  projectRoot,
  path,
  source,
}: ModuleBoundaryParams): readonly string[] {
  const relativePath: string = relative(projectRoot, path);
  if (ENVIRONMENT_BOUNDARY_FILES.includes(relativePath)) return [];
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "env") {
      const owner: ts.Expression = node.expression;
      const ownerName: string | undefined = ts.isIdentifier(owner) ? owner.text : undefined;
      if (ownerName === "process" || ownerName === "Bun") {
        problems.push(
          `${relativePath}:${lineOf(source, node.getStart(source))} reads ${ownerName}.env; ` +
          `only ${ENVIRONMENT_BOUNDARY_FILES.join(" and ")} may read the environment`
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

/**
 * `packages/states/` 只允许依赖同为叶子的纯模块。
 *
 * 状态机必须是「给定状态与事件就能算出下一状态和效果」的纯函数：一旦它能 import
 * 缓存、infra、config 或任何 Worker 桥，单测就得先把半个进程搭起来，而效果也会
 * 绕过 `{ next, effects }` 直接发生。types 与 consts 是纯声明，libs 是无副作用的
 * 叶子工具，其余一律拒绝。
 */
const STATES_ALLOWED_PREFIXES: readonly string[] = [
  "packages/consts/",
  "packages/libs/",
  "packages/states/",
  "packages/types/",
];

export function collectStatesPurityProblems({
  projectRoot,
  path,
  source,
}: ModuleBoundaryParams): readonly string[] {
  const relativePath: string = relative(projectRoot, path);
  const problems: string[] = [];
  for (const reference of runtimeModuleReferences(source)) {
    if (!reference.specifier.startsWith(".")) continue;
    const target: string = relative(projectRoot, resolve(dirname(path), reference.specifier));
    if (STATES_ALLOWED_PREFIXES.some((prefix: string): boolean => target.startsWith(prefix))) continue;
    problems.push(
      `${relativePath}:${lineOf(source, reference.start)} imports ${target} at runtime; ` +
      "packages/states/ may only depend on consts, libs, types and other states modules"
    );
  }
  return problems;
}

/**
 * `packages/infra/` 不得静态依赖业务层。
 *
 * infra 是命令、AI 与 Anti-Raid 共同依赖的底座；反过来依赖它们会造出文件级运行时
 * 环，并让 infra 的任何一个单测都被迫 mock 掉半个业务层。需要业务能力时由上层在
 * 组合点注入（见 docs/cn/04-invariants.md 的 chat runtime teardown 一节）。
 */
const INFRA_FORBIDDEN_PREFIXES: readonly string[] = [
  "packages/aiChat/",
  "packages/antiRaid/",
  "packages/app/",
  "packages/auto/",
  "packages/commands/",
  "packages/copy/",
  "packages/cron/",
  "packages/translate/",
  "packages/workers/",
];

/**
 * 唯一豁免：`packages/workers/diskIO/diagnosticSink.ts`。
 *
 * 它是一个没有任何依赖的叶子，只包一层 `console.error`；放在 workers/diskIO/ 下
 * 是因为 AGENTS.md 把「packages/ 里允许直接 console.error」的边界划在那个目录，
 * 而主线程的 Disk I/O 宿主恰恰不能改用 logger——logger 会把同一条错误再投给已经
 * 故障的落盘 Worker。新增豁免必须同时改这里与被豁免模块的头注。
 */
const INFRA_LAYERING_EXEMPTIONS: readonly string[] = [
  "packages/workers/diskIO/diagnosticSink.ts",
];

export function collectInfraLayeringProblems({
  projectRoot,
  path,
  source,
}: ModuleBoundaryParams): readonly string[] {
  const relativePath: string = relative(projectRoot, path);
  const problems: string[] = [];
  for (const reference of runtimeModuleReferences(source)) {
    if (!reference.specifier.startsWith(".")) continue;
    const target: string = relative(projectRoot, resolve(dirname(path), reference.specifier));
    const forbidden: string | undefined = INFRA_FORBIDDEN_PREFIXES.find(
      (prefix: string): boolean => target.startsWith(prefix)
    );
    if (forbidden === undefined) continue;
    if (INFRA_LAYERING_EXEMPTIONS.includes(`${target}.ts`)) continue;
    problems.push(
      `${relativePath}:${lineOf(source, reference.start)} imports ${target} at runtime; ` +
      "packages/infra/ must not statically depend on business modules — inject the dependency instead"
    );
  }
  return problems;
}

/**
 * 全量基准的 import 边界。
 *
 * 父进程与非夹具模块只能 import 纯常量与 `import type`：基准报告的读数必须来自
 * 子进程里那次真实运行，父进程一旦把生产实现拉进自己的堆，冷启动与 GC 读数就掺进
 * 了测量代码自己的模块加载。被点名的五个夹具模块是**在子进程里**搭真实环境的那
 * 几份，它们本来就要调生产入口。
 */
const FULL_SUITE_FIXTURE_FILES: readonly string[] = [
  "scripts/perf/fullSuite/chain.ts",
  "scripts/perf/fullSuite/coldStart.ts",
  "scripts/perf/fullSuite/fixture.ts",
  "scripts/perf/fullSuite/seed.ts",
  "scripts/perf/fullSuite/storage.ts",
];

export function collectFullSuiteImportProblems({
  projectRoot,
  path,
  source,
}: ModuleBoundaryParams): readonly string[] {
  const relativePath: string = relative(projectRoot, path);
  const inScope: boolean = relativePath === "scripts/perf/fullSuite.ts" ||
    relativePath.startsWith("scripts/perf/fullSuite/");
  if (!inScope || FULL_SUITE_FIXTURE_FILES.includes(relativePath)) return [];
  const problems: string[] = [];
  for (const reference of runtimeModuleReferences(source)) {
    if (!reference.specifier.startsWith(".")) continue;
    const target: string = relative(projectRoot, resolve(dirname(path), reference.specifier));
    if (!target.startsWith("packages/") || target.startsWith("packages/consts/")) continue;
    problems.push(
      `${relativePath}:${lineOf(source, reference.start)} imports ${target} at runtime; ` +
      "the full-suite parent and non-fixture modules may only import packages/consts/ values or use import type"
    );
  }
  return problems;
}
