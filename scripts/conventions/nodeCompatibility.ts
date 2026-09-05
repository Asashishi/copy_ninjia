import { relative } from "node:path";
import { isBuiltin } from "node:module";
import ts from "typescript";

import {
  SCRIPT_NODE_IMPORTS,
  PRODUCTION_NODE_IMPORTS,
  PRODUCTION_BUFFER_GLOBALS,
  SCRIPT_BUFFER_GLOBALS,
  SCRIPT_ONLY_NODE_IMPORTS,
  SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS,
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

function runtimeNodeLoad(node: ts.Node): { readonly kind: "dynamic import" | "require"; readonly moduleName: string } | undefined {
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
  if (!ts.isIdentifier(node) || node.text !== "Buffer") return false;
  const parent: ts.Node = node.parent;
  if (isInsideTypeNode(node)) return false;
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

function bufferGlobalMethod(node: ts.Identifier): string | undefined {
  const parent: ts.Node = node.parent;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node
  ) {
    return parent.name.text;
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
 * 核对一个生产模块的 Node 兼容 import。未登记模块、namespace/default import 与
 * 未登记符号都拒绝；第三方依赖和测试文件不进入本检查。
 */
export function collectNodeCompatibilityProblems(
  projectRoot: string,
  path: string,
  source: ts.SourceFile
): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  const isScript: boolean = relativePath.startsWith("scripts/");
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) continue;
    const moduleName: string | undefined = nodeModuleName(statement.moduleSpecifier.text);
    if (moduleName === undefined) continue;
    const allowed: NodeImportAllowance | undefined = moduleName === "node:path"
      ? SCRIPT_NODE_IMPORTS[moduleName]
      : isScript
        ? SCRIPT_NODE_IMPORTS[moduleName]
        : PRODUCTION_NODE_IMPORTS[relativePath]?.[moduleName];
    const scriptAllowed: NodeImportAllowance | undefined = isScript
      ? SCRIPT_ONLY_NODE_IMPORTS[moduleName]
      : undefined;
    const line: number = source.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
    const location: string = `${relativePath}:${line}`;
    const clause: ts.ImportClause | undefined = statement.importClause;
    if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
    if (clause?.name === undefined && clause?.namedBindings !== undefined &&
      ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((element: ts.ImportSpecifier): boolean => element.isTypeOnly)) continue;
    if (allowed === undefined && scriptAllowed === undefined) {
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
        : undefined;
      const isSynchronousContentIo: boolean = moduleName === "node:fs" &&
        (imported === "readFileSync" || imported === "writeFileSync");
      const permitted: boolean = isSynchronousContentIo && isScript
        ? allowsImport(contentIoAllowance, imported)
        : allowsImport(allowed, imported) || allowsImport(scriptAllowed, imported);
      if (!permitted) {
        problems.push(`${location} uses unreviewed ${moduleName} export ${imported}`);
      }
    }
  }

  const visitRuntimeNodeLoads = (node: ts.Node): void => {
    const load: { readonly kind: "dynamic import" | "require"; readonly moduleName: string } | undefined =
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
    : PRODUCTION_BUFFER_GLOBALS[relativePath];
  const visitBufferGlobal = (node: ts.Node): void => {
    if (isBufferGlobalUse(node)) {
      usesBufferGlobal = true;
      const method: string | undefined = bufferGlobalMethod(node as ts.Identifier);
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
