import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { isBuiltin } from "node:module";
import ts from "typescript";

import {
  PORTABLE_NODE_IMPORTS,
  PRODUCTION_BUFFER_GLOBALS,
  PRODUCTION_NODE_IMPORTS,
  SCRIPT_BUFFER_GLOBALS,
  SCRIPT_NODE_IMPORTS,
  SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS,
  TEST_BUFFER_GLOBALS,
  TEST_NODE_IMPORTS,
  TEST_SHARED_NODE_IMPORTS,
  TEST_SYNC_CONTENT_IO_EXEMPTIONS,
} from "./nodeAllowances";
import type { NodeImportAllowance, BufferGlobalAllowance } from "./nodeAllowances";

function allowsImport(
  allowance: NodeImportAllowance | undefined,
  imported: string
): boolean {
  return allowance?.symbols === "*" || allowance?.symbols.includes(imported) === true;
}

/** Bun 自有模块直接放行；Node 内建模块无论是否带前缀都进入同一白名单。 */
function nodeModuleName(name: string): string | undefined {
  if (name.startsWith("node:")) return name;
  if (name === "bun" || name.startsWith("bun:")) return undefined;
  return isBuiltin(name) ? `node:${name}` : undefined;
}

/** Bun 自有模块与 Node 内建模块（含不带前缀的形态）由运行时提供，不属于 npm 依赖。 */
export function isRuntimeBuiltinModule(name: string): boolean {
  return name === "bun" || name.startsWith("bun:") || nodeModuleName(name) !== undefined;
}

/** 属性名仅接收直接属性和字面量下标，不追踪动态表达式或别名。 */
function staticPropertyName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) &&
    (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function isGlobalReference(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name;
  return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    ts.isIdentifier(node.expression) && node.expression.text === "globalThis" &&
    staticPropertyName(node) === name;
}

function runtimeNodeLoad(node: ts.Node): { readonly kind: string; readonly moduleName: string } | undefined {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return undefined;
  const argument: ts.Expression | undefined = node.arguments[0];
  if (
    argument === undefined ||
    !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
  ) {
    return undefined;
  }
  const moduleName: string | undefined = nodeModuleName(argument.text);
  if (moduleName === undefined) return undefined;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return { kind: "dynamic import", moduleName };
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
    return { kind: "require", moduleName };
  }
  if ((ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
    isGlobalReference(node.expression.expression, "process") && staticPropertyName(node.expression) === "getBuiltinModule") {
    return { kind: "process.getBuiltinModule", moduleName };
  }
  return undefined;
}

function isInsideTypeNode(node: ts.Node): boolean {
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined && !ts.isSourceFile(parent)) {
    if (ts.isTypeNode(parent)) return true;
    parent = parent.parent;
  }
  return false;
}

function isBufferGlobalUse(node: ts.Node): boolean {
  if (isInsideTypeNode(node)) return false;
  if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    isGlobalReference(node, "Buffer")) return true;
  if (!ts.isIdentifier(node) || node.text !== "Buffer") return false;
  const parent: ts.Node = node.parent;
  const isImportName: boolean =
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent);
  if (isImportName) return false;
  const isPropertyName: boolean =
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node);
  return !isPropertyName;
}

function bufferGlobalMethod(node: ts.Node): string | undefined {
  const parent: ts.Node = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  ) {
    return staticPropertyName(parent);
  }
  return undefined;
}

function discouragedProcessProperty(node: ts.Node): string | undefined {
  if (!ts.isIdentifier(node) || node.text !== "process" || isInsideTypeNode(node)) return undefined;
  const parent: ts.Node = node.parent;
  const property: string | undefined = ts.isPropertyAccessExpression(parent) && parent.expression === node
    ? parent.name.text
    : ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteral(parent.argumentExpression)
      ? parent.argumentExpression.text
      : undefined;
  return property !== undefined && Object.hasOwn(PROCESS_REPLACEMENTS, property) ? property : undefined;
}

/** 需要原生替换或先核对调度语义的 process 入口。 */
const PROCESS_REPLACEMENTS: Readonly<Record<string, string>> = {
  argv: "Bun.argv",
  execPath: "Bun.argv",
  hrtime: "Bun.nanoseconds() after checking the time origin",
  nextTick: "queueMicrotask after checking scheduling and cancellation semantics",
};

