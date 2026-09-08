import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Stats } from "node:fs";
import { openStorageDatabase } from "../packages/database/interact/connection";
import { atomicWriteText, syncDirectory } from "../packages/libs/atomicFile";
import { InputValidationError, invalidInput, readUtf8TextInput } from "../packages/libs/inputValidation";
import { isErrno } from "../packages/libs/errno";
import type { StorageDatabase } from "../packages/types/storageDatabase";
import { migrateTranslationDatabase } from "./migrations/translate/database";
import { migrateTranslationState, TranslationStateMigrationError } from "./migrations/translate/state";
import { TRANSLATE_MIGRATION_SOURCE_RELEASE, TRANSLATE_MIGRATION_TARGET_SCHEMA } from "./migrations/translate/consts";

/** 停机备份中参与本次直接迁移的文件；SQLite 旁路文件必须来自同一一致性点。 */
const SOURCE_FILES: readonly string[] = ["state.json", "state.json.bak", "database/storage.sqlite", "database/storage.sqlite-wal", "database/storage.sqlite-shm"];
/** 只有这三份产物替换部署文件；ready.json 仅为校验清单。 */
const OUTPUT_FILES: readonly string[] = ["state.json", "state.json.bak", "database/storage.sqlite"];
/** 暂存目录仅当前账号可进入，部署权限由运维按清单手工恢复。 */
const STAGING_DIRECTORY_MODE: number = 0o700;
/** 校验清单与文本暂存文件只允许当前账号读写。 */
const STAGING_FILE_MODE: number = 0o600;

export interface TranslationMigrationOptions {
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly from: string;
}

export interface MigrationFileRecord {
  readonly path: string;
  readonly sha256: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

export interface TranslationMigrationResult {
  readonly sourceRelease: string;
  readonly targetSchema: number;
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly sourceFiles: readonly MigrationFileRecord[];
  readonly outputFiles: readonly MigrationFileRecord[];
}

/** 文件清单只记录相对路径、哈希与元数据，不输出部署内容。 */
async function fileRecord(root: string, path: string): Promise<MigrationFileRecord> {
  const fullPath: string = join(root, path);
  const stats: Stats = await lstat(fullPath);
  if (!stats.isFile()) return invalidInput(fullPath, "$type", "a regular file without symbolic links");
  return {
    path,
    sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(fullPath).bytes()).digest("hex"),
    mode: stats.mode & 0o7777,
    uid: stats.uid,
    gid: stats.gid,
  };
}

/** 只允许 SQLite 旁路文件真正缺省；悬空链接、类型不符和读取失败均拒绝。 */
async function sourceFileRecords(root: string): Promise<readonly MigrationFileRecord[]> {
  const records: MigrationFileRecord[] = [];
  for (const path of SOURCE_FILES) {
    try {
      records.push(await fileRecord(root, path));
    } catch (error: unknown) {
      if (!(path.endsWith("-wal") || path.endsWith("-shm")) || !isErrno(error, "ENOENT")) throw error;
    }
  }
  return records;
}

function isInside(parent: string, child: string): boolean {
  const path: string = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"));
}

/**
 * 从 10.5.4 停机备份生成独立产物；不改源文件，不覆盖既有目录，不执行服务操作。
 * ready.json 只在全部校验及源哈希复核后产生。中断后保留目录，换新 outputRoot 重跑。
 * 部署方按 docs/cn/04-invariants.md 的持久化边界手工替换主备及 SQLite 一致性点。
 */
