/**
 * 旧白名单、静态/动态黑名单与待踢 outbox 到 SQLite 的一次性手工迁移。
 *
 * 缺省只严格校验；`--apply` 才取得 bot.lock、调用 Telegram 补齐 meta、在工作树外
 * 留存带哈希清单的备份、原子发布 database/storage.sqlite，并删除三处旧结构。
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Bot, GrammyError } from "grammy";
import type { ChatFullInfo, User } from "@grammyjs/types";
import { BOT_TOKEN, SUPER_ADMIN_USER_ID } from "../packages/config/telegram";
import {
  IDENTITY_DATABASE_DIRECTORY_MODE,
  IDENTITY_DATABASE_FILE_MODE,
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_KEY,
} from "../packages/consts/identityStorage";
import {
  BLOCKLIST_CONFIG_PATH,
  BLOCKLIST_FILE_PATH,
  BLOCKLIST_MEMORY_DIR,
  BLOCKLIST_REMOVAL_OUTBOX_PATH,
  DATABASE_DIR,
  IDENTITY_DATABASE_PATH,
  RUNTIME_DATA_ROOT,
  STATE_FILE_PATH,
  WHITELIST_CONFIG_PATH,
} from "../packages/consts/paths";
import {
  decodeBlocklistEntryData,
  decodePendingBlockedRemovalData,
  decodeWhitelistEntryData,
  encodeBlocklistEntryData,
  encodePendingBlockedRemovalData,
  encodeWhitelistEntryData,
} from "../packages/database/codec/identity";
import {
  assertIdentityDatabaseIntegrity,
  assertIdentityDatabaseJsonbStorage,
  closeIdentityDatabase,
  createIdentityDatabase,
  enableIdentityDatabaseWal,
  openIdentityDatabase,
  readIdentityDatabaseRows,
  seedIdentityDatabase,
} from "../packages/database/interact/identity";
import type {
  IdentityDatabase,
  IdentityDatabaseRows,
  StoredIdentityPolicyRow,
  StoredPendingRemovalRow,
} from "../packages/types/identityDatabase";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "../packages/infra/storage/instanceLock";
import { readJsonInput } from "../packages/libs/inputValidation";
import { syncDirectorySync } from "../packages/libs/atomicFile";
import { hasExactKeys, isPlainRecord } from "../packages/libs/record";
import { formatTokyoTime } from "../packages/libs/time";
import { decodeStateFile } from "../packages/libs/stateFileCodec";
import type { PendingBlockedRemoval } from "../packages/types/blocklist";
import type { ChatState, StateFileSchema } from "../packages/types/chatState";
import type {
  BlocklistEntryData,
  TelegramIdentityMetadata,
  WhitelistEntryData,
  WhitelistPermissions,
} from "../packages/types/identityPolicy";
import type {
  MigrationInput,
} from "../packages/types/identityStorageMigration";
import {
  loadLegacyBlocklistConfig,
  loadLegacyWhitelistConfig,
} from "./identityStorageMigration/legacy";

const LEGACY_BLOCKLIST_REMOVAL_OUTBOX_VERSION: number = 2;

interface BackupManifestEntry {
  readonly relativePath: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly sha256: string;
}

interface QueriedMigrationInput {
  readonly input: MigrationInput;
  readonly metadata: ReadonlyMap<number, Readonly<TelegramIdentityMetadata>>;
  readonly droppedKickedWhitelistCount: number;
}

function decodeOldDynamicBlocklist(path: string): Set<number> {
  if (!existsSync(path)) return new Set();
  const value: unknown = readJsonInput(path);
  if (!isPlainRecord(value)) {
    throw new Error(`${path}: $ must be an object keyed by identity IDs.`);
  }
  const result: Set<number> = new Set();
  for (const [key, raw] of Object.entries(value)) {
    const id: number = Number(key);
    if (!Number.isSafeInteger(id) || id === 0 || String(id) !== key) {
      throw new Error(`${path}: $.<identity> must be a canonical non-zero safe integer key.`);
    }
    if (
      !isPlainRecord(raw) ||
      !hasExactKeys(raw, ["isBlocked", "blockedAt"]) ||
      raw.isBlocked !== true ||
      typeof raw.blockedAt !== "string" ||
      !/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(raw.blockedAt)
    ) {
      throw new Error(`${path}: $.<record> must be exactly the current blocked record shape.`);
    }
    result.add(id);
  }
  return result;
}

function decodeOldRemovalOutbox(path: string): Map<number, PendingBlockedRemoval> {
  if (!existsSync(path)) return new Map();
  const value: unknown = readJsonInput(path);
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["version", "entries"]) ||
    value.version !== LEGACY_BLOCKLIST_REMOVAL_OUTBOX_VERSION ||
    !Array.isArray(value.entries)
  ) {
    throw new Error(`${path}: $ must use the current removal outbox schema.`);
  }
  const result: Map<number, PendingBlockedRemoval> = new Map();
  for (let index: number = 0; index < value.entries.length; index++) {
    const raw: unknown = value.entries[index];
    const text: string = JSON.stringify(raw);
    const pending: PendingBlockedRemoval = decodePendingBlockedRemovalData(
      text,
      `${path}:$.entries[${index}]`
    );
    const removalId: number = pending.params.removalId;
    if (result.has(removalId)) {
      throw new Error(`${path}: duplicate removalId ${removalId}.`);
    }
    result.set(removalId, pending);
  }
  return result;
}

export interface LoadMigrationInputOptions {
  readonly whitelistPath?: string;
  readonly staticBlocklistPath?: string;
  readonly dynamicBlocklistPath?: string;
  readonly removalOutboxPath?: string;
  readonly superAdminUserId?: number;
}

/** 严格合并发布前四份旧身份 JSON；可注入路径仅用于隔离迁移测试。 */
export function loadMigrationInput({
  whitelistPath = WHITELIST_CONFIG_PATH,
  staticBlocklistPath = BLOCKLIST_CONFIG_PATH,
  dynamicBlocklistPath = BLOCKLIST_FILE_PATH,
  removalOutboxPath = BLOCKLIST_REMOVAL_OUTBOX_PATH,
  superAdminUserId = SUPER_ADMIN_USER_ID,
}: LoadMigrationInputOptions = {}): MigrationInput {
  const whitelist: Map<number, Readonly<WhitelistPermissions>> = new Map(
    loadLegacyWhitelistConfig(whitelistPath)
  );
  // 超级管理员的权限来自身份本身，旧文件残留从未生效，不迁入 SQLite。
  whitelist.delete(superAdminUserId);
  const dynamic: Set<number> = decodeOldDynamicBlocklist(dynamicBlocklistPath);
  const blockedIds: Set<number> = new Set(
    loadLegacyBlocklistConfig(staticBlocklistPath).blockedIds
  );
  for (const id of dynamic.keys()) blockedIds.add(id);
  for (const id of blockedIds) {
    if (id === superAdminUserId || whitelist.has(id)) {
      throw new Error(`${staticBlocklistPath}: blocklist identities must be disjoint from protected identities.`);
    }
  }
  const removals: Map<number, PendingBlockedRemoval> =
    decodeOldRemovalOutbox(removalOutboxPath);
  for (const pending of removals.values()) {
    if (pending.params.probeMembership) {
      if (blockedIds.size === 0) {
        throw new Error(`${removalOutboxPath}: sweep requires a non-empty blocklist.`);
      }
      continue;
    }
    if (pending.params.userIds.some((id: number): boolean => !blockedIds.has(id))) {
      throw new Error(`${removalOutboxPath}: frozen userIds must exist in the merged blocklist.`);
    }
  }
  return { whitelist, blockedIds: [...blockedIds], removals };
}

