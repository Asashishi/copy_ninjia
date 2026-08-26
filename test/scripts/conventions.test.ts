import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { collectCacheOwnershipProblems } from "../../scripts/conventions/cacheOwnership";
import { collectColdMigrationProblems } from "../../scripts/conventions/coldMigrations";
import { collectNodeCompatibilityProblems } from "../../scripts/conventions/nodeCompatibility";
import { collectTelegramMessageProblems } from "../../scripts/conventions/telegramMessages";
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
  test("Node 兼容白名单只放行已核对的模块与命名导入", () => {
    const projectRoot: string = "/project";
    const path: string = "/project/packages/example.ts";
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      path,
      source(path, 'import { readFileSync } from "node:fs";\nimport { join } from "node:path";')
    )).toEqual([]);

    const problems: readonly string[] = collectNodeCompatibilityProblems(
      projectRoot,
      path,
      source(path, 'import * as fs from "node:fs";\nimport { readFile } from "node:fs/promises";\nimport { exec } from "node:child_process";')
    );
    expect(problems).toEqual([
      expect.stringContaining("must not namespace-import node:fs"),
      expect.stringContaining("unreviewed node:fs/promises export readFile"),
      expect.stringContaining("unreviewed Node compatibility module node:child_process"),
    ]);

    const scriptPath: string = "/project/scripts/example.ts";
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      scriptPath,
      source(scriptPath, 'import { rmSync } from "node:fs";\nimport { tmpdir } from "node:os";')
    )).toEqual([]);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      path,
      source(path, 'import { rmSync } from "node:fs";\nimport { tmpdir } from "node:os";')
    )).toEqual([
      expect.stringContaining("unreviewed node:fs export rmSync"),
      expect.stringContaining("unreviewed node:os export tmpdir"),
    ]);

    const backupPath: string = "/project/scripts/migration/backup.ts";
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      backupPath,
      source(backupPath, 'import { readFileSync, writeFileSync } from "node:fs";')
    )).toEqual([]);
    expect(collectNodeCompatibilityProblems(
      projectRoot,
      scriptPath,
      source(scriptPath, 'import { readFileSync, writeFileSync } from "node:fs";')
    )).toEqual([
      expect.stringContaining("unreviewed node:fs export readFileSync"),
      expect.stringContaining("unreviewed node:fs export writeFileSync"),
    ]);
  });

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
    await Bun.write(join(root, "scripts", "migrateQaThumbnail.ts"), "");
    await Bun.write(join(root, "package.json"), JSON.stringify({
      scripts: {
        "migrate:qa-thumbnail": "bun scripts/migrateQaThumbnail.ts",
      },
    }));
    expect(await collectColdMigrationProblems(root)).toEqual([]);

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
