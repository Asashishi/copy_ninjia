import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

/**
 * 一条 import/export 说明符是不是运行时依赖边。类型专用 import 会被
 * TypeScript 擦掉，不会让目标模块在本线程里求值；副作用 import 永远算。
 */
function isRuntimeModuleEdge(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) return !node.isTypeOnly;
  const clause: ts.ImportClause | undefined = node.importClause;
  if (clause === undefined) return true;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return false;
  if (clause.name !== undefined) return true;
  const bindings: ts.NamedImportBindings | undefined = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return true;
  return bindings.elements.some((element: ts.ImportSpecifier): boolean => !element.isTypeOnly);
}

/** 把相对说明符解析成仓库内的 .ts 文件；解析不到（npm 包等）返回 undefined。 */
function resolveRelativeModule(specifier: string, fromFile: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base: string = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), base]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 本文件在同一条线程内会拉起哪些模块。刻意不跟 `new Worker(new URL(...))`：
 * 那正是线程边界，跟过去会把四条线程的模块图糊成一张。
 */
function runtimeDependencies(path: string): string[] {
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const targets: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isRuntimeModuleEdge(node)
    ) {
      const resolved: string | undefined = resolveRelativeModule(node.moduleSpecifier.text, path);
      if (resolved !== undefined) targets.push(resolved);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const resolved: string | undefined = resolveRelativeModule(node.arguments[0].text, path);
      if (resolved !== undefined) targets.push(resolved);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return targets;
}

/** 本文件会在运行期加载的 npm 包；类型专用 import 不进入结果。 */
export function runtimeExternalDependencies(path: string): string[] {
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const targets: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isRuntimeModuleEdge(node) &&
      !node.moduleSpecifier.text.startsWith(".")
    ) {
      targets.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      !node.arguments[0].text.startsWith(".")
    ) {
      targets.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return targets;
}

/** 从线程入口构建同线程模块闭包，并保留到每个模块的最短引入路径。 */
export function threadModuleClosure(entry: string): Map<string, string[]> {
  const trail: Map<string, string[]> = new Map([[entry, [entry]]]);
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const current: string = queue.shift()!;
    const path: string[] = trail.get(current)!;
    for (const dependency of runtimeDependencies(current)) {
      if (trail.has(dependency)) continue;
      trail.set(dependency, [...path, dependency]);
      queue.push(dependency);
    }
  }
  return trail;
}
