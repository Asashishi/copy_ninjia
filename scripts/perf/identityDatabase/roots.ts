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
  "../../fixtures/storageDatabase";
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
import { PERFORMANCE_MOCK_ROOT, PROJECT_ROOT } from "../fullSuite/mockRoot";
import {
  assertUnlinkedFixtureParent,
  assertUnlinkedFixturePath,
  type FixturePathBoundary,
} from "../../fixtures/pathBoundary";
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
 *
 * 本函数只做纯词法形态判定：看根的父目录和前缀，不读文件系统。真正会建目录或
 * 删除的入口必须再走 `assertMockRoot`，由它补上真实路径分量的核对。
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

/** 拒绝文案里对本基准的称呼；两种形态共用。 */
const IDENTITY_SUBJECT: string = "Identity benchmark";

/**
 * 取这一个 mock 根对应的文件系统边界：允许根就是它自己，锚点按形态选——全量
 * 基准形态锚在仓库根（于是 `performance/` 与 `run-*` 两段都要核对），独立运行
 * 形态锚在系统临时目录。
 */
function boundaryFor(mockRoot: string): FixturePathBoundary {
  const resolved: string = resolve(mockRoot);
  return {
    anchor: dirname(resolved) === PERFORMANCE_MOCK_ROOT ? PROJECT_ROOT : resolve(tmpdir()),
    root: resolved,
    subject: IDENTITY_SUBJECT,
  };
}

/** 形态与真实路径分量都要成立；词法判定挡不住指向根外的软链接。 */
export function assertMockRoot(root: string): void {
  if (!isBenchmarkMockRoot(root)) {
    throw new Error("Identity benchmark requires its isolated temporary mock root.");
  }
  assertUnlinkedFixturePath(root, boundaryFor(root));
}

/**
 * 删除本基准在 mock 根内建出的一棵子树；失败清理分支也走这里，不留直接 `rmSync`
 * 的旁路。只核对父链：末端本身是软链接时只摘链接、不动目标。
 */
export function removeMainBenchmarkRoot(path: string, mockRoot: string): void {
  assertMockRoot(mockRoot);
  assertUnlinkedFixtureParent(path, boundaryFor(mockRoot));
  rmSync(path, { recursive: true, force: true });
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
    removeMainBenchmarkRoot(temporaryRoot, mockRoot);
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