export async function prepareTranslationMigration({ sourceRoot, outputRoot, from }: TranslationMigrationOptions): Promise<TranslationMigrationResult> {
  if (from !== TRANSLATE_MIGRATION_SOURCE_RELEASE) return invalidInput("--from", "$", "release 10.5.4");
  const source: string = await realpath(sourceRoot);
  const output: string = join(await realpath(dirname(resolve(outputRoot))), basename(resolve(outputRoot)));
  if (isInside(source, output) || isInside(output, source)) return invalidInput(output, "$path", "a new directory outside the source backup");
  const databaseDirectory: Stats = await lstat(join(source, "database"));
  if (!databaseDirectory.isDirectory() || databaseDirectory.isSymbolicLink()) return invalidInput(source, "database", "a directory without symbolic links");
  const sourceFiles: readonly MigrationFileRecord[] = await sourceFileRecords(source);
  const primary: string = migrateTranslationState(await readUtf8TextInput(join(source, "state.json")), join(source, "state.json"));
  const backup: string = migrateTranslationState(await readUtf8TextInput(join(source, "state.json.bak")), join(source, "state.json.bak"));
  await mkdir(output, { mode: STAGING_DIRECTORY_MODE });
  await mkdir(join(output, "database"), { mode: STAGING_DIRECTORY_MODE });
  await atomicWriteText(join(output, "incomplete.json"), JSON.stringify({ from, sourceFiles }, null, 2), STAGING_FILE_MODE);
  for (const record of sourceFiles) {
    if (record.path.startsWith("database/")) {
      const target: string = join(output, record.path);
      await Bun.write(target, Bun.file(join(source, record.path)));
      if ((await fileRecord(output, record.path)).sha256 !== record.sha256) return invalidInput(target, "$sha256", "an exact copy of the source file");
    }
  }
  const databasePath: string = join(output, "database/storage.sqlite");
  const database: StorageDatabase = openStorageDatabase({ path: databasePath });
  try {
    migrateTranslationDatabase(database, databasePath);
  } finally {
    database.$client.close(true);
  }
  await syncDirectory(databasePath);
  await atomicWriteText(join(output, "state.json"), primary, STAGING_FILE_MODE);
  await atomicWriteText(join(output, "state.json.bak"), backup, STAGING_FILE_MODE);
  if (JSON.stringify(await sourceFileRecords(source)) !== JSON.stringify(sourceFiles)) {
    return invalidInput(source, "$snapshot", "an unchanged cold backup including metadata and SQLite sidecars");
  }
  const outputFiles: MigrationFileRecord[] = [];
  for (const path of OUTPUT_FILES) outputFiles.push(await fileRecord(output, path));
  const result: TranslationMigrationResult = {
    sourceRelease: from, targetSchema: TRANSLATE_MIGRATION_TARGET_SCHEMA,
    sourceRoot: source, outputRoot: output, sourceFiles, outputFiles,
  };
  await Bun.file(join(output, "incomplete.json")).delete();
  await atomicWriteText(join(output, "ready.json"), `${JSON.stringify(result, null, 2)}\n`, STAGING_FILE_MODE);
  return result;
}

/** CLI 不接受默认部署根；源备份与产物目录都必须明确提供。 */
function parseArguments(args: readonly string[]): TranslationMigrationOptions {
  const values: Map<string, string> = new Map();
  for (let index: number = 0; index < args.length; index += 2) {
    const key: string | undefined = args[index];
    const value: string | undefined = args[index + 1];
    if (key === undefined || !["--source-root", "--output-root", "--from"].includes(key) ||
      values.has(key) || value === undefined || value.trim().length === 0 || value.startsWith("--")) {
      return invalidInput("arguments", "$", "--from 10.5.4 --source-root <cold-backup> --output-root <new-directory>");
    }
    values.set(key, value);
  }
  const sourceRoot: string | undefined = values.get("--source-root");
  const outputRoot: string | undefined = values.get("--output-root");
  const from: string | undefined = values.get("--from");
  if (sourceRoot === undefined || outputRoot === undefined || from === undefined) return invalidInput("arguments", "$", "all three required options");
  return { sourceRoot, outputRoot, from };
}

if (import.meta.main) {
  if (Bun.argv.slice(2).length === 1 && Bun.argv[2] === "--help") {
    console.log("bun run migrate:translate --from 10.5.4 --source-root <cold-backup> --output-root <new-directory>\n" +
      "Stop the service and verify inactive before taking an external backup, including state.json, state.json.bak and SQLite WAL/SHM.\n" +
      "The source remains unchanged. Only ready.json marks validated output; after interruption rerun into a new output directory.\n" +
      "Verify output hashes, then manually replace both state files and SQLite while stopped. Remove stale deployment WAL/SHM only after preserving the backup.\n" +
      "Restore original ownership/modes from sourceFiles; ensure the service can write SQLite and its directory.\n" +
      "Validate configuration and state before startup; retain the backup until service stability is confirmed.");
  } else {
    try {
      const result: TranslationMigrationResult = await prepareTranslationMigration(parseArguments(Bun.argv.slice(2)));
      console.log(`Translation migration prepared: ${result.outputRoot}/ready.json. Manual replacement while stopped is required.`);
    } catch (error: unknown) {
      console.error(error instanceof InputValidationError || error instanceof TranslationStateMigrationError
        ? error.message
        : "Translation migration failed; source backup and incomplete output are retained. No deployment files were replaced.");
      process.exitCode = 1;
    }
  }
}
