import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";

const PROJECT_ROOT: string = join(import.meta.dir, "..");
const CACHE_ROOT: string = join(PROJECT_ROOT, "packages", "cache");
const CONSTS_ROOT: string = join(PROJECT_ROOT, "packages", "consts");
const SOURCE_ROOT: string = join(PROJECT_ROOT, "packages");

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

/** 剥掉 `as const` / `satisfies T` / 多余括号，拿到真正的初始化表达式。 */
function unwrapTypeWrappers(expression: ts.Expression): ts.Expression {
  let current: ts.Expression = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isObjectFreezeCall(expression: ts.Expression): boolean {
  return ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.expression.getText() === "Object" &&
    expression.expression.name.text === "freeze";
}

/**
 * 声明类型是不是「容器」。用于判断一个非 Object.freeze 的调用结果该不该被要求
 * 冻结：`Math.ceil(...)` 返回 number，不该管；`buildList()` 声明成 readonly T[]
 * 就该管——它返回的是一份全新的可变数组。
 */
function isContainerTypeNode(type: ts.TypeNode | undefined): boolean {
  if (type === undefined) return false;
  if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) return true;
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) return true;
  if (ts.isTypeReferenceNode(type)) {
    // 刻意不含 Map/Set：Object.freeze 只冻结自有属性，Map/Set 的数据放在内部
    // 槽里，冻完 .add()/.set() 照样能改。对它们要求冻结等于要求一个无效动作。
    const CONTAINER_TYPE_NAMES: readonly string[] = ["Readonly", "ReadonlyArray", "Record", "Array"];
    return CONTAINER_TYPE_NAMES.includes(type.typeName.getText());
  }
  return false;
}

/**
 * AGENTS.md 要求「跨调用方共享的对象常量 Object.freeze」。只认数组/对象字面量：
 * RegExp、`new X()` 与派生的标量计算不在此列——冻结正则会把 lastIndex 变成只读，
 * 对带 /g 的正则反而是引入 bug。
 *
 * Object.freeze 是浅冻结，因此还要递归进已冻结容器的元素/属性值：`BOT_COMMANDS`
 * 那样的数组，外层冻了但每一项仍可被就地改写。
 * @returns 需要报告的问题描述；没问题则为空数组。
 */
function collectUnfrozenLiterals(expression: ts.Expression, path: string): string[] {
  const inner: ts.Expression = unwrapTypeWrappers(expression);

  if (ts.isArrayLiteralExpression(inner) || ts.isObjectLiteralExpression(inner)) {
    return [`${path} is a shared container literal and must be wrapped in Object.freeze`];
  }

  if (isObjectFreezeCall(inner)) {
    const frozen: ts.Expression | undefined = (inner as ts.CallExpression).arguments[0];
    if (frozen === undefined) return [];
    const target: ts.Expression = unwrapTypeWrappers(frozen);
    if (ts.isArrayLiteralExpression(target)) {
      return target.elements.flatMap((element: ts.Expression, index: number): string[] =>
        collectUnfrozenLiterals(element, `${path}[${index}]`));
    }
    if (ts.isObjectLiteralExpression(target)) {
      return target.properties.flatMap((property: ts.ObjectLiteralElementLike): string[] =>
        ts.isPropertyAssignment(property)
          ? collectUnfrozenLiterals(property.initializer, `${path}.${property.name.getText()}`)
          : []);
    }
    return [];
  }

  return [];
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
      if (isExported(statement) && declaration.initializer !== undefined) {
        for (const problem of collectUnfrozenLiterals(declaration.initializer, `constant ${name}`)) {
          failures.push(`${location} ${problem}`);
        }
        // 声明成容器类型、却由 Object.freeze 之外的调用产出：静态看不出返回的是不是
        // 新的可变容器，一律要求显式冻结，别让「看起来只读」的类型标注糊弄过去。
        const initializer: ts.Expression = unwrapTypeWrappers(declaration.initializer);
        if (
          isContainerTypeNode(declaration.type) &&
          (ts.isCallExpression(initializer) || ts.isNewExpression(initializer)) &&
          !isObjectFreezeCall(initializer)
        ) {
          failures.push(`${location} constant ${name} is a shared container built by a call and must be wrapped in Object.freeze`);
        }
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
