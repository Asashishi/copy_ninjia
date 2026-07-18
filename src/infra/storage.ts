import { link, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { logger } from "./logger";
import type { CachedUser, ChatState, CopyMode, GlobalCopyState, StateFileSchema } from "../types";
import { LOCK_FILE_PATH, STATE_FILE_PATH, TMP_FILE_SUFFIX } from "../consts/paths";
import { DEFAULT_CHAT_STATE } from "../consts/storage";
import { createLatestValueRunner } from "../libs/latestValueRunner";
import { atomicWriteText } from "../libs/atomicFile";
import { normalizeChatState, normalizeChatStateEntry } from "../libs/chatState";
import { decodeStateFile } from "../libs/stateFileCodec";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM 表示进程存在、只是当前用户无权向它发信号，不能当成 stale 锁。
    return isErrno(error, "EPERM");
  }
}

export function getBotTokenFingerprint(botToken: string): string {
  if (botToken.length === 0) throw new Error("Cannot derive a bot instance lock from an empty token");
  return createHash("sha256").update(botToken, "utf8").digest("hex");
}

/**
 * 锁注册表不变量：bot.lock 的每行是 pid:sha256(token)，但同一
 * 数据目录最多只允许一个活跃 PID。所有读改写都在短期 guard 下
 * 完成；正式文件用 tmp + fsync + rename 发布。格式异常直接拒绝，
 * 不做旧格式推断或迁移。README 记录部署和手工处理规则。
 */
interface BotLockRecord {
  pid: number;
  tokenFingerprint: string;
}

const BOT_LOCK_LINE_PATTERN = /^([1-9]\d*):([0-9a-f]{64})$/;

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
        // link 的目标路径存在性检查与创建是同一个内核操作：并发启动只有一个
        // 候选能发布成功。成功后删候选名，正式锁仍指向同一份完整内容。
        await link(candidatePath, lockFilePath);
        return;
      } catch (error: unknown) {
        if (!isErrno(error, "EEXIST")) throw error;
      }

      let existingPid: number;
      try {
        existingPid = parseInt((await Bun.file(lockFilePath).text()).trim(), 10);
      } catch (error: unknown) {
        // 另一个竞争者可能刚完成 stale 锁回收；重新观察即可。
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      if (!Number.isNaN(existingPid) && isProcessAlive(existingPid)) {
        throw new Error(`Another process (pid=${existingPid}) is updating the bot lock registry; retry startup shortly.`);
      }

      // stale 锁回收本身也必须互斥。否则两个启动者都读到旧 PID 后，较慢者可能
      // 删掉较快者刚发布的新锁。recovery 也用已经完整写好 PID 的候选文件做
      // hard-link 原子发布，避免竞争者看见一个刚 open、尚未写 PID 的空文件。
      // 若上一次启动恰好死在回收期间，recovery 会残留；先检查其中 PID，仍
      // 存活就拒绝，已退出/内容无效则清掉并重新竞争，避免以后永久无法启动。
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
          // 对方可能刚好完成回收并删除 recovery，重新竞争即可。
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
        // 获得回收权后重新读取，不能沿用取得回收权之前观察到的 PID。
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

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * 启动时清扫顶层残留的原子写临时文件。state.json/bot.lock 的 tmp+fsync+rename
 * 写入若崩在 fsync 完成、rename 之前，会在 PROJECT_ROOT 下留一个隐藏的
 * .<文件名>.<pid>.<uuid>.tmp（见 atomicFile.ts 的 temporaryPath），无人清理，
 * 跨崩溃累积——memory/ai、memory/luck、memory/stickers、logs 各自的启动恢复
 * 早就会清自己目录下的 *.tmp（见 workers/diskIO/logFiles.ts、snapshotFiles.ts），
 * 唯独这两个顶层文件没有对应的清扫。只应在 acquireSingleInstanceLock 成功
 * 之后调用——此刻已确认没有其它活跃实例在并发写它们，删除是安全的。
 */
export async function cleanupOrphanedTempFiles(): Promise<void> {
  const dir: string = dirname(STATE_FILE_PATH);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error: unknown) {
    logger.error("Failed to scan project root for orphaned temp files:", error);
    return;
  }
  const prefixes: string[] = [basename(STATE_FILE_PATH), basename(LOCK_FILE_PATH)].map((name) => `.${name}.`);
  for (const entry of entries) {
    if (!entry.endsWith(TMP_FILE_SUFFIX) || !prefixes.some((prefix) => entry.startsWith(prefix))) continue;
    try {
      await unlink(join(dir, entry));
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) logger.error(`Failed to remove orphaned temp file ${entry}:`, error);
    }
  }
}

