/**
 * 进程唯一的磁盘 IO 线程宿主（主线程侧）：统一承载日志、AI/贴纸快照、
 * 每日运势与待验证当日增量 JSON——由 diskIOWorker 在单一 Worker 线程里
 * 串行执行，避免多个落盘线程并发写坏文件（见 infra/logger.ts 模块头注
 * 「唯一落盘线程」的定位）。
 *
 * Worker 拥有权、崩溃自愈的重启节流、flush/load 握手全部收在这里；
 * infra/logger.ts 只是调用方之一（error 日志经 relayLogMessage 投递）。
 * aiChat.ts、commands/luckChallenge.ts 与 antiRaid.ts 经 postDiskIO 投递。
 *
 * 本模块自身的错误一律 console.error（journal 兜底）——它就是落盘终点，
 * 不能再指望被自己转发的日志线程落盘自己的错误，否则是一场递归。这也是
 * 本模块不复用 libs/supervisedWorker.ts 通用骨架（其 onerror 走 logger.error）
 * 的原因，需要一份独立的、只用 console 的自愈逻辑，与 logger.ts 原有的
 * createDiskWorker 一脉相承。
 */

import { pendingFlushes, pendingLoad, pendingLuckSecrets } from "../cache/diskIO";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from "../consts/workerSupervisor";
import { createRestartThrottle } from "../libs/workerSupervisor";
import { LOAD_TIMEOUT_MS } from "../consts/diskIO/common";
import type {
  AiMemoryDiskMessage,
  AiMemoryDeleteDiskMessage,
  DiskFlushRequest,
  DiskIOReply,
  EnsureLuckSecretRequest,
  LoadRequest,
  LoadedReply,
  LogEnvelope,
  LogMessage,
  LuckDayCache,
  LuckDrawDiskMessage,
  LuckReceiptSecret,
  StickerCatalogDiskMessage,
  VerificationDeleteDiskMessage,
  VerificationPersistedReply,
  VerificationSnapshot,
  VerificationUpsertDiskMessage,
} from "../types";

const isMainThread: boolean = Bun.isMainThread;

// 落盘 Worker 崩溃自愈的节流，避免陷入无限重启烧 CPU；耗尽后只保留控制台
// 输出（所有持久化领域都停，功能本身不受影响，只是不再落盘）。
const restartThrottle = createRestartThrottle(WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS);

// 落盘 Worker 只能由入口在取得 bot.lock 后显式初始化。模块导入本身不得
// 创建线程：否则竞争单实例锁失败的第二进程仍会执行 diskIOWorker 顶层的
// initLogFiles()，提前创建/清扫共享 logs/ 目录。Worker 线程里永远不初始化
// 本宿主，只使用 logger.ts 的转发模式。
let diskIOWorker: Worker | null = null;
let diskIOInitialized: boolean = false;

/**
 * 在主线程显式启动唯一的落盘 Worker。调用方必须已经取得数据目录的
 * bot.lock；重复调用幂等，不能借重复初始化绕过崩溃自愈的放弃阈值。
 */
export function initDiskIO(): void {
  if (!isMainThread) {
    throw new Error("Disk I/O can only be initialized by the main thread.");
  }
  if (diskIOInitialized) return;
  diskIOWorker = createDiskIOWorker();
  diskIOInitialized = true;
}

/** 供入口生命周期守卫和无副作用 import 测试查询，不代表 Worker 当前可用。 */
export function isDiskIOInitialized(): boolean {
  return diskIOInitialized;
}

