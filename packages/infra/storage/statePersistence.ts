import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Stats } from "node:fs";
import { STATE_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import { GLOBAL_STATE_FILE_PATH, LEGACY_STATE_FILE_PATHS } from "../../consts/paths";
import { RUNTIME_DATA_ROOT_MAX_MODE, STATE_SAVE_MAX_ATTEMPTS, STATE_SAVE_RETRY_DELAYS_MS } from "../../consts/storage";
import { atomicWriteText } from "../../libs/atomicFile";
import { isErrno } from "../../libs/errno";
import {
  InputValidationError,
  invalidInput,
  parseJsonInput,
  readUtf8TextInput,
} from "../../libs/inputValidation";
import { createLatestValueRunner } from "../../libs/latestValueRunner";
import type { LatestValueRunner } from "../../libs/latestValueRunner";
import { decodeGlobalStateFile } from "../../libs/stateFileCodec";
import type { FlushResult } from "../../types/lifecycle";
import type { DecodedGlobalState, GlobalState } from "../../types/chatState";
import { logger } from "../logger";
import { toError } from "../../libs/errorMessage";

export interface StateStoreOptions {
  stateFilePath?: string;
  readText?: (path: string) => Promise<string | null>;
  writeText?: (path: string, content: string) => Promise<void>;
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

interface PersistenceWaiter {
  revision: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * 叶子路径本身是否真的不存在。`BunFile.stat()` 跟随软链接，悬空链接和缺失文件
 * 同样报 ENOENT；只有 `lstat` 也报 ENOENT 才算「从没写过状态文件」。
 */
async function isMissingLeaf(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error: unknown) {
    return isErrno(error, "ENOENT");
  }
}

/**
 * 状态文件的默认读取边界：目标必须是普通文件，内容必须是严格 UTF-8。
 *
 * 用 `BunFile.stat()` 而不是 `exists()`：后者对目录返回 false，会把「路径被占成
 * 目录」误判成缺省。目录、指向目录的链接、其它非普通文件、悬空链接以及
 * EACCES/ELOOP/ENOTDIR 等访问失败一律是已配置但非法，按 AGENTS.md 的
 * 「不为用户行为兜底」拒绝启动；stat 成功之后的读取或解码失败也不降级为缺失。
 * 指向普通文件的软链接继续接受。
 *
 * 错误统一收敛为 InputValidationError，只带文件路径、字段路径和期望形态，不回显
 * 底层异常与状态内容（见 docs/cn/04-invariants.md 的严格解析约束）。
 * @returns 文件文本；叶子路径真正缺失时为 null。
 */
async function readExistingText(path: string): Promise<string | null> {
  let stats: Stats;
  try {
    stats = await Bun.file(path).stat();
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT") && await isMissingLeaf(path)) return null;
    return invalidInput(path, "$", "an accessible regular file");
  }
  if (!stats.isFile()) return invalidInput(path, "$", "a regular file");
  try {
    return await readUtf8TextInput(path);
  } catch {
    return invalidInput(path, "$", "a regular file readable as strictly valid UTF-8 text");
  }
}

/**
 * 14.x 数据根下的 state.json 与备份副本任一存在即拒绝：当前格式不读取它们，继续运行会让
 * 复读状态与语音计数静默归零。只有叶子路径真正不存在才放行；启动恢复（stateStore.ts 的
 * loadState）与安装器共用。
 */
export async function assertLegacyStateFilesAbsent(): Promise<void> {
  for (const path of LEGACY_STATE_FILE_PATHS) {
    if (!await isMissingLeaf(path)) {
      invalidInput(path, "$", "absent; migrate it with migrate:global-state and move it out of the data root");
    }
  }
}

/** 默认写入边界：状态目录缺失时先按数据根权限上限建出，再原子写入。 */
async function writeStateText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: RUNTIME_DATA_ROOT_MAX_MODE });
  await atomicWriteText(path, content);
}

/**
 * 保留解析错误的文件路径、字段路径和期望形态；为解码错误补齐文件路径。
 * 两类错误均不携带状态值，见 docs/cn/04-invariants.md 的严格解析约束。
 */
function describeStateDecodeFailure(path: string, error: unknown): Error {
  if (error instanceof InputValidationError) return error;
  if (error instanceof Error && error.message.length > 0) {
    return new Error(`${path}: ${error.message}.`);
  }
  return new Error(`${path}: $ must match the current state schema.`);
}

/**
 * memory/global/state.json 的可注入持久化边界：负责全局状态 schema 解码/序列化、
 * latest-only 串行原子写、失败退避和退出 flush；按群的状态由 SQLite 独立持久化。
 * 状态目录由主线程独占，Disk I/O Worker 不访问（见 docs/cn/04-invariants.md）。
 */
export class StateStore {
  private readonly stateFilePath: string;
  private readonly readText: (path: string) => Promise<string | null>;
  private readonly writeText: (path: string, content: string) => Promise<void>;
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