// 内存中唯一的一份持久化状态，本模块独占持有：各群独立状态 + copy 类功能的
// 全局状态。调用方一律通过下面的 getter/工具函数读写，不再各自传引用——
// 状态只有这一份，落盘时全量序列化即可，不存在"只传一半覆盖丢另一半"的问题。
const chatStates: Map<number, ChatState> = new Map();
const globalCopyState: GlobalCopyState = { copiedUser: null };

/** copy 类功能的全局状态（复读目标 + 冷却时钟），直接读写字段即可，改完记得
 *  saveStateInBackground()——命令热路径不要直接 await saveState()，那会让
 *  用户等双 fsync 才收到回复（性能项 M-6），除非确有必须等落盘成功的理由。 */
export function getGlobalCopyState(): GlobalCopyState {
  return globalCopyState;
}

/**
 * 若全局复读目标存在、且发起 /copy 的群就是 chatId，返回目标与模式；否则
 * 返回 null。「复读/表情同步只在发起群生效」的判定统一走这里——不在各消费
 * 点散写一遍 copiedUser 非空 + copyChatId 相等的组合条件，也免得每处都要
 * 对 copiedUser 做非空断言。
 */
export function getActiveCopyIn(chatId: number): { copiedUser: CachedUser; copyMode: CopyMode | undefined } | null {
  if (globalCopyState.copiedUser === null || globalCopyState.copyChatId !== chatId) return null;
  return { copiedUser: globalCopyState.copiedUser, copyMode: globalCopyState.copyMode };
}

/** 所有群的状态表（只读视图，供遍历/统计；要改某个群的状态用 getOrCreateChatState）。 */
export function getAllChatStates(): ReadonlyMap<number, ChatState> {
  return chatStates;
}

/** 定位唯一的 /send 目标；群数量很小，直接扫描而不维护易失配的反向索引。 */
export function getActiveProxySendTarget(): number | undefined {
  for (const [chatId, chatState] of chatStates) {
    if (chatState.isProxySendEnabled === true) return chatId;
  }
  return undefined;
}

// runner 并发处理不同群的更新后，两个群可能同时触发 saveState。写入必须
// 串行，但不能为每次变化都无限排队：写入期间只保留最新快照，中间快照没有
// 落盘价值。调度器因此最多持有「在写 + 待写」两份 JSON。

/**
 * 串行排队写入 state.json。调用方必须先把状态同步序列化成字符串再传进来，
 * 这样落盘的一定是调用时刻的状态快照——若把序列化推迟到队列执行时，共享状态
 * 可能已被并发的处理器改过。
 *
 * 先写临时文件、fsync、再 rename 到目标路径：rename 在同一文件系统内是
 * 原子操作，进程如果在这中间被杀（OOM/断电/容器被回收），目标文件要么是
 * 写入前的旧内容，要么是写入后的新内容，不会停在半截的撕裂 JSON——不然
 * 重启后 loadState() 会因解析失败拒绝启动。
 * rename 前的 fsync 不能省：它保证数据块先于改名落到磁盘，否则断电时
 * rename 可能已提交而数据还在页缓存里，目标文件变成空文件/半截内容——
 * 恰好是这套机制要防的事（进程被杀不经过这个风险，只有断电经过）。
 */
const STATE_SAVE_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 5_000, 30_000];
let dirtyStateJson: string | null = null;
let stateRetryAttempt: number = 0;
let stateRetryTimer: ReturnType<typeof setTimeout> | null = null;

