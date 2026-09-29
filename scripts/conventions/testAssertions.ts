import { relative } from "node:path";
import ts from "typescript";

/**
 * 测试断言的取值口径（AGENTS.md「测试」）：断言涉及代码常量的取值时必须从常量模块
 * 读取，不得在测试里写死具体值。机器可判的下界有两条：
 *
 * - 「把导入的 SCREAMING_SNAKE_CASE 常量直接与数字字面量比对」：
 *   `expect(IMPORTED_CONST).toBe(30_000)`、`.toEqual(3 * 60_000)` 这类写法只重复常量的
 *   当前取值，常量改了测试跟着改，不验证任何行为（collectConstantValueAssertionProblems）。
 * - 「匹配器实参里写出与 packages/consts 导出字符串常量逐字相同的字面量」：常量的文案
 *   一改，断言要么跟着手改、要么红得与行为无关（collectStringConstantAssertionProblems）。
 *   同一字面量在本文件匹配器实参之外出现过（测试自造的夹具输入，断言只是核对它原样
 *   透传）时不算，短于 STRING_CONSTANT_MIN_LENGTH 的常量不参与比对。
 *
 * 测试文件自己声明的夹具常量不在本规则范围内。
 */

/** 逐文件规则的入参。 */
export interface TestAssertionRuleParams {
  readonly projectRoot: string;
  /** 被检查文件的绝对路径。 */
  readonly path: string;
  /** 该文件唯一一次解析得到的 AST。 */
  readonly source: ts.SourceFile;
}

/** 字符串常量规则的入参：逐文件入参外加 packages/consts 的字符串常量表。 */
export interface StringConstantAssertionRuleParams extends TestAssertionRuleParams {
  /** 常量取值 → 取这个值的全部导出常量名（见 collectExportedStringConstants）。 */
  readonly constants: ReadonlyMap<string, readonly string[]>;
}

const CONSTANT_NAME_PATTERN: RegExp = /^[A-Z][A-Z0-9_]*$/;
const VALUE_MATCHERS: ReadonlySet<string> = new Set(["toBe", "toEqual", "toStrictEqual"]);

/**
 * 参与字符串常量比对的最短取值长度。更短的取值（"user"、"text" 这类）与夹具、协议字段
 * 天然重名，逐字相同说明不了断言在重复常量。
 */
const STRING_CONSTANT_MIN_LENGTH: number = 8;

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

/** 字符串字面量、无插值模板或它们的 `+` 拼接在编译期的取值；其余表达式为 undefined。 */
function staticStringValue(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticStringValue(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left: string | undefined = staticStringValue(node.left);
    const right: string | undefined = staticStringValue(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

/**
 * 收集一个 packages/consts 文件导出的字符串常量（取值不短于 STRING_CONSTANT_MIN_LENGTH），
 * 并入调用方的「取值 → 常量名」表；同值的多个常量都记下。
 */
export function collectExportedStringConstants(
  source: ts.SourceFile,
  constants: Map<string, string[]>
): void {
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      statement.modifiers?.some((modifier: ts.ModifierLike): boolean => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true
    ) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      const value: string | undefined = staticStringValue(declaration.initializer);
      if (value === undefined || value.length < STRING_CONSTANT_MIN_LENGTH) continue;
      const names: string[] | undefined = constants.get(value);
      if (names === undefined) constants.set(value, [declaration.name.text]);
      else names.push(declaration.name.text);
    }
  }
}

/** 表达式是否是以 `expect(...)` 起头的属性链（`expect(a).not`、`expect(a).resolves` 等）。 */
function isExpectChain(node: ts.Expression): boolean {
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === "expect";
}

/** 调用是否是匹配器调用：被调者是 `expect(...)` 属性链上的一个方法。 */
function isMatcherCall(node: ts.Node): node is ts.CallExpression & { readonly expression: ts.PropertyAccessExpression } {
  return ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    isExpectChain(node.expression.expression);
}

function isStringLiteralNode(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** 匹配器实参之外出现的全部字符串字面量取值：测试自造的夹具输入。 */
function fixtureLiterals(source: ts.SourceFile): ReadonlySet<string> {
  const literals: Set<string> = new Set();
  const visit = (node: ts.Node): void => {
    if (isMatcherCall(node)) {
      visit(node.expression);
      return;
    }
    if (isStringLiteralNode(node)) literals.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return literals;
}

/** 找出匹配器实参里与 packages/consts 字符串常量逐字相同、又不是本文件夹具的字面量。 */
export function collectStringConstantAssertionProblems({
  projectRoot,
  path,
  source,
  constants,
}: StringConstantAssertionRuleParams): readonly string[] {
  const fixtures: ReadonlySet<string> = fixtureLiterals(source);
  const problems: string[] = [];
  const inspectArgument = (node: ts.Node): void => {
    if (isStringLiteralNode(node) && !fixtures.has(node.text)) {
      const names: readonly string[] | undefined = constants.get(node.text);
      if (names !== undefined) {
        const line: number = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        problems.push(
          `${relative(projectRoot, path)}:${line} asserts a string literal equal to ${names.join(" / ")}; ` +
          "import the constant or assert behavior"
        );
      }
    }
    ts.forEachChild(node, inspectArgument);
  };
  const visit = (node: ts.Node): void => {
    if (isMatcherCall(node)) {
      for (const argument of node.arguments) inspectArgument(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}