/**
 * 核对生产模块、脚本或测试文件的 Node 兼容 import。未登记模块、namespace/default
 * import 与未登记符号都拒绝；第三方依赖不进入本检查。
 */
export function collectNodeCompatibilityProblems(
  projectRoot: string,
  path: string,
  source: ts.SourceFile
): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  const isScript: boolean = relativePath.startsWith("scripts/");
  const isTest: boolean = relativePath.startsWith("test/");
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) continue;
    const moduleName: string | undefined = nodeModuleName(statement.moduleSpecifier.text);
    if (moduleName === undefined) continue;
    const allowed: NodeImportAllowance | undefined = PORTABLE_NODE_IMPORTS[moduleName] ?? (isScript
      ? SCRIPT_NODE_IMPORTS[moduleName]
      : isTest
        ? TEST_NODE_IMPORTS[relativePath]?.[moduleName]
        : PRODUCTION_NODE_IMPORTS[relativePath]?.[moduleName]);
    const extraAllowed: NodeImportAllowance | undefined = isTest
      ? TEST_SHARED_NODE_IMPORTS[moduleName]
      : undefined;
    const line: number = source.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
    const location: string = `${relativePath}:${line}`;
    const clause: ts.ImportClause | undefined = statement.importClause;
    if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
    if (clause?.name === undefined && clause?.namedBindings !== undefined &&
      ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((element: ts.ImportSpecifier): boolean => element.isTypeOnly)) continue;
    if (allowed === undefined && extraAllowed === undefined) {
      problems.push(`${location} uses unreviewed Node compatibility module ${moduleName}`);
      continue;
    }
    if (
      clause === undefined ||
      allowed?.symbols === "*"
    ) continue;
    if (clause.name !== undefined || clause.namedBindings === undefined) {
      problems.push(`${location} must use reviewed named imports from ${moduleName}`);
      continue;
    }
    if (ts.isNamespaceImport(clause.namedBindings)) {
      problems.push(`${location} must not namespace-import ${moduleName}`);
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const imported: string = element.propertyName?.text ?? element.name.text;
      const contentIoAllowance: NodeImportAllowance | undefined = isScript
        ? SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS[relativePath]?.[moduleName]
        : isTest
          ? TEST_SYNC_CONTENT_IO_EXEMPTIONS[relativePath]?.[moduleName]
          : undefined;
      const isSynchronousContentIo: boolean = moduleName === "node:fs" &&
        (imported === "readFileSync" || imported === "writeFileSync");
      const permitted: boolean = isSynchronousContentIo && (isScript || isTest)
        ? allowsImport(contentIoAllowance, imported)
        : allowsImport(allowed, imported) || allowsImport(extraAllowed, imported);
      if (!permitted) {
        problems.push(`${location} uses unreviewed ${moduleName} export ${imported}`);
      }
    }
  }

  const visitRuntimeNodeLoads = (node: ts.Node): void => {
    const load: { readonly kind: string; readonly moduleName: string } | undefined =
      runtimeNodeLoad(node);
    if (load !== undefined) {
      const line: number = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      problems.push(
        `${relativePath}:${line} uses unreviewed runtime ${load.kind} of ${load.moduleName}; ` +
        "use reviewed static named imports"
      );
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly &&
      !(node.exportClause !== undefined && ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((element: ts.ExportSpecifier): boolean => element.isTypeOnly)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName: string | undefined = nodeModuleName(node.moduleSpecifier.text);
      if (moduleName !== undefined) {
        problems.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
          `uses unreviewed runtime re-export of ${moduleName}; use reviewed static named imports`);
      }
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression !== undefined &&
      ts.isStringLiteral(node.moduleReference.expression)) {
      const moduleName: string | undefined = nodeModuleName(node.moduleReference.expression.text);
      if (moduleName !== undefined) {
        problems.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
          `uses unreviewed runtime require of ${moduleName}; use reviewed static named imports`);
      }
    }
    ts.forEachChild(node, visitRuntimeNodeLoads);
  };
  visitRuntimeNodeLoads(source);

  let usesBufferGlobal: boolean = false;
  const bufferAllowance: BufferGlobalAllowance | undefined = isScript
    ? SCRIPT_BUFFER_GLOBALS[relativePath]
    : isTest
      ? TEST_BUFFER_GLOBALS[relativePath]
      : PRODUCTION_BUFFER_GLOBALS[relativePath];
  const visitBufferGlobal = (node: ts.Node): void => {
    if (isBufferGlobalUse(node)) {
      usesBufferGlobal = true;
      const method: string | undefined = bufferGlobalMethod(node);
      if (bufferAllowance === undefined || method === undefined || !bufferAllowance.methods.includes(method)) {
        const line: number = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        problems.push(
          `${relativePath}:${line} uses unreviewed Node compatibility global Buffer` +
          (method === undefined ? "" : `.${method}`)
        );
      }
    }
    ts.forEachChild(node, visitBufferGlobal);
  };
  visitBufferGlobal(source);
  if (bufferAllowance !== undefined && !usesBufferGlobal) {
    problems.push(
      `${relativePath}:1 retains a stale Node compatibility global Buffer allowance`
    );
  }

  const visitDiscouragedProcessProperties = (node: ts.Node): void => {
    const property: string | undefined = discouragedProcessProperty(node);
    if (property !== undefined) {
      const line: number = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      problems.push(
        `${relativePath}:${line} uses process.${property}; use ${PROCESS_REPLACEMENTS[property]}`
      );
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined && ts.isIdentifier(node.initializer) && node.initializer.text === "process") {
      for (const element of node.name.elements) {
        const name: ts.PropertyName | ts.BindingName = element.propertyName ?? element.name;
        if ((!ts.isIdentifier(name) && !ts.isStringLiteral(name)) || !(Object.hasOwn(PROCESS_REPLACEMENTS, name.text))) continue;
        problems.push(`${relativePath}:${source.getLineAndCharacterOfPosition(element.getStart()).line + 1} ` +
          `uses process.${name.text}; use ${PROCESS_REPLACEMENTS[name.text]}`);
      }
    }
    ts.forEachChild(node, visitDiscouragedProcessProperties);
  };
  visitDiscouragedProcessProperties(source);
  return problems;
}