const stateWriter = createLatestValueRunner<string>(async (json: string): Promise<void> => {
  await atomicWriteText(STATE_FILE_PATH, json);
  if (dirtyStateJson === json) {
    dirtyStateJson = null;
    stateRetryAttempt = 0;
  }
});

function scheduleStateSaveRetry(): void {
  if (dirtyStateJson === null || stateRetryTimer !== null) return;
  const delay: number = STATE_SAVE_RETRY_DELAYS_MS[Math.min(stateRetryAttempt, STATE_SAVE_RETRY_DELAYS_MS.length - 1)]!;
  stateRetryAttempt++;
  stateRetryTimer = setTimeout(() => {
    stateRetryTimer = null;
    const json: string | null = dirtyStateJson;
    if (json === null) return;
    void stateWriter.push(json).catch((error: unknown) => {
      logger.error(`Failed to retry state persistence (attempt ${stateRetryAttempt}):`, error);
      scheduleStateSaveRetry();
    });
  }, delay);
  stateRetryTimer.unref();
}

function persistStateJson(json: string): Promise<void> {
  dirtyStateJson = json;
  return stateWriter.push(json).catch((error: unknown) => {
    scheduleStateSaveRetry();
    throw error;
  });
}

/** 全局复读目标的三个字段永远一起写：只设其中一部分会造成「全局占着复读
 * 槽位、却没有任何群在复读」的卡死状态（/copy 处处被拒、复读无处发生）。 */
function adoptCopyTarget(copiedUser: CachedUser, copyMode: CopyMode | undefined, copyChatId: number): void {
  globalCopyState.copiedUser = copiedUser;
  globalCopyState.copyMode = copyMode;
  globalCopyState.copyChatId = copyChatId;
}

/**
 * 从 state.json 加载全部持久化状态，填充本模块持有的内存状态。整个文件由
 * 内存状态全量序列化而来（结构见 StateFileSchema），这里只接受当前结构并
 * 逐字段校验。持久化 schema 变更由部署前的手工迁移负责，运行时不保留旧版
 * 自动对齐分支。
 *
 * 顶层形状不是对象时（数组/原始值/损坏）记一条错误日志——不能默默当空状态
 * 处理，那样出问题了完全没有排查线索。
 */
export async function loadState(): Promise<void> {
  try {
    const file = Bun.file(STATE_FILE_PATH);
    if (!(await file.exists())) return;

    const decoded: StateFileSchema = decodeStateFile(JSON.parse(await file.text()));
    if (decoded.globalCopy.lastCopyTime !== undefined) {
      globalCopyState.lastCopyTime = decoded.globalCopy.lastCopyTime;
    }
    if (decoded.globalCopy.copiedUser !== null) {
      adoptCopyTarget(decoded.globalCopy.copiedUser, decoded.globalCopy.copyMode, decoded.globalCopy.copyChatId!);
    }

    for (const [chatIdStr, chatState] of Object.entries(decoded.chats)) {
      normalizeChatState(chatState);
      if (Object.keys(chatState).length > 0) chatStates.set(Number(chatIdStr), chatState);
    }
  } catch (error: unknown) {
    logger.error("Failed to load state:", error);
    // 不能带着空状态继续启动：后续任意 saveState 都可能覆盖尚未手工迁移或
    // 已损坏的文件。让启动失败，修好 state.json 后再重启。
    throw error;
  }
}

/**
 * 把内存状态全量规范化、序列化并持久化到 state.json。规范化会同步回收
 * Map 中已经没有有效字段的条目，使内存与落盘内容始终采用同一表示。
 */
export async function saveState(): Promise<void> {
  const chats: Record<string, ChatState> = {};
  for (const [chatId, chatState] of chatStates) {
    normalizeChatState(chatState);
    if (Object.keys(chatState).length === 0) {
      chatStates.delete(chatId);
      continue;
    }
    chats[String(chatId)] = chatState;
  }
  const serializable: StateFileSchema = { chats, globalCopy: globalCopyState };
  await persistStateJson(JSON.stringify(serializable, null, 2));
}

