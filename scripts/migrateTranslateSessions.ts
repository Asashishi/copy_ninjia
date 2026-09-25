import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Stats } from "node:fs";
import { openStorageDatabase } from "../packages/database/interact/connection";
import { atomicWriteText, syncDirectory } from "../packages/libs/atomicFile";
import { InputValidationError, invalidInput, parseJsonInput } from "../packages/libs/inputValidation";
import { decodeStateFile } from "../packages/libs/stateFileCodec";
import type { StorageDatabase } from "../packages/types/storageDatabase";
import {
  migrationPathContains,
  readMigrationFileRecord,
  readMigrationFileRecords,
} from "./migrations/files";
import type { MigrationFileRecord } from "./migrations/files";
import { migrateTranslateSessionsDatabase } from "./migrations/translateSessions/database";
import type { TranslateSessionMigrationCounts } from "./migrations/translateSessions/database";
import { splitStateDocument } from "./migrations/translateSessions/state";
import type { SplitStateDocument } from "./migrations/translateSessions/state";

/** 停机备份中参与本次迁移的文件；SQLite 旁路文件必须来自同一一致性点。 */
const SOURCE_FILES: readonly string[] = [
  "state.json",
  "state.json.bak",
  "database/storage.sqlite",
  "database/storage.sqlite-wal",
  "database/storage.sqlite-shm",
];
/** 允许真正缺省的源文件：state 备份副本与 SQLite 旁路文件。 */
const OPTIONAL_SOURCE_FILES: ReadonlySet<string> = new Set([
  "state.json.bak",
  "database/storage.sqlite-wal",
  "database/storage.sqlite-shm",
]);
/** 暂存目录仅当前账号可进入，部署权限由运维按清单手工恢复。 */
const STAGING_DIRECTORY_MODE: number = 0o700;
/** 产物与校验清单只允许当前账号读写。 */
const STAGING_FILE_MODE: number = 0o600;
/** 与 StateStore 落盘一致的 JSON 缩进。 */
const STATE_JSON_INDENT: number = 2;

export interface TranslateSessionsMigrationOptions {
  readonly sourceRoot: string;
  readonly outputRoot: string;
}

export interface TranslateSessionsMigrationResult extends TranslateSessionMigrationCounts {
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly sourceFiles: readonly MigrationFileRecord[];
  readonly outputFiles: readonly MigrationFileRecord[];
}

/** 读取并拆分一份源 state 文档；文件缺省时返回 null。 */
async function readStateDocument(root: string, path: string, records: readonly MigrationFileRecord[]): Promise<SplitStateDocument | null> {
  if (!records.some((record: MigrationFileRecord): boolean => record.path === path)) return null;
  const fullPath: string = join(root, path);
  return splitStateDocument(parseJsonInput(await Bun.file(fullPath).text(), fullPath), fullPath);
}

/** 写出去掉 translate 的 state 文档，并用当前解码器复验。 */
async function writeStateDocument(output: string, path: string, split: SplitStateDocument): Promise<void> {
  const target: string = join(output, path);
  const text: string = JSON.stringify(split.document, null, STATE_JSON_INDENT);
  await atomicWriteText(target, text, STAGING_FILE_MODE);
  decodeStateFile(parseJsonInput(await Bun.file(target).text(), target), target);
}

/**
 * 从迁移前格式的停机备份生成独立产物：主 state.json 的翻译会话写入 chat_states，
 * state.json 与备份副本去掉 translate 块。不改源文件，不覆盖既有目录，不执行服务操作。
 * ready.json 只在全部校验及源哈希复核后产生；中断后保留目录，换新 outputRoot 重跑。
 * 部署方按清单在停服期间手工替换 state.json、state.json.bak 与 SQLite。
 */
