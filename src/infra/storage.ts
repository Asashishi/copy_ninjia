import { link, open, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { logger } from "./logger";
import type { CachedUser, ChatState, CopyMode, GlobalCopyState, StateFileSchema } from "../types";
import { LOCK_FILE_PATH, STATE_FILE_PATH, TMP_FILE_SUFFIX } from "../consts/paths";
import { DEFAULT_CHAT_STATE } from "../consts/storage";
import { createLatestValueRunner } from "../libs/latestValueRunner";
import { copyModeValue, finiteNumber, isRecord, rebuildCachedUser, rebuildChatState } from "../storage/stateCodec";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM 表示进程存在、只是当前用户无权向它发信号，不能当成 stale 锁。
    return isErrno(error, "EPERM");
  }
}

/**
 * token 不得出现在文件名/日志里；用完整 SHA-256 指纹把锁按 bot 身份分域。
 * Telegram bot token 自身有高熵 secret，摘要无法用于恢复 token；完整 256 bit
 * 也避免人为截短后引入不必要的碰撞概率。
 */
export function getSingleInstanceLockPath(botToken: string, baseLockPath: string = LOCK_FILE_PATH): string {
  if (botToken.length === 0) throw new Error("Cannot derive a bot instance lock from an empty token");
  const tokenFingerprint: string = createHash("sha256").update(botToken, "utf8").digest("hex");
  return `${baseLockPath}.${tokenFingerprint}`;
}

/**
 * 确保同一个 token 同一时间只有一个机器人实例在轮询。相同 token 跑两个实例
 * 会各自处理（并回复）同一批 Telegram 更新；不同 token 使用不同摘要后缀，
 * 不会仅因为共用程序目录就在这道锁上互相阻塞。
 */
