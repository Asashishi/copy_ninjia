import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

/** import/export 是否在运行时求值目标模块；空声明仍保留副作用，纯类型引用被擦除。 */
export function isRuntimeModuleEdge(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return false;
    const clause: ts.NamedExportBindings | undefined = node.exportClause;
    return clause === undefined || !ts.isNamedExports(clause) || clause.elements.length === 0 ||
      clause.elements.some((element: ts.ExportSpecifier): boolean => !element.isTypeOnly);
  }
  const clause: ts.ImportClause | undefined = node.importClause;
  if (clause === undefined) return true;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return false;
  if (clause.name !== undefined) return true;
  const bindings: ts.NamedImportBindings | undefined = clause.namedBindings;
  return bindings === undefined || !ts.isNamedImports(bindings) || bindings.elements.length === 0 ||
    bindings.elements.some((element: ts.ImportSpecifier): boolean => !element.isTypeOnly);
}

/**
 * 一处运行期模块引用。`names` 是取用的导出名（默认导出记为 `default`）；命名空间
 * 绑定取其属性访问。命名空间被整体传出、`export *`、结果未绑定的动态导入等无法
 * 静态确定取用范围的形态记为 null。
 */
export interface RuntimeModuleReference {
  readonly specifier: string;
  readonly names: readonly string[] | null;
  /** 引用节点在源文件中的起始位置，供报告行号。 */
  readonly start: number;
}

/** 静态字符串字面量说明符；模板插值与动态表达式不参与判定。 */
function literalSpecifier(node: ts.Expression | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** 标识符是否只出现在类型位置（如 `typeof ns`），这类引用在运行期被擦除。 */
function isInTypePosition(node: ts.Node): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isTypeNode(parent)) return true;
    if (ts.isStatement(parent) || ts.isSourceFile(parent)) return false;
  }
  return false;
}

/** 标识符是否只是属性访问、对象字面量或类成员里的成员名。 */
function isMemberName(node: ts.Identifier): boolean {
  const parent: ts.Node = node.parent;
  return (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) ||
    ts.isPropertySignature(parent)) && parent.name === node;
}

/**
 * 命名空间绑定在本文件里取用的属性名：`ns.x` 与 `ns["x"]` 记名，展开进对象字面量
 * （`{ ...ns }`）只是转交替身、不记名；被整体传出或以其它方式使用时返回 null。
 * 按标识符文本匹配，不区分同名遮蔽。
 */
