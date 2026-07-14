import { rename } from "node:fs/promises";
import { logger } from "./logger";
import type { ChatPermissions } from "@grammyjs/types";
import type { ChatState, GlobalCopyState, StateFileSchema } from "../types";
import { LOCK_FILE_PATH, STATE_FILE_PATH } from "../consts/paths";
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
// 并发写同一个文件会产生撕裂的 JSON，因此所有持久化写入挂到同一条 promise
// 链上串行执行（无论上一次成败都继续下一次）。
let persistChain: Promise<void> = Promise.resolve();

/**
 * 串行排队对 state.json 做一次局部 patch：chats/globalCopy（saveState）和
 * lockdowns（saveLockdowns）由两条完全独立的调用路径写入，谁都不持有对方
 * 那部分的最新引用（saveLockdowns 触发自 antiRaid.ts 的 Worker 事件回调，
 * 手上只有 lockedChats 镜像；saveState 触发自各命令处理器，手上只有
 * chatStates/globalCopyState）。所以每次落盘前都在队列里现读一次磁盘上的
 * 最新内容，只覆盖 patch 里带的那几个顶层字段，其余字段原样保留——不这样做
 * 的话，后写入的一路会把先写入的一路刚存的数据整个覆盖掉。现读是安全的：
 * persistChain 把所有写入串行成一条队列，同一时刻只有一个 patch 在执行，
 * 读到的必然是上一次写入落盘后的最终内容，不会跟其他写入交叉。
 *
 * 先写临时文件、再 rename 到目标路径：rename 在同一文件系统内是原子操作，
 * 进程如果在这中间被杀（OOM/断电/容器被回收），目标文件要么是写入前的旧内容，
 * 要么是写入后的新内容，不会停在半截的撕裂 JSON——不然重启后 loadState()
 * 解析失败，会把这份文件当前聚合的三块数据（各群状态、全局冷却、反刷群私密
 * 模式镜像）一次性清空。
 * @param patch 本次要覆盖的顶层字段，其余字段保持磁盘上的原值不变。
 * @param label 用于错误日志的文件描述。
 */
function patchStateFile(patch: Partial<StateFileSchema>, label: string): Promise<void> {
  const write = async (): Promise<void> => {
    try {
      let current: StateFileSchema = { chats: {}, globalCopy: {}, lockdowns: {} };
      const file = Bun.file(STATE_FILE_PATH);
      if (await file.exists()) {
        try {
          const parsed: unknown = JSON.parse(await file.text());
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            current = { ...current, ...(parsed as Partial<StateFileSchema>) };
          }
        } catch {
          // On-disk JSON is corrupted: fall back to the defaults above so
          // this write still lands cleanly instead of failing outright.
        }
      }
      const merged: StateFileSchema = { ...current, ...patch };
      const tmpPath: string = `${STATE_FILE_PATH}.tmp`;
      await Bun.write(tmpPath, JSON.stringify(merged, null, 2));
      await rename(tmpPath, STATE_FILE_PATH);
    } catch (error: unknown) {
      logger.error(`Failed to save ${label}:`, error);
    }
  };
  persistChain = persistChain.then(write, write);
  return persistChain;
}

/** 编译期兜底：ChatState 新增字段时，如果忘了在下面 loadState() 的白名单
 * 重建里同步处理，这个 Record<keyof ChatState, true> 字面量会因为缺键报错，
 * 不会像过去的 lastCopyTime 那样，字段从类型里删了、白名单却没跟着改，
 * 一直悄悄漏读/漏写。 */
const CHAT_STATE_FIELD_WHITELIST: Record<keyof ChatState, true> = { copiedUser: true, copyMode: true, quietUntil: true };

/**
 * 从持久化的 JSON 文件加载「各群聊各自的状态」+「copy 类命令的全局冷却
 * 时钟」+「反刷群私密模式镜像」——三者维度各不相同，但都只有这一份，合并
 * 存在同一个 state.json 里（结构见 StateFileSchema），不必为了这些全局/半
 * 全局数据单开文件。
 *
 * 兼容合并前的旧格式：那时 state.json 顶层直接就是 Record<chatId, ChatState>，
 * 没有 chats/globalCopy/lockdowns 包装。用有没有 "chats" 键区分新旧格式——
 * 真实的 chatId 不可能是字符串 "chats"，这个判定不会误伤。不兼容的话，用旧
 * 格式文件重启会把 parsed.chats 读成 undefined，静默把所有群状态和全局冷却
 * 清零，且不报错。
 *
 * 顶层形状既不是新格式也不是旧格式（比如整个文件是个数组或原始值）时记一条
 * 错误日志——不能就这样默默当空状态处理，那样出问题了完全没有排查线索。
 *
 * chats 部分逐字段重建而不是把解析结果直接当 ChatState 用：这样字段一旦从
 * 类型里删掉，磁盘上的旧值会在下一次 loadState → saveState 的往返中自动被
 * 甩掉，不会像 lastCopyTime 曾经那样，因为存量文件里还带着而一直被原样读出、
 * 原样存回、永远清不掉。
 * @returns 各群 ChatState 的 Map（机器人可能同时在多个群里运行，各群的
 * 复制目标互相独立）+ 全局冷却状态 + 当前生效中的私密模式镜像。
 */
