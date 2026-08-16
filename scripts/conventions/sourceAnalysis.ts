import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

/** 递归读取目录下的 TypeScript 源文件。 */
export function sourceFilesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path: string = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(path));
    else if (entry.isFile() && extname(entry.name) === ".ts") files.push(path);
  }
  return files;
}

/** 判断声明是否带有 export 修饰符。 */
export function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier: ts.ModifierLike): boolean => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

/** 判断声明是否带有 JSDoc。 */
export function hasJsDoc(node: ts.Node): boolean {
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

/** 判断表达式是否为 `Object.freeze(...)` 调用。 */
export function isObjectFreezeCall(expression: ts.Expression): boolean {
  return ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.expression.getText() === "Object" &&
    expression.expression.name.text === "freeze";
}

/**
 * 模块顶层 Map/Set 与 holder 都是跨调用长期存活的状态，必须进入带 owner 的
 * packages/cache/。consts 下的 ReadonlySet 是静态查找表，不属于运行时缓存。
 */
export function moduleCacheInitializerKind(expression: ts.Expression): string | null {
  const initializer: ts.Expression = unwrapTypeWrappers(expression);
  if (
    ts.isNewExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    ["Map", "Set", "WeakMap", "WeakSet"].includes(initializer.expression.text)
  ) {
    return initializer.expression.text;
  }
  if (!ts.isObjectLiteralExpression(initializer)) return null;
  const hasCurrent: boolean = initializer.properties.some(
    (property: ts.ObjectLiteralElementLike): boolean =>
      ts.isPropertyAssignment(property) &&
      (
        (ts.isIdentifier(property.name) && property.name.text === "current") ||
        (ts.isStringLiteral(property.name) && property.name.text === "current")
      )
  );
  return hasCurrent ? "holder" : null;
}

/** 判断声明类型是不是只读容器。 */
function isReadonlyContainerTypeNode(type: ts.TypeNode | undefined): boolean {
  if (type === undefined) return false;
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) return true;
  if (ts.isTypeReferenceNode(type)) {
    const READONLY_TYPE_NAMES: readonly string[] = [
      "Readonly", "ReadonlyArray", "ReadonlySet", "ReadonlyMap",
    ];
    return READONLY_TYPE_NAMES.includes(type.typeName.getText());
  }
  return false;
}

/** 判断声明类型是不是裸的可变容器。 */
function isMutableContainerTypeNode(type: ts.TypeNode | undefined): boolean {
  if (type === undefined) return false;
  if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) return true;
  if (ts.isTypeReferenceNode(type)) {
    const MUTABLE_TYPE_NAMES: readonly string[] = ["Record", "Array", "Set", "Map"];
    return MUTABLE_TYPE_NAMES.includes(type.typeName.getText());
  }
  return false;
}

/**
 * 检查共享常量容器是否使用编译期 readonly，且没有运行期 `Object.freeze`。
 * @returns 需要报告的问题描述；没问题则为空数组。
 */
export function collectSharedConstantProblems(
  expression: ts.Expression,
  type: ts.TypeNode | undefined,
  path: string
): string[] {
  const inner: ts.Expression = unwrapTypeWrappers(expression);

  if (isObjectFreezeCall(inner)) {
    return [
      `${path} must not use Object.freeze: shared constants rely on readonly types, ` +
      "and freezing costs an order of magnitude on every read (see AGENTS.md 常量)",
    ];
  }

  const isContainerLiteral: boolean =
    ts.isArrayLiteralExpression(inner) || ts.isObjectLiteralExpression(inner);
  const isContainerCall: boolean =
    (ts.isCallExpression(inner) || ts.isNewExpression(inner)) &&
    (isReadonlyContainerTypeNode(type) || isMutableContainerTypeNode(type));
  if (!isContainerLiteral && !isContainerCall) return [];

  if (!isReadonlyContainerTypeNode(type)) {
    return [
      `${path} is a shared container and must be declared with a readonly type ` +
      "(readonly T[] / Readonly<T> / ReadonlyArray<T> / ReadonlyMap / ReadonlySet)",
    ];
  }
  return [];
}

/** 返回声明名称；匿名声明回退为语法节点名称。 */
export function declarationName(node: ts.Node): string {
  if ("name" in node && node.name !== undefined) {
    return (node.name as ts.Node).getText();
  }
  return ts.SyntaxKind[node.kind];
}
