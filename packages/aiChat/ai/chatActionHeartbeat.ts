import { typingHeartbeats } from "../../cache/workers/aiChat/heartbeat";
import { CHAT_ACTION_MAX_CONSECUTIVE_FAILURES, TYPING_ACTION_INTERVAL_MS } from "../../consts/aiChat/tools";
import { sendChatAction } from "../../infra/telegram";
import { settleInflight, trackInflight } from "../../libs/inflight";
import type { ChatActionHeartbeatControl, ChatActionHeartbeatEntry, ChatActionPhase } from "../../types/aiChat/chatAction";
import type { TelegramChatAction } from "../../types/telegram";

/** 一发状态请求的完整参数；话题是第四项，因此收成 options。 */
export interface ChatActionSendRequest {
  action: TelegramChatAction;
  chatId: number;
  /** 状态要亮在哪个论坛话题；General、非论坛群为 undefined。 */
  messageThreadId: number | undefined;
  signal?: AbortSignal;
}

/** 依赖可注入只为让心跳的并发/失败时序能用确定性的单测覆盖；生产调用使用
 *  下方默认值，仍共享 Worker 内的 typingHeartbeats。 */
export interface ChatActionHeartbeatDependencies {
  entries: Map<number, ChatActionHeartbeatEntry>;
  intervalMs: number;
  maxConsecutiveFailures: number;
  /** 只有一个发送口：每个挡位各开一个依赖方法的话，新增挡位要同时改依赖接口、
   *  默认值与分发分支，而漏掉分发那处对现有挡位照样编译通过。 */
  sendChatAction(request: ChatActionSendRequest): Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: ChatActionHeartbeatDependencies = {
  entries: typingHeartbeats,
  intervalMs: TYPING_ACTION_INTERVAL_MS,
  maxConsecutiveFailures: CHAT_ACTION_MAX_CONSECUTIVE_FAILURES,
  sendChatAction: ({
    action,
    chatId,
    messageThreadId,
    signal,
  }: ChatActionSendRequest): Promise<boolean> =>
    sendChatAction({ chatId, action, messageThreadId, ...(signal ? { signal } : {}) }),
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
export interface PumpChatActionParams {
  chatId: number;
  entry: ChatActionHeartbeatEntry;
  deduplicate: boolean;
  dependencies: ChatActionHeartbeatDependencies;
}

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
    if (phase === "idle") return;
    if (deduplicable && entry.lastSentPhase === phase && Date.now() - entry.lastSentAt < dependencies.intervalMs) return;
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
 * 思考期间不亮任何状态，「正在输入/发送图片/选择贴纸…」只在具体动作临发前由工具
 * 执行路径拉起有界窗口（见 aiChat/ai/tools/replyToolset/ 与 stickers.ts 的挡位
 * 切换）。指令虽已要求每轮必须回应（见 consts/aiChat/prompts/tools.ts
 * 的 REPLY_ACTION_INSTRUCTION），只扣反应的轮本就不发消息，模型也仍可能违背
 * 指令整轮零产出——这两种轮里全程亮着的打字状态最后等不来任何消息，就是
 * 群友看到的「假输入」遗留。切到非 idle
 * 挡会立即补发一次对应状态（同挡位在间隔内刚发过则节流跳过），此后由
 * 定时器按间隔重发维持（choose_sticker 挡要跨越模型挑贴纸的整个往返，
 * upload_photo 挡跨越参考图下载与生图，upload_document 挡更长——它跨越整首歌的
 * 合成，以分钟计，长消息的 typing 窗口也可长达 7.5
 * 秒，都可能超过单次状态约 5 秒的过期时间，全靠间隔小于过期时间的重发
 * 接力）。所有发送共用条目上的串行链
 * （见 pumpChatAction），并发切挡不会乱序。发送消息或贴纸前，调用方先切
 * idle 再 settle，确保所有较早的状态请求都先于消息落定。
 *
 * settle/stop 故意不依赖 Map 中仍存在本条目：连续失败可能先把条目移除，但
 * 本代链上仍可能有请求在途；若此时直接返回，它们就会在消息之后迟到并重新
 * 盖回状态。stop 同样会等待这些请求，避免异常中断后还有状态请求姗姗来迟。
 */
export interface StartChatActionHeartbeatParams {
  chatId: number;
  /**
   * 本轮所在的论坛话题；General、非论坛群为 undefined。
   *
   * 不带它的话，话题群里「正在输入…」会亮在 General，而消息落在话题里。
   */
  messageThreadId: number | undefined;
  dependencies?: ChatActionHeartbeatDependencies;
  signal?: AbortSignal;
}

export function startChatActionHeartbeat({
  chatId,
  messageThreadId,
  dependencies = DEFAULT_DEPENDENCIES,
  signal,
}: StartChatActionHeartbeatParams): ChatActionHeartbeatControl {
  let entry: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
  if (entry !== undefined && entry.signal !== signal) {
    // invalidate 已同步 abort 旧 generation，但新 generation 可以在旧任务 settle
    // 前开始。两代不能共享 timer/请求链；旧句柄的 stop 会识别 Map 已换代。
    clearInterval(entry.timer);
    dependencies.entries.delete(chatId);
    entry = undefined;
  }
  if (!entry) {
    const timer: ReturnType<typeof setInterval> = setInterval((): void => {
      const live: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
      if (live?.timer !== timer || live.action === "idle") return;
      pumpChatAction({ chatId, entry: live, deduplicate: false, dependencies });
    }, dependencies.intervalMs);
    // 与全仓其余四处 setInterval 一致地 unref：条目正常由 stop/refCount 归零或
    // resetAiChatHeartbeatCache 清掉，但一个还在重发打字状态的心跳不该成为
    // 「谁都没拆表」时唯一吊住 Worker 事件循环、拖住停机的东西。
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
      inflight: new Set(),
      consecutiveFailures: 0,
    };
    dependencies.entries.set(chatId, entry);
  }

  // 心跳条目按群共享并用 refCount 记持有句柄数，最后一个 stop 才拆表；轮次
  // 与各独立调用链分别持有句柄，refCount/owner 防止迟到 stop
  // 误拆仍由其它句柄使用的条目。
  // 非 idle 挡按句柄记归属（owner）：后切非 idle 挡的句柄盖掉此前的挡位仍是
  // 后写覆盖（Telegram 一个聊天同时只显示一种状态，接受），但收挡只认持有
  // 句柄——切 idle/停止只收回自己拉起的挡位，其它调用链的窗口不受影响，
  // 先结束的句柄也不会把「正在选择贴纸…」遗留给还在跑的任务一直重发。
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
        acquired.messageThreadId = undefined;
        // 重置节流记忆：切 idle 意味着一条消息/贴纸即将落地并清掉聊天状态，
        // 下一段窗口哪怕还是同一挡位，第一发也必须立即补出去，不能被
        // 「刚发过」误判跳过而黑屏到下一个 tick。
        acquired.lastSentPhase = "idle";
        return;
      }
      acquired.owner = ownerToken;
      acquired.action = phase;
      acquired.messageThreadId = messageThreadId;
      pumpChatAction({ chatId, entry: acquired, deduplicate: true, dependencies });
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
            acquired.messageThreadId = undefined;
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
