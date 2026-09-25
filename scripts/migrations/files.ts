import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { Stats } from "node:fs";
import { invalidInput } from "../../packages/libs/inputValidation";
import { isErrno } from "../../packages/libs/errno";

/** 冷迁移清单里的一项：相对路径、哈希与权限元数据，不记录文件内容。 */
export interface MigrationFileRecord {
  readonly path: string;
  readonly sha256: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

/** 清单哈希按 Bun 文件流增量计算，不持有整份文件。 */
async function fileSha256(path: string): Promise<string> {
  const hasher: Bun.CryptoHasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/** 读取 root 下一个普通文件的清单项；符号链接与非普通文件一律拒绝。 */
export async function readMigrationFileRecord(root: string, path: string): Promise<MigrationFileRecord> {
  const fullPath: string = join(root, path);
  const stats: Stats = await lstat(fullPath);
  if (!stats.isFile()) return invalidInput(fullPath, "$type", "a regular file without symbolic links");
  return {
    path,
    sha256: await fileSha256(fullPath),
    mode: stats.mode & 0o7777,
    uid: stats.uid,
    gid: stats.gid,
  };
}

/**
 * 按顺序读取 root 下的清单项。optional 中的路径真正缺省时跳过；悬空链接、类型不符
 * 与读取失败一律拒绝。
 */
export async function readMigrationFileRecords(
  root: string,
  paths: readonly string[],
  optional: ReadonlySet<string>
): Promise<readonly MigrationFileRecord[]> {
  const records: MigrationFileRecord[] = [];
  for (const path of paths) {
    try {
      records.push(await readMigrationFileRecord(root, path));
    } catch (error: unknown) {
      if (!optional.has(path) || !isErrno(error, "ENOENT")) throw error;
    }
  }
  return records;
}

/** 解析后的祖先关系：child 等于 parent 或位于其下时为 true。 */
export function migrationPathContains(parent: string, child: string): boolean {
  const path: string = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"));
}
