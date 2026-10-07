import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Stats } from "node:fs";
import { openStorageDatabase } from "../packages/database/interact/connection";
import { atomicWriteText, syncDirectory } from "../packages/libs/atomicFile";
import { isErrno } from "../packages/libs/errno";
import { InputValidationError, invalidInput } from "../packages/libs/inputValidation";
import type { StorageDatabase } from "../packages/types/storageDatabase";
import { adoptTimeZone } from "../packages/config/time";
import { IDENTITY_DATABASE_SCHEMA_VERSION } from "../packages/consts/identityStorage";
import { TOKYO_TIME_ZONE } from "../packages/consts/time";
import { CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION, migrateChatPersonaRemovalDatabase } from "./migrations/chatPersonaRemoval/database";
import type { ChatPersonaRemovalMigrationCounts } from "./migrations/chatPersonaRemoval/database";
import { parseSourceOutputRoots } from "./migrations/cli";
import { migrationPathContains, readMigrationFileRecords } from "./migrations/files";
import type { MigrationFileRecord } from "./migrations/files";

/** 停机备份中参与本次直接迁移的文件；SQLite 旁路文件必须来自同一一致性点。 */
const SOURCE_FILES: readonly string[] = ["database/storage.sqlite", "database/storage.sqlite-wal", "database/storage.sqlite-shm"];
/** 只有 SQLite 产物替换部署文件；ready.json 仅为校验清单。 */
const OUTPUT_FILES: readonly string[] = ["database/storage.sqlite"];
/** 暂存目录仅当前账号可进入，部署权限由运维按清单手工恢复。 */
const STAGING_DIRECTORY_MODE: number = 0o700;
/** 校验清单只允许当前账号读写。 */
const STAGING_FILE_MODE: number = 0o600;
/** ready.json 与 incomplete.json 的 JSON 缩进。 */
const JSON_INDENT: number = 2;

export interface ChatPersonaRemovalMigrationOptions {
  readonly sourceRoot: string;
  readonly outputRoot: string;
}

export interface ChatPersonaRemovalMigrationResult extends ChatPersonaRemovalMigrationCounts {
  readonly sourceSchema: number;
  readonly targetSchema: number;
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly sourceFiles: readonly MigrationFileRecord[];
  readonly outputFiles: readonly MigrationFileRecord[];
}

/** 只允许 SQLite 旁路文件真正缺省；悬空链接、类型不符和读取失败均拒绝。 */
async function sourceFileRecords(root: string): Promise<readonly MigrationFileRecord[]> {
  const records: MigrationFileRecord[] = [];
  for (const path of SOURCE_FILES) {
    try {
      records.push(...await readMigrationFileRecords(root, [path]));
    } catch (error: unknown) {
      if (!(path.endsWith("-wal") || path.endsWith("-shm")) || !isErrno(error, "ENOENT")) throw error;
    }
  }
  return records;
}

/**
 * 从源 schema（`CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION`）停机备份生成独立的当前 schema
 * （`IDENTITY_DATABASE_SCHEMA_VERSION`）产物：直接删除 chat_states.ai_persona 列与 isCanConfigAiPrompt
 * 权限位，并写入 Asia/Tokyo 时区标记。不改源文件，不覆盖既有目录，不执行服务操作；ready.json 只在
 * 全部校验及源哈希复核后产生，中断后保留目录，换新 outputRoot 重跑。部署方停服期间按清单手工替换 SQLite。
 */
