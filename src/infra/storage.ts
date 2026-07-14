import { logger } from "./logger";
import type { ChatPermissions } from "@grammyjs/types";
import type { ChatState, GlobalCopyState, StateFileSchema } from "../types";
import { LOCK_FILE_PATH, LOCKDOWNS_FILE_PATH, STATE_FILE_PATH } from "../consts/paths";
import { DEFAULT_CHAT_STATE } from "../consts/storage";

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
        `另一个 bot 实例 (pid=${existingPid}) 已经在运行，拒绝启动第二个实例——` +
        `多个实例同时轮询会导致同一条消息被重复回复。`
      );
      process.exit(1);
    }
  }
  await Bun.write(LOCK_FILE_PATH, String(process.pid));
}

// runner 并发处理不同群的更新后，两个群可能同时触发 saveState。
// Bun.write 是「截断再写」，并发写同一个文件会产生撕裂的 JSON，因此所有持久化
// 写入挂到同一条 promise 链上串行执行（无论上一次成败都继续下一次）。
let persistChain: Promise<void> = Promise.resolve();

/**
 * 串行排队写入一份 JSON 文件。调用方必须先把数据同步序列化成字符串再传进来，
 * 这样落盘的一定是调用时刻的状态快照——若把序列化推迟到队列执行时，共享数据
 * 可能已被并发的处理器改过。
 * @param label 用于错误日志的文件描述。
 */
function persistJson(filePath: string, json: string, label: string): Promise<void> {
  const write = async (): Promise<void> => {
    try {
      await Bun.write(filePath, json);
    } catch (error: unknown) {
      logger.error(`Failed to save ${label}:`, error);
    }
  };
  persistChain = persistChain.then(write, write);
  return persistChain;
}

/**
 * 从持久化的 JSON 文件加载「各群聊各自的状态」+「copy 类命令的全局冷却
 * 时钟」——两者虽然一个按群一个全局，但都只有这一份，合并存在同一个
 * state.json 里（结构见 StateFileSchema），不必为了这份全局数据单开一个
 * 只有一个字段的文件。
 *
 * chats 部分逐字段重建而不是把解析结果直接当 ChatState 用：这样字段一旦从
 * 类型里删掉，磁盘上的旧值会在下一次 loadState → saveState 的往返中自动被
 * 甩掉，不会像 lastCopyTime 曾经那样，因为存量文件里还带着而一直被原样读出、
 * 原样存回、永远清不掉。
 * @returns 各群 ChatState 的 Map（机器人可能同时在多个群里运行，各群的
 * 复制目标互相独立）+ 全局冷却状态。
 */
export async function loadState(): Promise<{ chatStates: Map<number, ChatState>; globalCopyState: GlobalCopyState }> {
  try {
    const file = Bun.file(STATE_FILE_PATH);
    if (await file.exists()) {
      const text: string = await file.text();
      const parsed: Partial<StateFileSchema> = JSON.parse(text);
      const chatStates: Map<number, ChatState> = new Map();
      for (const [chatIdStr, raw] of Object.entries(parsed.chats ?? {})) {
        chatStates.set(Number(chatIdStr), {
          copiedUser: (raw as any)?.copiedUser ?? null,
          copyMode: (raw as any)?.copyMode,
          quietUntil: (raw as any)?.quietUntil,
        });
      }
      const globalCopyState: GlobalCopyState =
        typeof parsed.globalCopy?.lastCopyTime === "number" ? { lastCopyTime: parsed.globalCopy.lastCopyTime } : {};
      return { chatStates, globalCopyState };
    }
  } catch (error: unknown) {
    logger.error("Failed to load state:", error);
  }
  return { chatStates: new Map(), globalCopyState: {} };
}

/**
 * 将「各群聊各自的状态」和「copy 类命令的全局冷却时钟」一起持久化到同一个
 * JSON 文件。两者必须一起传、一起写：这是同一个文件的完整快照，只传其中
 * 一半会把另一半的最新值覆盖丢——调用方永远持有两者的最新引用（都是同一份
 * 内存对象，不是快照拷贝），所以传自己手上现有的那份即可，不需要现读。
 * @param chatStates 当前 Map<chatId, ChatState>。
 * @param globalCopyState 当前全局冷却状态。
 */
export async function saveState(chatStates: Map<number, ChatState>, globalCopyState: GlobalCopyState): Promise<void> {
  const serializable: StateFileSchema = { chats: {}, globalCopy: globalCopyState };
  for (const [chatId, chatState] of chatStates) {
    serializable.chats[String(chatId)] = chatState;
  }
  await persistJson(STATE_FILE_PATH, JSON.stringify(serializable, null, 2), "state");
}

/**
 * 加载持久化的反刷群私密模式记录（chatId -> 锁定前的原始权限）。
 * 进程重启后由 initAntiRaid() 重放给守卫 Worker 接管——权限限制已实际
 * 落在群上，不重放就永远无人解锁（见 src/antiRaid.ts）。
 */
export async function loadLockdowns(): Promise<Map<number, ChatPermissions>> {
  try {
    const file = Bun.file(LOCKDOWNS_FILE_PATH);
    if (await file.exists()) {
      const parsed: any = JSON.parse(await file.text());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const lockdowns: Map<number, ChatPermissions> = new Map();
        for (const [chatIdStr, permissions] of Object.entries(parsed)) {
          lockdowns.set(Number(chatIdStr), permissions as ChatPermissions);
        }
        return lockdowns;
      }
    }
  } catch (error: unknown) {
    logger.error("Failed to load lockdowns file:", error);
  }
  return new Map();
}

/**
 * 持久化当前生效中的私密模式镜像（每次 lockdown/unlock 事件后全量覆写）。
 */
export async function saveLockdowns(lockedChats: Map<number, ChatPermissions>): Promise<void> {
  const serializable: Record<string, ChatPermissions> = {};
  for (const [chatId, permissions] of lockedChats) {
    serializable[String(chatId)] = permissions;
  }
  await persistJson(LOCKDOWNS_FILE_PATH, JSON.stringify(serializable, null, 2), "lockdowns file");
}

/**
 * 只读地取某个群聊的状态，不存在时返回共享的默认状态（不会插入到 Map 里）。
 * 供仅需要读取的场景使用（比如判断是否要复读某条消息），避免机器人所在的
 * 每个群、每条消息都往 Map 里塞一个从未用过 /copy 的空条目。
 */
export function getChatState(chatStates: Map<number, ChatState>, chatId: number): ChatState {
  return chatStates.get(chatId) ?? DEFAULT_CHAT_STATE;
}

/**
 * 取某个群聊的状态，不存在则创建一份默认状态并插入 Map。供需要修改状态的场景
 * 使用（比如 /copy、/stop_copy），确保拿到的是可以直接写入、且后续会被持久化的对象。
 */
export function getOrCreateChatState(chatStates: Map<number, ChatState>, chatId: number): ChatState {
  let chatState = chatStates.get(chatId);
  if (!chatState) {
    chatState = { copiedUser: null };
    chatStates.set(chatId, chatState);
  }
  return chatState;
}