function managedChatIds(): readonly number[] {
  if (!existsSync(STATE_FILE_PATH)) return [];
  const state: StateFileSchema = decodeStateFile(readJsonInput(STATE_FILE_PATH));
  const ids: number[] = [];
  for (const [chatIdText, chatState] of Object.entries(state.chats)) {
    const stateEntry: ChatState = chatState;
    if (stateEntry.isInitEnabled === true) ids.push(Number(chatIdText));
  }
  return ids;
}

function metadataFromUser(user: User): Readonly<TelegramIdentityMetadata> {
  return {
    firstName: user.first_name,
    lastName: user.last_name ?? "",
    username: user.username ?? "",
  };
}

function metadataFromChat(
  chat: ChatFullInfo
): Readonly<TelegramIdentityMetadata> | undefined {
  if ("first_name" in chat) {
    return {
      firstName: chat.first_name ?? "",
      lastName: "last_name" in chat ? chat.last_name ?? "" : "",
      username: "username" in chat ? chat.username ?? "" : "",
    };
  }
  if ("title" in chat) {
    return {
      firstName: chat.title,
      lastName: "",
      username: "username" in chat ? chat.username ?? "" : "",
    };
  }
  return undefined;
}

async function queryIdentityMetadata(
  bot: Bot,
  id: number,
  chatIds: readonly number[]
): Promise<Readonly<TelegramIdentityMetadata> | null> {
  try {
    const chat: ChatFullInfo = await bot.api.getChat(id);
    const direct: Readonly<TelegramIdentityMetadata> | undefined = metadataFromChat(chat);
    if (direct !== undefined) return direct;
  } catch (error: unknown) {
    if (isBotKickedFromChatError(error)) return null;
    // 正用户 ID 继续走托管群 getChatMember；最终仍解析不到时统一致命退出。
  }
  if (id > 0) {
    for (const chatId of chatIds) {
      try {
        const member: Awaited<ReturnType<typeof bot.api.getChatMember>> =
          await bot.api.getChatMember(chatId, id);
        return metadataFromUser(member.user);
      } catch {
        // 该群不可见或用户不在群时继续下一处已管理群，不把 API payload 写入日志。
      }
    }
  }
  throw new Error(`Telegram API could not resolve required metadata for identity ${id}.`);
}

