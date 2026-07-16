import { link, open, rename, unlink } from "node:fs/promises";
import { logger } from "./logger";
import type { CachedUser, ChatState, CopyMode, GlobalCopyState, LockdownRecord, StateFileSchema } from "../types";
import { LOCK_FILE_PATH, STATE_FILE_PATH, TMP_FILE_SUFFIX } from "../consts/paths";
import { DEFAULT_CHAT_STATE } from "../consts/storage";
import { createLatestValueRunner } from "../libs/latestValueRunner";
import { copyModeValue, finiteNumber, isRecord, rebuildCachedUser, rebuildChatState, rebuildLockdown } from "../storage/stateCodec";

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
 * 确保同一时间只有一个机器人实例在轮询。用同一个 token 跑两个实例会导致两者
 * 各自独立地处理（并回复）同一批 Telegram 更新，表现为回复重复/不一致。
 */
export async function acquireSingleInstanceLock(): Promise<void> {
  // 候选文件先完整写好，再通过 hard-link 原子发布为正式锁；正式路径永远不
  // 会短暂暴露一个尚未写入 PID 的空文件。
  const candidatePath: string = `${LOCK_FILE_PATH}.candidate.${process.pid}.${crypto.randomUUID()}`;
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
        await link(candidatePath, LOCK_FILE_PATH);
        return;
      } catch (error: unknown) {
        if (!isErrno(error, "EEXIST")) throw error;
      }

      let existingPid: number;
      try {
        existingPid = parseInt((await Bun.file(LOCK_FILE_PATH).text()).trim(), 10);
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
      // 删掉较快者刚发布的新锁。独占 recovery 文件保证只有一个进程能重检、
      // 删除并接管；竞争者直接失败，稍后重启即可。
      const recoveryPath: string = `${LOCK_FILE_PATH}.recovery`;
      let recoveryHandle: Awaited<ReturnType<typeof open>>;
      try {
        recoveryHandle = await open(recoveryPath, "wx");
      } catch (error: unknown) {
        if (isErrno(error, "EEXIST")) {
          throw new Error("Another process is recovering a stale bot.lock; retry startup shortly.");
        }
        throw error;
      }

      try {
        await recoveryHandle.writeFile(String(process.pid));
        // 获得回收权后重新读取，不能沿用取得回收权之前观察到的 PID。
        let currentPid: number;
        try {
          currentPid = parseInt((await Bun.file(LOCK_FILE_PATH).text()).trim(), 10);
        } catch (error: unknown) {
          if (isErrno(error, "ENOENT")) continue;
          throw error;
        }
        if (!Number.isNaN(currentPid) && isProcessAlive(currentPid)) {
          throw new Error(`Another bot instance (pid=${currentPid}) acquired the lock during recovery.`);
        }
        await unlink(LOCK_FILE_PATH);
      } finally {
        await recoveryHandle.close();
        await unlink(recoveryPath).catch(() => undefined);
      }
    }
  } finally {
    await unlink(candidatePath).catch(() => undefined);
  }
}

