/**
 * 冷迁移共用的工作树外备份原语。
 *
 * 冷迁移入口自己决定备份内容，
 * 但「怎么算备份成功」只有一份：写完立刻读回比对 SHA-256，并连同权限、属主、
 * 大小一起记进清单。`cp` 因无法保留属主而返回非零时，逐文件哈希核对就是唯一
 * 还能自证的凭据（见 AGENTS.md「数据、配置与迁移安全」）。
 */

import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 备份清单里的一项：源路径、备份文件名，以及可据此还原的元数据。 */
export interface BackupManifestEntry {
  readonly sourcePath: string;
  readonly backupFile: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly sha256: string;
}

/** 内容哈希；备份自证与迁移后核对共用同一套摘要。 */
export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** 把一个已存在的路径刷进磁盘；备份必须先落地才能被当成凭据。 */
export function fsyncPath(path: string): void {
  const fd: number = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 写入备份后立刻读回比对哈希；写成功不等于落地内容正确。 */
export function writeVerifiedBackup(root: string, backupFile: string, bytes: Uint8Array): void {
  const path: string = join(root, backupFile);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  fsyncPath(path);
  const persisted: Uint8Array = readFileSync(path);
  if (persisted.byteLength !== bytes.byteLength || sha256(persisted) !== sha256(bytes)) {
    throw new Error(`${path}: external migration backup hash verification failed.`);
  }
  fsyncPath(root);
}

/**
 * 以不覆盖语义写出备份清单，读回逐字复核并同步目录项。
 *
 * manifest 是恢复入口；调用方不能只同步数据副本而漏掉它。把完整耐久边界收在
 * 此处后，迁移脚本不会因少一次目录 fsync 得到一份掉电后找不到的备份。
 */
export function writeVerifiedBackupManifest(
  root: string,
  entries: readonly BackupManifestEntry[]
): void {
  const path: string = join(root, "manifest.json");
  const content: string = `${JSON.stringify(entries, null, 2)}\n`;
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  fsyncPath(path);
  if (readFileSync(path, "utf8") !== content) {
    throw new Error(`${path}: external migration backup manifest verification failed.`);
  }
  fsyncPath(root);
}

/** 按源文件当前的权限、属主与内容摘要生成一条清单项。 */
export function manifestEntry(
  sourcePath: string,
  backupFile: string,
  bytes: Uint8Array
): BackupManifestEntry {
  const stats: ReturnType<typeof statSync> = statSync(sourcePath);
  return {
    sourcePath,
    backupFile,
    mode: stats.mode & 0o777,
    uid: stats.uid,
    gid: stats.gid,
    size: bytes.byteLength,
    sha256: sha256(bytes),
  };
}
