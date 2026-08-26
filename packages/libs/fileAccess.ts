import { accessSync, constants } from "node:fs";
import { invalidInput } from "./inputValidation";

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
