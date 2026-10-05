import ts from "typescript";

/** 只解析字符串和无插值模板；计算表达式不参与静态属性识别。 */
function staticString(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

/** 属性访问或具名解构的静态属性名；rest 与动态下标不产生属性名。 */
export function staticPropertyName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return staticString(node.argumentExpression);
  if (ts.isBindingElement(node) && node.dotDotDotToken !== undefined) return undefined;
  if (!ts.isBindingElement(node) && !ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) {
    return undefined;
  }
  const name: ts.PropertyName | ts.BindingName = ts.isBindingElement(node)
    ? node.propertyName ?? node.name
    : node.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return ts.isComputedPropertyName(name) ? staticString(name.expression) : undefined;
}

/** 去掉括号与运行期被擦除的类型标注，不追踪变量别名。 */
function unwrapExpression(node: ts.Node): ts.Node {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
    node = node.expression;
  }
  return node;
}

/** 按名称识别直接全局引用和 globalThis 的静态成员，不解析别名或同名局部绑定。 */
export function isGlobalReference(node: ts.Node, name: string): boolean {
  const reference: ts.Node = unwrapExpression(node);
  if (ts.isIdentifier(reference)) return reference.text === name;
  if (!ts.isPropertyAccessExpression(reference) && !ts.isElementAccessExpression(reference)) return false;
  const owner: ts.Node = unwrapExpression(reference.expression);
  return ts.isIdentifier(owner) && owner.text === "globalThis" && staticPropertyName(reference) === name;
}

/** 类型查询、类型标注及其子节点没有运行期访问。 */
export function isInsideTypeNode(node: ts.Node): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isTypeNode(parent)) return true;
    if (ts.isSourceFile(parent)) return false;
  }
  return false;
}

/**
 * 全局对象的直接运行期属性访问或具名解构；支持声明、参数默认值与解构赋值。
 * 仅识别当前节点，不追踪别名、动态下标或 rest 中隐含的属性。
 */
export function globalPropertyName(node: ts.Node, owner: string): string | undefined {
  if (isInsideTypeNode(node)) return undefined;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return isGlobalReference(node.expression, owner) ? staticPropertyName(node) : undefined;
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const declaration: ts.Node = node.parent.parent;
    if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
      declaration.initializer !== undefined && isGlobalReference(declaration.initializer, owner)) {
      return staticPropertyName(node);
    }
  }
  if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
    ts.isObjectLiteralExpression(node.parent)) {
    const assignment: ts.Node = node.parent.parent;
    if (ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      assignment.left === node.parent && isGlobalReference(assignment.right, owner)) {
      return staticPropertyName(node);
    }
  }
  return undefined;
}
