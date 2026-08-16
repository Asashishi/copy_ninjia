/** 旧身份 JSON 到 SQLite 的一次性冷迁移编排入口。 */

import { BOT_TOKEN } from "../packages/config/telegram";
import { RUNTIME_DATA_ROOT } from "../packages/consts/paths";
import {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock,
} from "../packages/infra/storage/instanceLock";
import { formatTokyoTime } from "../packages/libs/time";
import type { MigrationInput } from "../packages/types/identityStorageMigration";
import {
  assertSourceOwnership,
  backupMigrationSources,
  deleteOldIdentityStructures,
} from "./identityStorageMigration/backup";
import { createMigratedDatabase } from "./identityStorageMigration/database";
import { loadMigrationInput } from "./identityStorageMigration/input";
import {
  queryAllMetadata,
} from "./identityStorageMigration/telegram";
import type {
  QueriedMigrationInput,
} from "./identityStorageMigration/telegram";

export {
  insertMigratedRows,
  verifyDatabase,
} from "./identityStorageMigration/database";
export type {
  InsertMigratedRowsParams,
  VerifyDatabaseParams,
} from "./identityStorageMigration/database";
export {
  loadMigrationInput,
} from "./identityStorageMigration/input";
export type {
  LoadMigrationInputOptions,
} from "./identityStorageMigration/input";
export {
  isBotKickedFromChatError,
} from "./identityStorageMigration/telegram";

/** 取得部署锁后依序执行 Telegram 补全、外部备份、原子发布和旧结构删除。 */
async function applyMigration(input: MigrationInput): Promise<void> {
  assertSourceOwnership();
  await acquireSingleInstanceLock(BOT_TOKEN);
  try {
    const queried: QueriedMigrationInput = await queryAllMetadata(input);
    const backupRoot: string = backupMigrationSources();
    console.info(`Verified external migration backup at ${backupRoot}.`);
    createMigratedDatabase({
      input: queried.input,
      metadata: queried.metadata,
      blockedAt: formatTokyoTime(Date.now()),
    });
    deleteOldIdentityStructures();
    console.info(
      `Identity storage migration complete: ${queried.input.whitelist.size} whitelist, ` +
      `${queried.input.blockedIds.length} blocklist, ` +
      `${queried.input.removals.size} pending removal row(s), ` +
      `${queried.droppedKickedWhitelistCount} kicked whitelist identity row(s) dropped. ` +
      `External backup retained at ${backupRoot}.`
    );
  } finally {
    await releaseSingleInstanceLock(BOT_TOKEN);
  }
}

async function main(): Promise<void> {
  const args: string[] = Bun.argv.slice(2);
  if (args.some(
    (argument: string): boolean =>
      argument !== "--apply" && argument !== "--check"
  )) {
    throw new Error(
      "Usage: bun scripts/migrateIdentityStorageToSqlite.ts [--check|--apply]"
    );
  }
  if (args.includes("--apply") && args.includes("--check")) {
    throw new Error("Use exactly one of --check or --apply.");
  }
  const input: MigrationInput = loadMigrationInput();
  if (!args.includes("--apply")) {
    console.info(
      `Identity storage migration check passed for ${RUNTIME_DATA_ROOT}: ` +
      `${input.whitelist.size} whitelist, ${input.blockedIds.length} blocklist, ` +
      `${input.removals.size} pending removal row(s). No files were changed.`
    );
    return;
  }
  await applyMigration(input);
}

if (import.meta.main) {
  await main().catch((error: unknown): never => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