/** 后台状态刷新统一收口，避免持久化失败变成未处理的 Promise rejection。 */
export function saveStateInBackground(context: string): void {
  void saveState().catch((error: unknown) => {
    logger.error(`Failed to persist background state update (${context}):`, error);
  });
}

/**
 * 进程退出前把 state.json 排空落盘，纳入 index.ts 的 flushAllToDisk 链。
 * 存在两种待落盘态都要在这里兜住：①有一次 stateWriter 写入正在飞行中
 * （push 已发起、consume 尚未 resolve）；②上一次写入失败、只排了一个
 * unref() 的重试计时器（任何退出路径都不会等它，含正常 SIGTERM）。两种
 * 情况 dirtyStateJson 都非 null，直接把它重新 push 一遍：若①在途，这次
 * push 只是加入同一条 drain 队列，等在途那次结束后顺带处理；若②只是
 * 排着定时器，这里改为立即执行、不再等退避延迟。清掉重试计时器避免它在
 * 落盘完成后又空跑一次。resolve 只代表"尽力等过"，不保证一定成功——单次
 * 失败会重新排下一轮重试，但这里不再继续等，短超时兜底，不让停机流程
 * 被一次异常的磁盘故障拖住太久。
 */
export function flushStateToDisk(timeoutMs: number = 3000): Promise<void> {
  if (stateRetryTimer !== null) {
    clearTimeout(stateRetryTimer);
    stateRetryTimer = null;
  }
  const json: string | null = dirtyStateJson;
  if (json === null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    stateWriter
      .push(json)
      .catch((error: unknown) => {
        logger.error("Failed to flush state to disk on shutdown:", error);
      })
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/**
 * 只读地取某个群聊的状态，不存在时返回共享的默认状态（不会插入到 Map 里）。
 * 供仅需要读取的场景使用（比如判断本群是否在静默期），避免机器人所在的
 * 每个群、每条消息都往 Map 里塞一个空条目。
 */
export function getChatState(chatId: number): ChatState {
  return chatStates.get(chatId) ?? DEFAULT_CHAT_STATE;
}

/**
 * 取某个群聊的状态，不存在则创建一份默认状态并插入 Map。供需要修改状态的
 * 场景使用（比如 /quiet、私密模式镜像），确保拿到的是可以直接写入、且后续
 * 会被持久化的对象。
 */
export function getOrCreateChatState(chatId: number): ChatState {
  let chatState = chatStates.get(chatId);
  if (!chatState) {
    // ChatState 所有字段都是可选的，新条目就是个空对象（DEFAULT_CHAT_STATE
    // 被冻结了，不能直接塞进 Map 给人改写）。
    chatState = {};
    chatStates.set(chatId, chatState);
  }
  return chatState;
}

/**
 * 删除单个可选字段并立即规范化该群状态。若删除后再无有效字段，连 Map 条目
 * 一起回收；调用方仍需在确有状态变化时安排 saveStateInBackground()。
 */
export function clearChatStateField(chatId: number, field: keyof ChatState): boolean {
  const chatState: ChatState | undefined = chatStates.get(chatId);
  if (!chatState || !(field in chatState)) return false;
  delete chatState[field];
  normalizeChatStateEntry(chatStates, chatId);
  return true;
}

/**
 * 机器人被移出/离开某群时删除该群的持久化状态条目——不是降级个别字段，
 * 整条记录对一个机器人已不在场的群都不再有意义（初始化开关、AI 闲聊、
 * 静默期、私密模式镜像……），留着只会让内存与 state.json 随「加群又退群」
 * 单调增长。若机器人之后被重新拉回同一个群，getOrCreateChatState 会照常
 * 创建一份全新的默认状态，不丢失任何本该保留的信息。只在真的存在条目时
 * 才落盘，避免为从未被追踪过的群做一次空写。
 */
export function deleteChatState(chatId: number): void {
  if (chatStates.delete(chatId)) {
    saveStateInBackground(`chat ${chatId} state removed (bot left/kicked)`);
  }
}
