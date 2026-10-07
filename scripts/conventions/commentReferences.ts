import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type ts from "typescript";

/**
 * 注释里「见 `<模块路径>` 的 `<符号>`」这类交叉引用的核对。
 *
 * 判据只做一件事：被点名的文件里还有没有这个符号（含 `export *` 兼容入口
 * 展开一层后的再导出）。不判断语义是否贴切，也不要求所有引用都写全路径。
 */

/** 只认这几种写法：`<路径>.ts 的 <符号>`、`<路径>.ts 里的 <符号>` 与 `<路径>.ts 中的 <符号>`。 */
const REFERENCE_PATTERN: RegExp =
  /([A-Za-z0-9_./-]+\.ts)\s*(?:里|中)?\s*的\s*`?([A-Za-z_$][A-Za-z0-9_$]*)/g;

/**
 * 不参与核对的引用：注释里写的是常量名前缀而不是完整符号（如
 * `TYPING_DELAY_` 泛指同前缀的一组停顿常量）。
 */
const EXEMPT_SYMBOLS: readonly string[] = ["TYPING_DELAY_"];

/** 把 `export * from "./x"` / `export type * from "./x"` 的目标展开一层。 */
function reexportTargets(path: string, source: string): readonly string[] {
  const targets: string[] = [];
  for (const match of source.matchAll(/export\s+(?:type\s+)?\*\s+from\s+"(\.[^"]+)"/g)) {
    const specifier: string | undefined = match[1];
    if (specifier === undefined) continue;
    const base: string = join(path, "..", specifier);
    for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
      if (existsSync(candidate)) targets.push(candidate);
    }
  }
  return targets;
}

/** 被点名的文件（含一层兼容入口再导出）里是否还有这个符号。 */
async function declaresSymbol(
  path: string,
  symbol: string,
  depth: number = 1
): Promise<boolean> {
  const source: string = await Bun.file(path).text();
  if (new RegExp(`\\b${symbol}\\b`).test(source)) return true;
  if (depth <= 0) return false;
  for (const target of reexportTargets(path, source)) {
    if (await declaresSymbol(target, symbol, depth - 1)) return true;
  }
  return false;
}

export interface CommentReferenceParams {
  readonly projectRoot: string;
  readonly path: string;
  readonly source: ts.SourceFile;
  /** 全仓源文件的绝对路径，用于按 basename 解析未写全的相对引用。 */
  readonly allSourceFiles: readonly string[];
}

/**
 * 把注释里写的模块路径解析成仓库里的真实文件。
 *
 * 引用可能写全（`packages/libs/time.ts`）、写成 packages 内相对路径
 * （`libs/time.ts`），也可能只写文件名。只在能唯一确定目标时才核对，
 * 歧义一律放过。
 */
function resolveReference(
  projectRoot: string,
  specifier: string,
  allSourceFiles: readonly string[]
): string | undefined {
  const direct: string = join(projectRoot, specifier);
  if (existsSync(direct)) return direct;
  const withPackages: string = join(projectRoot, "packages", specifier);
  if (existsSync(withPackages)) return withPackages;
  const suffix: string = `/${specifier}`;
  const matches: readonly string[] = allSourceFiles.filter(
    (file: string): boolean => file.endsWith(suffix)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** 核对一个源文件注释里的全部跨模块符号引用。 */
export async function collectCommentReferenceProblems({
  projectRoot,
  path,
  source,
  allSourceFiles,
}: CommentReferenceParams): Promise<readonly string[]> {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  const lines: readonly string[] = source.getFullText().split("\n");
  for (let index: number = 0; index < lines.length; index += 1) {
    const line: string = lines[index] ?? "";
    const trimmed: string = line.trim();
    const isComment: boolean = trimmed.startsWith("//") ||
      trimmed.startsWith("*") || trimmed.startsWith("/*");
    if (!isComment) continue;
    for (const match of line.matchAll(REFERENCE_PATTERN)) {
      const specifier: string | undefined = match[1];
      const symbol: string | undefined = match[2];
      if (specifier === undefined || symbol === undefined) continue;
      if (EXEMPT_SYMBOLS.includes(symbol)) continue;
      const target: string | undefined = resolveReference(
        projectRoot,
        specifier,
        allSourceFiles
      );
      // 解析不到唯一目标就不判：注释可以引用未随仓库分发的路径。
      if (target === undefined) continue;
      if (await declaresSymbol(target, symbol)) continue;
      problems.push(
        `${relativePath}:${index + 1} comment references ${symbol} in ${specifier}, ` +
        "but that module no longer declares or re-exports it"
      );
    }
  }
  return problems;
}
