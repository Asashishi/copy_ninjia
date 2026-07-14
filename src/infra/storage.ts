import { rename } from "node:fs/promises";
import { logger } from "./logger";
import type { ChatPermissions } from "@grammyjs/types";
import type { CachedUser, ChatState, CopyMode, GlobalCopyState, StateFileSchema } from "../types";
import { LOCK_FILE_PATH, STATE_FILE_PATH } from "../consts/paths";
import { DEFAULT_CHAT_STATE } from "../consts/storage";
import { persistChainState } from "../cache/storage";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保同一时间只有一个机器人实例在轮询。用同一个 token 跑两个实例会导致两者
 * 各自独立地处理（并回复）同一批 Telegram 更新，表现为回复重复/不一致。
 */
export async function acquireSingleInstanceLock(): Promise<void> {
  const lockFile = Bun.file(LOCK_FILE_PATH);
  if (await lockFile.exists()) {
    const existingPid: number = parseInt((await lockFile.text()).trim(), 10);
    if (!Number.isNaN(existingPid) && isProcessAlive(existingPid)) {
      logger.error(
        `Another bot instance (pid=${existingPid}) is already running; refusing to start a second one — ` +
        `two instances polling with the same token would answer the same updates twice.`
      );
      process.exit(1);
    }
  }
  await Bun.write(LOCK_FILE_PATH, String(process.pid));
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

// runner 并发处理不同群的更新后，两个群可能同时触发 saveState。
// 并发写同一个文件会产生撕裂的 JSON，因此所有持久化写入挂到同一条 promise
// 链上串行执行（无论上一次成败都继续下一次，见 cache/storage.ts）。

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
function persistStateJson(json: string): Promise<void> {
  const write = async (): Promise<void> => {
    try {
      const tmpPath: string = `${STATE_FILE_PATH}.tmp`;
      await Bun.write(tmpPath, json);
      await rename(tmpPath, STATE_FILE_PATH);
    } catch (error: unknown) {
      logger.error("Failed to save state:", error);
    }
  };
  persistChainState.chain = persistChainState.chain.then(write, write);
  return persistChainState.chain;
}

// ChatState 的字段白名单：loadState() 里各群条目的重建直接由它驱动（只挑
// 这里列出的键），所以 ChatState 新增字段时这个 Record<keyof ChatState, true>
// 字面量会因为缺键编译报错，补上键的同时重建逻辑就自动跟上了——不会像过去
// 的 lastCopyTime 那样，重建漏了某个字段还一直悄悄漏读/漏写。
// （GlobalCopyState 没有对应白名单：它的重建带逐字段校验，见 loadState 内，
// 新增字段时需要手动去那里补校验逻辑。）
const CHAT_STATE_FIELD_WHITELIST: Record<keyof ChatState, true> = { quietUntil: true, lockdown: true };

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

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if ("chats" in parsed) {
        rawChats = (parsed as any).chats;
        rawGlobalCopy = (parsed as any).globalCopy;
        rawLegacyLockdowns = (parsed as any).lockdowns;
      } else {
        // 最老的扁平格式：顶层本身就是 chats 那部分。
        rawChats = parsed;
      }
    } else {
      logger.error("Top level of state.json is not an object (array/primitive/corrupted); ignoring it and starting with empty state");
      return;
    }

    if (rawGlobalCopy && typeof rawGlobalCopy === "object") {
      const g: any = rawGlobalCopy;
      if (typeof g.lastCopyTime === "number") globalCopyState.lastCopyTime = g.lastCopyTime;
      if (g.copiedUser && typeof g.copyChatId === "number") {
        adoptCopyTarget(g.copiedUser, g.copyMode, g.copyChatId);
      } else if (g.copiedUser) {
        // 有目标却没有有效的发起群 id（手改文件/中间版本写坏）：这种目标
        // 在任何群都不会被复读，却会让所有群的 /copy 都被「已有猎物」拒绝，
        // 直接丢弃并留日志，不让进程带着卡死的全局槽位启动。
        logger.error("state.json globalCopy has copiedUser but no valid copyChatId; dropping the copy target to avoid a stuck global copy slot");
      }
    }

    if (rawChats && typeof rawChats === "object" && !Array.isArray(rawChats)) {
      for (const [chatIdStr, raw] of Object.entries(rawChats)) {
        const chatId: number = Number(chatIdStr);
        const entry: any = raw ?? {};
        // 重建由字段白名单驱动：新增 ChatState 字段时补全白名单键即可，
        // 这里不用改（见 CHAT_STATE_FIELD_WHITELIST 的注释）。
        const chatState: ChatState = {};
        for (const key of Object.keys(CHAT_STATE_FIELD_WHITELIST) as (keyof ChatState)[]) {
          if (entry[key] !== undefined) (chatState as any)[key] = entry[key];
        }
        chatStates.set(chatId, chatState);
        // 旧格式迁移：按群维护的复读目标提升为全局的。全局同一时刻只有一个
        // 目标，多个群同时在复读时只保留最先遇到的，其余的记日志后丢弃——
        // 不能一声不吭，被丢的那个群升级重启后复读凭空消失，得留排查线索。
        if (entry.copiedUser) {
          if (globalCopyState.copiedUser === null) {
            adoptCopyTarget(entry.copiedUser, entry.copyMode, chatId);
          } else {
            logger.error(`Dropped legacy per-chat copy target of chat ${chatId} during migration: the single global copy slot is already taken`);
          }
        }
      }
    }

    // 旧格式迁移：顶层 lockdowns 移入对应群的 chats[id].lockdown。
    if (rawLegacyLockdowns && typeof rawLegacyLockdowns === "object" && !Array.isArray(rawLegacyLockdowns)) {
      for (const [chatIdStr, permissions] of Object.entries(rawLegacyLockdowns)) {
        getOrCreateChatState(Number(chatIdStr)).lockdown = permissions as ChatPermissions;
      }
    }
  } catch (error: unknown) {
    logger.error("Failed to load state:", error);
  }
}

/**
 * 把内存状态全量序列化并持久化到 state.json。状态只有本模块这一份，
 * 无需调用方传任何东西；没有任何有效字段的群条目不落盘，保持文件干净。
 */
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