/**
 * 逐文件登记表里指向**已不存在文件**的条目。
 *
 * `collectNodeCompatibilityProblems` 只在遍历到某个文件时才查它的登记，文件一旦删除，
 * 它留下的登记就再也不会被访问到，会作为一条永不过期的豁免留在表里。本函数在逐文件
 * 遍历之外整表核对一次路径存在性，七张逐文件登记表各查一遍。
 */
export function collectStaleNodeAllowanceProblems(
  projectRoot: string
): readonly string[] {
  const problems: string[] = [];
  const tables: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
    ["PRODUCTION_NODE_IMPORTS", PRODUCTION_NODE_IMPORTS],
    ["SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS", SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS],
    ["PRODUCTION_BUFFER_GLOBALS", PRODUCTION_BUFFER_GLOBALS],
    ["SCRIPT_BUFFER_GLOBALS", SCRIPT_BUFFER_GLOBALS],
    ["TEST_NODE_IMPORTS", TEST_NODE_IMPORTS],
    ["TEST_SYNC_CONTENT_IO_EXEMPTIONS", TEST_SYNC_CONTENT_IO_EXEMPTIONS],
    ["TEST_BUFFER_GLOBALS", TEST_BUFFER_GLOBALS],
  ];
  for (const [table, entries] of tables) {
    for (const relativePath of Object.keys(entries)) {
      if (!existsSync(join(projectRoot, relativePath))) {
        problems.push(
          `${table} retains an allowance for a file that no longer exists: ${relativePath}`
        );
      }
    }
  }
  return problems;
}

/** 一处真实存在的 Node 兼容具名 import；逐文件遍历时顺带记下，供反向核对。 */
export interface NodeImportUsage {
  /** 相对仓库根的文件路径。 */
  readonly relativePath: string;
  readonly moduleName: string;
  readonly imported: string;
}

/**
 * 收集一个文件里全部运行期 Node 兼容具名 import。
 *
 * 与 collectNodeCompatibilityProblems 共用同一份 AST：前者判「用到的是否登记过」，
 * 本函数供 collectUnusedNodeAllowanceProblems 判反方向的「登记的是否还在用」。
 */