export async function loadState(): Promise<{
  chatStates: Map<number, ChatState>;
  globalCopyState: GlobalCopyState;
  lockdowns: Map<number, ChatPermissions>;
}> {
  try {
    const file = Bun.file(STATE_FILE_PATH);
    if (await file.exists()) {
      const text: string = await file.text();
      const parsed: unknown = JSON.parse(text);
      const chatStates: Map<number, ChatState> = new Map();
      const lockdowns: Map<number, ChatPermissions> = new Map();
      let rawChats: unknown;
      let rawGlobalCopy: unknown;
      let rawLockdowns: unknown;

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if ("chats" in parsed) {
          // 合并后的新格式。
          rawChats = (parsed as Partial<StateFileSchema>).chats;
          rawGlobalCopy = (parsed as Partial<StateFileSchema>).globalCopy;
          rawLockdowns = (parsed as Partial<StateFileSchema>).lockdowns;
        } else {
          // 合并前的旧格式：顶层本身就是 chats 那部分。
          rawChats = parsed;
        }
      } else {
        logger.error("Top level of state.json is not an object (array/primitive/corrupted); ignoring it and starting with empty state");
      }

      if (rawChats && typeof rawChats === "object" && !Array.isArray(rawChats)) {
        for (const [chatIdStr, raw] of Object.entries(rawChats)) {
          chatStates.set(Number(chatIdStr), {
            copiedUser: (raw as any)?.copiedUser ?? null,
            copyMode: (raw as any)?.copyMode,
            quietUntil: (raw as any)?.quietUntil,
          });
        }
      }

      if (rawLockdowns && typeof rawLockdowns === "object" && !Array.isArray(rawLockdowns)) {
        for (const [chatIdStr, permissions] of Object.entries(rawLockdowns)) {
          lockdowns.set(Number(chatIdStr), permissions as ChatPermissions);
        }
      }

      const globalCopyState: GlobalCopyState =
        rawGlobalCopy && typeof rawGlobalCopy === "object" && typeof (rawGlobalCopy as any).lastCopyTime === "number"
          ? { lastCopyTime: (rawGlobalCopy as any).lastCopyTime }
          : {};
      return { chatStates, globalCopyState, lockdowns };
    }
  } catch (error: unknown) {
    logger.error("Failed to load state:", error);
  }
  return { chatStates: new Map(), globalCopyState: {}, lockdowns: new Map() };
}

/**
 * 持久化「各群聊各自的状态」和「copy 类命令的全局冷却时钟」，lockdowns
 * 部分保持磁盘上的原值不变（见 patchStateFile）。
 * @param chatStates 当前 Map<chatId, ChatState>。
 * @param globalCopyState 当前全局冷却状态。
 */
export async function saveState(chatStates: Map<number, ChatState>, globalCopyState: GlobalCopyState): Promise<void> {
  const chats: Record<string, ChatState> = {};
  for (const [chatId, chatState] of chatStates) {
    chats[String(chatId)] = chatState;
  }
  await patchStateFile({ chats, globalCopy: globalCopyState }, "state");
}

/**
 * 持久化当前生效中的反刷群私密模式镜像（每次 lockdown/unlock 事件后全量
 * 覆写这一部分），chats/globalCopy 部分保持磁盘上的原值不变（见
 * patchStateFile）。
 */
export async function saveLockdowns(lockedChats: Map<number, ChatPermissions>): Promise<void> {
  const lockdowns: Record<string, ChatPermissions> = {};
  for (const [chatId, permissions] of lockedChats) {
    lockdowns[String(chatId)] = permissions;
  }
  await patchStateFile({ lockdowns }, "lockdowns");
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
    // 展开 DEFAULT_CHAT_STATE 而不是另写一份同形状的字面量：两处默认值曾经
    // 各写各的，这次改字段就得手动同步两边，容易漏改一处。spread 出的是
    // 普通对象，不共享 DEFAULT_CHAT_STATE 那份 Object.freeze，可以正常改写。
    chatState = { ...DEFAULT_CHAT_STATE };
    chatStates.set(chatId, chatState);
  }
  return chatState;
}