export async function acquireSingleInstanceLock(botToken: string, baseLockPath: string = LOCK_FILE_PATH): Promise<void> {
  const lockFilePath: string = getSingleInstanceLockPath(botToken, baseLockPath);
  // 候选文件先完整写好，再通过 hard-link 原子发布为正式锁；正式路径永远不
  // 会短暂暴露一个尚未写入 PID 的空文件。
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
        throw new Error(
          `Another bot instance (pid=${existingPid}) is already running; refusing to start a second one — ` +
          `two instances polling with the same token would answer the same updates twice.`
        );
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
          throw new Error(`Another process (pid=${recoveryPid}) is recovering a stale bot.lock; retry startup shortly.`);
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
          throw new Error(`Another bot instance (pid=${currentPid}) acquired the lock during recovery.`);
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

/** 正常停机时只释放属于当前 PID 的锁；硬崩留下的锁由下次启动回收。 */
export async function releaseSingleInstanceLock(botToken: string, baseLockPath: string = LOCK_FILE_PATH): Promise<void> {
  const lockFilePath: string = getSingleInstanceLockPath(botToken, baseLockPath);
  try {
    const ownerPid: number = parseInt((await Bun.file(lockFilePath).text()).trim(), 10);
    if (ownerPid === process.pid) await unlink(lockFilePath);
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) logger.error("Failed to release bot instance lock:", error);
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

// 内存中唯一的一份持久化状态，本模块独占持有：各群独立状态 + copy 类功能的
// 全局状态。调用方一律通过下面的 getter/工具函数读写，不再各自传引用——
// 状态只有这一份，落盘时全量序列化即可，不存在"只传一半覆盖丢另一半"的问题。
const chatStates: Map<number, ChatState> = new Map();
const globalCopyState: GlobalCopyState = { copiedUser: null };

/** copy 类功能的全局状态（复读目标 + 冷却时钟），直接读写字段即可，改完记得 saveState()。 */
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

/**
 * 当前处于 /send 中转目标的群 chatId；没有会话生效则 undefined。
 * ChatState.isUseProxySend 挂在目标群自己的状态上（键本身就是目标群
 * chatId，不必再另存一份），同一时刻全局只允许一个群处于该状态
 * （commands/send.ts 的 handleSendCommand 保证，同 GlobalCopyState「全局
 * 只有一个复读目标」的单例约束），扫一遍已知群即可定位——群数量很小
 * （README：单实例建议控制在约 15 个活跃群以内），没必要为这维护一份
 * 反向索引。
 */
export function getActiveProxySendTarget(): number | undefined {
  for (const [chatId, chatState] of chatStates) {
    if (chatState.isUseProxySend === true) return chatId;
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
 * 重启后 loadState() 解析失败，会把这份文件聚合的所有数据一次性清空。
 * rename 前的 fsync 不能省：它保证数据块先于改名落到磁盘，否则断电时
 * rename 可能已提交而数据还在页缓存里，目标文件变成空文件/半截内容——
 * 恰好是这套机制要防的事（进程被杀不经过这个风险，只有断电经过）。
 */
const stateWriter = createLatestValueRunner<string>(async (json: string): Promise<void> => {
  try {
    const tmpPath: string = `${STATE_FILE_PATH}${TMP_FILE_SUFFIX}`;
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(json);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, STATE_FILE_PATH);
  } catch (error: unknown) {
    logger.error("Failed to save state:", error);
  }
});

function persistStateJson(json: string): Promise<void> {
  return stateWriter.push(json);
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

    const parsed: unknown = JSON.parse(await file.text());
    if (!isRecord(parsed) || !isRecord(parsed.chats) || !isRecord(parsed.globalCopy)) {
      throw new Error("state.json does not match the current { chats, globalCopy } schema; migrate it manually before starting the bot");
    }
    const rawChats: Record<string, unknown> = parsed.chats;
    const rawGlobalCopy: Record<string, unknown> = parsed.globalCopy;

    const lastCopyTime: number | undefined = finiteNumber(rawGlobalCopy.lastCopyTime);
    if (lastCopyTime !== undefined) globalCopyState.lastCopyTime = lastCopyTime;
    const copiedUser: CachedUser | null = rebuildCachedUser(rawGlobalCopy.copiedUser);
    const copyChatId: number | undefined = finiteNumber(rawGlobalCopy.copyChatId);
    if (copiedUser && copyChatId !== undefined && Number.isSafeInteger(copyChatId)) {
      adoptCopyTarget(copiedUser, copyModeValue(rawGlobalCopy.copyMode), copyChatId);
    } else if (rawGlobalCopy.copiedUser) {
      // 有目标却没有有效的发起群 id（手改文件/文件损坏）：这种目标在任何群
      // 都不会被复读，却会卡住全局槽位，直接丢弃并留日志。
      logger.error("state.json globalCopy has copiedUser but no valid copyChatId; dropping the copy target to avoid a stuck global copy slot");
    }

    for (const [chatIdStr, raw] of Object.entries(rawChats)) {
      const chatId: number = Number(chatIdStr);
      if (!Number.isSafeInteger(chatId) || chatId === 0) continue;
      const chatState: ChatState | null = rebuildChatState(raw);
      if (chatState) chatStates.set(chatId, chatState);
    }
  } catch (error: unknown) {
    logger.error("Failed to load state:", error);
    // 不能带着空状态继续启动：后续任意 saveState 都可能覆盖尚未手工迁移或
    // 已损坏的文件。让启动失败，修好 state.json 后再重启。
    throw error;
  }
}

/** 把内存状态全量序列化并持久化到 state.json；没有任何有效字段的群条目不落盘，保持文件干净。 */
export async function saveState(): Promise<void> {
  const chats: Record<string, ChatState> = {};
  for (const [chatId, chatState] of chatStates) {
    if (Object.values(chatState).some((value) => value !== undefined)) {
      chats[String(chatId)] = chatState;
    }
  }
  const serializable: StateFileSchema = { chats, globalCopy: globalCopyState };
  await persistStateJson(JSON.stringify(serializable, null, 2));
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
