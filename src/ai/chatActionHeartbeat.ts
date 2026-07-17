import { typingHeartbeats } from "../cache/aiChatWorker";
import { CHAT_ACTION_MAX_CONSECUTIVE_FAILURES, TYPING_ACTION_INTERVAL_MS } from "../consts/aiChat";
import { sendChooseStickerAction, sendTypingAction } from "../infra/telegram";
import { settleInflight, trackInflight } from "../libs/inflight";
import type { ChatActionHeartbeatControl, ChatActionHeartbeatEntry, ChatActionPhase } from "../types";

/** 依赖可注入只为让心跳的并发/失败时序能用确定性的单测覆盖；生产调用使用
 *  下方默认值，仍共享 Worker 内的 typingHeartbeats。 */
export interface ChatActionHeartbeatDependencies {
  entries: Map<number, ChatActionHeartbeatEntry>;
  intervalMs: number;
  maxConsecutiveFailures: number;
  sendTyping(chatId: number): Promise<boolean>;
  sendChooseSticker(chatId: number): Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: ChatActionHeartbeatDependencies = {
  entries: typingHeartbeats,
  intervalMs: TYPING_ACTION_INTERVAL_MS,
  maxConsecutiveFailures: CHAT_ACTION_MAX_CONSECUTIVE_FAILURES,
  sendTyping: sendTypingAction,
  sendChooseSticker: sendChooseStickerAction,
};

/** 记录一发状态请求直至真正落定；按 Promise 本体删除，多个并发请求不会互相
 *  覆盖。请求结果同时维护连续失败计数，达到阈值才停表。 */
function requestChatAction(
  chatId: number,
  entry: ChatActionHeartbeatEntry,
  phase: Exclude<ChatActionPhase, "idle">,
  dependencies: ChatActionHeartbeatDependencies
): void {
  const request: Promise<void> = (phase === "typing" ? dependencies.sendTyping(chatId) : dependencies.sendChooseSticker(chatId)).then((ok: boolean) => {
    const current: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
    if (current !== entry) return;
    if (ok) {
      entry.consecutiveFailures = 0;
      return;
    }
    if (++entry.consecutiveFailures < dependencies.maxConsecutiveFailures) return;
    clearInterval(entry.timer);
    dependencies.entries.delete(chatId);
  });
  void trackInflight(entry.inflight, request);
}

/**
 * 在整轮 AI 工具对话期间维持聊天状态：默认立即显示「正在输入…」，随后按
 * typing / choose_sticker / idle 当前挡位定时刷新。发送消息或贴纸前，调用方
 * 先切 idle 再 settle，确保所有较早的状态请求都先于消息落定。
 *
 * settle/stop 故意不依赖 Map 中仍存在本条目：连续失败可能先把条目移除，但
 * 本代其他请求仍可能在途；若此时直接返回，它们就会在消息之后迟到并重新盖
 * 回状态。stop 同样会等待这些请求，避免异常中断后还有状态请求姗姗来迟。
 */
export function startChatActionHeartbeat(
  chatId: number,
  dependencies: ChatActionHeartbeatDependencies = DEFAULT_DEPENDENCIES
): ChatActionHeartbeatControl {
  let entry: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
  const reused: boolean = !!entry;
  if (!entry) {
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      const live: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
      if (!live || live.timer !== timer || live.action === "idle") return;
      requestChatAction(chatId, live, live.action, dependencies);
    }, dependencies.intervalMs);
    entry = {
      timer,
      refCount: 0,
      action: "typing",
      inflight: new Set(),
      consecutiveFailures: 0,
    };
    dependencies.entries.set(chatId, entry);
  }

  entry.refCount++;
  entry.action = "typing";
  requestChatAction(chatId, entry, "typing", dependencies);

  // 当前 activeReplyChats 会保证同群只有一轮在途；refCount 仍作为防御性保护
  // 保留。复用时也立即补发 typing，避免上一持有者停在其他挡位而要等下个 tick。
  if (reused) entry.consecutiveFailures = 0;

  const acquired: ChatActionHeartbeatEntry = entry;
  let released: boolean = false;
  return {
    set: (phase: ChatActionPhase): void => {
      if (released || dependencies.entries.get(chatId) !== acquired) return;
      acquired.action = phase;
      if (phase !== "idle") requestChatAction(chatId, acquired, phase, dependencies);
    },
    settle: async (): Promise<void> => {
      // 即使本代已经因连续失败从 Map 移除，也必须等齐它留下的全部请求。
      await settleInflight(acquired.inflight);
    },
    stop: async (): Promise<void> => {
      if (!released) {
        released = true;
        const current: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
        if (current === acquired && --current.refCount <= 0) {
          current.action = "idle";
          clearInterval(current.timer);
          dependencies.entries.delete(chatId);
        }
      }
      await settleInflight(acquired.inflight);
    },
  };
}
