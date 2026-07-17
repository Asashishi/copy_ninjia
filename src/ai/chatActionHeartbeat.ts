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

/**
 * 把一发状态请求排进本群的串行链。执行时才重读当下挡位：挡位已切走的排队
 * 请求坍缩成最新挡位、已切 idle 的直接跳过——同群请求逐个到达 Telegram，
 * 并发切挡不会乱序把旧状态盖回新状态之上。deduplicate 为 true（切挡补发）
 * 时对重复状态节流：同一挡位在 intervalMs 内刚真正发过就跳过，状态本就还
 * 在 Telegram 约 5 秒的过期窗口里亮着；定时 tick 不节流——tick 间隔就是
 * 维持显示的节奏，再跳过会在过期边缘造成闪断。
 *
 * 链上最多保留一发「排队未执行」的请求：它执行时才读挡位，天然代表它
 * 入队之后到来的所有请求，发送挂起期间的连续 tick 全部合并进它，恢复后
 * 只补一发、不背靠背连发同一状态；合并时混入过 tick 则排队那发降级为
 * 必发（entry.pendingSendDeduplicate），保住强制刷新语义。请求结果维护
 * 连续失败计数，达到阈值才停表；链上的执行函数自身不抛异常，发送层报错
 * 按失败计。导出仅为可测试性（挂起/合并的时序靠直接驱动才能确定性复现）。
 */
export function pumpChatAction(chatId: number, entry: ChatActionHeartbeatEntry, deduplicate: boolean, dependencies: ChatActionHeartbeatDependencies): void {
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
    if (phase === "idle") return;
    if (deduplicable && entry.lastSentPhase === phase && Date.now() - entry.lastSentAt < dependencies.intervalMs) return;
    let ok: boolean;
    try {
      ok = await (phase === "typing" ? dependencies.sendTyping(chatId) : dependencies.sendChooseSticker(chatId));
    } catch {
      ok = false;
    }
    if (dependencies.entries.get(chatId) !== entry) return;
    if (ok) {
      // 节流记忆只记真正送达的状态：失败不落账，后续同挡位补发不会被一发
      // 失败请求的「刚发过」误拦（重试有定时 tick 兜底，但补发更快）。
      entry.lastSentPhase = phase;
      entry.lastSentAt = Date.now();
      entry.consecutiveFailures = 0;
      return;
    }
    if (++entry.consecutiveFailures < dependencies.maxConsecutiveFailures) return;
    clearInterval(entry.timer);
    dependencies.entries.delete(chatId);
  };
  entry.sendChain = entry.sendChain.then(run);
  void trackInflight(entry.inflight, entry.sendChain);
}

/**
 * 在整轮 AI 工具对话期间提供聊天状态的挡位心跳：从 idle 挡起步——生成/
 * 思考期间不亮任何状态，「正在输入/选择贴纸…」只在具体动作临发前由工具
 * 执行路径拉起有界窗口（见 ai/tools/replyToolset.ts 与 stickers.ts 的挡位
 * 切换）。指令虽已要求每轮必须回应（见 consts/aiChat.ts 的
 * REPLY_ACTION_INSTRUCTION），只扣反应的轮本就不发消息，模型也仍可能违背
 * 指令整轮零产出——这两种轮里全程亮着的打字状态最后等不来任何消息，就是
 * 群友看到的「假输入」遗留。切到非 idle
 * 挡会立即补发一次对应状态（同挡位在间隔内刚发过则节流跳过），此后由
 * 定时器按间隔重发维持（choose_sticker 挡要跨越模型挑贴纸的整个往返，
 * 长消息的 typing 窗口也可长达 7.5 秒，都可能超过单次状态约 5 秒的过期
 * 时间，全靠间隔小于过期时间的重发接力）。所有发送共用条目上的串行链
 * （见 pumpChatAction），并发切挡不会乱序。发送消息或贴纸前，调用方先切
 * idle 再 settle，确保所有较早的状态请求都先于消息落定。
 *
 * settle/stop 故意不依赖 Map 中仍存在本条目：连续失败可能先把条目移除，但
 * 本代链上仍可能有请求在途；若此时直接返回，它们就会在消息之后迟到并重新
 * 盖回状态。stop 同样会等待这些请求，避免异常中断后还有状态请求姗姗来迟。
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
      pumpChatAction(chatId, live, false, dependencies);
    }, dependencies.intervalMs);
    entry = {
      timer,
      refCount: 0,
      action: "idle",
      owner: null,
      sendChain: Promise.resolve(),
      pendingSend: false,
      pendingSendDeduplicate: true,
      lastSentPhase: "idle",
      lastSentAt: 0,
      inflight: new Set(),
      consecutiveFailures: 0,
    };
    dependencies.entries.set(chatId, entry);
  }

  // 同群可能有多轮回复并发（见 consts/aiChat.ts 的 REPLY_ROUND_MAX_CONCURRENT），
  // 并发轮共用同一份心跳条目：refCount 记持有者数，最后一个 stop 才拆表。
  // 非 idle 挡按轮记归属（owner）：后切非 idle 挡的轮盖掉前一轮的挡位仍是
  // 后写覆盖（Telegram 一个聊天同时只显示一种状态，接受），但收挡只认持有
  // 轮——切 idle/停止只收回自己拉起的挡位，并发轮的窗口不会被别的轮掐灭，
  // 先结束的轮也不会把「正在选择贴纸…」遗留给还在跑的轮一直重发。
  entry.refCount++;

  const acquired: ChatActionHeartbeatEntry = entry;
  const ownerToken: object = {};
  let released: boolean = false;
  return {
    current: (): ChatActionPhase =>
      released || dependencies.entries.get(chatId) !== acquired || acquired.owner !== ownerToken ? "idle" : acquired.action,
    set: (phase: ChatActionPhase): void => {
      if (released || dependencies.entries.get(chatId) !== acquired) return;
      if (phase === "idle") {
        if (acquired.owner !== ownerToken) return;
        acquired.owner = null;
        acquired.action = "idle";
        // 重置节流记忆：切 idle 意味着一条消息/贴纸即将落地并清掉聊天状态，
        // 下一段窗口哪怕还是同一挡位，第一发也必须立即补出去，不能被
        // 「刚发过」误判跳过而黑屏到下一个 tick。
        acquired.lastSentPhase = "idle";
        return;
      }
      acquired.owner = ownerToken;
      acquired.action = phase;
      pumpChatAction(chatId, acquired, true, dependencies);
    },
    settle: async (): Promise<void> => {
      // 即使本代已经因连续失败从 Map 移除，也必须等齐它留下的全部请求。
      await settleInflight(acquired.inflight);
    },
    stop: async (): Promise<void> => {
      if (!released) {
        released = true;
        const current: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
        if (current === acquired) {
          // 收回本轮持有的挡位：并发轮还在时条目继续存活，不收回的话本轮
          // 遗留的「正在选择贴纸…」会被定时重发一直维持到最后一轮结束。
          if (acquired.owner === ownerToken) {
            acquired.owner = null;
            acquired.action = "idle";
            acquired.lastSentPhase = "idle";
          }
          if (--acquired.refCount <= 0) {
            clearInterval(acquired.timer);
            dependencies.entries.delete(chatId);
          }
        }
      }
      await settleInflight(acquired.inflight);
    },
  };
}
