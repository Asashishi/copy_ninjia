import { link, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface DataRootProbeDependencies {
  mkdir: typeof mkdir;
  stat: typeof stat;
  open: typeof open;
  link: typeof link;
  rename: typeof rename;
  unlink: typeof unlink;
}

const DEFAULT_DEPENDENCIES: DataRootProbeDependencies = { mkdir, stat, open, link, rename, unlink };

/**
 * 在实例锁和任何联网/Worker 初始化之前验证数据根真正支持本仓库依赖的
 * durability 原语：可创建/写入、同目录 hard link、原子 rename 与目录 fsync。
 */
export async function prepareRuntimeDataRoot(
  dataRoot: string,
  dependencies: Partial<DataRootProbeDependencies> = {}
): Promise<void> {
  const root: string = resolve(dataRoot);
  const fs: DataRootProbeDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const nonce: string = `${process.pid}.${crypto.randomUUID()}`;
  const sourcePath: string = join(root, `.copy-ninjia-preflight.${nonce}`);
  const linkPath: string = `${sourcePath}.link`;
  const renamedPath: string = `${sourcePath}.renamed`;
  let sourceHandle: FileHandle | null = null;
  let directoryHandle: FileHandle | null = null;

  try {
    await fs.mkdir(root, { recursive: true });
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) throw new Error("path exists but is not a directory");

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
    await sourceHandle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
    await fs.unlink(linkPath).catch(() => undefined);
    await fs.unlink(renamedPath).catch(() => undefined);
    await fs.unlink(sourcePath).catch(() => undefined);
  }
}
