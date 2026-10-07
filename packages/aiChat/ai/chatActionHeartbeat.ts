import { typingHeartbeats } from "../../cache/workers/aiChat/heartbeat";
import {
  CHAT_ACTION_MAX_CONSECUTIVE_FAILURES,
  CHAT_ACTION_REST_MS,
  TYPING_ACTION_INTERVAL_MS,
} from "../../consts/aiChat/tools";
import { sendChatAction } from "../../infra/telegram";
import { trackInflight } from "../../libs/inflight";
import type { ChatActionHeartbeatControl, ChatActionHeartbeatEntry, ChatActionPhase } from "../../types/aiChat/chatAction";
import type { TelegramChatAction } from "../../types/telegram";

/** 一发状态请求的完整参数。 */
export interface ChatActionSendRequest {
  action: TelegramChatAction;
  chatId: number;
  /** 状态要亮在哪个论坛话题；General、非论坛群为 undefined。 */
  messageThreadId: number | undefined;
  signal?: AbortSignal;
}

/** 心跳依赖集合，可注入测试替身；生产调用使用下方默认值，共享 Worker 内的
 *  typingHeartbeats。 */
export interface ChatActionHeartbeatDependencies {
  entries: Map<number, ChatActionHeartbeatEntry>;
  intervalMs: number;
  maxConsecutiveFailures: number;
  /** 一段状态结束后到下一段亮起的最短静默（ms）。 */
  restMs: number;
  /** 唯一的发送口；挡位取值由 TelegramChatAction 单点定义。 */
  sendChatAction(request: ChatActionSendRequest): Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: ChatActionHeartbeatDependencies = {
  entries: typingHeartbeats,
  intervalMs: TYPING_ACTION_INTERVAL_MS,
  maxConsecutiveFailures: CHAT_ACTION_MAX_CONSECUTIVE_FAILURES,
  restMs: CHAT_ACTION_REST_MS,
  sendChatAction,
};

export interface PumpChatActionParams {
  chatId: number;
  entry: ChatActionHeartbeatEntry;
  deduplicate: boolean;
  dependencies: ChatActionHeartbeatDependencies;
}

/**
 * 把一发状态请求排进本群的串行链，同群请求逐个到达 Telegram。执行时才重读当下挡位：
 * 挡位已切走的排队请求按最新挡位发送，已切 idle 或正处静默期的直接跳过（静默结束由
 * lightChatAction 补发）。deduplicate 为 true（切挡补发）时对重复状态节流：同一挡位
 * 在 intervalMs 内刚真正发过就跳过；定时 tick 不节流。
 *
 * 链上最多保留一发「排队未执行」的请求：它执行时才读挡位，代表它入队之后到来的所有
 * 请求，发送挂起期间的连续 tick 合并进它，恢复后只补一发；合并时混入过 tick 则排队那发
 * 降级为必发（entry.pendingSendDeduplicate）。请求结果维护连续失败计数，达到阈值才停表；
 * 链上的执行函数自身不抛异常，发送层报错按失败计。导出供测试直接驱动挂起/合并时序。
 */
export function pumpChatAction({
  chatId,
  entry,
  deduplicate,
  dependencies,
}: PumpChatActionParams): void {
  if (entry.pendingSend) {
    entry.pendingSendDeduplicate &&= deduplicate;
    return;
  }
  entry.pendingSend = true;
  entry.pendingSendDeduplicate = deduplicate;
  const run = async (): Promise<void> => {
    const deduplicable: boolean = entry.pendingSendDeduplicate;
    entry.pendingSend = false;
    if (dependencies.entries.get(chatId) !== entry) return;
    const phase: ChatActionPhase = entry.action;
    if (phase === "idle" || performance.now() < entry.restUntil) return;
    // 同挡位在一个间隔内已送达过就不重发；墙钟回拨让 now 早于上次送达时按已过期处理。
    const sinceLastSent: number = Date.now() - entry.lastSentAt;
    if (
      deduplicable &&
      entry.lastSentPhase === phase &&
      sinceLastSent >= 0 &&
      sinceLastSent < dependencies.intervalMs
    ) return;
    let ok: boolean;
    try {
      ok = await dependencies.sendChatAction({
        action: phase,
        chatId,
        messageThreadId: entry.messageThreadId,
        signal: entry.signal,
      });
    } catch {
      ok = false;
    }
    if (dependencies.entries.get(chatId) !== entry) return;
    if (ok) {
      // 节流记忆只记真正送达、且送达时挡位未变的状态：失败不落账；在途期间挡位已被切走的送达也不记。
      if (entry.action === phase) {
        entry.lastSentPhase = phase;
        entry.lastSentAt = Date.now();
      }
      entry.consecutiveFailures = 0;
      return;
    }
    if (++entry.consecutiveFailures < dependencies.maxConsecutiveFailures) return;
    clearInterval(entry.timer);
    clearTimeout(entry.restTimer ?? undefined);
    dependencies.entries.delete(chatId);
  };
  entry.sendChain = entry.sendChain.then(run);
  void trackInflight(entry.inflight, entry.sendChain);
}

/**
 * 点亮条目当前挡位并返回还要静默的毫秒数：静默期已过就立即补发（返回 0）；仍在静默期内则
 * 推迟到静默结束再补发当时的挡位——期间再切挡只改挡位，由同一个定时器发出，静默期被延长时
 * 到点重新排期；条目换代、拆除或已切 idle 时到点直接返回。
 */
function lightChatAction(
  chatId: number,
  entry: ChatActionHeartbeatEntry,
  dependencies: ChatActionHeartbeatDependencies
): number {
  const rest: number = Math.ceil(entry.restUntil - performance.now());
  if (rest <= 0) {
    pumpChatAction({ chatId, entry, deduplicate: true, dependencies });
    return 0;
  }
  if (entry.restTimer === null) {
    entry.restTimer = setTimeout((): void => {
      entry.restTimer = null;
      if (dependencies.entries.get(chatId) === entry && entry.action !== "idle") lightChatAction(chatId, entry, dependencies);
    }, rest);
    entry.restTimer.unref();
  }
  return rest;
}

export interface StartChatActionHeartbeatParams {
  chatId: number;
  /** 本轮所在的论坛话题；General、非论坛群为 undefined。 */
  messageThreadId: number | undefined;
  dependencies?: ChatActionHeartbeatDependencies;
  signal?: AbortSignal;
}

/**
 * 在整轮 AI 工具对话期间提供聊天状态的挡位心跳，从 idle 挡起步。有序并行轮生成/思考期间
 * 不亮任何状态，「正在输入/发送图片/选择贴纸/录音…」只由本轮串行动作链按工具调用顺序拉起
 * 有界窗口（见 aiChat/ai/tools/replyToolset/actionChains.ts），链上的步骤按顺序切挡。直接轮的
 * 动作同样由串行链切挡；链空闲时，还没接纳过动作的请求期间亮「正在输入」、刚看过贴纸包的那次
 * 请求亮「正在选择贴纸」，其余请求不亮，链忙时请求的挡位等链排空再亮，模型阶段结束时收回
 * 还没被动作接走的请求挡位（见 replyToolset/pacing.ts 与 replyToolset/orchestrator.ts）。
 * 切到非 idle 挡会补发一次对应状态（同挡位在间隔内刚发过则节流跳过），此后由定时器按
 * intervalMs 间隔重发维持，间隔小于 Telegram 单次状态的过期窗口。所有发送共用条目上的
 * 串行链（见 pumpChatAction）。发送消息、贴纸、语音或图片前，调用方先切 idle 再 settle，
 * 使较早的状态请求先于消息落定；落地后再切一次 idle。切 idle 标记一段状态结束，同群静默
 * restMs 后才点亮下一段（见 lightChatAction），静默期从最后一次切 idle 算起，其间不发任何
 * 状态请求，set 返回的剩余静默供拟人停顿顺延。
 *
 * settle/stop 不依赖 Map 中仍存在本条目：连续失败可能先把条目移除，本代链上在途的请求
 * 仍由 settle/stop 等待。
 */
export function startChatActionHeartbeat({
  chatId,
  messageThreadId,
  dependencies = DEFAULT_DEPENDENCIES,
  signal,
}: StartChatActionHeartbeatParams): ChatActionHeartbeatControl {
  let entry: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
  if (entry !== undefined && entry.signal !== signal) {
    // signal 变化即换代：旧条目的 timer 与请求链拆除，不与新 generation 共享；旧句柄的 stop 识别 Map 已换代。
    clearInterval(entry.timer);
    clearTimeout(entry.restTimer ?? undefined);
    dependencies.entries.delete(chatId);
    entry = undefined;
  }
  if (!entry) {
    const timer: ReturnType<typeof setInterval> = setInterval((): void => {
      const live: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
      if (live?.timer !== timer || live.action === "idle" || performance.now() < live.restUntil) return;
      pumpChatAction({ chatId, entry: live, deduplicate: false, dependencies });
    }, dependencies.intervalMs);
    // timer 必须 unref（口径见 docs/cn/04-invariants.md）；条目正常由
    // stop/refCount 归零或 resetAiChatHeartbeatCache 清掉。
    timer.unref();
    entry = {
      timer,
      signal,
      refCount: 0,
      action: "idle",
      messageThreadId: undefined,
      owner: null,
      sendChain: Promise.resolve(),
      pendingSend: false,
      pendingSendDeduplicate: true,
      lastSentPhase: "idle",
      lastSentAt: 0,
      restUntil: 0,
      restTimer: null,
      inflight: new Set(),
      consecutiveFailures: 0,
    };
    dependencies.entries.set(chatId, entry);
  }

  // 心跳条目按群共享，refCount 记持有句柄数，最后一个 stop 才拆表；每轮持有一个句柄
  // （本轮串行动作链共用它），同群并发轮各持一个。
  // 非 idle 挡按句柄记归属（owner）：后切非 idle 挡的句柄覆盖此前的挡位，收挡只认持有
  // 句柄——切 idle/停止只收回自己拉起的挡位，不影响并发轮的窗口。
  entry.refCount++;

  const acquired: ChatActionHeartbeatEntry = entry;
  const ownerToken: object = {};
  let released: boolean = false;
  return {
    set: (phase: ChatActionPhase): number => {
      if (released || dependencies.entries.get(chatId) !== acquired) return 0;
      if (phase === "idle") {
        // 别的轮亮着的挡位不归本句柄收，也不算本轮的状态结束。
        if (acquired.owner !== null && acquired.owner !== ownerToken) return 0;
        acquired.restUntil = performance.now() + dependencies.restMs;
        if (acquired.owner === null) return 0;
        acquired.owner = null;
        acquired.action = "idle";
        acquired.messageThreadId = undefined;
        // 重置节流记忆：下一段窗口的第一发不受「刚发过」节流。
        acquired.lastSentPhase = "idle";
        return 0;
      }
      acquired.owner = ownerToken;
      acquired.action = phase;
      acquired.messageThreadId = messageThreadId;
      return lightChatAction(chatId, acquired, dependencies);
    },
    settle: async (): Promise<void> => {
      // 本代已因连续失败从 Map 移除时，仍等待它留下的全部在途请求。
      await Promise.allSettled(acquired.inflight);
    },
    stop: async (): Promise<void> => {
      if (!released) {
        released = true;
        const current: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
        if (current === acquired) {
          // 收回本轮持有的挡位；并发轮还在时条目继续存活。
          if (acquired.owner === ownerToken) {
            acquired.owner = null;
            acquired.action = "idle";
            acquired.messageThreadId = undefined;
            acquired.lastSentPhase = "idle";
          }
          if (--acquired.refCount <= 0) {
            clearInterval(acquired.timer);
            clearTimeout(acquired.restTimer ?? undefined);
            dependencies.entries.delete(chatId);
          }
        }
      }
      await Promise.allSettled(acquired.inflight);
    },
  };
}
