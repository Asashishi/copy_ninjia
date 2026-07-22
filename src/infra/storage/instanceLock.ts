import { createHash } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { BOT_LOCK_LINE_PATTERN, LINUX_BOOT_ID_PATTERN, PROCESS_IDENTITY_PATTERN } from "../../consts/storage";
import { LOCK_FILE_PATH } from "../../consts/paths";
import { atomicWriteText } from "../../libs/atomicFile";
import { logger } from "../logger";
import { prepareRuntimeDataRoot } from "./dataRoot";

export interface ProcessIdentity {
  pid: number;
  startTimeTicks: string;
  bootId: string;
}

interface BotLockRecord extends ProcessIdentity {
  tokenFingerprint: string;
}

export interface InstanceLockOptions {
  currentIdentity?: ProcessIdentity;
  readProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
}

interface LinuxProcessStat {
  pid: number;
  state: string;
  startTimeTicks: string;
}

interface ProcessIdentityContext {
  currentIdentity: ProcessIdentity;
  readProcessIdentity: (pid: number) => Promise<ProcessIdentity | null>;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function validateProcessIdentity(identity: ProcessIdentity, expectedPid?: number): ProcessIdentity {
  if (
    !Number.isSafeInteger(identity.pid) || identity.pid <= 0 ||
    (expectedPid !== undefined && identity.pid !== expectedPid) ||
    !/^(0|[1-9]\d*)$/.test(identity.startTimeTicks) ||
    !LINUX_BOOT_ID_PATTERN.test(identity.bootId)
  ) {
    throw new Error("Process identity reader returned an invalid Linux process identity.");
  }
  return identity;
}

/** 解析 /proc/<pid>/stat，comm 可包含空格和右括号，不能按普通空格字段切分整行。 */
export function parseLinuxProcessStat(content: string): LinuxProcessStat {
  const openParen: number = content.indexOf("(");
  const closeParen: number = content.lastIndexOf(")");
  if (openParen <= 0 || closeParen <= openParen || content[closeParen + 1] !== " ") {
    throw new Error("Invalid Linux /proc process stat format.");
  }
  const pid: number = Number(content.slice(0, openParen).trim());
  const fields: string[] = content.slice(closeParen + 2).trim().split(/\s+/);
  const state: string | undefined = fields[0];
  const startTimeTicks: string | undefined = fields[19];
  if (
    !Number.isSafeInteger(pid) || pid <= 0 ||
    state?.length !== 1 ||
    startTimeTicks === undefined || !/^(0|[1-9]\d*)$/.test(startTimeTicks)
  ) {
    throw new Error("Invalid Linux /proc process stat format.");
  }
  return { pid, state, startTimeTicks };
}

/** Linux PID 的稳定身份；进程不存在返回 null，其它读取/格式错误一律 fail-closed。 */
export async function readLinuxProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (process.platform !== "linux") {
    throw new Error("The instance lock requires Linux /proc process identity support.");
  }
  let statContent: string;
  try {
    statContent = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  const stat: LinuxProcessStat = parseLinuxProcessStat(statContent);
  if (stat.pid !== pid) throw new Error(`/proc/${pid}/stat reported an unexpected pid ${stat.pid}.`);
  const bootId: string = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
  return validateProcessIdentity({ pid, startTimeTicks: stat.startTimeTicks, bootId }, pid);
}

export function getBotTokenFingerprint(botToken: string): string {
  if (botToken.length === 0) throw new Error("Cannot derive a bot instance lock from an empty token");
  return createHash("sha256").update(botToken, "utf8").digest("hex");
}

function serializeProcessIdentity(identity: ProcessIdentity): string {
  const valid: ProcessIdentity = validateProcessIdentity(identity);
  return `v2:${valid.pid}:${valid.startTimeTicks}:${valid.bootId}`;
}

function parseProcessIdentity(content: string, path: string): ProcessIdentity {
  const match: RegExpExecArray | null = PROCESS_IDENTITY_PATTERN.exec(content);
  if (!match) throw new Error(`${path} has an obsolete or invalid lock owner format; repair it manually.`);
  return validateProcessIdentity({
    pid: Number(match[1]),
    startTimeTicks: match[2]!,
    bootId: match[3]!,
  });
}

function sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid &&
    left.startTimeTicks === right.startTimeTicks &&
    left.bootId === right.bootId;
}

