import { relative } from "node:path";
import ts from "typescript";
import type { ExportedConstDeclaration } from "./constsProgram";

/** collectConstImmutabilityAssertionProblems 的入参。 */
export interface ConstImmutabilityParams {
  readonly projectRoot: string;
  /** createConstsProgram 建的 program 的类型检查器。 */
  readonly checker: ts.TypeChecker;
  /** packages/consts/ 的全部导出常量声明（exportedConstDeclarations）。 */
  readonly declarations: readonly ExportedConstDeclaration[];
  /** test/consts/immutability.test.ts 的全文。 */
  readonly assertionSource: string;
}

/**
 * 字符串、数字、布尔、null、undefined、函数值与正则不算对象元素（正则的 lastIndex 在类型上
 * 无法只读，单独的正则常量由断言文件按 lastIndex 覆盖）。
 */
function isObjectLike(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(isObjectLike);
  if (type.getSymbol()?.getName() === "RegExp") return false;
  const primitiveFlags: number = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike
    | ts.TypeFlags.Null | ts.TypeFlags.Undefined;
  if ((type.flags & primitiveFlags) !== 0) return false;
  if (type.getCallSignatures().length > 0) return false;
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

/** 容器的元素类型：数组/元组的元素、Map 的值、Set 的元素，普通对象的索引签名值与属性值。 */
function elementTypes(checker: ts.TypeChecker, type: ts.Type): ts.Type[] {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return [...checker.getTypeArguments(type as ts.TypeReference)];
  }
  const symbolName: string | undefined = type.getSymbol()?.getName();
  if (symbolName === "Map" || symbolName === "ReadonlyMap") {
    const value: ts.Type | undefined = checker.getTypeArguments(type as ts.TypeReference)[1];
    return value === undefined ? [] : [value];
  }
  if (symbolName === "Set" || symbolName === "ReadonlySet") {
    const element: ts.Type | undefined = checker.getTypeArguments(type as ts.TypeReference)[0];
    return element === undefined ? [] : [element];
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return [];
  const indexValues: ts.Type[] = checker.getIndexInfosOfType(type).map((info: ts.IndexInfo): ts.Type => info.type);
  if (indexValues.length > 0) return indexValues;
  return checker.getPropertiesOfType(type).map((property: ts.Symbol): ts.Type => checker.getTypeOfSymbol(property));
}

/** 第 index 行正上方连续的 `//` 注释行里有没有 `@ts-expect-error`（多行说明的首行带指令）。 */
function followsExpectError(lines: readonly string[], index: number): boolean {
  for (let line: number = index - 1; line >= 0; line--) {
    const text: string = lines[line]!.trim();
    if (!text.startsWith("//")) return false;
    if (text.includes("@ts-expect-error")) return true;
  }
  return false;
}

/**
 * 带对象元素的导出常量表必须在 test/consts/immutability.test.ts 里有 `@ts-expect-error` 改写
 * 断言（AGENTS.md「常量与不可变性」）。用类型检查器读 packages/consts/ 下导出常量的声明类型，
 * 元素里有对象（函数值与正则除外）即要求断言文件里有一行按 `NAME.` 或 `NAME[` 访问它，且这一行
 * 紧跟在带 `@ts-expect-error` 的注释之后。
 */
export function collectConstImmutabilityAssertionProblems({
  projectRoot,
  checker,
  declarations,
  assertionSource,
}: ConstImmutabilityParams): string[] {
  const lines: readonly string[] = assertionSource.split("\n");
  const problems: string[] = [];
  for (const { path, name, declaration } of declarations) {
    const type: ts.Type = checker.getTypeAtLocation(declaration.name);
    if (type.getSymbol()?.getName() === "RegExp") continue;
    if (!elementTypes(checker, type).some(isObjectLike)) continue;
    const access: RegExp = new RegExp(`\\b${name}[.[]`);
    if (lines.some((line: string, index: number): boolean => access.test(line) && followsExpectError(lines, index))) continue;
    problems.push(
      `${relative(projectRoot, path)}: ${name} holds object elements; add a @ts-expect-error immutability ` +
      "assertion to test/consts/immutability.test.ts"
    );
  }
  return problems;
}
