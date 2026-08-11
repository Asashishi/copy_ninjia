import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import {
  RUNTIME_DATA_ROOT_MAX_MODE,
  RUNTIME_SENSITIVE_DIRECTORY_NAMES,
} from "../../consts/storage";
import { IDENTITY_DATABASE_DIRECTORY_MODE } from "../../consts/identityStorage";
import { isErrno } from "../../libs/errno";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Stats } from "node:fs";

export interface DataRootProbeDependencies {
  mkdir: typeof mkdir;
  lstat: typeof lstat;
  open: typeof open;
  link: typeof link;
  rename: typeof rename;
  unlink: typeof unlink;
}

const DEFAULT_DEPENDENCIES: DataRootProbeDependencies = { mkdir, lstat, open, link, rename, unlink };

export interface PrepareRuntimeDataRootOptions {
  dependencies?: Partial<DataRootProbeDependencies>;
  enforcePrivatePermissions?: boolean;
  expectedGroupGids?: readonly number[];
  expectedOwnerUid?: number;
}

interface AssertPrivateDirectoryOptions {
  readonly allowCollaborativeGroup: boolean;
  readonly expectedGroupGids: readonly number[];
  readonly expectedOwnerUid: number | undefined;
  readonly maximumMode: number;
}

function formatUnixMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function assertPrivateDirectory(
  path: string,
  stats: Stats,
  {
    allowCollaborativeGroup,
    expectedGroupGids,
    expectedOwnerUid,
    maximumMode,
  }: AssertPrivateDirectoryOptions
): void {
  if (stats.isSymbolicLink()) {
    throw new Error(`${path} is a symbolic link; runtime data directories must be real directories`);
  }
  if (!stats.isDirectory()) throw new Error(`${path} exists but is not a directory`);
  const mode: number = stats.mode & 0o777;
  const hasWritableCollaborativeGroup: boolean =
    allowCollaborativeGroup &&
    expectedGroupGids.includes(stats.gid) &&
    (mode & 0o070) === 0o070;
  if (
    expectedOwnerUid !== undefined &&
    stats.uid !== expectedOwnerUid &&
    !hasWritableCollaborativeGroup
  ) {
    throw new Error(
      `${path} is owned by uid ${stats.uid}, expected runtime uid ${expectedOwnerUid}; ` +
      (allowCollaborativeGroup
        ? "stop all instances and correct the owner or writable deployment group"
        : "stop all instances and correct the owner")
    );
  }
  if ((mode & ~maximumMode) !== 0) {
    throw new Error(
      `${path} mode ${formatUnixMode(mode)} is broader than ${formatUnixMode(maximumMode)}; ` +
      `stop all instances and run chmod ${formatUnixMode(maximumMode)} -- ${JSON.stringify(path)}`
    );
  }
}

function currentProcessGroupIds(): readonly number[] {
  return typeof process.getgroups === "function" ? process.getgroups() : [];
}

/**
 * 在实例锁和任何联网/Worker 初始化之前验证数据根真正支持本仓库依赖的
 * durability 原语：可创建/写入、同目录 hard link、原子 rename 与目录 fsync。
 * 显式配置的生产数据根还必须是 0750 或更严格；已有目录只校验、不自动
 * chmod，避免进程替部署者改变共享主机上的访问策略。
 */
export async function prepareRuntimeDataRoot(
  dataRoot: string,
  options: PrepareRuntimeDataRootOptions = {}
): Promise<void> {
  const {
    dependencies = {},
    enforcePrivatePermissions = true,
    expectedGroupGids = currentProcessGroupIds(),
    expectedOwnerUid = typeof process.getuid === "function" ? process.getuid() : undefined,
  }: PrepareRuntimeDataRootOptions = options;
  const root: string = resolve(dataRoot);
  const fs: DataRootProbeDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const nonce: string = `${process.pid}.${crypto.randomUUID()}`;
  const sourcePath: string = join(root, `.copy-ninjia-preflight.${nonce}`);
  const linkPath: string = `${sourcePath}.link`;
  const renamedPath: string = `${sourcePath}.renamed`;
  let sourceHandle: FileHandle | null = null;
  let directoryHandle: FileHandle | null = null;

  try {
    await fs.mkdir(root, { recursive: true, mode: RUNTIME_DATA_ROOT_MAX_MODE });
    const rootStat: Stats = await fs.lstat(root);
    if (rootStat.isSymbolicLink()) {
      throw new Error("path is a symbolic link; runtime data roots must be real directories");
    }
    if (!rootStat.isDirectory()) throw new Error("path exists but is not a directory");
    if (enforcePrivatePermissions) {
      assertPrivateDirectory(root, rootStat, {
        allowCollaborativeGroup: false,
        expectedGroupGids,
        expectedOwnerUid,
        maximumMode: RUNTIME_DATA_ROOT_MAX_MODE,
      });
    }
    for (const directoryName of RUNTIME_SENSITIVE_DIRECTORY_NAMES) {
      const directoryPath: string = join(root, directoryName);
      const isIdentityDatabaseDirectory: boolean = directoryName === "database";
      let directoryStat: Stats;
      try {
        directoryStat = await fs.lstat(directoryPath);
      } catch (error: unknown) {
        if (!isErrno(error, "ENOENT")) throw error;
        if (!enforcePrivatePermissions) continue;
        await fs.mkdir(directoryPath, {
          recursive: true,
          mode: RUNTIME_DATA_ROOT_MAX_MODE,
        });
        directoryStat = await fs.lstat(directoryPath);
      }
      if (enforcePrivatePermissions) {
        assertPrivateDirectory(directoryPath, directoryStat, {
          allowCollaborativeGroup: isIdentityDatabaseDirectory,
          expectedGroupGids,
          expectedOwnerUid,
          maximumMode: isIdentityDatabaseDirectory
            ? IDENTITY_DATABASE_DIRECTORY_MODE & 0o777
            : RUNTIME_DATA_ROOT_MAX_MODE,
        });
      } else if (directoryStat.isSymbolicLink()) {
        throw new Error(`${directoryPath} is a symbolic link; runtime data directories must be real directories`);
      } else if (!directoryStat.isDirectory()) {
        throw new Error(`${directoryPath} exists but is not a directory`);
      }
    }

    sourceHandle = await fs.open(sourcePath, "wx", 0o600);
    await sourceHandle.writeFile("copy-ninjia data root preflight\n");
    await sourceHandle.sync();
    await sourceHandle.close();
    sourceHandle = null;

    await fs.link(sourcePath, linkPath);
    await fs.rename(linkPath, renamedPath);
    directoryHandle = await fs.open(root, "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = null;
  } catch (error: unknown) {
    const reason: Error = error instanceof Error ? error : new Error(String(error));
    throw new Error(
      `Runtime data root preflight failed for ${root}: ${reason.message}. ` +
      "Ensure it is a writable directory on a filesystem that supports hard links, atomic rename, and directory fsync.",
      { cause: error }
    );
  } finally {
    await sourceHandle?.close().catch((): undefined => undefined);
    await directoryHandle?.close().catch((): undefined => undefined);
    await fs.unlink(linkPath).catch((): undefined => undefined);
    await fs.unlink(renamedPath).catch((): undefined => undefined);
    await fs.unlink(sourcePath).catch((): undefined => undefined);
  }
}
