import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dirtyWedChats, pendingWedMembers, wedFileFlushTimer } from "../../cache/workers/diskIO/wed";
import { FLUSH_INTERVAL_MS } from "../../consts/diskIO/appendOnly";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { TMP_FILE_SUFFIX, WED_MEMORY_DIR } from "../../consts/paths";
import { STATE_MANAGED_CHAT_LIMIT } from "../../consts/storage";
import { WED_MEMBER_LIMIT } from "../../consts/wed";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import { assertDirectoryReadableWritable, assertFileReadableWritable } from "../../libs/fileAccess";
import { isErrno } from "../../libs/errno";
import { invalidInput, readJsonInput } from "../../libs/inputValidation";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import type { WedMembersDiskMessage } from "../../types/diskIO/messages";
import { flushDirtyEntries } from "./dirtyFlush";

export interface WedMemberInspection {
  readonly snapshots: ReadonlyMap<number, Set<number>>;
  readonly temporaryPaths: readonly string[];
}

/** 启动只读门禁：文件名、数字 ID、唯一性、每群容量和群总数均严格验证。 */
export async function inspectWedMemberFiles(): Promise<WedMemberInspection> {
  const snapshots: Map<number, Set<number>> = new Map();
  const temporaryPaths: string[] = [];
  let names: readonly string[];
  try {
    names = readdirSync(WED_MEMORY_DIR);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return { snapshots, temporaryPaths };
    return invalidInput(WED_MEMORY_DIR, "$", "a readable directory");
  }
  assertDirectoryReadableWritable(WED_MEMORY_DIR);
  for (const name of names) {
    const path: string = join(WED_MEMORY_DIR, name);
    if (name.endsWith(TMP_FILE_SUFFIX)) { temporaryPaths.push(path); continue; }
    if (!name.endsWith(".json")) continue;
    const chatIdText: string = name.slice(0, -".json".length);
    const chatId: number = Number(chatIdText);
    if (!isTelegramGroupChatId(chatId) || String(chatId) !== chatIdText) {
      return invalidInput(path, "$filename", "the canonical <negative safe integer chatId>.json form");
    }
    if (snapshots.size >= STATE_MANAGED_CHAT_LIMIT) {
      return invalidInput(WED_MEMORY_DIR, "$", `at most ${STATE_MANAGED_CHAT_LIMIT} group files`);
    }
    assertFileReadableWritable(path);
    const parsed: unknown = await readJsonInput(path);
    if (!Array.isArray(parsed) || parsed.length > WED_MEMBER_LIMIT) {
      return invalidInput(path, "$", `an array of at most ${WED_MEMBER_LIMIT} unique positive safe integer user IDs`);
    }
    const ids: Set<number> = new Set();
    for (let index: number = 0; index < parsed.length; index++) {
      const id: unknown = parsed[index];
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || ids.has(id)) {
        return invalidInput(path, `$[${index}]`, "a unique positive safe integer user ID");
      }
      ids.add(id);
    }
    snapshots.set(chatId, ids);
  }
  return { snapshots, temporaryPaths };
}

/** 全域校验成功后创建目录并清除未提交的临时文件。 */
export async function maintainWedMemberFiles(inspection: WedMemberInspection): Promise<void> {
  mkdirSync(WED_MEMORY_DIR, { recursive: true });
  for (const path of inspection.temporaryPaths) await Bun.file(path).delete();
}

/** 唯一落盘边界；完整数组经现有 tmp、fsync、rename 实现原子替换，缺失文件自动创建。 */
export function writeWedMemberFile(chatId: number, members: readonly number[]): void {
  mkdirSync(WED_MEMORY_DIR, { recursive: true });
  atomicWriteTextSync(join(WED_MEMORY_DIR, `${chatId}.json`), JSON.stringify(members), PERSISTED_FILE_MODE);
}

/** 主线程已按 TTL/累计条数合并；到达 DiskIO 后直接提交，失败仅保留每群最新一份。 */
export function handleWedMembersMessage(message: WedMembersDiskMessage): void {
  pendingWedMembers.set(message.chatId, message.members);
  dirtyWedChats.add(message.chatId);
  if (wedFileFlushTimer.current === null) flushWedMemberFiles();
}

/** 复用统一 dirty flush 与原子写入；强制 flush 同样报告本领域失败，重试 timer 不阻止退出。 */
export function flushWedMemberFiles(
  write: typeof writeWedMemberFile = writeWedMemberFile
): boolean {
  if (wedFileFlushTimer.current !== null) clearTimeout(wedFileFlushTimer.current);
  wedFileFlushTimer.current = null;
  flushDirtyEntries({
    dirty: dirtyWedChats,
    cache: pendingWedMembers,
    write,
    describeFailure: (chatId: number): string => `[diskIOWorker] failed to write wed members for chat ${chatId}:`,
  });
  for (const chatId of pendingWedMembers.keys()) {
    if (!dirtyWedChats.has(chatId)) pendingWedMembers.delete(chatId);
  }
  if (dirtyWedChats.size > 0) {
    wedFileFlushTimer.current = setTimeout(flushWedMemberFiles, FLUSH_INTERVAL_MS);
    wedFileFlushTimer.current.unref();
  }
  return dirtyWedChats.size === 0;
}
