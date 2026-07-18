import { createHash } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { BOT_LOCK_LINE_PATTERN } from "../../consts/storage";
import { LOCK_FILE_PATH } from "../../consts/paths";
import { atomicWriteText } from "../../libs/atomicFile";
import { logger } from "../logger";

interface BotLockRecord {
  pid: number;
  tokenFingerprint: string;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isErrno(error, "EPERM");
  }
}

export function getBotTokenFingerprint(botToken: string): string {
  if (botToken.length === 0) throw new Error("Cannot derive a bot instance lock from an empty token");
  return createHash("sha256").update(botToken, "utf8").digest("hex");
}

/** 严格读取 pid:sha256(token) 锁注册表；损坏格式必须人工修复。 */
async function readBotLockRecords(lockFilePath: string): Promise<BotLockRecord[]> {
  let content: string;
  try {
    content = await Bun.file(lockFilePath).text();
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  if (content === "") return [];
  if (!content.endsWith("\n")) throw new Error(`${lockFilePath} has an invalid lock registry format; repair it manually.`);

  const records: BotLockRecord[] = [];
  const fingerprints: Set<string> = new Set();
  for (const line of content.slice(0, -1).split("\n")) {
    const match = BOT_LOCK_LINE_PATTERN.exec(line);
    if (!match) throw new Error(`${lockFilePath} has an invalid lock registry format; repair it manually.`);
    const pid: number = Number(match[1]);
    const tokenFingerprint: string = match[2]!;
    if (!Number.isSafeInteger(pid) || fingerprints.has(tokenFingerprint)) {
      throw new Error(`${lockFilePath} has duplicate or invalid lock records; repair it manually.`);
    }
    fingerprints.add(tokenFingerprint);
    records.push({ pid, tokenFingerprint });
  }
  return records;
}

async function writeBotLockRecords(lockFilePath: string, records: BotLockRecord[]): Promise<void> {
  if (records.length === 0) {
    try {
      await unlink(lockFilePath);
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    return;
  }
  await atomicWriteText(
    lockFilePath,
    records.map((record) => `${record.pid}:${record.tokenFingerprint}\n`).join("")
  );
}

/** 用 hard link 原子发布 PID guard，并安全回收崩溃遗留的 stale guard。 */
async function acquirePidFileLock(lockFilePath: string): Promise<void> {
  const candidatePath: string = `${lockFilePath}.candidate.${process.pid}.${crypto.randomUUID()}`;
  const handle = await open(candidatePath, "wx");
  try {
    await handle.writeFile(String(process.pid));
  } finally {
    await handle.close();
  }

  try {
    for (;;) {
      try {
        await link(candidatePath, lockFilePath);
        return;
      } catch (error: unknown) {
        if (!isErrno(error, "EEXIST")) throw error;
      }

      let existingPid: number;
      try {
        existingPid = parseInt((await Bun.file(lockFilePath).text()).trim(), 10);
      } catch (error: unknown) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      if (!Number.isNaN(existingPid) && isProcessAlive(existingPid)) {
        throw new Error(`Another process (pid=${existingPid}) is updating the bot lock registry; retry startup shortly.`);
      }

      const recoveryPath: string = `${lockFilePath}.recovery`;
      for (;;) {
        try {
          await link(candidatePath, recoveryPath);
          break;
        } catch (error: unknown) {
          if (!isErrno(error, "EEXIST")) throw error;
        }

        let recoveryPid: number;
        try {
          recoveryPid = Number((await Bun.file(recoveryPath).text()).trim());
        } catch (error: unknown) {
          if (isErrno(error, "ENOENT")) continue;
          throw error;
        }
        if (Number.isSafeInteger(recoveryPid) && recoveryPid > 0 && isProcessAlive(recoveryPid)) {
          throw new Error(`Another process (pid=${recoveryPid}) is recovering the bot lock guard; retry startup shortly.`);
        }
        try {
          await unlink(recoveryPath);
        } catch (error: unknown) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
      }

      try {
        let currentPid: number;
        try {
          currentPid = parseInt((await Bun.file(lockFilePath).text()).trim(), 10);
        } catch (error: unknown) {
          if (isErrno(error, "ENOENT")) continue;
          throw error;
        }
        if (!Number.isNaN(currentPid) && isProcessAlive(currentPid)) {
          throw new Error(`Another process (pid=${currentPid}) acquired the bot lock guard during recovery.`);
        }
        await unlink(lockFilePath);
      } finally {
        await unlink(recoveryPath).catch(() => undefined);
      }
    }
  } finally {
    await unlink(candidatePath).catch(() => undefined);
  }
}

async function releasePidFileLock(lockFilePath: string): Promise<void> {
  try {
    const ownerPid: number = parseInt((await Bun.file(lockFilePath).text()).trim(), 10);
    if (ownerPid === process.pid) await unlink(lockFilePath);
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

async function withBotLockGuard<T>(lockFilePath: string, action: () => Promise<T>): Promise<T> {
  const guardPath: string = `${lockFilePath}.guard`;
  await acquirePidFileLock(guardPath);
  try {
    return await action();
  } finally {
    await releasePidFileLock(guardPath);
  }
}

export async function acquireSingleInstanceLock(botToken: string, lockFilePath: string = LOCK_FILE_PATH): Promise<void> {
  const tokenFingerprint: string = getBotTokenFingerprint(botToken);
  await withBotLockGuard(lockFilePath, async (): Promise<void> => {
    const activeRecords: BotLockRecord[] = (await readBotLockRecords(lockFilePath))
      .filter((record) => isProcessAlive(record.pid));
    const owner: BotLockRecord | undefined = activeRecords[0];
    if (owner) {
      const tokenScope: string = owner.tokenFingerprint === tokenFingerprint ? "the same token" : "a different token";
      throw new Error(
        `Another bot instance (pid=${owner.pid}) is already using this data directory with ${tokenScope}; ` +
        "refusing concurrent access to shared state."
      );
    }
    await writeBotLockRecords(lockFilePath, [{ pid: process.pid, tokenFingerprint }]);
  });
}

export async function releaseSingleInstanceLock(botToken: string, lockFilePath: string = LOCK_FILE_PATH): Promise<void> {
  const tokenFingerprint: string = getBotTokenFingerprint(botToken);
  try {
    await withBotLockGuard(lockFilePath, async (): Promise<void> => {
      const remaining: BotLockRecord[] = (await readBotLockRecords(lockFilePath)).filter((record) =>
        isProcessAlive(record.pid) && !(record.pid === process.pid && record.tokenFingerprint === tokenFingerprint)
      );
      await writeBotLockRecords(lockFilePath, remaining);
    });
  } catch (error: unknown) {
    logger.error("Failed to release bot instance lock:", error);
  }
}
