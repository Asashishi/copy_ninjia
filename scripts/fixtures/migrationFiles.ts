/** 冷迁移端到端验证用的文件快照：来源、实际目标、哈希与权限元数据，不记录内容。 */
import { lstat, readlink, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isErrno } from "../../packages/libs/errno";
import { invalidInput } from "../../packages/libs/inputValidation";

export interface MigrationFileSnapshot {
  readonly path: string;
  readonly resolvedPath: string;
  readonly linkTarget: string | null;
  readonly linkMode: number;
  readonly linkUid: number;
  readonly linkGid: number;
  readonly sha256: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

/** 只有叶子真正缺省才返回 null；文件链接须指向可读普通文件。 */
export async function readMigrationFileSnapshot(path: string): Promise<MigrationFileSnapshot | null> {
  let entry: Stats;
  try {
    entry = await lstat(path);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return null;
    return invalidInput(path, "$type", "an accessible regular file or a valid file symbolic link");
  }
  try {
    const resolvedPath: string = await realpath(path);
    const stats: Stats = await Bun.file(resolvedPath).stat();
    if (!stats.isFile()) return invalidInput(path, "$type", "a regular file");
    const hasher: Bun.CryptoHasher = new Bun.CryptoHasher("sha256");
    for await (const chunk of Bun.file(resolvedPath).stream()) hasher.update(chunk);
    return {
      path, resolvedPath, linkTarget: entry.isSymbolicLink() ? await readlink(path) : null,
      linkMode: entry.mode & 0o7777, linkUid: entry.uid, linkGid: entry.gid,
      sha256: hasher.digest("hex"), mode: stats.mode & 0o7777, uid: stats.uid, gid: stats.gid,
    };
  } catch {
    return invalidInput(path, "$type", "a readable regular file with valid symbolic-link topology");
  }
}
