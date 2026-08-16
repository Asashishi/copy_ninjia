import { existsSync, readFileSync, statSync } from "node:fs";
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

const PROJECT_ROOT: string = join(import.meta.dir, "..");
const CACHE_ROOT: string = join(PROJECT_ROOT, "packages", "cache");
const CONSTS_ROOT: string = join(PROJECT_ROOT, "packages", "consts");
const SOURCE_ROOT: string = join(PROJECT_ROOT, "packages");
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
const CACHE_OWNER_BY_PREFIX: readonly (readonly [string, string])[] = [
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
    for (const dependency of runtimeExternalDependencies(path)) {
      if (dependency !== "grammy" && !dependency.startsWith("@grammyjs/")) continue;
      failures.push(
        `${thread} Worker loads Telegram runtime package ${dependency}: ` +
        trail.map((step: string): string => relative(PROJECT_ROOT, step)).join(" -> ")
      );
    }
  }
}

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
    ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    failures
  );
}

for (const path of sourceFilesUnder(SOURCE_ROOT)) {
  if (path.startsWith(CACHE_ROOT) || path.startsWith(CONSTS_ROOT)) continue;
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
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

/**
 * 群聊命令文本必须经统一的 30 秒清理边界发送。唯一例外是 gag 会话状态和
 * 发言入口；它们由同一会话持有，只能由滚动换新、超时、`/ungag` 或 teardown
 * 删除。头像更新结果虽在 copy owner 内异步
 * 落地，但只由 /copy 与 /steal_icon 触发，因此同样纳入检查。
 */
const COMMAND_TEXT_OUTPUT_FILES: readonly string[] = [
  ...sourceFilesUnder(COMMANDS_ROOT),
  join(SOURCE_ROOT, "copy", "avatarQueue.ts"),
];
const GAG_COMMAND_PATH: string = join(COMMANDS_ROOT, "gag.ts");
const GAG_NOTICES_PATH: string = join(COMMANDS_ROOT, "gag", "notices.ts");
for (const path of COMMAND_TEXT_OUTPUT_FILES) {
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  function visit(node: ts.Node): void {
    if (
      ts.isImportSpecifier(node) &&
      ["sendEphemeralMessage", "sendMessage"].includes(
        node.propertyName?.text ?? node.name.text
      )
    ) {
      if (
        (path === GAG_COMMAND_PATH || path === GAG_NOTICES_PATH) &&
        ["sendEphemeralMessage", "sendMessage"].includes(node.name.text)
      ) {
        ts.forEachChild(node, visit);
        return;
      }
      failures.push(
        `${relative(PROJECT_ROOT, path)}:` +
        `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
        "command text must use sendCommandMessage so group prompts are deleted"
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

/** gag 只允许状态消息和统一入口动作边界绕开 30 秒清理。 */
for (const path of [GAG_COMMAND_PATH, GAG_NOTICES_PATH]) {
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["sendEphemeralMessage", "sendMessage"].includes(node.expression.text)
    ) {
      let owner: ts.Node | undefined = node.parent;
      while (
        owner !== undefined &&
        !ts.isVariableDeclaration(owner) &&
        !ts.isFunctionLike(owner)
      ) {
        owner = owner.parent;
      }
      const isPublicNoticeAssignment: boolean = path === GAG_COMMAND_PATH &&
        owner !== undefined && ts.isVariableDeclaration(owner) &&
        ts.isIdentifier(owner.name) &&
        owner.name.text === "publicNoticeMessageId";
      const isSpeakNoticeBoundary: boolean = path === GAG_NOTICES_PATH &&
        owner !== undefined && ts.isFunctionDeclaration(owner) &&
        owner.name?.text === "sendGagSpeakNotice";
      if (!isPublicNoticeAssignment && !isSpeakNoticeBoundary) {
        failures.push(
          `${relative(PROJECT_ROOT, path)}:` +
          `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
          "only the state-owned gag notice may bypass sendCommandMessage"
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

/**
 * 入群验证按钮由状态机在点击、离群、豁免或超时结算时删除；inline 运势由
 * Telegram inline API 生成。二者都不能误接命令文本的固定延迟清理边界。
 */
const FIXED_DELAY_DELETE_EXEMPT_FILES: readonly string[] = [
  ...sourceFilesUnder(join(COMMANDS_ROOT, "luckChallenge")),
  join(
    SOURCE_ROOT,
    "workers",
    "antiRaid",
    "verificationReminders.ts"
  ),
];
for (const path of FIXED_DELAY_DELETE_EXEMPT_FILES) {
  const source: ts.SourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  function visit(node: ts.Node): void {
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName?.text ?? node.name.text) === "sendCommandMessage"
    ) {
      failures.push(
        `${relative(PROJECT_ROOT, path)}:` +
        `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
        "state-owned button messages and inline luck results must not use fixed-delay command cleanup"
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
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
