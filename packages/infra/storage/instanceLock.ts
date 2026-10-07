import { link, open } from "node:fs/promises";
import { dirname } from "node:path";
import { BOT_LOCK_LINE_PATTERN, LINUX_BOOT_ID_PATTERN, PROCESS_IDENTITY_PATTERN } from "../../consts/storage";
import { LOCK_FILE_PATH, RUNTIME_DATA_ROOT_IS_CONFIGURED } from "../../consts/paths";
import { atomicWriteText, syncDirectory } from "../../libs/atomicFile";
import { isErrno } from "../../libs/errno";
import { prepareRuntimeDataRoot } from "./dataRoot";
import type { FileHandle } from "node:fs/promises";
import type { ProcessIdentity } from "../../types/storage";

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
    statContent = await Bun.file(`/proc/${pid}/stat`).text();
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  const stat: LinuxProcessStat = parseLinuxProcessStat(statContent);
  if (stat.pid !== pid) throw new Error(`/proc/${pid}/stat reported an unexpected pid ${stat.pid}.`);
  const bootId: string = (await Bun.file("/proc/sys/kernel/random/boot_id").text())
    .trim()
    .toLowerCase();
  return validateProcessIdentity({ pid, startTimeTicks: stat.startTimeTicks, bootId }, pid);
}

export function getBotTokenFingerprint(botToken: string): string {
  if (botToken.length === 0) throw new Error("Cannot derive a bot instance lock from an empty token");
  return new Bun.CryptoHasher("sha256")
    .update(botToken, "utf8")
    .digest("hex");
}

function serializeProcessIdentity(identity: ProcessIdentity): string {
  const valid: ProcessIdentity = validateProcessIdentity(identity);
  return `v2:${valid.pid}:${valid.startTimeTicks}:${valid.bootId}`;
}

/** 按当前格式认出身份行；认不出时返回 null，字段取值不在这里校验。 */
function matchProcessIdentity(content: string): ProcessIdentity | null {
  const match: RegExpExecArray | null = PROCESS_IDENTITY_PATTERN.exec(content);
  if (!match) return null;
  return { pid: Number(match[1]), startTimeTicks: match[2]!, bootId: match[3]! };
}

