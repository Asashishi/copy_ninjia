import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_KEY,
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
} from "../../../packages/consts/identityStorage";
import {
  clearStorageBusinessTables,
  seedStorageDatabase,
} from "../../fixtures/storageDatabase";
import {
  closeStorageDatabase,
  enableStorageDatabaseWal,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import { readStoredIdentityPolicies } from
  "../../../packages/database/interact/identityPolicy";
import { createStorageDatabase } from
  "../../../packages/database/interact/migration";
import { commitStorageDatabaseChanges } from
  "../../../packages/database/interact/transaction";
import type {
  StorageDatabase,
  StorageDatabaseChange,
  StoredIdentityPolicyRow,
} from "../../../packages/types/storageDatabase";
import {
  COLD_READ_BATCH_COUNT,
  COLD_WRITE_TRANSACTION_COUNT,
  DATABASE_FIXTURE_ROOT_PREFIX,
  READ_BATCH_COUNT,
  READ_BATCH_SIZE,
  READ_FIXTURE_SIZE,
  WRITE_TRANSACTION_COUNT,
} from "./constants";
import {
  BLACK_DATA,
  EMPTY_CHAT_QA_CHANGES,
  EMPTY_STORAGE_CHANGES,
  WHITE_DATA,
} from "./fixtures";
import { measuredResult } from "./measurement";
import { assertMockRoot, isBenchmarkMockRoot } from "./roots";
import type { ChildResult } from "./types";

interface DatabaseFixture {
  readonly root: string;
  readonly path: string;
  readonly database: StorageDatabase;
}

function createFixture(mockRoot: string): DatabaseFixture {
  assertMockRoot(mockRoot);
  const root: string = mkdtempSync(join(mockRoot, DATABASE_FIXTURE_ROOT_PREFIX));
  const path: string = join(root, "storage.sqlite");
  createStorageDatabase(path);
  enableStorageDatabaseWal(path);
  const database: StorageDatabase = openStorageDatabase({ path });
  seedStorageDatabase(database, {
    metadata: [{
      key: IDENTITY_DATABASE_SCHEMA_KEY,
      data: IDENTITY_DATABASE_SCHEMA_DATA,
    }],
    whitelist: [],
    blocklist: [],
    removals: [],
  });
  return { root, path, database };
}

function removeFixture(fixture: DatabaseFixture): void {
  const resolvedRoot: string = resolve(fixture.root);
  const resolvedPath: string = resolve(fixture.path);
  if (
    dirname(resolvedPath) !== resolvedRoot ||
    basename(resolvedPath) !== "storage.sqlite" ||
    !basename(resolvedRoot).startsWith(DATABASE_FIXTURE_ROOT_PREFIX) ||
    !isBenchmarkMockRoot(dirname(resolvedRoot))
  ) {
    throw new Error("Identity benchmark refused to remove an unexpected fixture root.");
  }
  rmSync(fixture.root, { recursive: true, force: true });
}

function closeFixture(fixture: DatabaseFixture): void {
  closeStorageDatabase(fixture.database);
  removeFixture(fixture);
}

function readIds(): readonly number[] {
  const ids: number[] = new Array<number>(READ_BATCH_SIZE);
  for (let index: number = 0; index < READ_BATCH_SIZE; index += 1) {
    ids[index] = index + 1;
  }
  return ids;
}

function seedReadFixture(database: StorageDatabase): void {
  const whitelist: StoredIdentityPolicyRow[] = [];
  const blocklist: StoredIdentityPolicyRow[] = [];
  for (let id: number = 1; id <= READ_FIXTURE_SIZE; id += 1) {
    if ((id & 1) === 0) blocklist.push({ id, data: BLACK_DATA });
    else whitelist.push({ id, data: WHITE_DATA });
  }
  seedStorageDatabase(database, {
    metadata: [],
    whitelist,
    blocklist,
    removals: [],
  });
}

function runReadBatches(
  database: StorageDatabase,
  ids: readonly number[],
  batches: number
): number {
  let checksum: number = 0;
  for (let batch: number = 0; batch < batches; batch += 1) {
    checksum += readStoredIdentityPolicies(database, "whitelist", ids).length;
    checksum += readStoredIdentityPolicies(database, "blocklist", ids).length;
  }
  return checksum;
}

/**
 * 每批使用新连接，因此 SQLite 连接页缓存和 Bun 语句缓存都从空状态开始。
 * 操作系统页缓存在 fixture 建立后不做全局清理，报告会显式标注这一口径。
 */
function runColdReadBatches(
  path: string,
  ids: readonly number[],
  batches: number
): number {
  let checksum: number = 0;
  for (let batch: number = 0; batch < batches; batch += 1) {
    const database: StorageDatabase = openStorageDatabase({
      path,
      readonly: true,
    });
    try {
      checksum += readStoredIdentityPolicies(database, "whitelist", ids).length;
      checksum += readStoredIdentityPolicies(database, "blocklist", ids).length;
    } finally {
      closeStorageDatabase(database);
    }
  }
  return checksum;
}

function createWriteBatches(): readonly ReadonlyMap<
  number,
  StorageDatabaseChange
>[] {
  const batches: ReadonlyMap<number, StorageDatabaseChange>[] = [];
  let id: number = 1;
  for (let batch: number = 0; batch < WRITE_TRANSACTION_COUNT; batch += 1) {
    const changes: Map<number, StorageDatabaseChange> = new Map();
    for (
      let offset: number = 0;
      offset < IDENTITY_WRITE_BATCH_MAX_ENTRIES;
      offset += 1
    ) {
      changes.set(id, { data: WHITE_DATA });
      id += 1;
    }
    batches.push(changes);
  }
  return batches;
}

function runWriteBatches(
  database: StorageDatabase,
  batches: readonly ReadonlyMap<number, StorageDatabaseChange>[]
): number {
  let checksum: number = 0;
  for (const whitelist of batches) {
    commitStorageDatabaseChanges(database, {
      whitelist,
      blocklist: EMPTY_STORAGE_CHANGES,
      removals: EMPTY_STORAGE_CHANGES,
      chatStates: EMPTY_STORAGE_CHANGES,
      chatQa: EMPTY_CHAT_QA_CHANGES,
    });
    checksum += whitelist.size;
  }
  return checksum;
}

/** 每个 128 行事务都在新连接上提交并关闭，覆盖生产重连后的首写路径。 */
function runColdWriteBatches(
  path: string,
  batches: readonly ReadonlyMap<number, StorageDatabaseChange>[]
): number {
  let checksum: number = 0;
  for (const whitelist of batches) {
    const database: StorageDatabase = openStorageDatabase({ path });
    try {
      commitStorageDatabaseChanges(database, {
        whitelist,
        blocklist: EMPTY_STORAGE_CHANGES,
        removals: EMPTY_STORAGE_CHANGES,
        chatStates: EMPTY_STORAGE_CHANGES,
        chatQa: EMPTY_CHAT_QA_CHANGES,
      });
      checksum += whitelist.size;
    } finally {
      closeStorageDatabase(database);
    }
  }
  return checksum;
}

export function runHotReadChild(mockRoot: string): ChildResult {
  const fixture: DatabaseFixture = createFixture(mockRoot);
  try {
    seedReadFixture(fixture.database);
    const ids: readonly number[] = readIds();
    runReadBatches(fixture.database, ids, 2_000);
    const operations: number = READ_BATCH_COUNT * READ_BATCH_SIZE;
    const result: ChildResult = measuredResult({
      operation: "storage-read-hot-connection",
      operations,
      batches: READ_BATCH_COUNT,
      run: (): number => runReadBatches(fixture.database, ids, READ_BATCH_COUNT),
    });
    if (result.checksum !== operations) {
      throw new Error(`Read benchmark checksum mismatch: ${result.checksum}.`);
    }
    return result;
  } finally {
    closeFixture(fixture);
  }
}

export function runColdReadChild(mockRoot: string): ChildResult {
  const fixture: DatabaseFixture = createFixture(mockRoot);
  seedReadFixture(fixture.database);
  closeStorageDatabase(fixture.database);
  try {
    const ids: readonly number[] = readIds();
    runColdReadBatches(fixture.path, ids, 50);
    const operations: number = COLD_READ_BATCH_COUNT * READ_BATCH_SIZE;
    const result: ChildResult = measuredResult({
      operation: "storage-read-cold-connection",
      operations,
      batches: COLD_READ_BATCH_COUNT,
      run: (): number => runColdReadBatches(
        fixture.path,
        ids,
        COLD_READ_BATCH_COUNT
      ),
    });
    if (result.checksum !== operations) {
      throw new Error(`Cold read benchmark checksum mismatch: ${result.checksum}.`);
    }
    return result;
  } finally {
    removeFixture(fixture);
  }
}

export function runHotWriteChild(mockRoot: string): ChildResult {
  const fixture: DatabaseFixture = createFixture(mockRoot);
  try {
    const warmup: readonly ReadonlyMap<number, StorageDatabaseChange>[] =
      createWriteBatches().slice(0, 16);
    runWriteBatches(fixture.database, warmup);
    clearStorageBusinessTables(fixture.database);
    const batches: readonly ReadonlyMap<number, StorageDatabaseChange>[] =
      createWriteBatches();
    const operations: number = WRITE_TRANSACTION_COUNT *
      IDENTITY_WRITE_BATCH_MAX_ENTRIES;
    const result: ChildResult = measuredResult({
      operation: "storage-write-hot-connection",
      operations,
      batches: WRITE_TRANSACTION_COUNT,
      run: (): number => runWriteBatches(fixture.database, batches),
    });
    if (result.checksum !== operations) {
      throw new Error(`Write benchmark checksum mismatch: ${result.checksum}.`);
    }
    return result;
  } finally {
    closeFixture(fixture);
  }
}

export function runColdWriteChild(mockRoot: string): ChildResult {
  const fixture: DatabaseFixture = createFixture(mockRoot);
  closeStorageDatabase(fixture.database);
  try {
    const allBatches: readonly ReadonlyMap<number, StorageDatabaseChange>[] =
      createWriteBatches();
    const warmup: readonly ReadonlyMap<number, StorageDatabaseChange>[] =
      allBatches.slice(0, 4);
    runColdWriteBatches(fixture.path, warmup);
    const cleanupDatabase: StorageDatabase = openStorageDatabase({
      path: fixture.path,
    });
    try {
      clearStorageBusinessTables(cleanupDatabase);
    } finally {
      closeStorageDatabase(cleanupDatabase);
    }
    const batches: readonly ReadonlyMap<number, StorageDatabaseChange>[] =
      allBatches.slice(0, COLD_WRITE_TRANSACTION_COUNT);
    const operations: number = COLD_WRITE_TRANSACTION_COUNT *
      IDENTITY_WRITE_BATCH_MAX_ENTRIES;
    const result: ChildResult = measuredResult({
      operation: "storage-write-cold-connection",
      operations,
      batches: COLD_WRITE_TRANSACTION_COUNT,
      run: (): number => runColdWriteBatches(fixture.path, batches),
    });
    if (result.checksum !== operations) {
      throw new Error(`Cold write benchmark checksum mismatch: ${result.checksum}.`);
    }
    return result;
  } finally {
    removeFixture(fixture);
  }
}