function createDiskIOWorker(): Worker {
  const w: Worker = new Worker(new URL("../workers/diskIOWorker.ts", import.meta.url).href);
  w.unref();
  w.onmessage = (event: MessageEvent<DiskIOReply>) => {
    if (diskIOWorker !== w) return;
    const data: DiskIOReply = event.data;
    if (data.type === "verificationPersisted") {
      for (const listener of verificationPersistedListeners) listener(data);
      return;
    }
    if (data.type === "flushed") {
      const resolve = pendingFlushes.get(data.flushedId);
      if (resolve) {
        pendingFlushes.delete(data.flushedId);
        resolve();
      }
      return;
    }
    if (data.type === "luckSecret") {
      const pending = pendingLuckSecrets.get(data.requestId);
      if (!pending) return;
      pendingLuckSecrets.delete(data.requestId);
      clearTimeout(pending.timer);
      if (data.error !== undefined || data.secret === undefined) {
        pending.reject(new Error(data.error ?? "Disk I/O Worker returned no luck receipt secret."));
      } else {
        pending.resolve(data.secret);
      }
      return;
    }
    // data.type === "loaded"：崩溃重建后自动重跑的那次 load（见下方 onerror）
    // 没有人专门等待这次回执——Worker 侧缓存的热身在它自己内部已经完成，
    // 主线程这边只在存在挂起的 loadPersistedData() 调用时才需要消费。
    const resolve = pendingLoad.resolve;
    if (resolve) {
      pendingLoad.resolve = null;
      resolve(data);
    }
  };
  w.onerror = (event: ErrorEvent) => {
    // 已替换旧实例的迟到/重复错误不能再启动第二条并行重建链。
    if (diskIOWorker !== w) return;
    // 落盘线程自己出错时不能再指望它把这条日志落盘，直接走控制台，避免
    // 自己给自己转发出一场递归。Bun 里 Worker 内部一旦抛出未捕获异常
    // （同步或 async 均如此，已实测验证）就会直接终止该 Worker 线程，这里
    // 不需要（实际上也没法）再手动 terminate，直接换一个新实例顶上即可。
    console.error("[diskIO] persistence Worker errored:", event.message || event.error || event);
    if (pendingFlushes.size > 0) {
      // 崩溃这一刻若正好卡着 flushDiskIO 的等待：旧实例内存里的 dirty 数据
      // （上次成功落盘之后攒下的增量）随线程一起没了，新实例读不到、也补不
      // 回来——不能让 flushDiskIO 的调用方（进程退出前的最后一刷）误以为
      // 超时=已落盘。这里立即结算这些 flush（而不是干等 timeoutMs 到期），
      // 并把"这次 flush 实际落空"打进日志，与上面的崩溃日志对齐时间点。
      console.error(
        `[diskIO] ${pendingFlushes.size} pending flush(es) lost — persistence Worker crashed mid-flush, their buffered data was not written to disk.`
      );
      for (const resolve of pendingFlushes.values()) resolve();
      pendingFlushes.clear();
    }
    if (pendingLuckSecrets.size > 0) {
      const error = new Error("Persistence Worker crashed while loading the daily luck receipt secret.");
      for (const pending of pendingLuckSecrets.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      pendingLuckSecrets.clear();
    }
    if (restartThrottle.shouldGiveUp()) {
      console.error(
        `[diskIO] persistence Worker restarted ${WORKER_MAX_RESTARTS} times within ` +
        `${WORKER_RESTART_WINDOW_MS / 1000}s, giving up self-healing — logs, snapshots, luck draws and pending verifications ` +
        `will only stay in memory (no disk persistence) until the process restarts.`
      );
      diskIOWorker = null;
      return;
    }
    const next: Worker = createDiskIOWorker();
    diskIOWorker = next;
    // 崩溃重建后的第一层恢复：新实例缓存全空，先自己读一次盘拿到最后一次
    // 成功落盘的状态。
    next.postMessage({ type: "load" } satisfies LoadRequest);
    // 第二层恢复：把落盘间隔内的增量补齐，由各自登记的镜像重放负责——
    // aiChat.ts、luckChallenge.ts 与 antiRaid.ts 分别重放各自主线程镜像。
    // 两层叠加，load 先到（FIFO），重放消息随后
    // 落在新实例已经热好的缓存之上，损失为零或接近零。
    for (const listener of respawnListeners) {
      listener();
    }
  };
  return w;
}

const respawnListeners: (() => void)[] = [];
const verificationPersistedListeners: ((reply: VerificationPersistedReply) => void)[] = [];

/**
 * 注册一个回调：diskIOWorker 崩溃重建后调用，用于把主线程侧的镜像
 * （AI 记忆 latestAiMemories、运势 dailyLuckCache、待验证 active/终结变化）
 * 重新投递给新实例，补齐上一次成功落盘之后的增量。落盘 Worker 是唯一的
 * 单例，各领域各自登记一个回调即可。
 */
export function onDiskIORespawn(callback: () => void): void {
  respawnListeners.push(callback);
}

/** 注册待验证增量 JSON 真正写入后的确认回调。 */
export function onVerificationPersisted(callback: (reply: VerificationPersistedReply) => void): void {
  verificationPersistedListeners.push(callback);
}

/** 把其它 Worker 线程转发来的 error 日志转投落盘线程（logger.ts 的转发模式，仅主线程调用）。 */
export function relayLogMessage(message: LogMessage): void {
  diskIOWorker?.postMessage({ type: "log", ...message } satisfies LogEnvelope);
}

/** 主线程 -> diskIOWorker：统一的快照或增量写入。 */
export function postDiskIO(
  message:
    | AiMemoryDiskMessage
    | AiMemoryDeleteDiskMessage
    | StickerCatalogDiskMessage
    | LuckDrawDiskMessage
    | VerificationUpsertDiskMessage
    | VerificationDeleteDiskMessage
): void {
  diskIOWorker?.postMessage(message);
}

/** 两张快照表的值是序列化 JSON 文本（与消息协议同形态，见 types/aiChat.ts
 *  的 AiMemoryEvent.snapshot），hydrate 链路直接透传，解析发生在 aiChatWorker
 *  侧的灌入点。 */
export interface LoadedData {
  aiMemories: Map<number, string>;
  stickerCatalogs: Map<string, string>;
  luckDay: LuckDayCache | null;
  luckReceiptSecret: LuckReceiptSecret;
  verifications: Map<string, VerificationSnapshot>;
}

/**
 * 启动恢复：向 diskIOWorker 请求上一次成功落盘的全部状态，带超时兜底。
 * 必须在 runner 开始投喂更新之前调用并等待完成（见 index.ts）——尤其是
 * 运势缓存与待验证记录都必须先恢复，避免重复抽签或遗漏超时处置。
 * 超时或 Worker 不存在时拒绝启动。持久化恢复不能降级为空状态继续：迟到的
 * load 回执不会再被主线程接管，后续新快照会覆盖磁盘上的旧记忆，造成静默
 * 数据丢失；交给 index.ts 的 main().catch 以非零码退出并由进程管理器重试。
 */
export function loadPersistedData(timeoutMs: number = LOAD_TIMEOUT_MS): Promise<LoadedData> {
  const worker: Worker | null = diskIOWorker;
  if (!worker) {
    return Promise.reject(new Error("Persistence Worker is unavailable; refusing to start with empty persisted state."));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingLoad.resolve = null;
      reject(new Error(`[diskIO] load handshake timed out after ${timeoutMs}ms; refusing to start with empty persisted state.`));
    }, timeoutMs);
    pendingLoad.resolve = (reply: LoadedReply): void => {
      clearTimeout(timer);
      if (reply.error !== undefined) {
        reject(new Error(`[diskIO] persistence recovery failed: ${reply.error}`));
        return;
      }
      if (reply.luckReceiptSecret === null) {
        reject(new Error("[diskIO] persistence recovery returned no luck receipt secret."));
        return;
      }
      resolve({
        aiMemories: reply.aiMemories,
        stickerCatalogs: reply.stickerCatalogs,
        luckDay: reply.luckDay,
        luckReceiptSecret: reply.luckReceiptSecret,
        verifications: reply.verifications,
      });
    };
    const request: LoadRequest = { type: "load" };
    worker.postMessage(request);
  });
}