async function isProcessIdentityActive(
  identity: ProcessIdentity,
  readProcessIdentity: (pid: number) => Promise<ProcessIdentity | null>
): Promise<boolean> {
  const current: ProcessIdentity | null = await readProcessIdentity(identity.pid);
  return current !== null && sameProcessIdentity(identity, validateProcessIdentity(current, identity.pid));
}

async function resolveCurrentIdentity(options: InstanceLockOptions): Promise<ProcessIdentity> {
  if (options.currentIdentity !== undefined) {
    return validateProcessIdentity(options.currentIdentity, process.pid);
  }
  const reader = options.readProcessIdentity ?? readLinuxProcessIdentity;
  const identity: ProcessIdentity | null = await reader(process.pid);
  if (identity === null) throw new Error(`Cannot read the current process identity for pid ${process.pid}.`);
  return validateProcessIdentity(identity, process.pid);
}

/** 严格读取唯一 v2 锁注册表；旧格式与损坏格式都必须人工处理。 */
async function readBotLockRecords(lockFilePath: string): Promise<BotLockRecord[]> {
  let content: string;
  try {
    content = await Bun.file(lockFilePath).text();
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  if (content === "") {
    throw new Error(`${lockFilePath} has an obsolete or invalid lock registry format; repair it manually.`);
  }
  if (!content.endsWith("\n")) throw new Error(`${lockFilePath} has an invalid lock registry format; repair it manually.`);

  const records: BotLockRecord[] = [];
  const fingerprints: Set<string> = new Set();
  for (const line of content.slice(0, -1).split("\n")) {
    const match = BOT_LOCK_LINE_PATTERN.exec(line);
    if (!match) throw new Error(`${lockFilePath} has an obsolete or invalid lock registry format; repair it manually.`);
    const pid: number = Number(match[1]);
    const startTimeTicks: string = match[2]!;
    const bootId: string = match[3]!;
    const tokenFingerprint: string = match[4]!;
    if (!Number.isSafeInteger(pid) || fingerprints.has(tokenFingerprint)) {
      throw new Error(`${lockFilePath} has duplicate or invalid lock records; repair it manually.`);
    }
    fingerprints.add(tokenFingerprint);
    const identity: ProcessIdentity = validateProcessIdentity({ pid, startTimeTicks, bootId });
    records.push({ ...identity, tokenFingerprint });
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
    records.map((record) => `${serializeProcessIdentity(record)}:${record.tokenFingerprint}\n`).join("")
  );
}

/** 用 hard link 原子发布完整进程身份 guard，并安全回收当前 v2 格式的 stale guard。 */
async function acquirePidFileLock(
  lockFilePath: string,
  currentIdentity: ProcessIdentity,
  readProcessIdentity: (pid: number) => Promise<ProcessIdentity | null>
): Promise<void> {
  const candidatePath: string = `${lockFilePath}.candidate.${process.pid}.${crypto.randomUUID()}`;
  const handle = await open(candidatePath, "wx");
  try {
    await handle.writeFile(serializeProcessIdentity(currentIdentity));
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

      let existingIdentity: ProcessIdentity;
      try {
        existingIdentity = parseProcessIdentity(await Bun.file(lockFilePath).text(), lockFilePath);
      } catch (error: unknown) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      if (await isProcessIdentityActive(existingIdentity, readProcessIdentity)) {
        throw new Error(
          `Another process (pid=${existingIdentity.pid}) is updating the bot lock registry; retry startup shortly.`
        );
      }

      const recoveryPath: string = `${lockFilePath}.recovery`;
      for (;;) {
        try {
          await link(candidatePath, recoveryPath);
          break;
        } catch (error: unknown) {
          if (!isErrno(error, "EEXIST")) throw error;
        }

        let recoveryIdentity: ProcessIdentity;
        try {
          recoveryIdentity = parseProcessIdentity(await Bun.file(recoveryPath).text(), recoveryPath);
        } catch (error: unknown) {
          if (isErrno(error, "ENOENT")) continue;
          throw error;
        }
        if (await isProcessIdentityActive(recoveryIdentity, readProcessIdentity)) {
          throw new Error(
            `Another process (pid=${recoveryIdentity.pid}) is recovering the bot lock guard; retry startup shortly.`
          );
        }
        try {
          await unlink(recoveryPath);
        } catch (error: unknown) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
      }

      try {
        let currentOwner: ProcessIdentity;
        try {
          currentOwner = parseProcessIdentity(await Bun.file(lockFilePath).text(), lockFilePath);
        } catch (error: unknown) {
          if (isErrno(error, "ENOENT")) continue;
          throw error;
        }
        if (await isProcessIdentityActive(currentOwner, readProcessIdentity)) {
          throw new Error(`Another process (pid=${currentOwner.pid}) acquired the bot lock guard during recovery.`);
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

async function releasePidFileLock(lockFilePath: string, currentIdentity: ProcessIdentity): Promise<void> {
  try {
    const owner: ProcessIdentity = parseProcessIdentity(await Bun.file(lockFilePath).text(), lockFilePath);
    if (sameProcessIdentity(owner, currentIdentity)) await unlink(lockFilePath);
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

async function withBotLockGuard<T>(
  lockFilePath: string,
  context: ProcessIdentityContext,
  action: () => Promise<T>
): Promise<T> {
  const guardPath: string = `${lockFilePath}.guard`;
  await acquirePidFileLock(guardPath, context.currentIdentity, context.readProcessIdentity);
  try {
    return await action();
  } finally {
    await releasePidFileLock(guardPath, context.currentIdentity);
  }
}

export async function acquireSingleInstanceLock(
  botToken: string,
  lockFilePath: string = LOCK_FILE_PATH,
  options: InstanceLockOptions = {}
): Promise<void> {
  await prepareRuntimeDataRoot(dirname(lockFilePath));
  const tokenFingerprint: string = getBotTokenFingerprint(botToken);
  const readProcessIdentity = options.readProcessIdentity ?? readLinuxProcessIdentity;
  const currentIdentity: ProcessIdentity = await resolveCurrentIdentity({ ...options, readProcessIdentity });
  await withBotLockGuard(lockFilePath, { currentIdentity, readProcessIdentity }, async (): Promise<void> => {
    const activeRecords: BotLockRecord[] = [];
    for (const record of await readBotLockRecords(lockFilePath)) {
      if (await isProcessIdentityActive(record, readProcessIdentity)) activeRecords.push(record);
    }
    const owner: BotLockRecord | undefined = activeRecords[0];
    if (owner) {
      const tokenScope: string = owner.tokenFingerprint === tokenFingerprint ? "the same token" : "a different token";
      throw new Error(
        `Another bot instance (pid=${owner.pid}) is already using this data directory with ${tokenScope}; ` +
        "refusing concurrent access to shared state."
      );
    }
    await writeBotLockRecords(lockFilePath, [{ ...currentIdentity, tokenFingerprint }]);
  });
}

export async function releaseSingleInstanceLock(
  botToken: string,
  lockFilePath: string = LOCK_FILE_PATH,
  options: InstanceLockOptions = {}
): Promise<void> {
  const tokenFingerprint: string = getBotTokenFingerprint(botToken);
  try {
    const readProcessIdentity = options.readProcessIdentity ?? readLinuxProcessIdentity;
    const currentIdentity: ProcessIdentity = await resolveCurrentIdentity({ ...options, readProcessIdentity });
    await withBotLockGuard(lockFilePath, { currentIdentity, readProcessIdentity }, async (): Promise<void> => {
      const remaining: BotLockRecord[] = [];
      for (const record of await readBotLockRecords(lockFilePath)) {
        const active: boolean = await isProcessIdentityActive(record, readProcessIdentity);
        if (active && !(sameProcessIdentity(record, currentIdentity) && record.tokenFingerprint === tokenFingerprint)) {
          remaining.push(record);
        }
      }
      await writeBotLockRecords(lockFilePath, remaining);
    });
  } catch (error: unknown) {
    logger.error("Failed to release bot instance lock:", error);
  }
}
