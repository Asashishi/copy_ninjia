import { STATE_FLUSH_TIMEOUT_MS, type FlushResult } from "../../consts/lifecycle";
import { CORRUPT_FILE_SUFFIX, STATE_BACKUP_FILE_PATH, STATE_FILE_PATH } from "../../consts/paths";
import { DEFAULT_CHAT_STATE, STATE_SAVE_MAX_ATTEMPTS, STATE_SAVE_RETRY_DELAYS_MS } from "../../consts/storage";
import { atomicWriteText, durableRename } from "../../libs/atomicFile";
import { normalizeChatState, normalizeChatStateEntry } from "../../libs/chatState";
import { createLatestValueRunner, type LatestValueRunner } from "../../libs/latestValueRunner";
import { decodeStateFile } from "../../libs/stateFileCodec";
import type { CachedUser, ChatState, CopyMode, GlobalCopyState, StateFileSchema } from "../../types/chatState";
import { logger } from "../logger";

export interface StateStoreOptions {
  stateFilePath?: string;
  backupFilePath?: string;
  readText?: (path: string) => Promise<string | null>;
  writeText?: (path: string, content: string) => Promise<void>;
  moveFile?: (sourcePath: string, destinationPath: string) => Promise<void>;
  retryDelaysMs?: readonly number[];
  maxAttempts?: number;
  onRetryError?: (attempt: number, error: unknown) => void;
  onFlushError?: (error: unknown) => void;
  onFatal?: (error: Error) => void;
}

export interface StateSaveOptions {
  /** false 用于 fire-and-forget 快照：仍会重试，但不为每次后台变化保留等待者。 */
  waitForPersistence?: boolean;
}

interface StateWrite {
  json: string;
  revision: number;
}

interface ValidStateCopy {
  kind: "valid";
  content: string;
  schema: StateFileSchema;
}

interface InvalidStateCopy {
  kind: "invalid";
  error: Error;
}

interface MissingStateCopy {
  kind: "missing";
}