let nextLuckSecretRequestId: number = 1;

/** 东京日期切换后，经唯一 Disk I/O Worker 原子加载或轮换日级运势密钥。 */
export function ensureLuckReceiptSecret(
  day: string,
  timeoutMs: number = LOAD_TIMEOUT_MS
): Promise<LuckReceiptSecret> {
  const worker: Worker | null = diskIOWorker;
  if (!worker) return Promise.reject(new Error("Persistence Worker is unavailable; cannot rotate luck receipt secret."));
  const requestId: number = nextLuckSecretRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingLuckSecrets.delete(requestId);
      reject(new Error(`[diskIO] luck receipt secret request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    pendingLuckSecrets.set(requestId, { resolve, reject, timer });
    worker.postMessage({ type: "ensureLuckSecret", requestId, day } satisfies EnsureLuckSecretRequest);
  });
}

let nextFlushId: number = 1;

/**
 * 要求 diskIOWorker 立即把所有 dirty 数据（含待验证增量）全部落盘，
 * 并等待完成。用于进程退出前的最后一刷（替代原 flushLogs）。带超时兜底：
 * Worker 异常时停机流程最多被拖住 timeoutMs，不会挂死。resolve 只代表
 * "等待已结束"，不保证数据真落了盘——Worker 若恰好在这次 flush 期间崩溃，
 * onerror 会提前结算这次等待并单独记一条"flush 落空"的日志（见上方
 * createDiskIOWorker），调用方无需（也没法）区分，只按尽力而为对待。
 */
export function flushDiskIO(timeoutMs: number = 3000): Promise<void> {
  const worker: Worker | null = diskIOWorker;
  if (!worker) return Promise.resolve();
  return new Promise((resolve) => {
    const id: number = nextFlushId++;
    const timer = setTimeout(() => {
      pendingFlushes.delete(id);
      resolve();
    }, timeoutMs);
    pendingFlushes.set(id, () => {
      clearTimeout(timer);
      resolve();
    });
    const request: DiskFlushRequest = { type: "flush", flushId: id };
    worker.postMessage(request);
  });
}
