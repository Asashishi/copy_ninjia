import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { collectCacheOwnershipProblems } from "../../scripts/conventions/cacheOwnership";
import { collectColdMigrationProblems } from "../../scripts/conventions/coldMigrations";
import { collectCommentReferenceProblems } from "../../scripts/conventions/commentReferences";
import { collectWorkerTimerProblems } from "../../scripts/conventions/workerTimers";
import { collectTelegramMessageProblems } from "../../scripts/conventions/telegramMessages";
import {
  collectCacheJsDocProblems,
  collectConstantProblems,
  collectDeclarationProblems,
  collectModuleCacheProblems,
  collectObjectFreezeProblems,
} from "../../scripts/conventions/sourceRules";
import {
  collectSharedConstantProblems,
  declarationName,
  hasJsDoc,
  isExported,
  isObjectFreezeCall,
  moduleCacheInitializerKind,
  sourceFilesUnder,
} from "../../scripts/conventions/sourceAnalysis";

const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root: string = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function source(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project convention collectors", () => {
  test("cache owner 按真实模块图拒绝跨线程读取，并尊重显式豁免", () => {
    const projectRoot: string = "/project";
    const cachePath: string = "/project/packages/cache/main/value.ts";
    const aiEntry: string = "/project/packages/workers/aiChatWorker.ts";
    const closures: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map([
      ["main", new Map([[cachePath, ["/project/index.ts", cachePath]]])],
      ["aiChat", new Map([[cachePath, [aiEntry, cachePath]]])],
    ]);
    const base = {
      projectRoot,
      cacheFiles: [cachePath],
      threadEntries: { main: "/project/index.ts", aiChat: aiEntry },
      threadClosures: closures,
      ownerByPrefix: [["packages/cache/main/", "main"]] as const,
    };

    expect(collectCacheOwnershipProblems({ ...base, exemptions: {} }))
      .toEqual([expect.stringContaining("owned by the main thread but is loaded by the aiChat thread")]);
    expect(collectCacheOwnershipProblems({
      ...base,
      exemptions: { "packages/cache/main/value.ts": ["aiChat"] },
    })).toEqual([]);
  });

  test("常量容器与模块级缓存识别保持 fail-closed", () => {
    const parsed: ts.SourceFile = source(
      "fixture.ts",
      "const VALUES: string[] = [], CACHE: Map<string, string> = new Map(), " +
      "SAFE: readonly string[] = [], HOLDER = { current: null }, SCALAR: number = 1, " +
      "FROZEN: Readonly<Record<string, string>> = Object.freeze({});"
    );
    const first: ts.VariableStatement = parsed.statements[0] as ts.VariableStatement;
    const values: ts.VariableDeclaration = first.declarationList.declarations[0]!;
    const cache: ts.VariableDeclaration = first.declarationList.declarations[1]!;
    const safe: ts.VariableDeclaration = first.declarationList.declarations[2]!;
    const holder: ts.VariableDeclaration = first.declarationList.declarations[3]!;
    const scalar: ts.VariableDeclaration = first.declarationList.declarations[4]!;
    const frozen: ts.VariableDeclaration = first.declarationList.declarations[5]!;

    expect(collectSharedConstantProblems(values.initializer!, values.type, "constant VALUES"))
      .toEqual([expect.stringContaining("must be declared with a readonly type")]);
    expect(collectSharedConstantProblems(safe.initializer!, safe.type, "constant SAFE"))
      .toEqual([]);
    expect(collectSharedConstantProblems(scalar.initializer!, scalar.type, "constant SCALAR"))
      .toEqual([]);
    expect(collectSharedConstantProblems(frozen.initializer!, frozen.type, "constant FROZEN"))
      .toEqual([expect.stringContaining("must not use Object.freeze")]);
    expect(moduleCacheInitializerKind(cache.initializer!)).toBe("Map");
    expect(moduleCacheInitializerKind(holder.initializer!)).toBe("holder");
    expect(moduleCacheInitializerKind(scalar.initializer!)).toBeNull();
  });

  test("源码文件收集只递归返回 TypeScript 文件", async () => {
    const root: string = temporaryRoot("copy-ninjia-source-analysis-");
    mkdirSync(join(root, "nested"), { recursive: true });
    await Bun.write(join(root, "root.ts"), "export {};\n");
    await Bun.write(join(root, "nested", "child.ts"), "export {};\n");
    await Bun.write(join(root, "nested", "ignored.tsx"), "export {};\n");
    await Bun.write(join(root, "ignored.js"), "export {};\n");

    expect(sourceFilesUnder(root).sort()).toEqual([
      join(root, "nested", "child.ts"),
      join(root, "root.ts"),
    ]);
  });

  test("源码节点识别器同时覆盖命中与近似但不应命中的语法", () => {
    const parsed: ts.SourceFile = source(
      "fixture.ts",
      "/** 共享值。 */\nexport const VALUE = Object.freeze({ ok: true });\n" +
      "const LOCAL = Reflect.freeze({ ok: true });\nfunction named(): void {}"
    );
    const exported: ts.VariableStatement = parsed.statements[0] as ts.VariableStatement;
    const local: ts.VariableStatement = parsed.statements[1] as ts.VariableStatement;
    const named: ts.FunctionDeclaration = parsed.statements[2] as ts.FunctionDeclaration;
    const exportedDeclaration: ts.VariableDeclaration =
      exported.declarationList.declarations[0]!;
    const localDeclaration: ts.VariableDeclaration = local.declarationList.declarations[0]!;

    expect(isExported(exported)).toBeTrue();
    expect(isExported(local)).toBeFalse();
    expect(hasJsDoc(exported)).toBeTrue();
    expect(hasJsDoc(local)).toBeFalse();
    expect(isObjectFreezeCall(exportedDeclaration.initializer!)).toBeTrue();
    expect(isObjectFreezeCall(localDeclaration.initializer!)).toBeFalse();
    expect(declarationName(exportedDeclaration)).toBe("VALUE");
    expect(declarationName(named)).toBe("named");
    expect(declarationName(parsed)).toBe("SourceFile");
  });

  test("Telegram 提示留存规则在临时模块图上逐类报错", async () => {
    const root: string = temporaryRoot("copy-ninjia-telegram-conventions-");
    const sourceRoot: string = join(root, "packages");
    const commandsRoot: string = join(sourceRoot, "commands");
    for (const directory of [
      join(commandsRoot, "gag"),
      join(commandsRoot, "qa"),
      join(commandsRoot, "luckChallenge"),
      join(sourceRoot, "copy"),
      join(sourceRoot, "workers", "antiRaid"),
    ]) mkdirSync(directory, { recursive: true });
    await Bun.write(join(commandsRoot, "gag.ts"), "");
    await Bun.write(join(commandsRoot, "gag", "notices.ts"), "");
    await Bun.write(join(commandsRoot, "qa", "notices.ts"), "");
    await Bun.write(join(sourceRoot, "copy", "avatarQueue.ts"), "");
    await Bun.write(
      join(commandsRoot, "bad.ts"),
      'import { sendMessage } from "../infra/telegram";\n' +
      "const options = { preserveInGroup: true };"
    );
    await Bun.write(
      join(commandsRoot, "luckChallenge", "inline.ts"),
      'import { sendCommandMessage } from "../../infra/telegram";'
    );
    await Bun.write(
      join(sourceRoot, "workers", "antiRaid", "verificationReminders.ts"),
      'import { sendCommandMessage } from "../../../infra/telegram";'
    );

    const problems: readonly string[] = await collectTelegramMessageProblems(
      root,
      sourceRoot,
      commandsRoot
    );
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining("command text must use sendCommandMessage"),
      expect.stringContaining("must also pass messageThreadId"),
      expect.stringContaining("state-owned button messages"),
    ]));
    expect(problems).toHaveLength(4);
  });

  test("冷迁移命令、入口与当前 schema 边必须同步", async () => {
    const root: string = temporaryRoot("copy-ninjia-conventions-");
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "packages", "consts"), { recursive: true });
    for (const locale of ["cn", "en", "ja"] as const) {
      mkdirSync(join(root, "docs", locale), { recursive: true });
    }
    await Bun.write(join(root, "scripts", "migrateQaThumbnail.ts"), "");
    await Bun.write(
      join(root, "scripts", "migrateTemporaryWhitelist.ts"),
      "// v5 → v7\n" +
      "function inspect(): 5 | 6 | 7 {\n" +
      "  const version: number = 7;\n" +
      "  if (version === 5) { return 5; }\n" +
      "  if (version === 6) { return 6; }\n" +
      "  if (version === 7) { return 7; }\n" +
      "  throw new Error();\n" +
      "}\n"
    );
    await Bun.write(
      join(root, "packages", "consts", "identityStorage.ts"),
      "export const IDENTITY_DATABASE_SCHEMA_VERSION: number = 7;\n"
    );
    for (const locale of ["cn", "en", "ja"] as const) {
      await Bun.write(
        join(root, "docs", locale, "05-dev-workflow.md"),
        "temporary allowlist schema v5 → v7\n"
      );
      await Bun.write(
        join(root, "docs", locale, "07-operations.md"),
        "current schema v7; direct v5 → v7; v6 is a resumable intermediate lineage\n"
      );
    }
    await Bun.write(join(root, "package.json"), JSON.stringify({
      scripts: {
        "migrate:qa-thumbnail": "bun scripts/migrateQaThumbnail.ts",
        "migrate:temporary-whitelist": "bun scripts/migrateTemporaryWhitelist.ts",
      },
    }));
    expect(await collectColdMigrationProblems(root)).toEqual([]);

    await Bun.write(
      join(root, "docs", "cn", "07-operations.md"),
      "current schema v6; direct v5 → v6\n"
    );
    expect(await collectColdMigrationProblems(root)).toEqual(expect.arrayContaining([
      expect.stringContaining("docs/cn/07-operations.md must document schema v7"),
    ]));

    await Bun.write(join(root, "package.json"), JSON.stringify({
      scripts: {
        "migrate:qa-thumbnail": "node scripts/migrateQaThumbnail.ts",
        "migrate:legacy": "bun scripts/legacy.ts",
      },
    }));
    const problems: readonly string[] = await collectColdMigrationProblems(root);
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining("exactly the declared active cold migration commands"),
      expect.stringContaining("migrate:qa-thumbnail must invoke bun scripts/migrateQaThumbnail.ts"),
    ]));
  });
});

