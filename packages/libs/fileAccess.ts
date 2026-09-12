import { accessSync, constants, lstatSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import { invalidInput } from "./inputValidation";

/** 不跟随链接地检查路径；只有真正 ENOENT 返回 undefined，其它系统错误统一为输入错误。 */
function optionalEntry(path: string): Stats | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch {
    return invalidInput(path, "$type", "an accessible filesystem entry");
  }
}

/**
 * 只读检查可选领域目录；缺省返回 false，存在时要求可读写、可进入的目录。
 * 允许指向有效目录的链接；缺省分支继续核对父目录，祖先断链不能冒充缺省。
 * 同步契约供追加游标接管复用，Node lstat 保留链接本身的拓扑语义。
 */
export function inspectOptionalDirectory(path: string): boolean {
  const entry: Stats | undefined = optionalEntry(path);
  if (entry === undefined) {
    const parent: string = dirname(path);
    if (parent !== path) inspectOptionalDirectory(parent);
    return false;
  }
  try {
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && statSync(path).isDirectory())) {
      return invalidInput(path, "$type", "an accessible directory");
    }
  } catch {
    return invalidInput(path, "$type", "an accessible directory");
  }
  assertDirectoryReadableWritable(path);
  return true;
}

/**
 * 可选持久化文件只在所属目录有效且叶子真正缺省时返回 false；
 * 现有文件必须为可读写普通文件，不允许文件链接，不创建或修复路径。
 */
export function inspectOptionalFile(path: string): boolean {
  if (!inspectOptionalDirectory(dirname(path))) return false;
  if (optionalEntry(path) === undefined) return false;
  assertFileReadableWritable(path);
  return true;
}

/** 只读启动检查：已有持久化文件必须允许运行账号读取和写入，不自动 chmod。 */
export function assertFileReadableWritable(path: string): void {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
  } catch {
    return invalidInput(
      path,
      "$mode",
      "readable and writable by the runtime account without changing the existing mode"
    );
  }
  if (!optionalEntry(path)?.isFile()) {
    return invalidInput(path, "$type", "a regular file without symbolic-link indirection");
  }
}

/** SQLite 写连接还要求父目录可进入并可写，以维护 WAL/SHM sidecar。 */
export function assertDirectoryReadableWritable(path: string): void {
  try {
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    return invalidInput(
      path,
      "$mode",
      "readable, writable and searchable by the runtime account"
    );
  }
}
