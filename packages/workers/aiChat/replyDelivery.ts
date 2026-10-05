import { replyDeliveryCounts, replyDeliveryTotal, replyDeliveryWindows } from "../../cache/workers/aiChat/replies";
import { REPLY_DELIVERY_MAX_PER_CHAT, REPLY_DELIVERY_MAX_TOTAL } from "../../consts/aiChat/rateLimit";
import { LinkedQueue } from "../../libs/linkedQueue";
import type { ReplyDeliverySlot, ReplyDeliveryTurn, ReplyDeliveryWindow } from "../../types/aiChat/replies";

/** 跳过已完成项；队首仍是占位时等待，链就绪后只放行这一轮。 */
function advanceDelivery(chatId: number, window: ReplyDeliveryWindow): void {
  while (window.size > 0) {
    const slot: ReplyDeliverySlot | undefined = window.queue.peek();
    if (!slot) throw new Error("AI reply delivery slot missing.");
    if (slot.state !== "done") {
      if (slot.state === "ready") slot.ready.resolve();
      return;
    }
    window.queue.shift();
    window.size--;
    const remaining: number = (replyDeliveryCounts.get(chatId) ?? 0) - 1;
    if (remaining > 0) replyDeliveryCounts.set(chatId, remaining);
    else replyDeliveryCounts.delete(chatId);
    replyDeliveryTotal.current--;
    slot.released.resolve();
  }
  if (replyDeliveryWindows.get(chatId) === window) replyDeliveryWindows.delete(chatId);
}

/**
 * 同步按入站顺序追加发送占位；媒体解析和模型请求均在占位后进行。
 * 每个窗口用一个 FIFO 追加多轮；存活容量独立于模型并发计数。
 * 群里没有在途轮次（没有窗口）时本轮是直接轮：占位即就绪，ready 当即放行，动作接纳后立即由串行链执行、边生成边发送；
 * 它仍是发送链的队首，后续有序并行轮等它 finish 后才按入站顺位放行。直接轮在模型阶段独立占
 * 1 个并发位，commit（模型阶段结束）时交还。有序并行轮的 commit 标记完整动作链就绪，finish
 * 标记发送完成并等待按序回收。生命周期约束见 docs/cn/04-invariants.md。
 */
export function reserveReplyDelivery(chatId: number): ReplyDeliveryTurn | undefined {
  if (!hasReplyDeliveryCapacity(chatId)) return undefined;
  let window: ReplyDeliveryWindow | undefined = replyDeliveryWindows.get(chatId);
  const direct: boolean = window === undefined;
  if (!window) {
    window = {
      queue: new LinkedQueue<ReplyDeliverySlot>(),
      size: 0,
      directModelActive: true,
    };
    replyDeliveryWindows.set(chatId, window);
  }
  const ownedWindow: ReplyDeliveryWindow = window;
  const slot: ReplyDeliverySlot = {
    ready: Promise.withResolvers<void>(),
    released: Promise.withResolvers<void>(),
    state: direct ? "ready" : "pending",
  };
  if (direct) slot.ready.resolve();
  window.queue.push(slot);
  window.size++;
  replyDeliveryCounts.set(chatId, (replyDeliveryCounts.get(chatId) ?? 0) + 1);
  replyDeliveryTotal.current++;
  return {
    direct,
    ready: slot.ready.promise,
    commit: (): void => {
      if (direct) {
        ownedWindow.directModelActive = false;
        return;
      }
      if (slot.state !== "pending") return;
      slot.state = "ready";
      advanceDelivery(chatId, ownedWindow);
    },
    finish: (): Promise<void> => {
      slot.state = "done";
      advanceDelivery(chatId, ownedWindow);
      return slot.released.promise;
    },
  };
}

/** 同步查询所有仍存活代际的单群与全线程预算，不创建窗口或修改计数。 */
export function hasReplyDeliveryCapacity(chatId: number): boolean {
  return replyDeliveryTotal.current < REPLY_DELIVERY_MAX_TOTAL &&
    (replyDeliveryCounts.get(chatId) ?? 0) < REPLY_DELIVERY_MAX_PER_CHAT;
}

/** 该群的直接轮仍在模型阶段；准入与补跑据此在有序并行上限之外另放行这 1 轮。 */
export function isDirectReplyModelActive(chatId: number): boolean {
  return replyDeliveryWindows.get(chatId)?.directModelActive === true;
}
