import { relative } from "node:path";
import ts from "typescript";

/**
 * 测试断言的取值口径（AGENTS.md「测试」）：断言涉及代码常量的取值时必须从常量模块
 * 读取，不得在测试里写死具体值。
 *
 * 机器可判的下界是「把导入的 SCREAMING_SNAKE_CASE 常量直接与数字字面量比对」：
 * `expect(IMPORTED_CONST).toBe(30_000)`、`.toEqual(3 * 60_000)` 这类写法只重复常量的
 * 当前取值，常量改了测试跟着改，不验证任何行为。测试文件自己声明的夹具常量与非数字
 * 取值不在本规则范围内。
 */

/** 逐文件规则的入参。 */
export interface TestAssertionRuleParams {
  readonly projectRoot: string;
  /** 被检查文件的绝对路径。 */
  readonly path: string;
  /** 该文件唯一一次解析得到的 AST。 */
  readonly source: ts.SourceFile;
}

const CONSTANT_NAME_PATTERN: RegExp = /^[A-Z][A-Z0-9_]*$/;
const VALUE_MATCHERS: ReadonlySet<string> = new Set(["toBe", "toEqual", "toStrictEqual"]);

/** 文件内经静态 import 或 `await import(...)` 解构引入的本地绑定名。 */
function importedBindings(source: ts.SourceFile): ReadonlySet<string> {
  const names: Set<string> = new Set();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const bindings: ts.NamedImportBindings | undefined = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.add(element.name.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      ts.isAwaitExpression(node.initializer) &&
      ts.isCallExpression(node.initializer.expression) &&
      node.initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      for (const element of node.name.elements) {
        if (ts.isIdentifier(element.name)) names.add(element.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** 表达式是否只由数字字面量与四则运算组成。 */
function isNumericLiteralExpression(node: ts.Expression): boolean {
  if (ts.isNumericLiteral(node)) return true;
  if (ts.isParenthesizedExpression(node)) return isNumericLiteralExpression(node.expression);
  if (ts.isPrefixUnaryExpression(node)) {
    return node.operator === ts.SyntaxKind.MinusToken && isNumericLiteralExpression(node.operand);
  }
  if (ts.isBinaryExpression(node)) {
    const operator: ts.SyntaxKind = node.operatorToken.kind;
    return (
      operator === ts.SyntaxKind.PlusToken ||
      operator === ts.SyntaxKind.MinusToken ||
      operator === ts.SyntaxKind.AsteriskToken ||
      operator === ts.SyntaxKind.SlashToken
    ) && isNumericLiteralExpression(node.left) && isNumericLiteralExpression(node.right);
  }
  return false;
}

/** 找出把导入常量直接与数字字面量比对的断言。 */
export function collectConstantValueAssertionProblems({
  projectRoot,
  path,
  source,
}: TestAssertionRuleParams): readonly string[] {
  const imported: ReadonlySet<string> = importedBindings(source);
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      VALUE_MATCHERS.has(node.expression.name.text) &&
      node.arguments.length === 1 &&
      isNumericLiteralExpression(node.arguments[0]!)
    ) {
      const subject: ts.Expression = node.expression.expression;
      if (
        ts.isCallExpression(subject) &&
        ts.isIdentifier(subject.expression) &&
        subject.expression.text === "expect" &&
        subject.arguments.length === 1
      ) {
        const actual: ts.Expression = subject.arguments[0]!;
        if (
          ts.isIdentifier(actual) &&
          CONSTANT_NAME_PATTERN.test(actual.text) &&
          imported.has(actual.text)
        ) {
          const line: number = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          problems.push(
            `${relative(projectRoot, path)}:${line} asserts imported constant ${actual.text} ` +
            "against a numeric literal; derive the expectation from the constant module or assert behavior"
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}
