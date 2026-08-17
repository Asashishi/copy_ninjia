import type { BunFile } from "bun";
import { STATE_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import { STATE_BACKUP_FILE_PATH, STATE_FILE_PATH } from "../../consts/paths";
import { STATE_SAVE_MAX_ATTEMPTS, STATE_SAVE_RETRY_DELAYS_MS } from "../../consts/storage";
import { atomicWriteText } from "../../libs/atomicFile";
import { InputValidationError, parseJsonInput } from "../../libs/inputValidation";
import { createLatestValueRunner, type LatestValueRunner } from "../../libs/latestValueRunner";
import { decodeStateFile } from "../../libs/stateFileCodec";
import type { FlushResult } from "../../types/lifecycle";
import type { StateFileSchema } from "../../types/chatState";
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
  const file: BunFile = Bun.file(path);
  return await file.exists() ? file.text() : null;
}

/**
 * 把解码失败翻译成运维能直接照着改的一句话。
 *
 * 统一换成 `$ must match the current state schema.` 等于把解码器已经算出来的
 * 字段路径与期望形态全丢掉：运维手改坏一个字段后，只能得到「整份文件不符合
 * schema」，而这份文件正是他唯一能手工编辑的旋钮。AGENTS.md 要求错误必须写明
 * 文件路径、字段路径和期望形态——三者都在原异常里，缺的只有文件路径前缀。
 *
 * 两类异常的形状不同：`parseJsonInput` 抛的 InputValidationError 自带来源路径，
 * 原样保留；`decodeStateFile` 抛的只有「字段路径 + 期望形态」，补上文件名。
 * 两者按构造都不携带实际值，不会把状态内容泄进日志。
 */
function describeStateDecodeFailure(path: string, error: unknown): Error {
  if (error instanceof InputValidationError) return error;
  if (error instanceof Error && error.message.length > 0) {
    return new Error(`${path}: ${error.message}.`);
  }
  return new Error(`${path}: $ must match the current state schema.`);
}

/**
 * state.json 的可注入持久化边界：只负责 global schema 解码/序列化、latest-only
 * 串行写、失败退避和退出 flush；群状态由 SQLite 独立持久化。
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

  async load(): Promise<StateFileSchema | null> {
    // 两份副本必须先全部读完、严格解码，再做任何隔离或修复。这样两份都
    // 不可用时能原样保留现场，绝不把可能含 lockdown 的状态静默变为空。
    const copies: [PromiseSettledResult<StateCopy>, PromiseSettledResult<StateCopy>] = await Promise.allSettled([
      this.readCopy(this.stateFilePath),
      this.readCopy(this.backupFilePath),
    ]);
    const readFailures: unknown[] = copies
      .filter((result: PromiseSettledResult<StateCopy>): result is PromiseRejectedResult => result.status === "rejected")
      .map((result: PromiseRejectedResult): unknown => result.reason as unknown);
    if (readFailures.length > 0) {
      throw new AggregateError(readFailures, "Failed to read all persisted state copies.");
    }
    const primary: StateCopy = (copies[0] as PromiseFulfilledResult<StateCopy>).value;
    const backup: StateCopy = (copies[1] as PromiseFulfilledResult<StateCopy>).value;
    // 主文件在但解不开 = 拒绝启动，**不管 LKG 有多健康**。落盘走临时文件 + 原子
    // rename，不会留下半份文件，所以这里只剩两种来源：手工改错，或介质损坏。
    // 拿备份顶上去就是把运维刚编辑过的文件改名成 .corrupt、用上一次落盘的陈旧
    // 内容盖回去，然后一切正常启动——改动消失、零日志、零诊断，而这个文件正是
    // 运维唯一能手工编辑的旋钮（素材直链）。不隔离、不改写，原样保留现场，
    // error 里已点名文件路径与字段路径（见 AGENTS.md「不为用户行为兜底」）。
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

    // 主文件缺失（被删或还没写出来）时才允许用 LKG 重建：那不是「改错了」，
    // 而是这份冗余副本存在的全部理由。
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
