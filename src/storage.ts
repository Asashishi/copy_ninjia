import { join } from "path";
import type { BotState, UsersFileSchema } from "./types";

const PROJECT_ROOT: string = join(import.meta.dir, "..");

// 项目目录内用于持久化的各文件路径
const USERS_FILE_PATH: string = join(PROJECT_ROOT, "users.json");
const STATE_FILE_PATH: string = join(PROJECT_ROOT, "state.json");
const LOCK_FILE_PATH: string = join(PROJECT_ROOT, "bot.lock");

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
      console.error(
        `另一个 bot 实例 (pid=${existingPid}) 已经在运行，拒绝启动第二个实例——` +
        `多个实例同时轮询会导致同一条消息被重复回复。`
      );
      process.exit(1);
    }
  }
  await Bun.write(LOCK_FILE_PATH, String(process.pid));
}

/**
 * 从 JSON 文件加载包含冷却时间和当前复制目标的 users 数据。
 * @returns resolve 为 UsersFileSchema 的 promise。
 */
export async function loadUsersFile(): Promise<UsersFileSchema> {
  try {
    const file = Bun.file(USERS_FILE_PATH);
    if (await file.exists()) {
      const text: string = await file.text();
      const parsed: any = JSON.parse(text);
      if (parsed && typeof parsed.lastCopyTime === "number") {
        return parsed as UsersFileSchema;
      }
    }
  } catch (error: unknown) {
    console.error("Failed to load users file:", error);
  }
  return {
    lastCopyTime: 0,
    copiedUser: null,
  };
}

/**
 * 将 users 数据持久化保存到 JSON 文件。
 * @param data UsersFileSchema 数据。
 */
export async function saveUsersFile(data: UsersFileSchema): Promise<void> {
  try {
    await Bun.write(USERS_FILE_PATH, JSON.stringify(data, null, 2));
  } catch (error: unknown) {
    console.error("Failed to save users file:", error);
  }
}

/**
 * 从持久化的 JSON 文件加载机器人的状态。
 * @returns resolve 为当前 BotState 的 promise。
 */
export async function loadState(): Promise<BotState> {
  try {
    const file = Bun.file(STATE_FILE_PATH);
    if (await file.exists()) {
      const text: string = await file.text();
      return JSON.parse(text) as BotState;
    }
  } catch (error: unknown) {
    console.error("Failed to load state:", error);
  }
  return {
    copiedUserId: null,
    isCopying: false,
    lastCopiedUserId: null,
    lastCopyTime: 0,
  };
}

/**
 * 将机器人的状态持久化保存到 JSON 文件。
 * @param state 当前的 BotState。
 */
export async function saveState(state: BotState): Promise<void> {
  try {
    await Bun.write(STATE_FILE_PATH, JSON.stringify(state, null, 2));
  } catch (error: unknown) {
    console.error("Failed to save state:", error);
  }
}
