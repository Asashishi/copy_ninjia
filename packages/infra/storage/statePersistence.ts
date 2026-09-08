import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { STATE_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import { STATE_BACKUP_FILE_PATH, STATE_FILE_PATH } from "../../consts/paths";
import { STATE_SAVE_MAX_ATTEMPTS, STATE_SAVE_RETRY_DELAYS_MS } from "../../consts/storage";
import { atomicWriteText } from "../../libs/atomicFile";
import { isErrno } from "../../libs/errno";
import {
  InputValidationError,
  invalidInput,
  parseJsonInput,
  readUtf8TextInput,
} from "../../libs/inputValidation";
import { createLatestValueRunner, type LatestValueRunner } from "../../libs/latestValueRunner";
import { decodeStateFile } from "../../libs/stateFileCodec";
import type { FlushResult } from "../../types/lifecycle";
import type { DecodedStateFile, StateFileSchema } from "../../types/chatState";
import { logger } from "../logger";

export interface StateStoreOptions {
  stateFilePath?: string;
  backupFilePath?: string;
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

interface ValidStateCopy {
  kind: "valid";
  content: string;
  schema: DecodedStateFile;
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

/**
 * 叶子路径本身是否真的不存在。`BunFile.stat()` 跟随软链接，悬空链接和缺失文件
 * 同样报 ENOENT；只有 `lstat` 也报 ENOENT 才算「从没写过这份副本」。
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
 * 状态副本的默认读取边界：目标必须是普通文件，内容必须是严格 UTF-8。
 *
 * 用 `BunFile.stat()` 而不是 `exists()`：后者对目录返回 false，会把「路径被占成
 * 目录」误判成缺省。目录、指向目录的链接、其它非普通文件、悬空链接以及
 * EACCES/ELOOP/ENOTDIR 等访问失败一律是已配置但非法，按 AGENTS.md 的
 * 「不为用户行为兜底」拒绝启动；stat 成功之后的读取或解码失败也不降级为缺失。
 * 指向普通文件的软链接继续接受。
 *
 * 错误统一收敛为 InputValidationError，只带文件路径、字段路径和期望形态，不回显
 * 底层异常与状态内容（见 docs/cn/04-invariants.md 的严格解析约束）。
 * @returns 副本文本；叶子路径真正缺失时为 null。
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
 * state.json 的可注入持久化边界：负责 global/translate schema 解码/序列化、latest-only
 * 串行写、失败退避和退出 flush；群功能开关由 SQLite 独立持久化。
 */
export class StateStore {
  private readonly stateFilePath: string;
  private readonly backupFilePath: string;
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
    stateFilePath = STATE_FILE_PATH,
    backupFilePath,
    readText = readExistingText,
    writeText = atomicWriteText,
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
    this.backupFilePath = backupFilePath ??
      (stateFilePath === STATE_FILE_PATH ? STATE_BACKUP_FILE_PATH : `${stateFilePath}.bak`);
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
      await this.writeText(this.backupFilePath, write.json);
      if (this.dirtyWrite !== null && this.dirtyWrite.revision <= write.revision) {
        this.dirtyWrite = null;
      }
      this.retryAttempt = 0;
      this.resolvePersistedWaiters(write.revision);
    });
  }

  async load(): Promise<DecodedStateFile | null> {
    // 两份副本全部读完并严格解码后，才允许补齐缺失副本或同步合法副本。
    const copies: [PromiseSettledResult<StateCopy>, PromiseSettledResult<StateCopy>] = await Promise.allSettled([
      this.readCopy(this.stateFilePath),
      this.readCopy(this.backupFilePath),
    ]);
    const readFailures: unknown[] = copies
      .filter((result: PromiseSettledResult<StateCopy>): result is PromiseRejectedResult => result.status === "rejected")
      .map((result: PromiseRejectedResult): unknown => result.reason as unknown);
    if (readFailures.length > 0) {
      // 聚合消息点名两条副本路径；每条成员错误再各自带上失败的那一份。
      throw new AggregateError(
        readFailures,
        `Failed to read ${this.stateFilePath} or ${this.backupFilePath}.`
      );
    }
    const primary: StateCopy = (copies[0] as PromiseFulfilledResult<StateCopy>).value;
    const backup: StateCopy = (copies[1] as PromiseFulfilledResult<StateCopy>).value;
    // 存在但非法的主文件必须原样保留并拒绝启动，见 docs/cn/04-invariants.md。
    if (primary.kind === "invalid") throw primary.error;
    if (primary.kind === "missing" && backup.kind === "missing") return null;

    if (primary.kind === "valid") {
      if (backup.kind === "valid" && backup.content === primary.content) return primary.schema;
      if (backup.kind === "invalid") {
        // 备份也是当前持久化状态的一部分；存在但非法时不猜测是否可以
        // 用主副本覆盖，保留两份原字节并拒绝启动。
        throw backup.error;
      }
      await this.writeText(this.backupFilePath, primary.content);
      return primary.schema;
    }

    // 仅在主文件真正缺失且备份合法时重建主文件。
    if (backup.kind === "valid") {
      logger.log(`Restoring ${this.stateFilePath} from the last known good copy ${this.backupFilePath}.`);
      await this.writeText(this.stateFilePath, backup.content);
      return backup.schema;
    }

    const errors: Error[] = [primary, backup]
      .filter((copy: InvalidStateCopy | MissingStateCopy): copy is InvalidStateCopy => copy.kind === "invalid")
      .map((copy: InvalidStateCopy): Error => copy.error);
    throw new AggregateError(
      errors,
      `Neither ${this.stateFilePath} nor ${this.backupFilePath} contains a valid state; manual recovery is required.`
    );
  }

  private async readCopy(path: string): Promise<StateCopy> {
    const content: string | null = await this.readText(path);
    if (content === null) return { kind: "missing" };
    try {
      return { kind: "valid", content, schema: decodeStateFile(parseJsonInput(content, path)) };
    } catch (error: unknown) {
      return { kind: "invalid", error: describeStateDecodeFailure(path, error) };
    }
  }

  save(schema: StateFileSchema, options: StateSaveOptions = {}): Promise<void> {
    if (this.quiescing || this.disposed) {
      return Promise.reject(new Error("StateStore is quiescing and no longer accepts writes."));
    }
    let json: string;
    try {
      json = JSON.stringify(schema, null, 2);
      // TypeScript 类型不能约束运行时对共享 global 对象的修改；两份磁盘副本
      // 只能接收可被启动期同一严格 codec 再次加载的值。
      decodeStateFile(JSON.parse(json));
    } catch (error: unknown) {
      const reason: Error = error instanceof Error ? error : new Error(String(error));
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
      const reason: Error = error instanceof Error ? error : new Error(String(error));
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
    // 保留既有的倒序 resolve 次序，只把每条一次 splice 改为最后一次性移除前缀。
    for (let index: number = settledCount - 1; index >= 0; index--) {
      this.persistenceWaiters[index]!.resolve();
    }
    if (settledCount > 0) this.persistenceWaiters.splice(0, settledCount);
  }

  private rejectPersistenceWaiters(error: unknown): void {
    const reason: Error = error instanceof Error ? error : new Error(String(error));
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
