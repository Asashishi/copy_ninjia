import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TMP_FILE_SUFFIX } from "../consts/paths";
import type { FileHandle } from "node:fs/promises";

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
  const handle: FileHandle = await open(dirname(path), "r");
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

/** 同步 path 所在目录的目录项，供唯一的磁盘 I/O Worker 使用。 */
export function syncDirectorySync(path: string): void {
  const fd: number = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

type AtomicSyncWriter = (fd: number) => number;

/**
 * 同步原子写的公共生命周期。writer 返回已经写入的字节数，异常统一走
 * close + unlink，避免文本与分块写各自维护一套容易漂移的失败路径。
 */
function atomicWriteSync(
  path: string,
  writer: AtomicSyncWriter,
  mode?: number
): number {
  const tmpPath: string = temporaryPath(path);
  const fd: number = openSync(tmpPath, "wx", mode);
  let writtenBytes: number;
  try {
    writtenBytes = writer(fd);
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
  return writtenBytes;
}

/**
 * 读出目标文件当前的权限位；文件还不存在时返回 undefined（首次创建没有可
 * 沿用的权限，交给 open 的默认值）。ENOENT 之外的失败不吞：那时紧接着的
 * open 同样写不进去，谎报「没有权限可沿用」只会把真正的错误推迟一步。
 */
async function currentFileMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * 原子替换文本文件，并同步文件数据和父目录项。
 *
 * 权限必须显式接管：临时文件是新建的，`0666 & ~umask`（常见 0644）与目标
 * 原有的权限没有任何关系，而 rename 直接把它替换上去——部署方 `chmod 0600`
 * 过的 config/whitelist.json、state.json、bot.lock 会在一次普通写入后被静默
 * 放宽，且不留日志。`mode` 显式传入时以它为准（同 atomicWriteSync）；不传
 * 时沿用目标文件当前的权限，目标不存在才落到默认值上。
 */
export async function atomicWriteText(path: string, content: string, mode?: number): Promise<void> {
  const targetMode: number | undefined = mode ?? await currentFileMode(path);
  const tmpPath: string = temporaryPath(path);
  const handle: FileHandle = await open(tmpPath, "wx", targetMode);
  try {
    await handle.writeFile(content);
    // open(2) 的 mode 会被进程 umask 收紧。在临时文件尚未 rename 可见前显式
    // 设回要求的最终权限，理由同 atomicWriteSync。
    if (targetMode !== undefined) await handle.chmod(targetMode);
    await handle.sync();
  } catch (error: unknown) {
    await handle.close().catch((): undefined => undefined);
    await unlink(tmpPath).catch((): undefined => undefined);
    throw error;
  }
  try {
    await handle.close();
  } catch (error: unknown) {
    // close() 本身失败：不能再假设 tmp 文件完好可用，按失败路径清理，
    // 不尝试 rename——否则 close 抛错时会跳过下面的清理，留下孤儿 .tmp。
    await unlink(tmpPath).catch((): undefined => undefined);
    throw error;
  }

  try {
    await durableRename(tmpPath, path);
  } catch (error: unknown) {
    await unlink(tmpPath).catch((): undefined => undefined);
    throw error;
  }
}

/** atomicWriteText 的同步版本，供唯一的磁盘 IO Worker 使用。 */
export function atomicWriteTextSync(path: string, content: string, mode?: number): void {
  atomicWriteSync(path, (fd: number): number => {
    writeFileSync(fd, content);
    return Buffer.byteLength(content);
  }, mode);
}

/**
 * 逐块原子替换文本文件，并返回最终字节数。调用方必须让 iterable 可完整重放
 * 一次；本函数不把所有 chunk 汇总成一个大字符串，单次只保留当前块的 Buffer。
 */
export function atomicWriteTextChunksSync(
  path: string,
  chunks: Iterable<string>,
  mode?: number
): number {
  return atomicWriteSync(path, (fd: number): number => {
    let writtenBytes: number = 0;
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const buffer: Buffer = Buffer.from(chunk);
      let offset: number = 0;
      while (offset < buffer.length) {
        const written: number = writeSync(
          fd,
          buffer,
          offset,
          buffer.length - offset,
          null
        );
        if (
          !Number.isSafeInteger(written) ||
          written <= 0 ||
          written > buffer.length - offset
        ) {
          throw new Error(
            `Atomic chunk write made no valid progress (${written} byte(s) reported).`
          );
        }
        offset += written;
        writtenBytes += written;
      }
    }
    return writtenBytes;
  }, mode);
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
