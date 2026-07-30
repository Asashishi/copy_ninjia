import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";

const PROJECT_ROOT: string = join(import.meta.dir, "..");
const CACHE_ROOT: string = join(PROJECT_ROOT, "packages", "cache");
const CONSTS_ROOT: string = join(PROJECT_ROOT, "packages", "consts");
const SOURCE_ROOT: string = join(PROJECT_ROOT, "packages");

/** 读取 Git 跟踪清单；约定检查只约束会进入提交的文件。 */
function trackedFiles(): string[] {
  const result: ReturnType<typeof Bun.spawnSync> = Bun.spawnSync({
    cmd: [
      "git",
      "-c",
      `safe.directory=${PROJECT_ROOT}`,
      "ls-files",
      "-z",
    ],
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr: string = result.stderr === undefined
      ? ""
      : new TextDecoder().decode(result.stderr);
    throw new Error(
      `Failed to enumerate tracked files: ${stderr.trim()}`
    );
  }
  const stdout: string = result.stdout === undefined
    ? ""
    : new TextDecoder().decode(result.stdout);
  return stdout.split("\0").filter(
    (path: string): boolean => path.length > 0
  );
}

/** 去掉 fenced code block 内容但保留换行和下标，避免把示例语法当成真实链接。 */
function withoutMarkdownCodeFences(source: string): string {
  return source.replace(
    /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g,
    (block: string): string => block.replace(/[^\n]/g, " ")
  );
}

/** 检查 Markdown inline/reference link 与 HTML href/src 的本地目标。 */
function checkMarkdownLocalLinks(path: string, failures: string[]): void {
  const source: string = readFileSync(path, "utf8");
  const searchable: string = withoutMarkdownCodeFences(source);
  const patterns: readonly RegExp[] = [
    /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g,
    /(?:href|src)=["']([^"']+)["']/g,
    /^\s*\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/gm,
  ];
  for (const pattern of patterns) {
    for (const match of searchable.matchAll(pattern)) {
      const target: string | undefined = match[1];
      if (
        target === undefined ||
        target.startsWith("#") ||
        target.startsWith("/") ||
        target.startsWith("//") ||
        /^[a-z][a-z0-9+.-]*:/i.test(target)
      ) {
        continue;
      }
      const targetWithoutFragment: string = target.split(/[?#]/, 1)[0] ?? "";
      if (targetWithoutFragment.length === 0) continue;
      let decodedTarget: string;
      try {
        decodedTarget = decodeURIComponent(targetWithoutFragment);
      } catch {
        decodedTarget = targetWithoutFragment;
      }
      if (existsSync(resolve(dirname(path), decodedTarget))) continue;
      const line: number =
        searchable.slice(0, match.index).split("\n").length;
      failures.push(
        `${relative(PROJECT_ROOT, path)}:${line} local link target does not exist: ${target}`
      );
    }
  }
}

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
    ts.getModifiers(node)?.some((modifier: ts.ModifierLike): boolean => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
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

/**
 * 一条 import/export 说明符是不是**运行时**依赖边。`import type` 与「具名项
 * 全部标了 type」的形态都会被 TypeScript 整条擦掉，不会让目标模块在本线程里
 * 求值，因此不算边；副作用 import（没有 importClause）永远算。
 */
function isRuntimeModuleEdge(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) return !node.isTypeOnly;
  const clause: ts.ImportClause | undefined = node.importClause;
  if (clause === undefined) return true;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return false;
  if (clause.name !== undefined) return true;
  const bindings: ts.NamedImportBindings | undefined = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return true;
  return bindings.elements.some((element: ts.ImportSpecifier): boolean => !element.isTypeOnly);
}

/** 把相对说明符解析成仓库内的 .ts 文件；解析不到（npm 包等）返回 undefined。 */
function resolveRelativeModule(specifier: string, fromFile: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base: string = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), base]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 本文件在**同一条线程内**会拉起哪些模块。刻意不跟 `new Worker(new URL(...))`：
 * 那正是线程边界，跟过去就把四条线程的模块图糊成一张。
 */
function runtimeDependencies(path: string): string[] {
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const targets: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isRuntimeModuleEdge(node)
    ) {
      const resolved: string | undefined = resolveRelativeModule(node.moduleSpecifier.text, path);
      if (resolved !== undefined) targets.push(resolved);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const resolved: string | undefined = resolveRelativeModule(node.arguments[0].text, path);
      if (resolved !== undefined) targets.push(resolved);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return targets;
}

/** 四条线程各自的入口，以及从入口出发能加载到的模块闭包（含最短引入路径）。 */
const THREAD_ENTRIES: Readonly<Record<string, string>> = Object.freeze({
  main: join(PROJECT_ROOT, "index.ts"),
  aiChat: join(PROJECT_ROOT, "packages", "workers", "aiChatWorker.ts"),
  antiRaid: join(PROJECT_ROOT, "packages", "workers", "antiRaidWorker.ts"),
  diskIO: join(PROJECT_ROOT, "packages", "workers", "diskIOWorker.ts"),
});

function threadModuleClosure(entry: string): Map<string, string[]> {
  const trail: Map<string, string[]> = new Map([[entry, [entry]]]);
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const current: string = queue.shift()!;
    const path: string[] = trail.get(current)!;
    for (const dependency of runtimeDependencies(current)) {
      if (trail.has(dependency)) continue;
      trail.set(dependency, [...path, dependency]);
      queue.push(dependency);
    }
  }
  return trail;
}

/**
 * `packages/cache/` 的目录名就是这份状态的 owner 线程，见
 * docs/04-invariants.md「缓存的线程归属」。这里用真实模块图核对声明与事实是否
 * 一致：一份只属于某条线程的状态被别的线程 import，那条线程拿到的是一份永远
 * 对不上的空副本——静态看不出来，运行起来只是「缓存莫名其妙不命中」。
 */
const CACHE_OWNER_BY_PREFIX: readonly (readonly [string, string])[] = Object.freeze([
  [join("packages", "cache", "main") + "/", "main"],
  [join("packages", "cache", "workers", "aiChat") + "/", "aiChat"],
  [join("packages", "cache", "workers", "antiRaid") + "/", "antiRaid"],
  [join("packages", "cache", "workers", "diskIO") + "/", "diskIO"],
]);

/**
 * 唯一的归属豁免：infra/logger.ts 静态 import infra/diskIO.ts 取 relayLogMessage，
 * 而四条线程都要能记 error 日志。Worker isolate 里那份状态恒为初始值、一次也不
 * 会被读写，理由见 packages/cache/main/diskIO.ts 的模块头注。
 */
const CACHE_OWNER_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [join("packages", "cache", "main", "diskIO.ts")]: Object.freeze(["aiChat", "antiRaid"]),
});