export async function prepareChatPersonaRemovalMigration({ sourceRoot, outputRoot }: ChatPersonaRemovalMigrationOptions): Promise<ChatPersonaRemovalMigrationResult> {
  const source: string = await realpath(sourceRoot);
  const output: string = join(await realpath(dirname(resolve(outputRoot))), basename(resolve(outputRoot)));
  if (migrationPathContains(source, output) || migrationPathContains(output, source)) {
    return invalidInput(output, "$path", "a new directory outside the source backup");
  }
  const databaseDirectory: Stats = await lstat(join(source, "database"));
  if (!databaseDirectory.isDirectory() || databaseDirectory.isSymbolicLink()) return invalidInput(source, "database", "a directory without symbolic links");
  const sourceFiles: readonly MigrationFileRecord[] = await sourceFileRecords(source);
  await mkdir(output, { mode: STAGING_DIRECTORY_MODE });
  await mkdir(join(output, "database"), { mode: STAGING_DIRECTORY_MODE });
  await atomicWriteText(join(output, "incomplete.json"), JSON.stringify({ sourceSchema: CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION, sourceFiles }, null, JSON_INDENT), STAGING_FILE_MODE);
  for (const record of sourceFiles) {
    const target: string = join(output, record.path);
    await Bun.write(target, Bun.file(join(source, record.path)));
    const [copied]: readonly MigrationFileRecord[] = await readMigrationFileRecords(output, [record.path]);
    if (copied?.sha256 !== record.sha256) return invalidInput(target, "$sha256", "an exact copy of the source file");
  }
  const databasePath: string = join(output, "database/storage.sqlite");
  const database: StorageDatabase = openStorageDatabase({ path: databasePath });
  let counts: ChatPersonaRemovalMigrationCounts;
  try {
    counts = migrateChatPersonaRemovalDatabase(database, databasePath);
  } finally {
    database.$client.close(true);
  }
  await syncDirectory(databasePath);
  if (JSON.stringify(await sourceFileRecords(source)) !== JSON.stringify(sourceFiles)) {
    return invalidInput(source, "$snapshot", "an unchanged cold backup including metadata and SQLite sidecars");
  }
  const outputFiles: readonly MigrationFileRecord[] = await readMigrationFileRecords(output, OUTPUT_FILES);
  const result: ChatPersonaRemovalMigrationResult = {
    sourceSchema: CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION, targetSchema: IDENTITY_DATABASE_SCHEMA_VERSION, ...counts,
    sourceRoot: source, outputRoot: output, sourceFiles, outputFiles,
  };
  await atomicWriteText(join(output, "ready.json"), `${JSON.stringify(result, null, JSON_INDENT)}\n`, STAGING_FILE_MODE);
  await Bun.file(join(output, "incomplete.json")).delete();
  return result;
}

if (import.meta.main) {
  if (Bun.argv.slice(2).length === 1 && Bun.argv[2] === "--help") {
    console.log("bun run migrate:chat-persona-removal --source-root <cold-backup> --output-root <new-directory>\n" +
      "Stop the service and verify inactive before taking an external backup of database/ including SQLite WAL/SHM, ownership, modes and SHA-256.\n" +
      "Only schema v11 is accepted. The ai_persona column and the isCanConfigAiPrompt permission are dropped; chats kept only by a persona are deleted.\n" +
      "The output is schema v13 bound to the Asia/Tokyo time zone; config/static/bot.json time_zone must stay Asia/Tokyo or startup is refused.\n" +
      "The source remains unchanged. Only ready.json marks validated output; after interruption rerun into a new output directory.\n" +
      "Verify output hashes, then manually replace database/storage.sqlite while stopped. Remove stale deployment WAL/SHM only after preserving the backup.\n" +
      "Restore original ownership/modes from sourceFiles; ensure the service can write SQLite and its directory.\n" +
      "Validate configuration and state before startup; retain the backup until service stability is confirmed.");
  } else {
    // 源谱系的日历固定为 `TOKYO_TIME_ZONE`；产物按同一时区接受与生产启动相同的完整校验。
    adoptTimeZone(TOKYO_TIME_ZONE);
    try {
      const result: ChatPersonaRemovalMigrationResult = await prepareChatPersonaRemovalMigration(parseSourceOutputRoots(Bun.argv.slice(2)));
      console.log(`Chat persona removal migration prepared: ${result.outputRoot}/ready.json. Manual replacement while stopped is required.`);
    } catch (error: unknown) {
      console.error(error instanceof InputValidationError
        ? error.message
        : "Chat persona removal migration failed; source backup and incomplete output are retained. No deployment files were replaced.");
      process.exitCode = 1;
    }
  }
}
