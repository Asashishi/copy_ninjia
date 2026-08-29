import { relative } from "node:path";
import ts from "typescript";
import {
  collectSharedConstantProblems,
  declarationName,
  hasJsDoc,
  isExported,
  isObjectFreezeCall,
  moduleCacheInitializerKind,
} from "./sourceAnalysis";

/**
 * 逐文件的源码约定判定。
 *
 * 这些规则原先散在 checkProjectConventions.ts 的四遍 `sourceFilesUnder(SOURCE_ROOT)`
 * 循环里，每遍各自重读、重解析同一批文件。收进本模块后，编排器对每个文件只解析
 * 一次就能把适用于它的全部判定跑完；副产品是这些规则第一次可以单独测（见
 * test/scripts/conventions.test.ts）。
 *
 * 判定口径与合并前逐字一致，只改了调用方式：调用方按路径前缀决定哪几条适用，
 * 各函数自己不再做目录判断。
 */

/** 逐文件判定的公共入参。 */
export interface SourceFileRuleParams {
  /** 仓库根，用于把绝对路径压成报告里的相对路径。 */
  readonly projectRoot: string;
  /** 被检查文件的绝对路径。 */
  readonly path: string;
  /** 该文件**唯一一次**解析得到的 AST；调用方负责用它跑完所有适用规则。 */
  readonly source: ts.SourceFile;
}

/** 节点所在行号（1 起）。 */
function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

interface CacheLifecycleField {
  /** 失败报告中的稳定字段名。 */
  readonly name: string;
  /** 中文 JSDoc 中可表达该字段语义的受控词组。 */
  readonly pattern: RegExp;
}

/** 缓存模块 JSDoc 必须同时覆盖的生命周期字段。 */
const CACHE_LIFECYCLE_FIELDS: readonly Readonly<CacheLifecycleField>[] = [
  { name: "fill", pattern: /填|写入|注入|建立|创建|登记|加入|收到|派生|缓存|灌入/ },
  { name: "clear", pattern: /清理|清空|清除|删除|移除|释放|重置|停止|退出|结算|摘除|到期|销毁|淘汰|失效|撤销|归零|清零|作废|排空|关闭|结束/ },
  { name: "rebuild", pattern: /重建|重启|新 isolate|新进程|新生命周期|启动时|初始|恢复为空|销毁|崩溃|冷启动|重新创建|重新启动|从空|从 null|从 false/ },
  { name: "capacity", pattern: /容量|上限|有界|最多|固定|恒定|不超过|同阶|单例|唯一|一个|TTL|条目数|槽位|每群|每个|按群|按 chatId/ },
  { name: "eviction", pattern: /淘汰|清理策略|到期|删除|清空|清除|移除|释放|结算|摘除|销毁|作废|归零|清零|排空|重写|覆盖|关闭|结束|不淘汰|不设 TTL|不设超时|无需额外.*清理/ },
];

/** 提取文件中全部 JSDoc 正文；普通块注释不能替代生命周期契约。 */
function allJsDocText(source: ts.SourceFile): string {
  const comments: string[] = [];
  for (const match of source.text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const comment: string | undefined = match[0];
    if (comment !== undefined) comments.push(comment);
  }
  return comments.join("\n");
}

/** `packages/cache/` 下每个导出都要有 JSDoc，状态模块还须覆盖完整生命周期字段。 */
export function collectCacheJsDocProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  let hasExportedCacheState: boolean = false;
  for (const statement of source.statements) {
    if (!isExported(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      hasExportedCacheState = true;
      if (hasJsDoc(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        problems.push(`${relativePath}:${lineOf(source, declaration)} export ${declarationName(declaration)} lacks JSDoc`);
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
        problems.push(`${relativePath}:${lineOf(source, statement)} export ${declarationName(statement)} lacks JSDoc`);
      }
    }
  }
  if (hasExportedCacheState) {
    const jsDocText: string = allJsDocText(source);
    for (const field of CACHE_LIFECYCLE_FIELDS) {
      if (!field.pattern.test(jsDocText)) {
        problems.push(`${relativePath}:1 cache module JSDoc lacks lifecycle field ${field.name}`);
      }
    }
  }
  return problems;
}

/** `packages/consts/` 下的常量要求 SCREAMING_SNAKE_CASE、显式类型、JSDoc 与编译期只读。 */
export function collectConstantProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      const location: string = `${relativePath}:${lineOf(source, declaration)}`;
      const name: string = declarationName(declaration);
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        problems.push(`${location} constant ${name} is not SCREAMING_SNAKE_CASE`);
      }
      if (declaration.type === undefined) {
        problems.push(`${location} constant ${name} lacks an explicit type`);
      }
      if (!hasJsDoc(statement)) {
        problems.push(`${location} constant ${name} lacks JSDoc`);
      }
      if (isExported(statement) && declaration.initializer !== undefined) {
        for (const problem of collectSharedConstantProblems(
          declaration.initializer,
          declaration.type,
          `constant ${name}`
        )) {
          problems.push(`${location} ${problem}`);
        }
      }
    }
  }
  return problems;
}

