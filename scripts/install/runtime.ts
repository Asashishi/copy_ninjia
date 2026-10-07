/** 安装器共用的路径、严格校验和新库初始化入口；二进制发行时单独打包。 */
export { RUNTIME_DATA_ROOT, IDENTITY_DATABASE_PATH } from "../../packages/consts/paths";
import { IDENTITY_DATABASE_PATH } from "../../packages/consts/paths";
import { IDENTITY_DATABASE_SCHEMA_VERSION } from "../../packages/consts/identityStorage";
import { closeStorageDatabase, openStorageDatabase } from "../../packages/database/interact/connection";
import { readStorageDatabaseSchemaMetadata } from "../../packages/database/interact/inspection";
import { assertStorageTimeZone, readStorageSchemaVersion } from "../../packages/database/validation/storageRows";
import type { StorageDatabase, StoredStorageMetadataRow } from "../../packages/types/storageDatabase";
export { assertNoMisplacedConfigFiles } from "../../packages/config/layout";
export { validateAgentDeploymentConfig } from "../../packages/config/agent";
import { parseBotConfig } from "../../packages/config/botInput";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../../packages/consts/telegram";
import { StateStore, loadCurrentGlobalState } from "../../packages/infra/storage/statePersistence";
import { invalidInput, readJsonInput } from "../../packages/libs/inputValidation";
import { isPlainRecord } from "../../packages/libs/record";
import type { BotConfig } from "../../packages/types/config";
import type * as Readiness from "../../packages/config/readiness";
export { createStorageDatabase } from "../../packages/database/interact/migration";
export {
  closeStorageDatabase,
  enableStorageDatabaseWal,
  openStorageDatabase,
} from "../../packages/database/interact/connection";
export { initializeStorageDatabase } from "../../packages/database/interact/initialization";

/** 完成问卷和新库初始化后才加载启动总闸。 */
export async function validateExistingDeploymentInputs(): Promise<void> {
  const readiness: typeof Readiness = await import("../../packages/config/readiness");
  await readiness.validateExistingDeploymentInputs();
}

/**
 * 安装前按启动恢复同一口径只读校验全局状态：旧位置的状态文件（`LEGACY_STATE_FILE_PATHS`）
 * 存在，或 memory/global/state.json 不是当前格式时拒绝。
 */
export async function assertStateFilesMigrated(): Promise<void> {
  await loadCurrentGlobalState(new StateStore());
}

/** 只读读出已有共享数据库的 metadata，并先确认 schema 版本是当前版本。 */
function readCurrentStorageMetadata(database: StorageDatabase): readonly StoredStorageMetadataRow[] {
  const metadata: readonly StoredStorageMetadataRow[] = readStorageDatabaseSchemaMetadata(database);
  const version: number = readStorageSchemaVersion({ metadata }, IDENTITY_DATABASE_PATH);
  if (version !== IDENTITY_DATABASE_SCHEMA_VERSION) {
    invalidInput(IDENTITY_DATABASE_PATH, "storage_metadata.schema-version", `{"version":${IDENTITY_DATABASE_SCHEMA_VERSION}}`);
  }
  return metadata;
}

/**
 * 安装前只读核对已有共享数据库的 schema 版本：不是当前版本（例如未经
 * migrate:chat-persona-removal 的源 schema）时拒绝，不改写数据库。库不存在时由建库步骤创建；
 * 完整校验留给启动恢复。
 */
export async function assertStorageDatabaseMigrated(): Promise<void> {
  if (!await Bun.file(IDENTITY_DATABASE_PATH).exists()) return;
  const database: StorageDatabase = openStorageDatabase({ path: IDENTITY_DATABASE_PATH, readonly: true });
  try {
    readCurrentStorageMetadata(database);
  } finally {
    closeStorageDatabase(database);
  }
}

/**
 * 配置写定后、注册服务前只读核对已有共享数据库绑定的时区：time-zone 标记必须等于 bot.json
 * 的规范化时区，与启动闸同一口径；不改写数据库。
 */
export function assertStorageDatabaseTimeZone(timeZone: string): void {
  const database: StorageDatabase = openStorageDatabase({ path: IDENTITY_DATABASE_PATH, readonly: true });
  try {
    assertStorageTimeZone({ metadata: readCurrentStorageMetadata(database) }, IDENTITY_DATABASE_PATH, timeZone);
  } finally {
    closeStorageDatabase(database);
  }
}

/** 只严格校验候选文件内容；配置目录布局由安装准备（runtime.sh）与启动总闸检查。 */
export async function validateStagedBotConfig(path: string): Promise<void> {
  parseBotConfig(await readJsonInput(path), path);
}

/**
 * 问卷开始前校验既有 Bot 字段；仅示例 token 允许等待本次填写，风格与时区原样保留。配置目录
 * 布局已由安装准备（runtime.sh）检查。
 */
export async function loadInstallerBotConfig(path: string): Promise<BotConfig> {
  const value: unknown = await readJsonInput(path);
  const candidate: unknown = isPlainRecord(value) && typeof value.bot_token === "string" &&
    value.bot_token.trim() === TELEGRAM_BOT_TOKEN_PLACEHOLDER
    ? { ...value, bot_token: "installer-initial-identity" }
    : value;
  return parseBotConfig(candidate, path);
}
