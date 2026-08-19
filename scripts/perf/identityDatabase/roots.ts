import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../../../packages/consts/environment";
import {
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_KEY,
} from "../../../packages/consts/identityStorage";
import { seedStorageDatabase } from
  "../../../packages/database/interact/admin";
import {
  closeStorageDatabase,
  enableStorageDatabaseWal,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import { assertStorageDatabaseJsonbStorage } from
  "../../../packages/database/interact/inspection";
import { createStorageDatabase } from
  "../../../packages/database/interact/migration";
import type { StorageDatabase } from
  "../../../packages/types/storageDatabase";
import { RUN_ROOT_PREFIX } from "../fullSuite/constants";
import { PERFORMANCE_MOCK_ROOT } from "../fullSuite/mockRoot";
import {
  MAIN_BENCHMARK_ROOT_PREFIX,
  MOCK_ROOT_PREFIX,
} from "./constants";

/**
 * 本基准允许写入的 mock 根有两种形态，别的一律拒绝：
 *
 * 1. 独立运行 `bun run perf:identity-database` 时，系统临时目录下的
 *    `copy-ninjia-identity-mock-*`；
 * 2. 作为全量基准的存储分区被复用时，仓库 `performance/` 下的 `run-*`
 *    （见 scripts/perf/fullSuite/mockRoot.ts）。
 *
 * 两种形态共用同一道闸，而不是在全量基准里另写一份放宽版：多一份实现就多一
 * 条能绕过它写到真实数据根的路。
 */
export function isBenchmarkMockRoot(root: string): boolean {
  const resolvedRoot: string = resolve(root);
  if (
    dirname(resolvedRoot) === resolve(tmpdir()) &&
    basename(resolvedRoot).startsWith(MOCK_ROOT_PREFIX)
  ) return true;
  return dirname(resolvedRoot) === PERFORMANCE_MOCK_ROOT &&
    basename(resolvedRoot).startsWith(RUN_ROOT_PREFIX);
}

export function assertMockRoot(root: string): void {
  if (!isBenchmarkMockRoot(root)) {
    throw new Error("Identity benchmark requires its isolated temporary mock root.");
  }
}

export function createMockRoot(): string {
  return mkdtempSync(join(tmpdir(), MOCK_ROOT_PREFIX));
}

export function removeMockRoot(root: string): void {
  assertMockRoot(root);
  rmSync(root, { recursive: true, force: true });
}

export function createMainBenchmarkRoot(mockRoot: string): string {
  assertMockRoot(mockRoot);
  const temporaryRoot: string = mkdtempSync(
    join(mockRoot, MAIN_BENCHMARK_ROOT_PREFIX)
  );
  try {
    const databaseDirectory: string = join(temporaryRoot, "database");
    mkdirSync(databaseDirectory);
    const path: string = join(databaseDirectory, "storage.sqlite");
    createStorageDatabase(path);
    enableStorageDatabaseWal(path);
    const database: StorageDatabase = openStorageDatabase({ path });
    try {
      seedStorageDatabase(database, {
        metadata: [{
          key: IDENTITY_DATABASE_SCHEMA_KEY,
          data: IDENTITY_DATABASE_SCHEMA_DATA,
        }],
        whitelist: [],
        blocklist: [],
        removals: [],
      });
    } finally {
      closeStorageDatabase(database);
    }
    return temporaryRoot;
  } catch (error: unknown) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export function assertMainBenchmarkDatabase(temporaryRoot: string): void {
  const path: string = join(temporaryRoot, "database", "storage.sqlite");
  const database: StorageDatabase = openStorageDatabase({ path, readonly: true });
  try {
    assertStorageDatabaseJsonbStorage(database, path);
  } finally {
    closeStorageDatabase(database);
  }
}

export function mainBenchmarkEnvironment(
  temporaryRoot: string
): Readonly<Record<string, string | undefined>> {
  return {
    ...process.env,
    [RUNTIME_DATA_ROOT_ENV]: temporaryRoot,
    [CONFIG_ROOT_ENV]: join(process.cwd(), "config_example"),
  };
}
