import { logger } from "./logger";
import type { ChatPermissions } from "@grammyjs/types";
import type { CachedUser, ChatState, ChatStateFileSchema, UsersFileSchema } from "../types";
import { LOCK_FILE_PATH, LOCKDOWNS_FILE_PATH, STATE_FILE_PATH, USERS_FILE_PATH } from "../consts/paths";
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

/**
 * 从 JSON 文件加载各群聊的冷却时间和当前复制目标（按 chatId 分别保存）。
 * @returns resolve 为 UsersFileSchema 的 promise。
 */
export async function loadUsersFile(): Promise<UsersFileSchema> {
  try {
    const file = Bun.file(USERS_FILE_PATH);
    if (await file.exists()) {
      const text: string = await file.text();
      const parsed: any = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as UsersFileSchema;
      }
    }
  } catch (error: unknown) {
    logger.error("Failed to load users file:", error);
  }
  return {};
}

// runner 并发处理不同群的更新后，两个群可能同时触发 saveState/saveUsersFile。
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
 * 将 users 数据持久化保存到 JSON 文件。仅供本文件的 saveChatUsersEntry
 * 使用——外部的写路径统一走后者。
 * @param data UsersFileSchema 数据。
 */
async function saveUsersFile(data: UsersFileSchema): Promise<void> {
  await persistJson(USERS_FILE_PATH, JSON.stringify(data, null, 2), "users file");
}

/**
 * 更新 users.json 里某一个群的条目（冷却时间戳 + 当前复制目标）并整体持久化。
 * copy 类命令共用的收尾动作——只动本群自己的键，不影响其他群。
 * @param copiedUser 本群当前的复制目标；没有复读（/stop_copy 后、/steal_icon
 *   不触碰复读）时为 null。
 */
export async function saveChatUsersEntry(
  data: UsersFileSchema,
  chatId: number,
  lastCopyTime: number | undefined,
  copiedUser: CachedUser | null
): Promise<void> {
  data[String(chatId)] = { lastCopyTime: lastCopyTime ?? 0, copiedUser };
  await saveUsersFile(data);
}

/**
 * 从持久化的 JSON 文件加载各群聊各自的状态。
 * @returns resolve 为 Map<chatId, ChatState> 的 promise（机器人可能同时在多个群
 * 里运行，各群的复制目标/冷却时间互相独立）。
 */
export async function loadState(): Promise<Map<number, ChatState>> {
  try {
    const file = Bun.file(STATE_FILE_PATH);
    if (await file.exists()) {
      const text: string = await file.text();
      const parsed: ChatStateFileSchema = JSON.parse(text);
      const chatStates: Map<number, ChatState> = new Map();
      for (const [chatIdStr, chatState] of Object.entries(parsed)) {
        chatStates.set(Number(chatIdStr), chatState);
      }
      return chatStates;
    }
  } catch (error: unknown) {
    logger.error("Failed to load state:", error);
  }
  return new Map();
}

/**
 * 将各群聊各自的状态持久化保存到 JSON 文件。
 * @param chatStates 当前 Map<chatId, ChatState>。
 */
export async function saveState(chatStates: Map<number, ChatState>): Promise<void> {
  const serializable: ChatStateFileSchema = {};
  for (const [chatId, chatState] of chatStates) {
    serializable[String(chatId)] = chatState;
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
    chatState = { copiedUserId: null, isCopying: false };
    chatStates.set(chatId, chatState);
  }
  return chatState;
}