const failures: string[] = [];
const tracked: string[] = trackedFiles();
for (const trackedPath of tracked) {
  const path: string = join(PROJECT_ROOT, trackedPath);
  // 允许尚未 stage 的正常删除；其它门禁会从最终工作树/索引确认变更范围。
  if (!existsSync(path)) continue;
  if (extname(path) === ".md") {
    checkMarkdownLocalLinks(path, failures);
  }
  const extension: string = extname(path);
  if (
    ![".ts", ".json", ".md", ".yaml", ".yml"].includes(extension) ||
    !statSync(path).isFile() ||
    (statSync(path).mode & 0o111) === 0
  ) {
    continue;
  }
  if (readFileSync(path, "utf8").startsWith("#!")) continue;
  failures.push(
    `${trackedPath} is a tracked non-script ${extension} file with executable permissions`
  );
}

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

const threadClosures: Map<string, Map<string, string[]>> = new Map(
  Object.entries(THREAD_ENTRIES).map(
    ([thread, entry]: [string, string]): [string, Map<string, string[]>] => [thread, threadModuleClosure(entry)]
  )
);

for (const path of sourceFilesUnder(CACHE_ROOT)) {
  const relativePath: string = relative(PROJECT_ROOT, path);
  const perThread: boolean = relativePath.startsWith(join("packages", "cache", "perThread") + "/");
  const owner: string | undefined = CACHE_OWNER_BY_PREFIX.find(
    ([prefix]: readonly [string, string]): boolean => relativePath.startsWith(prefix)
  )?.[1];
  if (owner === undefined && !perThread) {
    failures.push(
      `${relativePath} is not under a cache owner directory ` +
      `(expected packages/cache/{main,workers/<thread>,perThread}/)`
    );
    continue;
  }

  const allowed: ReadonlySet<string> = new Set(
    owner === undefined
      ? Object.keys(THREAD_ENTRIES)
      : [owner, ...(CACHE_OWNER_EXEMPTIONS[relativePath] ?? [])]
  );
  for (const [thread, closure] of threadClosures) {
    if (allowed.has(thread)) continue;
    const trail: string[] | undefined = closure.get(path);
    if (trail === undefined) continue;
    const chain: string = trail
      .map((step: string): string => relative(PROJECT_ROOT, step))
      .join(" -> ");
    failures.push(
      `${relativePath} is owned by the ${owner} thread but is loaded by the ${thread} thread: ${chain}`
    );
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
