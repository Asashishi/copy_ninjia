import { STATE_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import { STATE_FILE_PATH } from "../../consts/paths";
import { DEFAULT_CHAT_STATE, STATE_SAVE_RETRY_DELAYS_MS } from "../../consts/storage";
import { atomicWriteText } from "../../libs/atomicFile";
import { normalizeChatState, normalizeChatStateEntry } from "../../libs/chatState";
import { createLatestValueRunner, type LatestValueRunner } from "../../libs/latestValueRunner";
import { decodeStateFile } from "../../libs/stateFileCodec";
import type { CachedUser, ChatState, CopyMode, GlobalCopyState, StateFileSchema } from "../../types/chatState";
import { logger } from "../logger";

export interface StateStoreOptions {
  stateFilePath?: string;
  readText?: (path: string) => Promise<string | null>;
  writeText?: (path: string, content: string) => Promise<void>;
  retryDelaysMs?: readonly number[];
  onRetryError?: (attempt: number, error: unknown) => void;
  onFlushError?: (error: unknown) => void;
}

async function readExistingText(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return await file.exists() ? file.text() : null;
}

/**
 * state.json 的可注入持久化边界：负责 schema 解码/序列化、latest-only 串行写、
 * 失败退避和退出 flush；ChatState 的业务内存不进入这个类。
 */
export class StateStore {
  private readonly stateFilePath: string;
  private readonly readText: (path: string) => Promise<string | null>;
  private readonly writeText: (path: string, content: string) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];
  private readonly onRetryError: (attempt: number, error: unknown) => void;
  private readonly onFlushError: (error: unknown) => void;
  private readonly writer: LatestValueRunner<string>;

  private dirtyJson: string | null = null;
  private retryAttempt: number = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: StateStoreOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? STATE_FILE_PATH;
    this.readText = options.readText ?? readExistingText;
    this.writeText = options.writeText ?? atomicWriteText;
    this.retryDelaysMs = options.retryDelaysMs ?? STATE_SAVE_RETRY_DELAYS_MS;
    if (this.retryDelaysMs.length === 0) throw new Error("StateStore requires at least one retry delay");
    this.onRetryError = options.onRetryError ?? ((attempt, error) => {
      logger.error(`Failed to retry state persistence (attempt ${attempt}):`, error);
    });
    this.onFlushError = options.onFlushError ?? ((error) => {
      logger.error("Failed to flush state to disk on shutdown:", error);
    });
    this.writer = createLatestValueRunner<string>(async (json) => {
      await this.writeText(this.stateFilePath, json);
      if (this.dirtyJson === json) {
        this.dirtyJson = null;
        this.retryAttempt = 0;
      }
    });
  }

  async load(): Promise<StateFileSchema | null> {
    const content: string | null = await this.readText(this.stateFilePath);
    return content === null ? null : decodeStateFile(JSON.parse(content));
  }

  save(schema: StateFileSchema): Promise<void> {
    const json: string = JSON.stringify(schema, null, 2);
    this.dirtyJson = json;
    return this.writer.push(json).catch((error: unknown) => {
      this.scheduleRetry();
      throw error;
    });
  }

  private scheduleRetry(): void {
    if (this.dirtyJson === null || this.retryTimer !== null) return;
    const delay: number = this.retryDelaysMs[Math.min(this.retryAttempt, this.retryDelaysMs.length - 1)]!;
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const json: string | null = this.dirtyJson;
      if (json === null) return;
      void this.writer.push(json).catch((error: unknown) => {
        this.onRetryError(this.retryAttempt, error);
        this.scheduleRetry();
      });
    }, delay);
    this.retryTimer.unref();
  }

  flush(timeoutMs: number = STATE_FLUSH_TIMEOUT_MS): Promise<void> {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const json: string | null = this.dirtyJson;
    if (json === null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.writer
        .push(json)
        .catch((error: unknown) => this.onFlushError(error))
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  }

  /** 测试/显式 dispose 用；不隐式落盘，调用方应先 flush。 */
  dispose(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

const stateStore = new StateStore();
const chatStates: Map<number, ChatState> = new Map();
const globalCopyState: GlobalCopyState = { copiedUser: null };

export function getGlobalCopyState(): GlobalCopyState {
  return globalCopyState;
}

export function getActiveCopyIn(chatId: number): { copiedUser: CachedUser; copyMode: CopyMode | undefined } | null {
  if (globalCopyState.copiedUser === null || globalCopyState.copyChatId !== chatId) return null;
  return { copiedUser: globalCopyState.copiedUser, copyMode: globalCopyState.copyMode };
}

export function getAllChatStates(): ReadonlyMap<number, ChatState> {
  return chatStates;
}

export function getActiveProxySendTarget(): number | undefined {
  for (const [chatId, chatState] of chatStates) {
    if (chatState.isProxySendEnabled === true) return chatId;
  }
  return undefined;
}

function adoptCopyTarget(copiedUser: CachedUser, copyMode: CopyMode | undefined, copyChatId: number): void {
  globalCopyState.copiedUser = copiedUser;
  globalCopyState.copyMode = copyMode;
  globalCopyState.copyChatId = copyChatId;
}

export async function loadState(): Promise<void> {
  try {
    const decoded: StateFileSchema | null = await stateStore.load();
    if (decoded === null) return;
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
    throw error;
  }
}

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
  await stateStore.save({ chats, globalCopy: globalCopyState });
}

export function saveStateInBackground(context: string): void {
  void saveState().catch((error: unknown) => {
    logger.error(`Failed to persist background state update (${context}):`, error);
  });
}

export function flushStateToDisk(timeoutMs: number = STATE_FLUSH_TIMEOUT_MS): Promise<void> {
  return stateStore.flush(timeoutMs);
}

export function getChatState(chatId: number): ChatState {
  return chatStates.get(chatId) ?? DEFAULT_CHAT_STATE;
}

export function getOrCreateChatState(chatId: number): ChatState {
  let chatState = chatStates.get(chatId);
  if (!chatState) {
    chatState = {};
    chatStates.set(chatId, chatState);
  }
  return chatState;
}

export function clearChatStateField(chatId: number, field: keyof ChatState): boolean {
  const chatState: ChatState | undefined = chatStates.get(chatId);
  if (!chatState || !(field in chatState)) return false;
  delete chatState[field];
  normalizeChatStateEntry(chatStates, chatId);
  return true;
}

export function deleteChatState(chatId: number): void {
  if (chatStates.delete(chatId)) {
    saveStateInBackground(`chat ${chatId} state removed (bot left/kicked)`);
  }
}
