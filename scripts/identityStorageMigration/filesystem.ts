import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

/** 计算迁移清单使用的 SHA-256；只读取指定普通文件。 */
export function migrationFileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 递归收集普通文件；迁移源和外部备份都拒绝符号链接。 */
export function collectMigrationFiles(
  root: string,
  relative: string = ""
): string[] {
  const path: string = relative.length === 0 ? root : join(root, relative);
  const stats: ReturnType<typeof lstatSync> = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new Error(
      `${path}: migration sources and backups must not contain symbolic links.`
    );
  }
  if (!stats.isDirectory()) {
    if (!stats.isFile()) {
      throw new Error(
        `${path}: migration sources must contain regular files only.`
      );
    }
    return [relative];
  }
  const files: string[] = [];
  for (const name of readdirSync(path).sort()) {
    const child: string = relative.length === 0 ? name : join(relative, name);
    files.push(...collectMigrationFiles(root, child));
  }
  return files;
}

/** 把普通文件或目录 inode 的当前内容同步到持久化介质。 */
export function fsyncMigrationPath(path: string): void {
  const fd: number = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 先同步目录树中的子目录，再同步根目录 inode。 */
export function fsyncMigrationDirectoryTree(path: string): void {
  for (const name of readdirSync(path)) {
    const child: string = join(path, name);
    if (lstatSync(child).isDirectory()) fsyncMigrationDirectoryTree(child);
  }
  fsyncMigrationPath(path);
}