function namespaceMemberNames(source: ts.SourceFile, binding: ts.Identifier): readonly string[] | null {
  const names: string[] = [];
  let opaque: boolean = false;
  const visit = (node: ts.Node): void => {
    if (opaque) return;
    if (ts.isIdentifier(node) && node !== binding && node.text === binding.text && !isInTypePosition(node)) {
      const parent: ts.Node = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        names.push(parent.name.text);
      } else if (
        ts.isElementAccessExpression(parent) && parent.expression === node &&
        (ts.isStringLiteral(parent.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(parent.argumentExpression))
      ) {
        names.push(parent.argumentExpression.text);
      } else if (isMemberName(node)) {
        // `other.ns`、`{ ns: 1 }` 里的同名属性名不是对绑定的引用。
      } else if (!ts.isSpreadAssignment(parent)) {
        opaque = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return opaque ? null : names;
}

/** `import()` / `require()` 的结果被解构时取出属性名，绑定为命名空间时取其属性访问；其余用法按整模块计。 */
function loadedBindingNames(source: ts.SourceFile, call: ts.CallExpression): readonly string[] | null {
  let node: ts.Node = call;
  while (
    ts.isAwaitExpression(node.parent) ||
    ts.isParenthesizedExpression(node.parent) ||
    ts.isAsExpression(node.parent) ||
    ts.isSatisfiesExpression(node.parent) ||
    ts.isNonNullExpression(node.parent)
  ) {
    node = node.parent;
  }
  const declaration: ts.Node = node.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== node) return null;
  if (ts.isIdentifier(declaration.name)) return namespaceMemberNames(source, declaration.name);
  if (!ts.isObjectBindingPattern(declaration.name)) return null;
  const names: string[] = [];
  for (const element of declaration.name.elements) {
    if (element.dotDotDotToken !== undefined) return null;
    const property: ts.PropertyName | ts.BindingName = element.propertyName ?? element.name;
    if (!ts.isIdentifier(property) && !ts.isStringLiteral(property)) return null;
    names.push(property.text);
  }
  return names;
}

/**
 * 取出一个模块的全部运行期模块引用：静态 `import`/`export … from`、`import()` 与
 * `require()`。纯类型引用被擦除，不进入结果；只认 AST 节点，字符串夹具里的路径
 * 不会被误判成引用。`source` 必须带父节点指针解析（`setParentNodes: true`）。
 */
export function runtimeModuleReferences(source: ts.SourceFile): readonly RuntimeModuleReference[] {
  const references: RuntimeModuleReference[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier: string | undefined = literalSpecifier(node.moduleSpecifier);
      if (specifier === undefined || !isRuntimeModuleEdge(node)) return;
      const clause: ts.ImportClause | undefined = node.importClause;
      const bindings: ts.NamedImportBindings | undefined = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        references.push({ specifier, names: namespaceMemberNames(source, bindings.name), start: node.getStart(source) });
        return;
      }
      const names: string[] = clause?.name === undefined ? [] : ["default"];
      for (const element of bindings?.elements ?? []) {
        if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
      }
      references.push({ specifier, names, start: node.getStart(source) });
      return;
    }
    if (ts.isExportDeclaration(node)) {
      const specifier: string | undefined = literalSpecifier(node.moduleSpecifier);
      if (specifier === undefined || !isRuntimeModuleEdge(node)) return;
      const clause: ts.NamedExportBindings | undefined = node.exportClause;
      if (clause === undefined || !ts.isNamedExports(clause)) {
        references.push({ specifier, names: null, start: node.getStart(source) });
        return;
      }
      const names: string[] = [];
      for (const element of clause.elements) {
        if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
      }
      references.push({ specifier, names, start: node.getStart(source) });
      return;
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const specifier: string | undefined = literalSpecifier(node.arguments[0]);
      if (specifier !== undefined) {
        references.push({ specifier, names: loadedBindingNames(source, node), start: node.getStart(source) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

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

/** 模块级纯字面量及其组合；含函数、句柄、变量引用或展开的装配表达式不属于此类。 */
export function isLiteralConstant(expression: ts.Expression): boolean {
  const value: ts.Expression = unwrapTypeWrappers(expression);
  if (ts.isLiteralExpression(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isPrefixUnaryExpression(value)) return isLiteralConstant(value.operand);
  if (ts.isBinaryExpression(value)) return isLiteralConstant(value.left) && isLiteralConstant(value.right);
  if (ts.isArrayLiteralExpression(value)) return value.elements.every(isLiteralConstant);
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.every((property: ts.ObjectLiteralElementLike): boolean =>
      ts.isPropertyAssignment(property) &&
      !ts.isComputedPropertyName(property.name) &&
      isLiteralConstant(property.initializer)
    );
  }
  return false;
}

/** 判断表达式是否为 `Object.freeze(...)` 调用。 */
export function isObjectFreezeCall(expression: ts.Expression): boolean {
  return ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.expression.getText() === "Object" &&
    expression.expression.name.text === "freeze";
}

/** 实例本身跨调用保存运行时状态的构造器；RegExp、Intl 格式化器等无状态句柄不在此列。 */
const MODULE_CACHE_CONSTRUCTORS: readonly string[] = [
  "Map", "Set", "WeakMap", "WeakSet", "AsyncLocalStorage",
];

/**
 * 模块顶层 Map/Set、AsyncLocalStorage 与 holder 都是跨调用长期存活的状态，必须进入
 * 带 owner 的 packages/cache/。consts 下的 ReadonlySet 是静态查找表，不属于运行时缓存。
 */
export function moduleCacheInitializerKind(expression: ts.Expression): string | null {
  const initializer: ts.Expression = unwrapTypeWrappers(expression);
  if (
    ts.isNewExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    MODULE_CACHE_CONSTRUCTORS.includes(initializer.expression.text)
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