describe("逐文件源码规则", () => {
  const projectRoot: string = "/project";

  function rule(path: string, text: string): { projectRoot: string; path: string; source: ts.SourceFile } {
    return { projectRoot, path, source: source(path, text) };
  }

  test("cache 导出与模块生命周期字段都由 JSDoc 门禁", () => {
    const path: string = "/project/packages/cache/main/example.ts";
    const complete: string = [
      "/**",
      " * 启动时填充，停止时清空；Worker 重建后恢复为空。",
      " * 容量固定为一个，不淘汰有效值。",
      " */",
      "/** 当前值。 */",
      "export const documented: number = 1;",
      "",
    ].join("\n");
    expect(collectCacheJsDocProblems(rule(path, complete)))
      .toEqual([]);
    expect(collectCacheJsDocProblems(rule(
      path,
      "/** 只有一句说明。 */\nexport const bare: number = 1;\nexport interface Bare { readonly a: number }\n"
    ))).toEqual([
      "packages/cache/main/example.ts:3 export Bare lacks JSDoc",
      "packages/cache/main/example.ts:1 cache module JSDoc lacks lifecycle field fill",
      "packages/cache/main/example.ts:1 cache module JSDoc lacks lifecycle field clear",
      "packages/cache/main/example.ts:1 cache module JSDoc lacks lifecycle field rebuild",
      "packages/cache/main/example.ts:1 cache module JSDoc lacks lifecycle field capacity",
      "packages/cache/main/example.ts:1 cache module JSDoc lacks lifecycle field eviction",
    ]);
    expect(collectCacheJsDocProblems(rule(
      path,
      "export const bare: number = 1;\nexport interface Bare { readonly a: number }\n"
    ))).toEqual([
      "packages/cache/main/example.ts:1 export bare lacks JSDoc",
      "packages/cache/main/example.ts:2 export Bare lacks JSDoc",
      "packages/cache/main/example.ts:1 cache module JSDoc lacks lifecycle field fill",
      "packages/cache/main/example.ts:1 cache module JSDoc lacks lifecycle field clear",
      "packages/cache/main/example.ts:1 cache module JSDoc lacks lifecycle field rebuild",
      "packages/cache/main/example.ts:1 cache module JSDoc lacks lifecycle field capacity",
      "packages/cache/main/example.ts:1 cache module JSDoc lacks lifecycle field eviction",
    ]);
  });

  test("consts 常量要 SCREAMING_SNAKE_CASE、显式类型与 JSDoc", () => {
    const path: string = "/project/packages/consts/example.ts";
    expect(collectConstantProblems(rule(path, "/** 说明。 */\nexport const GOOD_NAME: number = 1;\n")))
      .toEqual([]);
    expect(collectConstantProblems(rule(path, "export const badName = 1;\n"))).toEqual([
      "packages/consts/example.ts:1 constant badName is not SCREAMING_SNAKE_CASE",
      "packages/consts/example.ts:1 constant badName lacks an explicit type",
      "packages/consts/example.ts:1 constant badName lacks JSDoc",
    ]);
  });

  test("Object.freeze 在 packages/ 下一处都不许有", () => {
    const path: string = "/project/packages/example.ts";
    expect(collectObjectFreezeProblems(rule(path, "export const A: number = 1;\n"))).toEqual([]);
    expect(collectObjectFreezeProblems(rule(path, "const a = Object.freeze({ x: 1 });\n")))
      .toEqual([expect.stringContaining("packages/example.ts:1 Object.freeze is not allowed")]);
  });

  test("模块级 Map/Set/holder 必须落在 packages/cache/<owner>/", () => {
    const path: string = "/project/packages/example.ts";
    expect(collectModuleCacheProblems(rule(path, "function f(): Map<string, number> { return new Map(); }\n")))
      .toEqual([]);
    expect(collectModuleCacheProblems(rule(path, "const table: Map<string, number> = new Map();\n")))
      .toEqual([
        "packages/example.ts:1 module-level Map table must be declared under packages/cache/<owner>/",
      ]);
  });

  test("声明规范：类型入口、console.error 边界、返回类型、内联对象参数与 catch 标注", () => {
    const path: string = "/project/packages/example.ts";
    expect(collectDeclarationProblems(rule(
      path,
      "import type { A } from \"./types/domain\";\n" +
      "export function ok(value: A): number {\n" +
      "  try { return 1; } catch (error: unknown) { return Number(Boolean(error)); }\n" +
      "}\n"
    ))).toEqual([]);

    const problems: readonly string[] = collectDeclarationProblems(rule(
      path,
      "import type { A } from \"./types\";\n" +
      "export function bad(options: { a: number }) {\n" +
      "  try { console.error(options.a); } catch (error) { void error; }\n" +
      "  return 1;\n" +
      "}\n"
    ));
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining("must import from a domain type module instead of types/index"),
      expect.stringContaining("direct console.error is restricted to the disk I/O Worker boundary"),
      expect.stringContaining("exported function bad lacks an explicit return type"),
      expect.stringContaining("inline object parameter type must be an exported XxxParams interface"),
      expect.stringContaining("catch binding error must be explicitly typed unknown"),
    ]));
  });

  test("diskIO Worker 边界仍然允许 console.error", () => {
    const path: string = "/project/packages/workers/diskIO/files.ts";
    expect(collectDeclarationProblems(rule(path, "export function log(): void { console.error(\"x\"); }\n")))
      .toEqual([]);
  });

  test("Worker isolate 内的 timer 必须逐个句柄 unref", () => {
    const projectRoot: string = "/project";
    const path: string = "/project/packages/workers/antiRaid/lockdownRuntime.ts";
    const message = (line: number, kind: string): string =>
      `packages/workers/antiRaid/lockdownRuntime.ts:${line} installs a worker ${kind} ` +
      "without unref(): worker timers must not hold the isolate event loop open";

    // 合规形态一：装进 entry 字段后就地 unref。
    expect(collectWorkerTimerProblems(projectRoot, path, source(
      path,
      "function schedule(): void {\n" +
      "  entry.timer = setTimeout((): void => { fire(); }, 1000);\n" +
      "  entry.timer.unref();\n" +
      "}\n"
    ))).toEqual([]);

    // 合规形态二：先落成局部变量再返回。
    expect(collectWorkerTimerProblems(projectRoot, path, source(
      path,
      "function start(): ReturnType<typeof setTimeout> {\n" +
      "  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => { fire(); }, 1000);\n" +
      "  timer.unref();\n" +
      "  return timer;\n" +
      "}\n"
    ))).toEqual([]);

    // setInterval 与 holder 形态同样受约束。
    expect(collectWorkerTimerProblems(projectRoot, path, source(
      path,
      "function tick(): void {\n" +
      "  holder.current = setInterval((): void => { sweep(); }, 1000);\n" +
      "  holder.current.unref();\n" +
      "}\n"
    ))).toEqual([]);

    // 漏 unref 点名到行。
    expect(collectWorkerTimerProblems(projectRoot, path, source(
      path,
      "function schedule(): void {\n" +
      "  entry.timer = setTimeout((): void => { fire(); }, 1000);\n" +
      "}\n"
    ))).toEqual([message(2, "setTimeout")]);

    // 别的函数里的 unref 不算数。
    expect(collectWorkerTimerProblems(projectRoot, path, source(
      path,
      "function schedule(): void {\n" +
      "  entry.timer = setTimeout((): void => { fire(); }, 1000);\n" +
      "}\n" +
      "function stop(): void {\n" +
      "  entry.timer.unref();\n" +
      "}\n"
    ))).toEqual([message(2, "setTimeout")]);

    // 回归：同一函数里装多个 timer 时，逐个句柄核对——不得被同函数里
    // 另一个句柄的 unref 掩盖（startVerificationTimer、runLockdownEffects 都是
    // 这种形态）。
    expect(collectWorkerTimerProblems(projectRoot, path, source(
      path,
      "function startTwo(): void {\n" +
      "  const first: ReturnType<typeof setTimeout> = setTimeout((): void => { a(); }, 1);\n" +
      "  const second: ReturnType<typeof setTimeout> = setTimeout((): void => { b(); }, 2);\n" +
      "  second.unref();\n" +
      "}\n"
    ))).toEqual([message(2, "setTimeout")]);

    // 回归：同一目标被连续写两次时，前一次必须在被覆盖之前 unref。
    expect(collectWorkerTimerProblems(projectRoot, path, source(
      path,
      "function scheduleTwice(): void {\n" +
      "  entry.retryTimer = setTimeout((): void => { a(); }, 1);\n" +
      "  entry.retryTimer = setTimeout((): void => { b(); }, 2);\n" +
      "  entry.retryTimer.unref();\n" +
      "}\n"
    ))).toEqual([message(2, "setTimeout")]);

    // 句柄没有落点：直接 return 的写法根本无从 unref。
    expect(collectWorkerTimerProblems(projectRoot, path, source(
      path,
      "function start(): ReturnType<typeof setTimeout> {\n" +
      "  return setTimeout((): void => { fire(); }, 1000);\n" +
      "}\n"
    ))).toEqual([
      "packages/workers/antiRaid/lockdownRuntime.ts:2 installs a worker setTimeout " +
      "without keeping the handle: assign it before returning so it can be unref()ed",
    ]);

    // Worker 入口文件（直接位于 packages/workers/ 下）同样在范围内。
    const entryPath: string = "/project/packages/workers/antiRaidWorker.ts";
    expect(collectWorkerTimerProblems(projectRoot, entryPath, source(
      entryPath,
      "function startWorker(): void {\n" +
      "  holder.current = setInterval(sweep, 1000);\n" +
      "}\n"
    ))).toEqual([
      "packages/workers/antiRaidWorker.ts:2 installs a worker setInterval " +
      "without unref(): worker timers must not hold the isolate event loop open",
    ]);
  });
});

