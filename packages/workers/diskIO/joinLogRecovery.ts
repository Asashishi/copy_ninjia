import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  joinLogCleanupDay,
  joinLogFileCaches,
  joinLogRetryAt,
} from "../../cache/workers/diskIO/joinLog";
import {
  JOIN_LOG_FILE_PATTERN,
  JOIN_LOG_FILE_RETENTION_DAYS,
  JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
} from "../../consts/diskIO/joinLog";
import { JOIN_LOG_MEMORY_DIR, TMP_FILE_SUFFIX } from "../../consts/paths";
import { invalidInput, readUtf8TextInput } from "../../libs/inputValidation";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import {
  getTokyoDateKey,
  isCanonicalDateKey,
} from "../../libs/time";
import type { JoinLogRecord } from "../../types/diskIO/storage";
import { openValidatedAppendOnlyFile } from "./appendOnlyDayFile";
import {
  assertJoinLogSchema,
  latestJoinLogRecords,
  recentJoinLogDayKeys,
} from "./joinLogRecords";

/** 一份已通过领域 schema 校验的入群日志文件：原始字节与解析结果。 */
export interface ValidatedJoinLogFile {
  readonly content: string;
  readonly parsed: Record<string, JoinLogRecord>;
}

/** 读取并严格校验一份已存在的入群日志文件。 */
export async function readValidatedJoinLogFile(
  path: string
): Promise<ValidatedJoinLogFile> {
  let content: string;
  let candidate: unknown;
  try {
    content = await readUtf8TextInput(path);
    candidate = JSON.parse(content) as unknown;
  } catch {
    return invalidInput(path, "$", "a readable valid JSON document");
  }
  assertJoinLogSchema(path, candidate);
  return { content, parsed: candidate };
}

/** 按文件名清掉保留窗口以外的入群日志和遗留临时文件，不读取日志内容。 */
export function cleanupExpiredJoinLogDays(
  today: string,
  knownNames?: readonly string[]
): void {
  mkdirSync(JOIN_LOG_MEMORY_DIR, { recursive: true });
  const names: readonly string[] = knownNames ?? readdirSync(JOIN_LOG_MEMORY_DIR);
  const retainedDays: ReadonlySet<string> =
    recentJoinLogDayKeys(today, JOIN_LOG_FILE_RETENTION_DAYS);
  for (const name of names) {
    const path: string = join(JOIN_LOG_MEMORY_DIR, name);
    if (name.endsWith(TMP_FILE_SUFFIX)) {
      try {
        unlinkSync(path);
      } catch {
        // 权限异常不阻断当天记录；下一次跨日清理仍会重试。
      }
      continue;
    }
    const match: RegExpExecArray | null = JOIN_LOG_FILE_PATTERN.exec(name);
    if (match === null || retainedDays.has(match[2]!) || match[2]! > today) continue;
    try {
      unlinkSync(path);
      const key: string = `${Number(match[1]!)}:${match[2]!}`;
      joinLogFileCaches.delete(key);
      joinLogRetryAt.delete(key);
    } catch {
      // 清理失败不影响窗口内事实；旧文件留给下一次跨日清理重试。
    }
  }
  joinLogCleanupDay.current = today;
}

export interface JoinLogRecoveryInspection {
  readonly today: string;
  readonly names: readonly string[];
}

/** 启动第一阶段：只读扫描保留窗口，不填充常驻 LRU 或删除文件。 */
export async function inspectJoinLogFiles(
  today: string = getTokyoDateKey()
): Promise<JoinLogRecoveryInspection> {
  const retainedDays: ReadonlySet<string> =
    recentJoinLogDayKeys(today, JOIN_LOG_FILE_RETENTION_DAYS);
  const names: string[] = existsSync(JOIN_LOG_MEMORY_DIR)
    ? readdirSync(JOIN_LOG_MEMORY_DIR)
    : [];
  for (const name of names) {
    if (name.endsWith(TMP_FILE_SUFFIX)) continue;
    const path: string = join(JOIN_LOG_MEMORY_DIR, name);
    const match: RegExpExecArray | null = JOIN_LOG_FILE_PATTERN.exec(name);
    if (match === null) {
      if (name.endsWith(".json")) {
        return invalidInput(path, "$filename", "the canonical <chatId>.<YYYY-MM-DD>.json form");
      }
      continue;
    }
    const chatIdText: string = match[1]!;
    const chatId: number = Number(chatIdText);
    const day: string = match[2]!;
    if (!isTelegramGroupChatId(chatId) || String(chatId) !== chatIdText) {
      return invalidInput(
        path,
        "$filename",
        "a canonical negative safe-integer Telegram group or channel ID"
      );
    }
    if (!isCanonicalDateKey(day)) {
      return invalidInput(path, "$filename", "a canonical calendar date");
    }
    if (day > today) {
      return invalidInput(path, "$filename", "a date no later than the current Tokyo day");
    }
    if (!retainedDays.has(day)) continue;
    const { content, parsed }: ValidatedJoinLogFile =
      await readValidatedJoinLogFile(path);
    const latest: Map<number, JoinLogRecord> = latestJoinLogRecords(parsed);
    if (latest.size > JOIN_LOG_MAX_USERS_PER_CHAT_DAY) {
      return invalidInput(
        path,
        "$",
        `at most ${JOIN_LOG_MAX_USERS_PER_CHAT_DAY} distinct users per chat day`
      );
    }
    openValidatedAppendOnlyFile({
      path,
      content,
      empty: Object.keys(parsed).length === 0,
    });
  }
  return { today, names };
}

/** 全域启动成功后清理过期日与临时文件。 */
export function maintainJoinLogFiles(
  inspection: JoinLogRecoveryInspection
): void {
  cleanupExpiredJoinLogDays(inspection.today, inspection.names);
}
