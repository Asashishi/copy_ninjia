import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TMP_FILE_SUFFIX } from "../consts/paths";

/**
 * 可持久化的原子文件操作。写入遵循“同目录唯一临时文件 -> fsync -> rename ->
 * 父目录 fsync”，避免进程崩溃后留下半份目标文件，并保证目录项已落盘。
 */
function temporaryPath(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${crypto.randomUUID()}${TMP_FILE_SUFFIX}`
  );
}

/**
 * 同步 path 所在目录的目录项，让此前的 rename/link/unlink 在掉电后仍可见。
 * 导出供 hard link 协议（infra/storage/instanceLock.ts）复用，不要另抄一份。
 */
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** rename 后同步涉及的目录项；用于把损坏文件持久隔离到同目录唯一路径。 */
export async function durableRename(sourcePath: string, destinationPath: string): Promise<void> {
  await rename(sourcePath, destinationPath);
  await syncDirectory(destinationPath);
  if (dirname(sourcePath) !== dirname(destinationPath)) await syncDirectory(sourcePath);
}

function syncDirectorySync(path: string): void {
  const fd: number = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 原子替换文本文件，并同步文件数据和父目录项。 */
export async function atomicWriteText(path: string, content: string): Promise<void> {
  const tmpPath: string = temporaryPath(path);
  const handle = await open(tmpPath, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
  try {
    await handle.close();
  } catch (error: unknown) {
    // close() 本身失败：不能再假设 tmp 文件完好可用，按失败路径清理，
    // 不尝试 rename——否则 close 抛错时会跳过下面的清理，留下孤儿 .tmp。
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }

  try {
    await durableRename(tmpPath, path);
  } catch (error: unknown) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/** atomicWriteText 的同步版本，供唯一的磁盘 IO Worker 使用。 */
export function atomicWriteTextSync(path: string, content: string, mode?: number): void {
  const tmpPath: string = temporaryPath(path);
  const fd: number = openSync(tmpPath, "wx", mode);
  try {
    writeFileSync(fd, content);
    // open(2) 的 mode 会被进程 umask 收紧。在临时文件尚未 rename 可见前
    // 显式设回调用方要求的最终权限，避免目标曾短暂以 0600 出现。
    if (mode !== undefined) fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (error: unknown) {
    try {
      closeSync(fd);
    } catch {
      // closeSync 若也抛错不能让它盖过原始写入错误（下面 throw error 抛的
      // 仍是 write/fsync 失败），否则会跳过 unlinkSync 清理、留下孤儿 .tmp。
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // 保留原始写入错误。
    }
    throw error;
  }
  try {
    closeSync(fd);
  } catch (error: unknown) {
    // close 本身失败：不能再假设 tmp 文件完好可用，按失败路径清理，
    // 不尝试 rename。
    try {
      unlinkSync(tmpPath);
    } catch {
      // 保留原始 close 错误。
    }
    throw error;
  }

  try {
    renameSync(tmpPath, path);
    syncDirectorySync(path);
  } catch (error: unknown) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // rename 成功时临时路径已经不存在；失败时保留原始错误。
    }
    throw error;
  }
}

/** 删除文件并同步父目录；文件已不存在视为成功。 */
export function durableUnlinkSync(path: string): void {
  try {
    unlinkSync(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  syncDirectorySync(path);
}
