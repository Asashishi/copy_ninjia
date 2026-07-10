import { join } from "path";
import type { BotState, UsersFileSchema } from "./types";

const PROJECT_ROOT: string = join(import.meta.dir, "..");

// File paths for persistence within the project directory
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
 * Ensures only one bot instance polls at a time. Running two instances against
 * the same token makes both of them independently process (and reply to) the
 * same Telegram updates, which looks like duplicated/inconsistent replies.
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
 * Loads the users schema containing cooldown and active copy user from JSON.
 * @returns A promise resolving to the UsersFileSchema.
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
 * Persists the users schema to the persistent JSON file.
 * @param data The UsersFileSchema.
 */
export async function saveUsersFile(data: UsersFileSchema): Promise<void> {
  try {
    await Bun.write(USERS_FILE_PATH, JSON.stringify(data, null, 2));
  } catch (error: unknown) {
    console.error("Failed to save users file:", error);
  }
}

/**
 * Loads the bot's state from the persistent JSON file.
 * @returns A promise resolving to the current BotState.
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
 * Persists the bot's state to the persistent JSON file.
 * @param state The current BotState.
 */
export async function saveState(state: BotState): Promise<void> {
  try {
    await Bun.write(STATE_FILE_PATH, JSON.stringify(state, null, 2));
  } catch (error: unknown) {
    console.error("Failed to save state:", error);
  }
}