describe("注释交叉引用核对", () => {
  /** 造一棵最小的假仓库：projectRoot/packages/<相对路径>。 */
  function fixture(files: Readonly<Record<string, string>>): {
    readonly projectRoot: string;
    readonly allSourceFiles: readonly string[];
  } {
    const projectRoot: string = temporaryRoot("comment-references-");
    const allSourceFiles: string[] = [];
    for (const [relativePath, text] of Object.entries(files)) {
      const absolute: string = join(projectRoot, "packages", relativePath);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, text);
      allSourceFiles.push(absolute);
    }
    return { projectRoot, allSourceFiles };
  }

  test("被点名的模块没有该符号时报告", async () => {
    const { projectRoot, allSourceFiles } = fixture({
      "libs/time.ts": "export function formatTokyoTime(): string { return \"\"; }\n",
    });
    const problems: readonly string[] = await collectCommentReferenceProblems({
      projectRoot,
      path: join(projectRoot, "packages", "caller.ts"),
      source: source("caller.ts", "/** 见 libs/time.ts 的 getTokyoHour。 */\nexport const x: number = 1;\n"),
      allSourceFiles,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("comment references getTokyoHour in libs/time.ts");
  });

  test("符号仍在时不报告", async () => {
    const { projectRoot, allSourceFiles } = fixture({
      "libs/time.ts": "export function getTokyoHour(): number { return 0; }\n",
    });
    expect(await collectCommentReferenceProblems({
      projectRoot,
      path: join(projectRoot, "packages", "caller.ts"),
      source: source("caller.ts", "/** 见 libs/time.ts 的 getTokyoHour。 */\nexport const x: number = 1;\n"),
      allSourceFiles,
    })).toEqual([]);
  });

  test("经 export * 兼容入口再导出的符号算数", async () => {
    const { projectRoot, allSourceFiles } = fixture({
      "types/diskIO/messages.ts": "export interface RecoveryReplayRequest { readonly id: number }\n",
      "types/diskIO.ts": 'export type * from "./diskIO/messages";\n',
    });
    expect(await collectCommentReferenceProblems({
      projectRoot,
      path: join(projectRoot, "packages", "caller.ts"),
      source: source("caller.ts", "/** 见 types/diskIO.ts 的 RecoveryReplayRequest。 */\nexport const x: number = 1;\n"),
      allSourceFiles,
    })).toEqual([]);
  });

  test("非注释行里的同形文本不参与判定", async () => {
    const { projectRoot, allSourceFiles } = fixture({
      "libs/time.ts": "export function getTokyoHour(): number { return 0; }\n",
    });
    expect(await collectCommentReferenceProblems({
      projectRoot,
      path: join(projectRoot, "packages", "caller.ts"),
      source: source("caller.ts", 'export const note: string = "libs/time.ts 的 missingSymbol";\n'),
      allSourceFiles,
    })).toEqual([]);
  });

  test("解析不到唯一目标的引用一律放过", async () => {
    const { projectRoot, allSourceFiles } = fixture({
      "a/shared.ts": "export const a: number = 1;\n",
      "b/shared.ts": "export const b: number = 2;\n",
    });
    expect(await collectCommentReferenceProblems({
      projectRoot,
      path: join(projectRoot, "packages", "caller.ts"),
      source: source("caller.ts", "/** 见 shared.ts 的 whatever。 */\nexport const x: number = 1;\n"),
      allSourceFiles,
    })).toEqual([]);
  });
});
