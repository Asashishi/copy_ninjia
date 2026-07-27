import { link, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import {
  RUNTIME_DATA_ROOT_MAX_MODE,
  RUNTIME_SENSITIVE_DIRECTORY_NAMES,
} from "../../consts/storage";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Stats } from "node:fs";

export interface DataRootProbeDependencies {
  mkdir: typeof mkdir;
  stat: typeof stat;
  open: typeof open;
  link: typeof link;
  rename: typeof rename;
  unlink: typeof unlink;
}

const DEFAULT_DEPENDENCIES: DataRootProbeDependencies = { mkdir, stat, open, link, rename, unlink };

export interface PrepareRuntimeDataRootOptions {
  dependencies?: Partial<DataRootProbeDependencies>;
  enforcePrivatePermissions?: boolean;
  expectedOwnerUid?: number;
}

function formatUnixMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function assertPrivateDirectory(
  path: string,
  stats: Stats,
  expectedOwnerUid: number | undefined
): void {
  if (!stats.isDirectory()) throw new Error(`${path} exists but is not a directory`);
  if (expectedOwnerUid !== undefined && stats.uid !== expectedOwnerUid) {
    throw new Error(
      `${path} is owned by uid ${stats.uid}, expected runtime uid ${expectedOwnerUid}; ` +
      "stop all instances and correct the owner"
    );
  }
  const mode: number = stats.mode & 0o777;
  if ((mode & ~RUNTIME_DATA_ROOT_MAX_MODE) !== 0) {
    throw new Error(
      `${path} mode ${formatUnixMode(mode)} is broader than 0750; ` +
      `stop all instances and run chmod 0750 -- ${JSON.stringify(path)}`
    );
  }
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
    const rootStat: Stats = await fs.stat(root);
    if (!rootStat.isDirectory()) throw new Error("path exists but is not a directory");
    if (enforcePrivatePermissions) {
      assertPrivateDirectory(root, rootStat, expectedOwnerUid);
      for (const directoryName of RUNTIME_SENSITIVE_DIRECTORY_NAMES) {
        const directoryPath: string = join(root, directoryName);
        await fs.mkdir(directoryPath, {
          recursive: true,
          mode: RUNTIME_DATA_ROOT_MAX_MODE,
        });
        assertPrivateDirectory(
          directoryPath,
          await fs.stat(directoryPath),
          expectedOwnerUid
        );
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
