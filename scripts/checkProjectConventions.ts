import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";

const PROJECT_ROOT: string = join(import.meta.dir, "..");
const CACHE_ROOT: string = join(PROJECT_ROOT, "src", "cache");
const CONSTS_ROOT: string = join(PROJECT_ROOT, "src", "consts");
const SOURCE_ROOT: string = join(PROJECT_ROOT, "src");

function sourceFilesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path: string = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(path));
    else if (entry.isFile() && extname(entry.name) === ".ts") files.push(path);
  }
  return files;
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function hasJsDoc(node: ts.Node): boolean {
  return ts.getJSDocCommentsAndTags(node).length > 0;
}

function declarationName(node: ts.Node): string {
  if ("name" in node && node.name !== undefined) {
    return (node.name as ts.Node).getText();
  }
  return ts.SyntaxKind[node.kind];
}

const failures: string[] = [];
for (const path of sourceFilesUnder(CACHE_ROOT)) {
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  for (const statement of source.statements) {
    if (!isExported(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      if (hasJsDoc(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        failures.push(`${relative(PROJECT_ROOT, path)}:${source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1} export ${declarationName(declaration)} lacks JSDoc`);
      }
      continue;
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (!hasJsDoc(statement)) {
        failures.push(`${relative(PROJECT_ROOT, path)}:${source.getLineAndCharacterOfPosition(statement.getStart()).line + 1} export ${declarationName(statement)} lacks JSDoc`);
      }
    }
  }
}

for (const path of sourceFilesUnder(CONSTS_ROOT)) {
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      const location: string =
        `${relative(PROJECT_ROOT, path)}:${source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1}`;
      const name: string = declarationName(declaration);
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        failures.push(`${location} constant ${name} is not SCREAMING_SNAKE_CASE`);
      }
      if (declaration.type === undefined) {
        failures.push(`${location} constant ${name} lacks an explicit type`);
      }
      if (!hasJsDoc(statement)) {
        failures.push(`${location} constant ${name} lacks JSDoc`);
      }
    }
  }
}

for (const path of sourceFilesUnder(SOURCE_ROOT)) {
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const modulePath: string = node.moduleSpecifier.text;
      if (
        modulePath.startsWith(".") &&
        (/(^|\/)types$/.test(modulePath) || /(^|\/)types\/index$/.test(modulePath))
      ) {
        failures.push(
          `${relative(PROJECT_ROOT, path)}:` +
          `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
          `production code must import from a domain type module instead of types/index`
        );
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      isExported(node) &&
      node.type === undefined
    ) {
      failures.push(
        `${relative(PROJECT_ROOT, path)}:` +
        `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
        `exported function ${declarationName(node)} lacks an explicit return type`
      );
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (parameter.type !== undefined && ts.isTypeLiteralNode(parameter.type)) {
          failures.push(
            `${relative(PROJECT_ROOT, path)}:` +
            `${source.getLineAndCharacterOfPosition(parameter.getStart()).line + 1} ` +
            `inline object parameter type must be an exported XxxParams interface`
          );
        }
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      if (node.variableDeclaration.type?.kind !== ts.SyntaxKind.UnknownKeyword) {
        failures.push(
          `${relative(PROJECT_ROOT, path)}:` +
          `${source.getLineAndCharacterOfPosition(node.variableDeclaration.getStart()).line + 1} ` +
          `catch binding ${declarationName(node.variableDeclaration)} must be explicitly typed unknown`
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

if (failures.length > 0) {
  console.error(`Project convention check failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Project convention check passed.");
}
