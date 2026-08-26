import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  runtimeExternalDependencies,
  threadModuleClosure,
} from "./conventions/moduleGraph";
import {
  collectSharedConstantProblems,
  declarationName,
  hasJsDoc,
  isExported,
  isObjectFreezeCall,
  moduleCacheInitializerKind,
  sourceFilesUnder,
} from "./conventions/sourceAnalysis";
import { collectColdMigrationProblems } from "./conventions/coldMigrations";
import { collectCoverageMetricProblems } from "./conventions/coverageMetrics";
import { collectPerformanceRecordProblems } from "./conventions/performanceRecord";
import { collectCacheOwnershipProblems } from "./conventions/cacheOwnership";
import type { CacheOwnerPrefix } from "./conventions/cacheOwnership";
import { collectNodeCompatibilityProblems } from "./conventions/nodeCompatibility";
import { collectTelegramMessageProblems } from "./conventions/telegramMessages";

const PROJECT_ROOT: string = join(import.meta.dir, "..");
const CACHE_ROOT: string = join(PROJECT_ROOT, "packages", "cache");
const CONSTS_ROOT: string = join(PROJECT_ROOT, "packages", "consts");
const SOURCE_ROOT: string = join(PROJECT_ROOT, "packages");
const SCRIPTS_ROOT: string = join(PROJECT_ROOT, "scripts");
const COMMANDS_ROOT: string = join(SOURCE_ROOT, "commands");

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
async function checkMarkdownLocalLinks(
  path: string,
  failures: string[]
): Promise<void> {
  const source: string = await Bun.file(path).text();
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

/** 四条线程各自的入口，以及从入口出发能加载到的模块闭包（含最短引入路径）。 */
const THREAD_ENTRIES: Readonly<Record<string, string>> = {
  main: join(PROJECT_ROOT, "index.ts"),
  aiChat: join(PROJECT_ROOT, "packages", "workers", "aiChatWorker.ts"),
  antiRaid: join(PROJECT_ROOT, "packages", "workers", "antiRaidWorker.ts"),
  diskIO: join(PROJECT_ROOT, "packages", "workers", "diskIOWorker.ts"),
};

/**
 * `packages/cache/` 的目录名就是这份状态的 owner 线程，见
 * docs/cn/04-invariants.md「缓存的线程归属」。这里用真实模块图核对声明与事实是否
 * 一致：一份只属于某条线程的状态被别的线程 import，那条线程拿到的是一份永远
 * 对不上的空副本——静态看不出来，运行起来只是「缓存莫名其妙不命中」。
 */
const CACHE_OWNER_BY_PREFIX: readonly CacheOwnerPrefix[] = [
  [join("packages", "cache", "main") + "/", "main"],
  [join("packages", "cache", "workers", "aiChat") + "/", "aiChat"],
  [join("packages", "cache", "workers", "antiRaid") + "/", "antiRaid"],
  [join("packages", "cache", "workers", "diskIO") + "/", "diskIO"],
];

/**
 * 唯一的归属豁免：infra/logger.ts 静态 import infra/diskIO.ts 取 relayLogMessage，
 * 而四条线程都要能记 error 日志。Worker isolate 里那份状态恒为初始值、一次也不
 * 会被读写，理由见 packages/cache/main/diskIO.ts 的模块头注。
 */
const CACHE_OWNER_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = {
  [join("packages", "cache", "main", "diskIO.ts")]: ["aiChat", "antiRaid"],
};

const failures: string[] = [];
for (const problem of await collectColdMigrationProblems(PROJECT_ROOT)) {
  failures.push(`cold migration: ${problem}`);
}
for (const problem of await collectCoverageMetricProblems(PROJECT_ROOT)) {
  failures.push(problem);
}

for (const problem of await collectPerformanceRecordProblems(PROJECT_ROOT)) {
  failures.push(`performance record: ${problem}`);
}
const tracked: string[] = trackedFiles();
for (const trackedPath of tracked) {
  const path: string = join(PROJECT_ROOT, trackedPath);
  // 允许尚未 stage 的正常删除；其它门禁会从最终工作树/索引确认变更范围。
  if (!existsSync(path)) continue;
  if (extname(path) === ".md") {
    await checkMarkdownLocalLinks(path, failures);
  }
  const extension: string = extname(path);
  if (
    ![".ts", ".json", ".md", ".yaml", ".yml"].includes(extension) ||
    !statSync(path).isFile() ||
    (statSync(path).mode & 0o111) === 0
  ) {
    continue;
  }
  if ((await Bun.file(path).text()).startsWith("#!")) continue;
  failures.push(
    `${trackedPath} is a tracked non-script ${extension} file with executable permissions`
  );
}

for (const path of sourceFilesUnder(CACHE_ROOT)) {
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    await Bun.file(path).text(),
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

const threadClosures: Map<string, Map<string, string[]>> = new Map();
for (const [thread, entry] of Object.entries(THREAD_ENTRIES)) {
  threadClosures.set(thread, await threadModuleClosure(entry));
}

/**
 * Telegram 凭据、真实客户端、网络分派与出站队列只属主线程。Worker 只能加载
 * 项目自有协议和双工代理，连 grammY 运行时都不得进入其模块闭包。
 */
const WORKER_TELEGRAM_FORBIDDEN_MODULES: readonly string[] = [
  join(PROJECT_ROOT, "packages", "config", "telegram.ts"),
  join(PROJECT_ROOT, "packages", "cache", "main", "telegram.ts"),
  join(PROJECT_ROOT, "packages", "infra", "telegram", "mainClient.ts"),
  join(PROJECT_ROOT, "packages", "infra", "telegram", "messageThrottler.ts"),
  join(PROJECT_ROOT, "packages", "infra", "telegram", "outboundGate.ts"),
  join(PROJECT_ROOT, "packages", "infra", "telegram", "workerRequests.ts"),
];

for (const [thread, closure] of threadClosures) {
  if (thread === "main") continue;
  for (const forbidden of WORKER_TELEGRAM_FORBIDDEN_MODULES) {
    const trail: string[] | undefined = closure.get(forbidden);
    if (trail === undefined) continue;
    failures.push(
      `${thread} Worker loads main-thread Telegram module: ` +
      trail.map((step: string): string => relative(PROJECT_ROOT, step)).join(" -> ")
    );
  }
  for (const [path, trail] of closure) {
    for (const dependency of await runtimeExternalDependencies(path)) {
      if (dependency !== "grammy" && !dependency.startsWith("@grammyjs/")) continue;
      failures.push(
        `${thread} Worker loads Telegram runtime package ${dependency}: ` +
        trail.map((step: string): string => relative(PROJECT_ROOT, step)).join(" -> ")
      );
    }
  }
}

for (const problem of collectCacheOwnershipProblems({
  projectRoot: PROJECT_ROOT,
  cacheFiles: sourceFilesUnder(CACHE_ROOT),
  threadEntries: THREAD_ENTRIES,
  threadClosures,
  ownerByPrefix: CACHE_OWNER_BY_PREFIX,
  exemptions: CACHE_OWNER_EXEMPTIONS,
})) {
  failures.push(problem);
}

for (const path of sourceFilesUnder(CONSTS_ROOT)) {
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    await Bun.file(path).text(),
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
        for (const problem of collectSharedConstantProblems(
          declaration.initializer,
          declaration.type,
          `constant ${name}`
        )) {
          failures.push(`${location} ${problem}`);
        }
      }
    }
  }
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
function checkNoObjectFreeze(path: string, source: ts.SourceFile, failures: string[]): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isObjectFreezeCall(node)) {
      const line: number = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      failures.push(
        `${relative(PROJECT_ROOT, path)}:${line} Object.freeze is not allowed: ` +
        "express immutability with readonly types instead (see AGENTS.md 常量)"
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

for (const path of sourceFilesUnder(SOURCE_ROOT)) {
  checkNoObjectFreeze(
    path,
    ts.createSourceFile(
      path,
      await Bun.file(path).text(),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    ),
    failures
  );
}

for (const path of sourceFilesUnder(SOURCE_ROOT)) {
  if (path.startsWith(CACHE_ROOT) || path.startsWith(CONSTS_ROOT)) continue;
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    await Bun.file(path).text(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer === undefined) continue;
      const kind: string | null =
        moduleCacheInitializerKind(declaration.initializer);
      if (kind === null) continue;
      failures.push(
        `${relative(PROJECT_ROOT, path)}:` +
        `${source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1} ` +
        `module-level ${kind} ${declarationName(declaration)} must be declared under packages/cache/<owner>/`
      );
    }
  }
}

for (const problem of await collectTelegramMessageProblems(
  PROJECT_ROOT,
  SOURCE_ROOT,
  COMMANDS_ROOT
)) {
  failures.push(problem);
}

for (const root of [SOURCE_ROOT, SCRIPTS_ROOT]) {
  for (const path of sourceFilesUnder(root)) {
    const source: ts.SourceFile = ts.createSourceFile(
      path,
      await Bun.file(path).text(),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    for (const problem of collectNodeCompatibilityProblems(
      PROJECT_ROOT,
      path,
      source
    )) failures.push(problem);
  }
}

for (const path of sourceFilesUnder(SOURCE_ROOT)) {
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    await Bun.file(path).text(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
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
        failures.push(
          `${relative(PROJECT_ROOT, path)}:` +
          `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
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
      const relativePath: string = relative(PROJECT_ROOT, path);
      const isDiskIOBoundary: boolean =
        relativePath === "packages/workers/diskIOWorker.ts" ||
        relativePath.startsWith("packages/workers/diskIO/");
      if (!isDiskIOBoundary) {
        failures.push(
          `${relativePath}:` +
          `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
          "direct console.error is restricted to the disk I/O Worker boundary"
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