export async function prepareTranslateSessionsMigration({
  sourceRoot,
  outputRoot,
}: TranslateSessionsMigrationOptions): Promise<TranslateSessionsMigrationResult> {
  const source: string = await realpath(sourceRoot);
  const output: string = join(await realpath(dirname(resolve(outputRoot))), basename(resolve(outputRoot)));
  if (migrationPathContains(source, output) || migrationPathContains(output, source)) {
    return invalidInput(output, "$path", "a new directory outside the source backup");
  }
  const databaseDirectory: Stats = await lstat(join(source, "database"));
  if (!databaseDirectory.isDirectory() || databaseDirectory.isSymbolicLink()) {
    return invalidInput(source, "database", "a directory without symbolic links");
  }
  const sourceFiles: readonly MigrationFileRecord[] = await readMigrationFileRecords(source, SOURCE_FILES, OPTIONAL_SOURCE_FILES);
  const primary: SplitStateDocument | null = await readStateDocument(source, "state.json", sourceFiles);
  if (primary === null) return invalidInput(join(source, "state.json"), "$type", "a regular file");
  const backup: SplitStateDocument | null = await readStateDocument(source, "state.json.bak", sourceFiles);

  await mkdir(output, { mode: STAGING_DIRECTORY_MODE });
  await mkdir(join(output, "database"), { mode: STAGING_DIRECTORY_MODE });
  await atomicWriteText(join(output, "incomplete.json"), JSON.stringify({ sourceFiles }, null, 2), STAGING_FILE_MODE);
  for (const record of sourceFiles) {
    if (!record.path.startsWith("database/")) continue;
    const target: string = join(output, record.path);
    await Bun.write(target, Bun.file(join(source, record.path)));
    if ((await readMigrationFileRecord(output, record.path)).sha256 !== record.sha256) {
      return invalidInput(target, "$sha256", "an exact copy of the source file");
    }
  }
  const databasePath: string = join(output, "database/storage.sqlite");
  const database: StorageDatabase = openStorageDatabase({ path: databasePath });
  let counts: TranslateSessionMigrationCounts;
  try {
    counts = migrateTranslateSessionsDatabase(database, databasePath, primary.sessions);
  } finally {
    database.$client.close(true);
  }
  await syncDirectory(databasePath);
  await writeStateDocument(output, "state.json", primary);
  if (backup !== null) await writeStateDocument(output, "state.json.bak", backup);
  if (JSON.stringify(await readMigrationFileRecords(source, SOURCE_FILES, OPTIONAL_SOURCE_FILES)) !== JSON.stringify(sourceFiles)) {
    return invalidInput(source, "$snapshot", "an unchanged cold backup including metadata and SQLite sidecars");
  }
  const outputPaths: readonly string[] = backup === null
    ? ["state.json", "database/storage.sqlite"]
    : ["state.json", "state.json.bak", "database/storage.sqlite"];
  const outputFiles: readonly MigrationFileRecord[] = await readMigrationFileRecords(output, outputPaths, new Set());
  const result: TranslateSessionsMigrationResult = {
    ...counts, sourceRoot: source, outputRoot: output, sourceFiles, outputFiles,
  };
  await atomicWriteText(join(output, "ready.json"), `${JSON.stringify(result, null, 2)}\n`, STAGING_FILE_MODE);
  await Bun.file(join(output, "incomplete.json")).delete();
  return result;
}

/** CLI 不接受默认部署根；源备份与产物目录都必须明确提供。 */
function parseArguments(args: readonly string[]): TranslateSessionsMigrationOptions {
  const values: Map<string, string> = new Map();
  for (let index: number = 0; index < args.length; index += 2) {
    const key: string | undefined = args[index];
    const value: string | undefined = args[index + 1];
    if (key === undefined || !["--source-root", "--output-root"].includes(key) ||
      values.has(key) || value === undefined || value.trim().length === 0 || value.startsWith("--")) {
      return invalidInput("arguments", "$", "--source-root <cold-backup> --output-root <new-directory>");
    }
    values.set(key, value);
  }
  const sourceRoot: string | undefined = values.get("--source-root");
  const outputRoot: string | undefined = values.get("--output-root");
  if (sourceRoot === undefined || outputRoot === undefined) return invalidInput("arguments", "$", "both required options");
  return { sourceRoot, outputRoot };
}

if (import.meta.main) {
  if (Bun.argv.slice(2).length === 1 && Bun.argv[2] === "--help") {
    console.log("bun run migrate:translate-sessions --source-root <cold-backup> --output-root <new-directory>\n" +
      "Stop the service and verify inactive before taking an external backup of state.json, state.json.bak and database/ including SQLite WAL/SHM.\n" +
      "The source remains unchanged. Only ready.json marks validated output; after interruption rerun into a new output directory.\n" +
      "Translation sessions from the primary state.json move into chat_states; both state files lose their translate block.\n" +
      "Verify output hashes, then manually replace state.json, state.json.bak and SQLite while stopped. Remove stale deployment WAL/SHM only after preserving the backup.\n" +
      "Restore original ownership/modes from sourceFiles; ensure the service can write SQLite, its directory and the state files.\n" +
      "Validate configuration and state before startup; retain the backup until service stability is confirmed.");
  } else {
    try {
      const result: TranslateSessionsMigrationResult = await prepareTranslateSessionsMigration(parseArguments(Bun.argv.slice(2)));
      console.log(`Translation session migration prepared: ${result.outputRoot}/ready.json. Manual replacement while stopped is required.`);
    } catch (error: unknown) {
      console.error(error instanceof InputValidationError
        ? error.message
        : "Translation session migration failed; source backup and incomplete output are retained. No deployment files were replaced.");
      process.exitCode = 1;
    }
  }
}