/** 正常停机时只释放属于当前 PID 的锁；硬崩留下的锁由下次启动回收。 */
export async function releaseSingleInstanceLock(): Promise<void> {
  try {
    const ownerPid: number = parseInt((await Bun.file(LOCK_FILE_PATH).text()).trim(), 10);
    if (ownerPid === process.pid) await unlink(LOCK_FILE_PATH);
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

// runner 并发处理不同群的更新后，两个群可能同时触发 saveState。写入必须
// 串行，但不能为每次变化都无限排队：写入期间只保留最新快照，中间快照没有
// 落盘价值。调度器因此最多持有「在写 + 待写」两份 JSON。

/**
 * 串行排队写入 state.json。调用方必须先把状态同步序列化成字符串再传进来，
 * 这样落盘的一定是调用时刻的状态快照——若把序列化推迟到队列执行时，共享状态
 * 可能已被并发的处理器改过。
 *
 * 先写临时文件、再 rename 到目标路径：rename 在同一文件系统内是原子操作，
 * 进程如果在这中间被杀（OOM/断电/容器被回收），目标文件要么是写入前的旧内容，
 * 要么是写入后的新内容，不会停在半截的撕裂 JSON——不然重启后 loadState()
 * 解析失败，会把这份文件聚合的所有数据一次性清空。
 */
const stateWriter = createLatestValueRunner<string>(async (json: string): Promise<void> => {
  try {
    const tmpPath: string = `${STATE_FILE_PATH}${TMP_FILE_SUFFIX}`;
    await Bun.write(tmpPath, json);
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
 * 内存状态全量序列化而来（结构见 StateFileSchema），这里逐字段重建而不是把
 * 解析结果直接当类型用：字段一旦从类型里删掉，磁盘上的旧值会在下一次
 * loadState → saveState 的往返中自动被甩掉，不会因为存量文件里还带着而
 * 一直被原样读出、原样存回、永远清不掉。
 *
 * 兼容两代旧格式：
 * 1. 最老的扁平格式——顶层直接就是 Record<chatId, ChatState>，没有 chats
 *    包装。用有没有 "chats" 键区分（真实 chatId 不可能是字符串 "chats"）。
 * 2. 上一代格式——copiedUser/copyMode 存在各群的 chats[id] 下（当时按群
 *    分别维护复读目标）、私密模式镜像存在顶层 lockdowns 下。迁移规则：
 *    正在复读的群（copiedUser 非 null）提升为全局复读目标（多个群都在复读
 *    时只保留最先遇到的那个，其余丢弃——全局同一时刻只有一个目标）；
 *    lockdowns[id] 移入对应 chats[id].lockdown。
 *
 * 顶层形状不是对象时（数组/原始值/损坏）记一条错误日志——不能默默当空状态
 * 处理，那样出问题了完全没有排查线索。
 */
export async function loadState(): Promise<void> {
  try {
    const file = Bun.file(STATE_FILE_PATH);
    if (!(await file.exists())) return;

    const parsed: unknown = JSON.parse(await file.text());
    let rawChats: unknown;
    let rawGlobalCopy: unknown;
    let rawLegacyLockdowns: unknown;

    if (isRecord(parsed)) {
      if ("chats" in parsed) {
        rawChats = parsed.chats;
        rawGlobalCopy = parsed.globalCopy;
        rawLegacyLockdowns = parsed.lockdowns;
      } else {
        // 最老的扁平格式：顶层本身就是 chats 那部分。
        rawChats = parsed;
      }
    } else {
      logger.error("Top level of state.json is not an object (array/primitive/corrupted); ignoring it and starting with empty state");
      return;
    }

    if (isRecord(rawGlobalCopy)) {
      const lastCopyTime: number | undefined = finiteNumber(rawGlobalCopy.lastCopyTime);
      if (lastCopyTime !== undefined) globalCopyState.lastCopyTime = lastCopyTime;
      const copiedUser: CachedUser | null = rebuildCachedUser(rawGlobalCopy.copiedUser);
      const copyChatId: number | undefined = finiteNumber(rawGlobalCopy.copyChatId);
      if (copiedUser && copyChatId !== undefined && Number.isSafeInteger(copyChatId)) {
        adoptCopyTarget(copiedUser, copyModeValue(rawGlobalCopy.copyMode), copyChatId);
      } else if (rawGlobalCopy.copiedUser) {
        // 有目标却没有有效的发起群 id（手改文件/中间版本写坏）：这种目标
        // 在任何群都不会被复读，却会让所有群的 /copy 都被「已有猎物」拒绝，
        // 直接丢弃并留日志，不让进程带着卡死的全局槽位启动。
        logger.error("state.json globalCopy has copiedUser but no valid copyChatId; dropping the copy target to avoid a stuck global copy slot");
      }
    }

    if (isRecord(rawChats)) {
      for (const [chatIdStr, raw] of Object.entries(rawChats)) {
        const chatId: number = Number(chatIdStr);
        if (!Number.isSafeInteger(chatId) || chatId === 0) continue;
        const entry: Record<string, unknown> = isRecord(raw) ? raw : {};
        const chatState: ChatState | null = rebuildChatState(entry, Date.now());
        if (!chatState) continue;
        // 迁移：isInit 是新引入的网关字段，state.json 里已有条目的群此前
        // 一直在正常被处理，缺省网关生效前的旧存量不该被当成"未初始化"
        // 直接吞掉更新——只有 state.json 里从未出现过、全新拉群的群才会
        // 保持 isInit undefined，需要显式 /init enable。
        if (chatState.isInit === undefined) chatState.isInit = true;
        chatStates.set(chatId, chatState);
        // 旧格式迁移：按群维护的复读目标提升为全局的。全局同一时刻只有一个
        // 目标，多个群同时在复读时只保留最先遇到的，其余的记日志后丢弃——
        // 不能一声不吭，被丢的那个群升级重启后复读凭空消失，得留排查线索。
        const legacyCopiedUser: CachedUser | null = rebuildCachedUser(entry.copiedUser);
        if (legacyCopiedUser) {
          if (globalCopyState.copiedUser === null) {
            adoptCopyTarget(legacyCopiedUser, copyModeValue(entry.copyMode), chatId);
          } else {
            logger.error(`Dropped legacy per-chat copy target of chat ${chatId} during migration: the single global copy slot is already taken`);
          }
        }
      }
    }

    // 旧格式迁移：顶层 lockdowns 移入对应群的 chats[id].lockdown。这个最老
    // 的格式只有裸 ChatPermissions、没有到期时刻；加载时立即包装成严格的
    // LockdownRecord，并从此刻重新给一轮满额时长。
    if (isRecord(rawLegacyLockdowns)) {
      for (const [chatIdStr, permissions] of Object.entries(rawLegacyLockdowns)) {
        const chatId: number = Number(chatIdStr);
        if (!Number.isSafeInteger(chatId) || chatId === 0) continue;
        const lockdown: LockdownRecord | undefined = rebuildLockdown(permissions, Date.now());
        if (lockdown) getOrCreateChatState(chatId).lockdown = lockdown;
      }
    }
  } catch (error: unknown) {
    logger.error("Failed to load state:", error);
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
