import { join, relative } from "node:path";
import type ts from "typescript";
import { isRuntimeBuiltinModule } from "./nodeCompatibility";
import { runtimeModuleReferences } from "./sourceAnalysis";

/**
 * 项目源码的运行期裸导入必须由根 `package.json` 直接声明。
 *
 * 只经传递依赖提升到 `node_modules/` 顶层的包（phantom dependency）当前能解析，
 * 但它的存在取决于其它包的依赖声明与安装器布局；这里按 AST 取运行期引用，
 * 纯类型引用、相对路径、Bun 与 Node 内建模块不参与判定，包子路径归到所属包名。
 */

interface RootPackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/** 读取根 manifest 直接声明的包名（`dependencies` 与 `devDependencies`）。 */
export async function readDeclaredPackages(projectRoot: string): Promise<ReadonlySet<string>> {
  const manifest: RootPackageManifest = await Bun.file(join(projectRoot, "package.json")).json() as RootPackageManifest;
  return new Set<string>([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
}

/** 裸说明符所属的包名；相对或绝对路径与运行时内建模块返回 undefined。 */
export function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || isRuntimeBuiltinModule(specifier)) {
    return undefined;
  }
  const segments: readonly string[] = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

/** 单文件依赖声明核对的入参。 */
export interface CollectUndeclaredDependencyProblemsParams {
  readonly projectRoot: string;
  /** 被检查文件的绝对路径。 */
  readonly path: string;
  /** 带父节点指针解析的 AST。 */
  readonly source: ts.SourceFile;
  /** readDeclaredPackages 的结果。 */
  readonly declaredPackages: ReadonlySet<string>;
}

/** 列出一个文件里未由根 manifest 直接声明的运行期包引用。 */
export function collectUndeclaredDependencyProblems({
  projectRoot,
  path,
  source,
  declaredPackages,
}: CollectUndeclaredDependencyProblemsParams): readonly string[] {
  const problems: string[] = [];
  for (const reference of runtimeModuleReferences(source)) {
    const packageName: string | undefined = packageNameOf(reference.specifier);
    if (packageName === undefined || declaredPackages.has(packageName)) continue;
    const line: number = source.getLineAndCharacterOfPosition(reference.start).line + 1;
    problems.push(
      `${relative(projectRoot, path)}:${line} imports ${reference.specifier} at runtime, ` +
      `but ${packageName} is not declared in package.json dependencies or devDependencies`
    );
  }
  return problems;
}