/** 只识别 getChat 明确报告的「机器人已被群/频道踢出」，其余 403 不能删除名单。 */
export function isBotKickedFromChatError(error: unknown): boolean {
  return error instanceof GrammyError &&
    error.method === "getChat" &&
    error.error_code === 403 &&
    /^Forbidden: bot was kicked from the (?:group|supergroup|channel) chat$/.test(
      error.description
    );
}

async function queryAllMetadata(
  input: MigrationInput
): Promise<QueriedMigrationInput> {
  const bot: Bot = new Bot(BOT_TOKEN);
  const chatIds: readonly number[] = managedChatIds();
  const metadata: Map<number, Readonly<TelegramIdentityMetadata>> = new Map();
  const whitelist: Map<number, Readonly<WhitelistPermissions>> = new Map(input.whitelist);
  const ids: readonly number[] = [...new Set<number>([
    ...whitelist.keys(),
    ...input.blockedIds,
  ])];
  let droppedKickedWhitelistCount: number = 0;
  for (const id of ids) {
    const resolved: Readonly<TelegramIdentityMetadata> | null =
      await queryIdentityMetadata(bot, id, chatIds);
    if (resolved !== null) {
      metadata.set(id, resolved);
      continue;
    }
    if (!whitelist.delete(id)) {
      throw new Error(
        `Telegram reports that the bot was kicked from blocklisted identity ${id}; refusing to drop a blocklist entry.`
      );
    }
    droppedKickedWhitelistCount += 1;
  }
  return {
    input: {
      whitelist,
      blockedIds: input.blockedIds,
      removals: input.removals,
    },
    metadata,
    droppedKickedWhitelistCount,
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function collectFiles(root: string, relative: string = ""): string[] {
  const path: string = relative.length === 0 ? root : join(root, relative);
  const stats: ReturnType<typeof lstatSync> = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new Error(`${path}: migration sources and backups must not contain symbolic links.`);
  }
  if (!stats.isDirectory()) {
    if (!stats.isFile()) {
      throw new Error(`${path}: migration sources must contain regular files only.`);
    }
    return [relative];
  }
  const files: string[] = [];
  for (const name of readdirSync(path).sort()) {
    const child: string = relative.length === 0 ? name : join(relative, name);
    files.push(...collectFiles(root, child));
  }
  return files;
}

function fsyncFile(path: string): void {
  const fd: number = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectoryTree(path: string): void {
  for (const name of readdirSync(path)) {
    const child: string = join(path, name);
    if (lstatSync(child).isDirectory()) fsyncDirectoryTree(child);
  }
  fsyncFile(path);
}

function backupMigrationSources(): string {
  const backupRoot: string = mkdtempSync(join(tmpdir(), "copy-ninjia-identity-migration-"));
  const sources: readonly (readonly [string, string])[] = [
    [WHITELIST_CONFIG_PATH, join("config", basename(WHITELIST_CONFIG_PATH))],
    [BLOCKLIST_CONFIG_PATH, join("config", basename(BLOCKLIST_CONFIG_PATH))],
    [BLOCKLIST_MEMORY_DIR, join("memory", basename(BLOCKLIST_MEMORY_DIR))],
  ];
  const manifest: BackupManifestEntry[] = [];
  let completed: boolean = false;
  try {
    for (const [source, relativeTarget] of sources) {
      if (!existsSync(source)) continue;
      const sourceStats: ReturnType<typeof lstatSync> = lstatSync(source);
      if (sourceStats.isSymbolicLink()) {
        throw new Error(`${source}: migration sources must not be symbolic links.`);
      }
      const target: string = join(backupRoot, relativeTarget);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (sourceStats.isDirectory()) {
        cpSync(source, target, { recursive: true, preserveTimestamps: true, errorOnExist: true });
      } else if (sourceStats.isFile()) {
        copyFileSync(source, target);
      } else {
        throw new Error(`${source}: migration sources must be regular files or directories.`);
      }
      const root: string = sourceStats.isDirectory() ? source : dirname(source);
      const relativeFiles: string[] = sourceStats.isDirectory()
        ? collectFiles(source)
        : [basename(source)];
      for (const relativeFile of relativeFiles) {
        const sourceFile: string = join(root, relativeFile);
        const backupRelativePath: string = sourceStats.isDirectory()
          ? join(relativeTarget, relativeFile)
          : relativeTarget;
        const backupFile: string = join(backupRoot, backupRelativePath);
        const stats: ReturnType<typeof statSync> = statSync(sourceFile);
        const sourceHash: string = sha256(sourceFile);
        const backupStats: ReturnType<typeof statSync> = statSync(backupFile);
        const backupHash: string = sha256(backupFile);
        if (backupStats.size !== stats.size || backupHash !== sourceHash) {
          throw new Error(`${sourceFile}: external migration backup verification failed.`);
        }
        fsyncFile(backupFile);
        manifest.push({
          relativePath: backupRelativePath,
          mode: stats.mode & 0o777,
          uid: stats.uid,
          gid: stats.gid,
          size: stats.size,
          sha256: sourceHash,
        });
      }
    }
    const manifestPath: string = join(backupRoot, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fsyncFile(manifestPath);
    fsyncDirectoryTree(backupRoot);
    completed = true;
    return backupRoot;
  } finally {
    if (!completed) rmSync(backupRoot, { recursive: true, force: true });
  }
}

function assertSourceOwnership(): void {
  const currentUid: number | undefined = typeof process.getuid === "function"
    ? process.getuid()
    : undefined;
  if (currentUid === undefined) return;
  for (const path of [WHITELIST_CONFIG_PATH, BLOCKLIST_CONFIG_PATH, BLOCKLIST_MEMORY_DIR]) {
    if (existsSync(path) && statSync(path).uid !== currentUid) {
      throw new Error(`${path}: owner uid must match the migration and service account uid ${currentUid}.`);
    }
  }
}

export interface InsertMigratedRowsParams {
  readonly database: IdentityDatabase;
  readonly input: MigrationInput;
  readonly metadata: ReadonlyMap<number, Readonly<TelegramIdentityMetadata>>;
  readonly blockedAt: string;
}

export function insertMigratedRows({
  database,
  input,
  metadata,
  blockedAt,
}: InsertMigratedRowsParams): void {
  const whitelist: StoredIdentityPolicyRow[] = [];
  for (const [id, permissions] of input.whitelist) {
    const meta: Readonly<TelegramIdentityMetadata> | undefined = metadata.get(id);
    if (meta === undefined) throw new Error(`Missing queried metadata for whitelist identity ${id}.`);
    const data: WhitelistEntryData = { permissions, meta };
    whitelist.push({ id, data: encodeWhitelistEntryData(data) });
  }
  const blocklist: StoredIdentityPolicyRow[] = [];
  for (const id of input.blockedIds) {
    const meta: Readonly<TelegramIdentityMetadata> | undefined = metadata.get(id);
    if (meta === undefined) throw new Error(`Missing queried metadata for blocklist identity ${id}.`);
    const data: BlocklistEntryData = { blockedAt, meta };
    blocklist.push({ id, data: encodeBlocklistEntryData(data) });
  }
  const removals: StoredPendingRemovalRow[] = [];
  for (const [removalId, pending] of input.removals) {
    removals.push({ removalId, data: encodePendingBlockedRemovalData(pending).text });
  }
  seedIdentityDatabase(database, {
    metadata: [{
      key: IDENTITY_DATABASE_SCHEMA_KEY,
      data: IDENTITY_DATABASE_SCHEMA_DATA,
    }],
    whitelist,
    blocklist,
    removals,
  });
}

export interface VerifyDatabaseParams {
  readonly path: string;
  readonly input: MigrationInput;
  readonly metadata: ReadonlyMap<number, Readonly<TelegramIdentityMetadata>>;
  readonly blockedAt: string;
}

export function verifyDatabase({
  path,
  input,
  metadata,
  blockedAt,
}: VerifyDatabaseParams): void {
  const database: IdentityDatabase = openIdentityDatabase({ path, readonly: true });
  try {
    assertIdentityDatabaseIntegrity(database);
    assertIdentityDatabaseJsonbStorage(database, path);
    const rows: IdentityDatabaseRows = readIdentityDatabaseRows(database);
    const whiteRows: readonly StoredIdentityPolicyRow[] = rows.whitelist;
    const blackRows: readonly StoredIdentityPolicyRow[] = rows.blocklist;
    const removalRows: readonly StoredPendingRemovalRow[] = rows.removals;
    const metadataRows: IdentityDatabaseRows["metadata"] = rows.metadata;
    if (
      whiteRows.length !== input.whitelist.size ||
      blackRows.length !== input.blockedIds.length ||
      removalRows.length !== input.removals.size ||
      metadataRows.length !== 1 ||
      metadataRows[0]?.key !== IDENTITY_DATABASE_SCHEMA_KEY ||
      metadataRows[0]?.data !== IDENTITY_DATABASE_SCHEMA_DATA
    ) {
      throw new Error(`${path}: migrated row counts do not match the strictly parsed source structures.`);
    }
    const expectedWhitelist: Map<number, string> = new Map();
    for (const [id, permissions] of input.whitelist) {
      const meta: Readonly<TelegramIdentityMetadata> | undefined = metadata.get(id);
      if (meta === undefined) throw new Error(`${path}: missing expected whitelist metadata for ${id}.`);
      expectedWhitelist.set(id, encodeWhitelistEntryData({ permissions, meta }));
    }
    const expectedBlocklist: Map<number, string> = new Map();
    for (const id of input.blockedIds) {
      const meta: Readonly<TelegramIdentityMetadata> | undefined = metadata.get(id);
      if (meta === undefined) throw new Error(`${path}: missing expected blocklist metadata for ${id}.`);
      expectedBlocklist.set(id, encodeBlocklistEntryData({ blockedAt, meta }));
    }
    for (const row of whiteRows) {
      decodeWhitelistEntryData(row.data, `${path}:whitelist_entries[${row.id}]`);
      if (expectedWhitelist.get(row.id) !== row.data) {
        throw new Error(`${path}: whitelist row ${row.id} does not match its migrated source value.`);
      }
      expectedWhitelist.delete(row.id);
    }
    for (const row of blackRows) {
      decodeBlocklistEntryData(row.data, `${path}:blocklist_entries[${row.id}]`);
      if (expectedBlocklist.get(row.id) !== row.data) {
        throw new Error(`${path}: blocklist row ${row.id} does not match its migrated source value.`);
      }
      expectedBlocklist.delete(row.id);
    }
    if (expectedWhitelist.size !== 0 || expectedBlocklist.size !== 0) {
      throw new Error(`${path}: migrated identity primary keys do not match the source structures.`);
    }
    const expectedRemovals: Map<number, string> = new Map();
    for (const [removalId, pending] of input.removals) {
      expectedRemovals.set(removalId, encodePendingBlockedRemovalData(pending).text);
    }
    for (const row of removalRows) {
      const pending: PendingBlockedRemoval = decodePendingBlockedRemovalData(
        row.data,
        `${path}:pending_blocked_removals[${row.removalId}]`
      );
      if (pending.params.removalId !== row.removalId) {
        throw new Error(`${path}: pending removal primary key mismatch.`);
      }
      if (expectedRemovals.get(row.removalId) !== row.data) {
        throw new Error(`${path}: pending removal row ${row.removalId} does not match its migrated source value.`);
      }
      expectedRemovals.delete(row.removalId);
    }
    if (expectedRemovals.size !== 0) {
      throw new Error(`${path}: migrated pending removal primary keys do not match the source structure.`);
    }
  } finally {
    closeIdentityDatabase(database);
  }
}

function createDatabase(
  input: MigrationInput,
  metadata: ReadonlyMap<number, Readonly<TelegramIdentityMetadata>>,
  blockedAt: string
): void {
  if (existsSync(IDENTITY_DATABASE_PATH)) {
    throw new Error(`${IDENTITY_DATABASE_PATH}: target already exists; refusing to overwrite it.`);
  }
  mkdirSync(DATABASE_DIR, {
    recursive: true,
    mode: IDENTITY_DATABASE_DIRECTORY_MODE,
  });
  const databaseDirectoryStats: ReturnType<typeof statSync> = statSync(DATABASE_DIR);
  const dataRootStats: ReturnType<typeof statSync> = statSync(RUNTIME_DATA_ROOT);
  // 服务账号与部署工作区用户可能不同；目录继承数据根协作组，新建旁路文件
  // 再由 setgid 继承该组，避免使用世界可写权限。
  if (databaseDirectoryStats.gid !== dataRootStats.gid) {
    chownSync(DATABASE_DIR, databaseDirectoryStats.uid, dataRootStats.gid);
  }
  // chmod 必须在 chown 后执行：部分平台的 chown 会清除 setgid 位。
  chmodSync(DATABASE_DIR, IDENTITY_DATABASE_DIRECTORY_MODE);
  const tempPath: string = join(DATABASE_DIR, `.storage.sqlite.${crypto.randomUUID()}.tmp`);
  let targetCreated: boolean = false;
  let completed: boolean = false;
  try {
    createIdentityDatabase(tempPath);
    const tempStats: ReturnType<typeof statSync> = statSync(tempPath);
    const databaseDirectoryGroup: number = statSync(DATABASE_DIR).gid;
    if (tempStats.gid !== databaseDirectoryGroup) {
      chownSync(tempPath, tempStats.uid, databaseDirectoryGroup);
    }
    const database: IdentityDatabase = openIdentityDatabase({ path: tempPath });
    try {
      insertMigratedRows({ database, input, metadata, blockedAt });
    } finally {
      closeIdentityDatabase(database);
    }
    chmodSync(tempPath, IDENTITY_DATABASE_FILE_MODE);
    verifyDatabase({ path: tempPath, input, metadata, blockedAt });
    fsyncFile(tempPath);
    renameSync(tempPath, IDENTITY_DATABASE_PATH);
    targetCreated = true;
    syncDirectorySync(IDENTITY_DATABASE_PATH);
    enableIdentityDatabaseWal(IDENTITY_DATABASE_PATH);
    chmodSync(IDENTITY_DATABASE_PATH, IDENTITY_DATABASE_FILE_MODE);
    fsyncFile(IDENTITY_DATABASE_PATH);
    verifyDatabase({ path: IDENTITY_DATABASE_PATH, input, metadata, blockedAt });
    fsyncDirectoryTree(DATABASE_DIR);
    completed = true;
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    if (!completed && targetCreated) {
      for (const path of [
        IDENTITY_DATABASE_PATH,
        `${IDENTITY_DATABASE_PATH}-wal`,
        `${IDENTITY_DATABASE_PATH}-shm`,
      ]) {
        if (existsSync(path)) unlinkSync(path);
      }
      fsyncFile(DATABASE_DIR);
    }
  }
}

function deleteOldStructures(): void {
  unlinkSync(WHITELIST_CONFIG_PATH);
  unlinkSync(BLOCKLIST_CONFIG_PATH);
  if (existsSync(BLOCKLIST_MEMORY_DIR)) rmSync(BLOCKLIST_MEMORY_DIR, { recursive: true });
}

async function applyMigration(input: MigrationInput): Promise<void> {
  assertSourceOwnership();
  await acquireSingleInstanceLock(BOT_TOKEN);
  try {
    const queried: QueriedMigrationInput = await queryAllMetadata(input);
    const backupRoot: string = backupMigrationSources();
    console.info(`Verified external migration backup at ${backupRoot}.`);
    createDatabase(
      queried.input,
      queried.metadata,
      formatTokyoTime(Date.now())
    );
    deleteOldStructures();
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
  if (args.some((argument: string): boolean => argument !== "--apply" && argument !== "--check")) {
    throw new Error("Usage: bun scripts/migrateIdentityStorageToSqlite.ts [--check|--apply]");
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
