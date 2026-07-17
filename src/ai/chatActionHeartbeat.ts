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
 * 在整轮 AI 工具对话期间提供聊天状态的挡位心跳：从 idle 挡起步——生成/
 * 思考期间不亮任何状态，「正在输入/选择贴纸…」只在具体动作临发前由工具
 * 执行路径拉起有界窗口（见 ai/tools/replyToolset.ts 与 stickers.ts 的挡位
 * 切换）。模型完全可能整轮沉默（随机插话不接话/只扣反应），全程亮着的
 * 打字状态最后等不来任何消息，就是群友看到的「假输入」遗留。切到非 idle
 * 挡会立即补发一次对应状态，此后由定时器按间隔重发维持（choose_sticker
 * 挡要跨越模型挑贴纸的整个往返，长消息的 typing 窗口也可长达 7.5 秒，
 * 都可能超过单次状态约 5 秒的过期时间，全靠间隔小于过期时间的重发接力）。
 * 发送消息或贴纸前，调用方先切 idle 再 settle，确保所有较早的状态请求都
 * 先于消息落定。
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
  if (!entry) {
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      const live: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
      if (!live || live.timer !== timer || live.action === "idle") return;
      requestChatAction(chatId, live, live.action, dependencies);
    }, dependencies.intervalMs);
    entry = {
      timer,
      refCount: 0,
      action: "idle",
      inflight: new Set(),
      consecutiveFailures: 0,
    };
    dependencies.entries.set(chatId, entry);
  }

  // 同群可能有多轮回复并发（见 consts/aiChat.ts 的 REPLY_ROUND_MAX_CONCURRENT），
  // 并发轮共用同一份心跳条目：refCount 记持有者数，最后一个 stop 才拆表。
  // 挡位是全群一份、后写覆盖——新持有者起步不归零挡位，免得把并发轮正在
  // 亮的「正在输入…」窗口掐灭（新建条目本就从 idle/零失败起步；并发轮互相
  // 覆盖挡位只是状态显示的瑕疵，接受）。
  entry.refCount++;

  const acquired: ChatActionHeartbeatEntry = entry;
  let released: boolean = false;
  return {
    current: (): ChatActionPhase => (released || dependencies.entries.get(chatId) !== acquired ? "idle" : acquired.action),
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