  constructor({
    stateFilePath = GLOBAL_STATE_FILE_PATH,
    readText = readExistingText,
    writeText = writeStateText,
    retryDelaysMs = STATE_SAVE_RETRY_DELAYS_MS,
    maxAttempts = STATE_SAVE_MAX_ATTEMPTS,
    onRetryError = (attempt: number, error: unknown): void => {
      logger.error(`Failed to persist state (attempt ${attempt}):`, error);
    },
    onFlushError = (error: unknown): void => {
      logger.error("Failed to flush state to disk on shutdown:", error);
    },
    onFatal,
  }: StateStoreOptions = {}) {
    this.stateFilePath = stateFilePath;
    this.readText = readText;
    this.writeText = writeText;
    this.retryDelaysMs = retryDelaysMs;
    if (this.retryDelaysMs.length === 0) throw new Error("StateStore requires at least one retry delay");
    if (this.retryDelaysMs.some((delay: number): boolean => !Number.isFinite(delay) || delay <= 0)) {
      throw new RangeError("StateStore retry delays must be positive finite numbers");
    }
    this.maxAttempts = maxAttempts;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("StateStore maxAttempts must be a positive safe integer");
    }
    this.onRetryError = onRetryError;
    this.onFlushError = onFlushError;
    this.fatalHandler = onFatal;
    this.writer = createLatestValueRunner<StateWrite>(async (write: StateWrite): Promise<void> => {
      await this.writeText(this.stateFilePath, write.json);
      if (this.dirtyWrite !== null && this.dirtyWrite.revision <= write.revision) {
        this.dirtyWrite = null;
      }
      this.retryAttempt = 0;
      this.resolvePersistedWaiters(write.revision);
    });
  }

  /**
   * 读取并严格解码状态文件。文件真正不存在时返回 null（从未写过）；存在但不可读、
   * 不是普通文件或解码失败时原样保留并抛出，见 docs/cn/04-invariants.md。
   */
  async load(): Promise<DecodedGlobalState | null> {
    const content: string | null = await this.readText(this.stateFilePath);
    if (content === null) return null;
    try {
      return decodeGlobalStateFile(parseJsonInput(content, this.stateFilePath), this.stateFilePath);
    } catch (error: unknown) {
      throw describeStateDecodeFailure(this.stateFilePath, error);
    }
  }

  save(schema: GlobalState, options: StateSaveOptions = {}): Promise<void> {
    if (this.quiescing || this.disposed) {
      return Promise.reject(new Error("StateStore is quiescing and no longer accepts writes."));
    }
    let json: string;
    try {
      json = JSON.stringify(schema, null, 2);
      // 写出前用启动期同一严格 codec 再解码一次，磁盘只接收可被再次加载的值。
      decodeGlobalStateFile(JSON.parse(json), this.stateFilePath);
    } catch (error: unknown) {
      const reason: Error = toError(error);
      return Promise.reject(reason);
    }
    const write: StateWrite = { json, revision: this.nextRevision++ };
    this.dirtyWrite = write;
    const persisted: Promise<void> = options.waitForPersistence === false
      ? Promise.resolve()
      : new Promise((resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: unknown) => void): void => {
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
        (): void => {
          if (this.observedWriterPromise === run) this.observedWriterPromise = null;
        },
        (error: unknown): void => {
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
      const reason: Error = toError(error);
      const fatal: Error = new Error(
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
    let settledCount: number = 0;
    while (
      settledCount < this.persistenceWaiters.length &&
      this.persistenceWaiters[settledCount]!.revision <= revision
    ) settledCount++;
    // 已落盘前缀按倒序 resolve，之后一次性移除。
    for (let index: number = settledCount - 1; index >= 0; index--) {
      this.persistenceWaiters[index]!.resolve();
    }
    if (settledCount > 0) this.persistenceWaiters.splice(0, settledCount);
  }

  private rejectPersistenceWaiters(error: unknown): void {
    const reason: Error = toError(error);
    for (const waiter of this.persistenceWaiters.splice(0)) waiter.reject(reason);
  }

  private scheduleRetry(): void {
    if (this.quiescing || this.disposed || this.dirtyWrite === null || this.retryTimer !== null) return;
    const delay: number = this.retryDelaysMs[Math.min(this.retryAttempt - 1, this.retryDelaysMs.length - 1)]!;
    this.retryTimer = setTimeout((): void => {
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
    return new Promise((resolve: (value: FlushResult | PromiseLike<FlushResult>) => void): void => {
      let settled: boolean = false;
      const settle = (result: FlushResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const timer: ReturnType<typeof setTimeout> = setTimeout((): void => settle("timedOut"), timeoutMs);
      run
        .then((): void => settle("flushed"))
        .catch((error: unknown): void => {
          this.onFlushError(error);
          settle("failed");
        })
        .finally((): void => {
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