/**
 * `Object.freeze` 在 packages/ 下一处都不许有。
 *
 * 常量、部署配置快照、句柄对象都一样：它们本来就不会变，运行期再冻一次买不到
 * 任何东西，却要为此付一大笔读取成本（数字见 collectSharedConstantProblems 的
 * 注释与 AGENTS.md 的「常量」一节）。不可变性一律由 `readonly`/`Readonly<T>`
 * 在编译期表达——那是 0 成本、且能在写入点当场报错的那一份保护。
 *
 * 这条独立于 consts 的常量检查：解析结果和句柄对象不是 SCREAMING_SNAKE 常量，
 * 走不到上面那段，但它们同样不该冻。
 */
export function collectObjectFreezeProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isObjectFreezeCall(node)) {
      problems.push(
        `${relativePath}:${lineOf(source, node)} Object.freeze is not allowed: ` +
        "express immutability with readonly types instead (see AGENTS.md 常量)"
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return problems;
}

/** 模块级 Map/Set/holder 必须声明在带 owner 的 `packages/cache/<owner>/` 下。 */
export function collectModuleCacheProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer === undefined) continue;
      const kind: string | null = moduleCacheInitializerKind(declaration.initializer);
      if (kind === null) continue;
      problems.push(
        `${relativePath}:` +
        `${lineOf(source, declaration)} ` +
        `module-level ${kind} ${declarationName(declaration)} must be declared under packages/cache/<owner>/`
      );
    }
  }
  return problems;
}

/**
 * `packages/` 通用的五条 AST 判定：领域类型入口、`console.error` 边界、导出函数
 * 返回类型、内联对象参数类型与 catch 绑定标注。
 */
export function collectDeclarationProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const modulePath: string = node.moduleSpecifier.text;
      const importsTypeIndex: boolean =
        /(^|\/)types$/.test(modulePath) || /(^|\/)types\/index$/.test(modulePath);
      const importsAntiRaidTypeBarrel: boolean =
        /(^|\/)types\/antiRaid$/.test(modulePath);
      if (
        modulePath.startsWith(".") &&
        (importsTypeIndex || importsAntiRaidTypeBarrel)
      ) {
        problems.push(
          `${relativePath}:` +
          `${lineOf(source, node)} ` +
          `production code must import from a domain type module instead of types/index`
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console" &&
      node.expression.name.text === "error"
    ) {
      const isDiskIOBoundary: boolean =
        relativePath === "packages/workers/diskIOWorker.ts" ||
        relativePath.startsWith("packages/workers/diskIO/");
      if (!isDiskIOBoundary) {
        problems.push(
          `${relativePath}:` +
          `${lineOf(source, node)} ` +
          "direct console.error is restricted to the disk I/O Worker boundary"
        );
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      isExported(node) &&
      node.type === undefined
    ) {
      problems.push(
        `${relativePath}:` +
        `${lineOf(source, node)} ` +
        `exported function ${declarationName(node)} lacks an explicit return type`
      );
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (parameter.type !== undefined && ts.isTypeLiteralNode(parameter.type)) {
          problems.push(
            `${relativePath}:` +
            `${lineOf(source, parameter)} ` +
            `inline object parameter type must be an exported XxxParams interface`
          );
        }
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      if (node.variableDeclaration.type?.kind !== ts.SyntaxKind.UnknownKeyword) {
        problems.push(
          `${relativePath}:` +
          `${lineOf(source, node.variableDeclaration)} ` +
          `catch binding ${declarationName(node.variableDeclaration)} must be explicitly typed unknown`
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return problems;
}