export function collectNodeImportUsage(
  projectRoot: string,
  path: string,
  source: ts.SourceFile
): readonly NodeImportUsage[] {
  const relativePath: string = relative(projectRoot, path);
  const usage: NodeImportUsage[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName: string | undefined = nodeModuleName(statement.moduleSpecifier.text);
    if (moduleName === undefined) continue;
    const clause: ts.ImportClause | undefined = statement.importClause;
    if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
    const bindings: ts.NamedImportBindings | undefined = clause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      // 命名空间 import 只在 `symbols: "*"` 下被允许；记成同一个通配名即可。
      usage.push({ relativePath, moduleName, imported: "*" });
      continue;
    }
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      usage.push({ relativePath, moduleName, imported: (element.propertyName ?? element.name).text });
    }
  }
  return usage;
}

/** 反向核对的作用域：登记条目只在这一类文件里才可能被用到。 */
type AllowanceScope = "script" | "test" | "any" | "production";

function inScope(relativePath: string, scope: AllowanceScope): boolean {
  const isScript: boolean = relativePath.startsWith("scripts/");
  const isTest: boolean = relativePath.startsWith("test/");
  if (scope === "script") return isScript;
  if (scope === "test") return isTest;
  if (scope === "any") return true;
  return !isScript && !isTest;
}

/**
 * 登记表里已经没人再用的条目。
 *
 * 正向检查只在遍历到某个文件时才查它的登记，因此「某个符号已经不再被 import」永远
 * 不会报出来——豁免于是只增不减，下一个人看到表里有它就以为这是被审过、仍然必要的
 * 用法。共享表（PORTABLE/SCRIPT/TEST_SHARED）按作用域核对符号是否还有使用者；
 * 逐文件表额外核对该文件是否真的还 import 这个模块与这些符号。
 *
 * 路径已经消失的条目由 collectStaleNodeAllowanceProblems 报，这里不重复。
 */
export function collectUnusedNodeAllowanceProblems(
  usage: readonly NodeImportUsage[]
): readonly string[] {
  const problems: string[] = [];
  const shared: readonly (readonly [string, Readonly<Record<string, NodeImportAllowance>>, AllowanceScope])[] = [
    ["PORTABLE_NODE_IMPORTS", PORTABLE_NODE_IMPORTS, "any"],
    ["SCRIPT_NODE_IMPORTS", SCRIPT_NODE_IMPORTS, "script"],
    ["TEST_SHARED_NODE_IMPORTS", TEST_SHARED_NODE_IMPORTS, "test"],
  ];
  for (const [table, entries, scope] of shared) {
    for (const [moduleName, allowance] of Object.entries(entries)) {
      const used: readonly NodeImportUsage[] = usage.filter(
        (entry: NodeImportUsage): boolean =>
          entry.moduleName === moduleName && inScope(entry.relativePath, scope)
      );
      if (allowance.symbols === "*") {
        if (used.length === 0) problems.push(`${table} retains an unused allowance for ${moduleName}`);
        continue;
      }
      for (const symbol of allowance.symbols) {
        if (used.some((entry: NodeImportUsage): boolean => entry.imported === symbol)) continue;
        problems.push(`${table} retains an unused allowance: ${moduleName} export ${symbol}`);
      }
    }
  }
  const perFile: readonly (readonly [string, Readonly<Record<string, Readonly<Record<string, NodeImportAllowance>>>>])[] = [
    ["PRODUCTION_NODE_IMPORTS", PRODUCTION_NODE_IMPORTS],
    ["TEST_NODE_IMPORTS", TEST_NODE_IMPORTS],
    ["SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS", SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS],
    ["TEST_SYNC_CONTENT_IO_EXEMPTIONS", TEST_SYNC_CONTENT_IO_EXEMPTIONS],
  ];
  for (const [table, entries] of perFile) {
    for (const [relativePath, modules] of Object.entries(entries)) {
      for (const [moduleName, allowance] of Object.entries(modules)) {
        const used: readonly NodeImportUsage[] = usage.filter(
          (entry: NodeImportUsage): boolean =>
            entry.relativePath === relativePath && entry.moduleName === moduleName
        );
        if (allowance.symbols === "*") {
          if (used.length === 0) {
            problems.push(`${table} retains an unused allowance for ${relativePath}: ${moduleName}`);
          }
          continue;
        }
        for (const symbol of allowance.symbols) {
          if (used.some((entry: NodeImportUsage): boolean => entry.imported === symbol)) continue;
          problems.push(`${table} retains an unused allowance for ${relativePath}: ${moduleName} export ${symbol}`);
        }
      }
    }
  }
  return problems;
}
