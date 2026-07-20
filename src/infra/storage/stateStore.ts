import { STATE_FLUSH_TIMEOUT_MS, type FlushResult } from "../../consts/lifecycle";
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

export interface StateSaveOptions {
  /** false 用于 fire-and-forget 快照：仍会重试，但不为每次后台变化保留等待者。 */
  waitForPersistence?: boolean;
}

interface StateWrite {
  json: string;
  revision: number;
}

interface PersistenceWaiter {
  revision: number;
  resolve: () => void;
  reject: (error: Error) => void;
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
  private readonly writer: LatestValueRunner<StateWrite>;

  private dirtyWrite: StateWrite | null = null;
  private nextRevision: number = 1;
  private retryAttempt: number = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private observedWriterPromise: Promise<void> | null = null;
  private readonly persistenceWaiters: PersistenceWaiter[] = [];
  private quiescing: boolean = false;
  private disposed: boolean = false;

  constructor(options: StateStoreOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? STATE_FILE_PATH;
    this.readText = options.readText ?? readExistingText;
    this.writeText = options.writeText ?? atomicWriteText;
    this.retryDelaysMs = options.retryDelaysMs ?? STATE_SAVE_RETRY_DELAYS_MS;
    if (this.retryDelaysMs.length === 0) throw new Error("StateStore requires at least one retry delay");
    this.onRetryError = options.onRetryError ?? ((attempt, error) => {
      logger.error(`Failed to persist state (attempt ${attempt}):`, error);
    });
    this.onFlushError = options.onFlushError ?? ((error) => {
      logger.error("Failed to flush state to disk on shutdown:", error);
    });
    this.writer = createLatestValueRunner<StateWrite>(async (write) => {
      await this.writeText(this.stateFilePath, write.json);
      if (this.dirtyWrite !== null && this.dirtyWrite.revision <= write.revision) {
        this.dirtyWrite = null;
      }
      this.retryAttempt = 0;
      this.resolvePersistedWaiters(write.revision);
    });
  }

  async load(): Promise<StateFileSchema | null> {
    const content: string | null = await this.readText(this.stateFilePath);
    return content === null ? null : decodeStateFile(JSON.parse(content));
  }

  save(schema: StateFileSchema, options: StateSaveOptions = {}): Promise<void> {
    if (this.quiescing || this.disposed) {
      return Promise.reject(new Error("StateStore is quiescing and no longer accepts writes."));
    }
    const json: string = JSON.stringify(schema, null, 2);
    const write: StateWrite = { json, revision: this.nextRevision++ };
    this.dirtyWrite = write;
    const persisted: Promise<void> = options.waitForPersistence === false
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
        this.persistenceWaiters.push({ revision: write.revision, resolve, reject });
      });
    void this.push(write);
    return persisted;
  }

  private push(write: StateWrite): Promise<void> {
    const run: Promise<void> = this.writer.push(write);
    if (this.observedWriterPromise !== run) {
      this.observedWriterPromise = run;
      void run.then(
        () => {
          if (this.observedWriterPromise === run) this.observedWriterPromise = null;
        },
        (error: unknown) => {
          if (this.observedWriterPromise === run) this.observedWriterPromise = null;
          this.handleWriteFailure(error);
        }
      );
    }
    return run;
  }

  private handleWriteFailure(error: unknown): void {
    if (this.quiescing || this.disposed) {
      this.rejectPersistenceWaiters(error);
      return;
    }
    this.onRetryError(this.retryAttempt + 1, error);
    this.scheduleRetry();
  }

  private resolvePersistedWaiters(revision: number): void {
    for (let index = this.persistenceWaiters.length - 1; index >= 0; index--) {
      const waiter: PersistenceWaiter = this.persistenceWaiters[index]!;
      if (waiter.revision > revision) continue;
      this.persistenceWaiters.splice(index, 1);
      waiter.resolve();
    }
  }

  private rejectPersistenceWaiters(error: unknown): void {
    const reason: Error = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.persistenceWaiters.splice(0)) waiter.reject(reason);
  }

  private scheduleRetry(): void {
    if (this.quiescing || this.disposed || this.dirtyWrite === null || this.retryTimer !== null) return;
    const delay: number = this.retryDelaysMs[Math.min(this.retryAttempt, this.retryDelaysMs.length - 1)]!;
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const write: StateWrite | null = this.dirtyWrite;
      if (write === null || this.quiescing || this.disposed) return;
      void this.push(write);
    }, delay);
    this.retryTimer.unref();
  }

  flush(timeoutMs: number = STATE_FLUSH_TIMEOUT_MS, quiesce: boolean = false): Promise<FlushResult> {
    if (quiesce) this.quiescing = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const write: StateWrite | null = this.dirtyWrite;
    const run: Promise<void> | null = write === null
      ? this.observedWriterPromise
      : this.push(write);
    if (run === null) return Promise.resolve("flushed");
    return new Promise((resolve) => {
      let settled: boolean = false;
      const settle = (result: FlushResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const timer = setTimeout(() => settle("timedOut"), timeoutMs);
      run
        .then(() => settle("flushed"))
        .catch((error: unknown) => {
          this.onFlushError(error);
          settle("failed");
        })
        .finally(() => {
          clearTimeout(timer);
        });
    });
  }

  /** 测试/显式 dispose 用；不隐式落盘，调用方应先 flush。 */
  dispose(): void {
    this.quiescing = true;
    this.disposed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.rejectPersistenceWaiters(new Error("StateStore was disposed before persistence completed."));
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

function currentStateSnapshot(): StateFileSchema {
  const chats: Record<string, ChatState> = {};
  for (const [chatId, chatState] of chatStates) {
    normalizeChatState(chatState);
    if (Object.keys(chatState).length === 0) {
      chatStates.delete(chatId);
      continue;
    }
    chats[String(chatId)] = chatState;
  }
  return { chats, globalCopy: globalCopyState };
}

export function saveState(): Promise<void> {
  return stateStore.save(currentStateSnapshot());
}

export function saveStateInBackground(context: string): void {
  void stateStore.save(currentStateSnapshot(), { waitForPersistence: false }).catch((error: unknown) => {
    logger.error(`Failed to persist background state update (${context}):`, error);
  });
}

export function flushStateToDisk(
  timeoutMs: number = STATE_FLUSH_TIMEOUT_MS,
  quiesce: boolean = false
): Promise<FlushResult> {
  return stateStore.flush(timeoutMs, quiesce);
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

/**
 * 机器人离群时删除普通配置，但保留尚需恢复的 lockdown write-ahead 记录。
 * 无记录时等价于 deleteChatState；调用方负责在同一 teardown 尾部统一落盘。
 */
export function pruneDepartedChatState(chatId: number): void {
  const current: ChatState | undefined = chatStates.get(chatId);
  if (!current) return;
  if (current.lockdown === undefined) {
    chatStates.delete(chatId);
    return;
  }
  chatStates.set(chatId, { lockdown: current.lockdown });
}