type StateCopy = ValidStateCopy | InvalidStateCopy | MissingStateCopy;

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
  private readonly backupFilePath: string;
  private readonly readText: (path: string) => Promise<string | null>;
  private readonly writeText: (path: string, content: string) => Promise<void>;
  private readonly moveFile: (sourcePath: string, destinationPath: string) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];
  private readonly maxAttempts: number;
  private readonly onRetryError: (attempt: number, error: unknown) => void;
  private readonly onFlushError: (error: unknown) => void;
  private fatalHandler: ((error: Error) => void) | undefined;
  private readonly writer: LatestValueRunner<StateWrite>;

  private dirtyWrite: StateWrite | null = null;
  private nextRevision: number = 1;
  private retryAttempt: number = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private observedWriterPromise: Promise<void> | null = null;
  private readonly persistenceWaiters: PersistenceWaiter[] = [];
  private quiescing: boolean = false;
  private disposed: boolean = false;
  private fatalSignaled: boolean = false;

  constructor(options: StateStoreOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? STATE_FILE_PATH;
    this.backupFilePath = options.backupFilePath ??
      (options.stateFilePath === undefined ? STATE_BACKUP_FILE_PATH : `${this.stateFilePath}.bak`);
    this.readText = options.readText ?? readExistingText;
    this.writeText = options.writeText ?? atomicWriteText;
    this.moveFile = options.moveFile ?? durableRename;
    this.retryDelaysMs = options.retryDelaysMs ?? STATE_SAVE_RETRY_DELAYS_MS;
    if (this.retryDelaysMs.length === 0) throw new Error("StateStore requires at least one retry delay");
    if (this.retryDelaysMs.some((delay) => !Number.isFinite(delay) || delay <= 0)) {
      throw new RangeError("StateStore retry delays must be positive finite numbers");
    }
    this.maxAttempts = options.maxAttempts ?? STATE_SAVE_MAX_ATTEMPTS;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("StateStore maxAttempts must be a positive safe integer");
    }
    this.onRetryError = options.onRetryError ?? ((attempt, error) => {
      logger.error(`Failed to persist state (attempt ${attempt}):`, error);
    });
    this.onFlushError = options.onFlushError ?? ((error) => {
      logger.error("Failed to flush state to disk on shutdown:", error);
    });
    this.fatalHandler = options.onFatal;
    this.writer = createLatestValueRunner<StateWrite>(async (write) => {
      await this.writeText(this.stateFilePath, write.json);
      await this.writeText(this.backupFilePath, write.json);
      if (this.dirtyWrite !== null && this.dirtyWrite.revision <= write.revision) {
        this.dirtyWrite = null;
      }
      this.retryAttempt = 0;
      this.resolvePersistedWaiters(write.revision);
    });
  }

  async load(): Promise<StateFileSchema | null> {
    // 两份副本必须先全部读完、严格解码，再做任何隔离或修复。这样两份都
    // 不可用时能原样保留现场，绝不把可能含 lockdown 的状态静默变为空。
    const copies = await Promise.allSettled([
      this.readCopy(this.stateFilePath),
      this.readCopy(this.backupFilePath),
    ]);
    const readFailures: unknown[] = copies
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (readFailures.length > 0) {
      throw new AggregateError(readFailures, "Failed to read all persisted state copies.");
    }
    const primary: StateCopy = (copies[0] as PromiseFulfilledResult<StateCopy>).value;
    const backup: StateCopy = (copies[1] as PromiseFulfilledResult<StateCopy>).value;
    if (primary.kind === "missing" && backup.kind === "missing") return null;

    if (primary.kind === "valid") {
      if (backup.kind === "valid" && backup.content === primary.content) return primary.schema;
      if (backup.kind === "invalid") await this.quarantine(this.backupFilePath);
      await this.writeText(this.backupFilePath, primary.content);
      return primary.schema;
    }

    if (backup.kind === "valid") {
      if (primary.kind === "invalid") await this.quarantine(this.stateFilePath);
      await this.writeText(this.stateFilePath, backup.content);
      return backup.schema;
    }

    const errors: Error[] = [primary, backup]
      .filter((copy): copy is InvalidStateCopy => copy.kind === "invalid")
      .map((copy) => copy.error);
    throw new AggregateError(
      errors,
      `Neither ${this.stateFilePath} nor ${this.backupFilePath} contains a valid state; manual recovery is required.`
    );
  }

  private async readCopy(path: string): Promise<StateCopy> {
    const content: string | null = await this.readText(path);
    if (content === null) return { kind: "missing" };
    try {
      return { kind: "valid", content, schema: decodeStateFile(JSON.parse(content)) };
    } catch (error: unknown) {
      const reason: Error = error instanceof Error ? error : new Error(String(error));
      return {
        kind: "invalid",
        error: new Error(`Invalid persisted state copy ${path}: ${reason.message}`, { cause: reason }),
      };
    }
  }

  private async quarantine(path: string): Promise<void> {
    const corruptPath: string = `${path}.${Date.now()}.${crypto.randomUUID()}${CORRUPT_FILE_SUFFIX}`;
    await this.moveFile(path, corruptPath);
  }

  save(schema: StateFileSchema, options: StateSaveOptions = {}): Promise<void> {
    if (this.quiescing || this.disposed) {
      return Promise.reject(new Error("StateStore is quiescing and no longer accepts writes."));
    }
    let json: string;
    try {
      json = JSON.stringify(schema, null, 2);
      // TypeScript 类型不能约束运行时对共享 ChatState 的修改；两份磁盘副本
      // 只能接收可被启动期同一严格 codec 再次加载的快照。
      decodeStateFile(JSON.parse(json));
    } catch (error: unknown) {
      const reason: Error = error instanceof Error ? error : new Error(String(error));
      return Promise.reject(reason);
    }
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
    const failedAttempt: number = ++this.retryAttempt;
    this.onRetryError(failedAttempt, error);
    if (failedAttempt >= this.maxAttempts) {
      const reason: Error = error instanceof Error ? error : new Error(String(error));
      const fatal = new Error(
        `State persistence failed after ${failedAttempt} attempt(s); refusing further updates.`,
        { cause: reason }
      );
      this.quiescing = true;
      this.rejectPersistenceWaiters(fatal);
      if (!this.fatalSignaled) {
        this.fatalSignaled = true;
        this.fatalHandler?.(fatal);
      }
      return;
    }
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
    const delay: number = this.retryDelaysMs[Math.min(this.retryAttempt - 1, this.retryDelaysMs.length - 1)]!;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const write: StateWrite | null = this.dirtyWrite;
      if (write === null || this.quiescing || this.disposed) return;
      void this.push(write);
    }, delay);
    this.retryTimer.unref();
  }

  flush(timeoutMs: number = STATE_FLUSH_TIMEOUT_MS, quiesce: boolean = false): Promise<FlushResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("StateStore flush timeout must be a positive finite number.");
    }
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

  setFatalHandler(handler: ((error: Error) => void) | undefined): void {
    this.fatalHandler = handler;
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

/**
 * 权威业务状态的统一 durability barrier。快照在调用同步栈内完成序列化，
 * 返回的 Promise 只会在对应 revision（或更新 revision）主、备两份都落盘后完成。
 */
export async function persistAuthoritativeState(context: string): Promise<void> {
  try {
    await stateStore.save(currentStateSnapshot());
  } catch (error: unknown) {
    const reason: Error = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Failed to persist authoritative state update (${context}): ${reason.message}`, { cause: error });
  }
}

export function setStatePersistenceFatalHandler(handler: ((error: Error) => void) | undefined): void {
  stateStore.setFatalHandler(handler);
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

/**
 * 机器人离群时删除普通配置，但保留尚需恢复的 lockdown write-ahead 记录。
 * 无记录时不做任何事；调用方负责在同一 teardown 尾部统一落盘。
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