function parseProcessIdentity(content: string, path: string): ProcessIdentity {
  const identity: ProcessIdentity | null = matchProcessIdentity(content);
  if (identity === null) throw new Error(`${path} has an obsolete or invalid lock owner format; repair it manually.`);
  return validateProcessIdentity(identity);
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

/**
 * 锁或其辅助文件记录的属主此刻是否已不在：内容认不出当前格式的身份行时返回 undefined，
 * 由调用方决定如何处理；认得出时按 PID 现查 /proc，进程不存在或启动时刻、boot id 与
 * 记录不同即为 true。PID 本身非法时按「不能确定」返回 false。
 */
export async function isRecordedLockOwnerInactive(content: string): Promise<boolean | undefined> {
  const owner: ProcessIdentity | null = matchProcessIdentity(content);
  if (owner === null) return undefined;
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  return !await isProcessIdentityActive(owner, readLinuxProcessIdentity);
}

async function resolveCurrentIdentity(
  currentIdentity: ProcessIdentity | undefined,
  readProcessIdentity: (pid: number) => Promise<ProcessIdentity | null>
): Promise<ProcessIdentity> {
  if (currentIdentity !== undefined) {
    return validateProcessIdentity(currentIdentity, process.pid);
  }
  const identity: ProcessIdentity | null = await readProcessIdentity(process.pid);
  if (identity === null) throw new Error(`Cannot read the current process identity for pid ${process.pid}.`);
  return validateProcessIdentity(identity, process.pid);
}

/**
 * 严格读取 bot.lock：内容必须恰好是一行当前格式的属主记录加换行。文件不存在返回 null；
 * 空文件、缺行尾换行、多于一行（含逐行都合法的多行）、旧格式或字段非法一律抛错，
 * 抛错前不查任何记录的 PID 生死，文件原样保留，须人工处理。
 */
async function readBotLockRecord(lockFilePath: string): Promise<BotLockRecord | null> {
  let content: string;
  try {
    content = await Bun.file(lockFilePath).text();
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  const match: RegExpExecArray | null = content.endsWith("\n")
    ? BOT_LOCK_LINE_PATTERN.exec(content.slice(0, -1))
    : null;
  const pid: number = match === null ? Number.NaN : Number(match[1]);
  if (match === null || !Number.isSafeInteger(pid)) {
    throw new Error(
      `${lockFilePath} must contain exactly one current-format lock owner line ` +
      "(v2:<pid>:<starttime>:<boot id>:<token fingerprint>); repair it manually."
    );
  }
  const identity: ProcessIdentity = validateProcessIdentity({ pid, startTimeTicks: match[2]!, bootId: match[3]! });
  return { ...identity, tokenFingerprint: match[4]! };
}

async function deleteBotLock(lockFilePath: string): Promise<void> {
  try {
    await Bun.file(lockFilePath).delete();
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

/**
 * 用 hard link 原子发布完整进程身份 guard，并回收当前格式的 stale guard。
 * 协议的非原子回收边界见 docs/cn/04-invariants.md。
 */
async function acquirePidFileLock(
  lockFilePath: string,
  currentIdentity: ProcessIdentity,
  readProcessIdentity: (pid: number) => Promise<ProcessIdentity | null>
): Promise<void> {
  const candidatePath: string = `${lockFilePath}.candidate.${process.pid}.${crypto.randomUUID()}`;
  const handle: FileHandle = await open(candidatePath, "wx");
  try {
    try {
      await Bun.write(Bun.file(handle.fd), serializeProcessIdentity(currentIdentity));
      // candidate 由 link() 直接发布成 guard 本体，发布前先把数据和目录项落盘。
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(candidatePath);

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
          `Another process (pid=${existingIdentity.pid}) is updating the bot lock; retry startup shortly.`
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
          await Bun.file(recoveryPath).delete();
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
        await Bun.file(lockFilePath).delete();
      } finally {
        await Bun.file(recoveryPath).delete().catch((): undefined => undefined);
      }
    }
  } finally {
    await Bun.file(candidatePath).delete().catch((): undefined => undefined);
  }
}

async function releasePidFileLock(lockFilePath: string, currentIdentity: ProcessIdentity): Promise<void> {
  try {
    const owner: ProcessIdentity = parseProcessIdentity(await Bun.file(lockFilePath).text(), lockFilePath);
    if (sameProcessIdentity(owner, currentIdentity)) await Bun.file(lockFilePath).delete();
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

/**
 * 启动时取得数据根的单实例锁，在 bot.lock.guard 互斥下执行：严格读取 bot.lock（见
 * readBotLockRecord，格式不符时抛错并原样保留文件）；属主进程仍在时不论 token 是否相同
 * 一律抛错；无属主或属主已不在时，用原子写把文件整体换成当前进程这一行。
 * 抛错由启动流程以非零码退出。
 */
export async function acquireSingleInstanceLock(
  botToken: string,
  lockFilePath: string = LOCK_FILE_PATH,
  options: InstanceLockOptions = {}
): Promise<void> {
  await prepareRuntimeDataRoot(dirname(lockFilePath), {
    enforcePrivatePermissions: lockFilePath === LOCK_FILE_PATH && RUNTIME_DATA_ROOT_IS_CONFIGURED,
  });
  const tokenFingerprint: string = getBotTokenFingerprint(botToken);
  const readProcessIdentity: (pid: number) => Promise<ProcessIdentity | null> = options.readProcessIdentity ?? readLinuxProcessIdentity;
  const currentIdentity: ProcessIdentity = await resolveCurrentIdentity(options.currentIdentity, readProcessIdentity);
  await withBotLockGuard(lockFilePath, { currentIdentity, readProcessIdentity }, async (): Promise<void> => {
    const owner: BotLockRecord | null = await readBotLockRecord(lockFilePath);
    if (owner !== null && await isProcessIdentityActive(owner, readProcessIdentity)) {
      const tokenScope: string = owner.tokenFingerprint === tokenFingerprint ? "the same token" : "a different token";
      throw new Error(
        `Another bot instance (pid=${owner.pid}) is already using this data directory with ${tokenScope}; ` +
        "refusing concurrent access to shared state."
      );
    }
    await atomicWriteText(lockFilePath, `${serializeProcessIdentity(currentIdentity)}:${tokenFingerprint}\n`);
  });
}

/**
 * 停机时释放单实例锁，在 bot.lock.guard 互斥下执行：文件不存在时直接返回；属主是本进程且
 * token 相同，或属主进程已不在时删除文件；属主是另一个仍在运行的进程时原样保留。
 * 读取同样严格，格式不符时抛错并原样保留文件，由停机流程记 error 并以退出码 1 结束。
 */
export async function releaseSingleInstanceLock(
  botToken: string,
  lockFilePath: string = LOCK_FILE_PATH,
  options: InstanceLockOptions = {}
): Promise<void> {
  const tokenFingerprint: string = getBotTokenFingerprint(botToken);
  const readProcessIdentity: (pid: number) => Promise<ProcessIdentity | null> =
    options.readProcessIdentity ?? readLinuxProcessIdentity;
  const currentIdentity: ProcessIdentity =
    await resolveCurrentIdentity(options.currentIdentity, readProcessIdentity);
  await withBotLockGuard(lockFilePath, { currentIdentity, readProcessIdentity }, async (): Promise<void> => {
    const owner: BotLockRecord | null = await readBotLockRecord(lockFilePath);
    if (owner === null) return;
    const active: boolean = await isProcessIdentityActive(owner, readProcessIdentity);
    if (active && !(sameProcessIdentity(owner, currentIdentity) && owner.tokenFingerprint === tokenFingerprint)) return;
    await deleteBotLock(lockFilePath);
  });
}
