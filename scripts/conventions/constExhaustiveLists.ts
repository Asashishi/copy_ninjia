import { relative } from "node:path";
import ts from "typescript";
import type { ExportedConstDeclaration } from "./constsProgram";

/**
 * 有意只列字面量联合子集的导出数组表：`<相对路径>#<表名>` → 为什么不是全集。登记的表不要求经
 * exhaustiveList 构造；表已删除、改用 exhaustiveList 或元素不再是字面量联合时报废弃登记。
 */
export const PARTIAL_LITERAL_TABLES: ReadonlyMap<string, string> = new Map<string, string>([
  ["packages/consts/aiChat/reactions.ts#AI_REACTION_EMOJIS", "Telegram 可用反应表情里按人设挑出的子集"],
]);

/** collectConstExhaustiveListProblems 的入参。 */
export interface ConstExhaustiveListParams {
  readonly projectRoot: string;
  /** createConstsProgram 建的 program 的类型检查器。 */
  readonly checker: ts.TypeChecker;
  /** packages/consts/ 的全部导出常量声明（exportedConstDeclarations）；废弃登记按这批声明判定。 */
  readonly declarations: readonly ExportedConstDeclaration[];
  readonly partialTables: ReadonlyMap<string, string>;
}

/** 字符串/数字字面量（或它们的联合）的取值集合；含其它成员时为 null。 */
function literalValues(type: ts.Type): Set<string | number> | null {
  const values: Set<string | number> = new Set<string | number>();
  for (const member of type.isUnion() ? type.types : [type]) {
    if (!member.isStringLiteral() && !member.isNumberLiteral()) return null;
    values.add(member.value);
  }
  return values;
}

/** 声明类型是数组（不含元组）且元素是至少两个字符串/数字字面量组成的联合时，返回元素的取值集合。 */
function literalUnionValues(checker: ts.TypeChecker, type: ts.Type): Set<string | number> | undefined {
  if (!checker.isArrayType(type)) return undefined;
  const element: ts.Type | undefined = checker.getTypeArguments(type as ts.TypeReference)[0];
  if (element?.isUnion() !== true) return undefined;
  return literalValues(element) ?? undefined;
}

/**
 * 初始化器形如 `exhaustiveList<U>()([...])`：恰好一个类型实参且与声明的元素类型取值集合相同，
 * 唯一的实参是逐项写出字符串/数字字面量的数组字面量（展开、类型断言或变量都会让 T[number]
 * 退化成整个 U，穷尽检查随之失效）。
 */
function builtByExhaustiveList(
  checker: ts.TypeChecker,
  declared: ReadonlySet<string | number>,
  initializer: ts.Expression | undefined
): boolean {
  if (initializer === undefined || !ts.isCallExpression(initializer)) return false;
  const factory: ts.LeftHandSideExpression = initializer.expression;
  if (!ts.isCallExpression(factory) || !ts.isIdentifier(factory.expression) || factory.expression.text !== "exhaustiveList") {
    return false;
  }
  const typeArgument: ts.TypeNode | undefined = factory.typeArguments?.length === 1 ? factory.typeArguments[0] : undefined;
  if (typeArgument === undefined) return false;
  const listed: Set<string | number> | null = literalValues(checker.getTypeFromTypeNode(typeArgument));
  if (listed?.size !== declared.size) return false;
  for (const value of declared) if (!listed.has(value)) return false;
  const items: ts.Expression | undefined = initializer.arguments.length === 1 ? initializer.arguments[0] : undefined;
  return items !== undefined && ts.isArrayLiteralExpression(items) && items.elements.every(
    (item: ts.Expression): boolean => ts.isStringLiteralLike(item) || ts.isNumericLiteral(item)
  );
}

/**
 * packages/consts/ 里元素为字面量联合的导出数组表必须经 packages/consts/exhaustiveList.ts 的
 * exhaustiveList 构造，联合类型增删成员而表没跟上时编译失败；有意只列子集的表登记在
 * partialTables。元组类型本身已固定全部元素，不在检查范围内。
 */
export function collectConstExhaustiveListProblems({
  projectRoot,
  checker,
  declarations,
  partialTables,
}: ConstExhaustiveListParams): string[] {
  const problems: string[] = [];
  const usedPartialTables: Set<string> = new Set<string>();
  for (const { path, name, declaration } of declarations) {
    const declared: Set<string | number> | undefined =
      literalUnionValues(checker, checker.getTypeAtLocation(declaration.name));
    if (declared === undefined || builtByExhaustiveList(checker, declared, declaration.initializer)) continue;
    const key: string = `${relative(projectRoot, path)}#${name}`;
    if (partialTables.has(key)) {
      usedPartialTables.add(key);
      continue;
    }
    problems.push(
      `${relative(projectRoot, path)}: ${name} lists members of a literal union; build it with ` +
      "exhaustiveList<U>()([...]) from packages/consts/exhaustiveList.ts, where U is the declared element type and every " +
      "item is a string or number literal, so a missing member fails to compile, or register it in " +
      "PARTIAL_LITERAL_TABLES (scripts/conventions/constExhaustiveLists.ts) with the reason it is a deliberate subset"
    );
  }
  for (const key of partialTables.keys()) {
    if (usedPartialTables.has(key)) continue;
    problems.push(
      `PARTIAL_LITERAL_TABLES registers ${key}, which is no longer a literal-union table listed without exhaustiveList ` +
      "in packages/consts/; remove the entry"
    );
  }
  return problems;
}
