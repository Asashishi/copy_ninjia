import {
  closeSync,
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

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
  await handle.close();

  try {
    await rename(tmpPath, path);
    await syncDirectory(path);
  } catch (error: unknown) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/** atomicWriteText 的同步版本，供唯一的磁盘 IO Worker 使用。 */
export function atomicWriteTextSync(path: string, content: string): void {
  const tmpPath: string = temporaryPath(path);
  const fd: number = openSync(tmpPath, "wx");
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } catch (error: unknown) {
    closeSync(fd);
    try {
      unlinkSync(tmpPath);
    } catch {
      // 保留原始写入错误。
    }
    throw error;
  }
  closeSync(fd);

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
