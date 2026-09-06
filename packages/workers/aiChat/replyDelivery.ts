import { replyDeliveryWindows } from "../../cache/workers/aiChat/replies";
import { REPLY_ROUND_MAX_CONCURRENT } from "../../consts/aiChat/rateLimit";
import { LinkedQueue } from "../../libs/linkedQueue";
import type { ReplyDeliverySlot, ReplyDeliveryTurn, ReplyDeliveryWindow } from "../../types/aiChat/replies";

/** 跳过已完成项；队首仍是占位时等待，链就绪后只放行这一轮。 */
function advanceDelivery(chatId: number, window: ReplyDeliveryWindow): void {
  while (window.size > 0) {
    const bucket: LinkedQueue<ReplyDeliverySlot> | undefined = window.slots[window.head];
    const slot: ReplyDeliverySlot | undefined = bucket?.peek();
    if (!bucket || !slot) throw new Error("AI reply delivery slot missing.");
    if (slot.state !== "done") {
      if (slot.state === "ready") slot.ready.resolve();
      return;
    }
    bucket.shift();
    window.head = (window.head + 1) % window.slots.length;
    window.size--;
    slot.released.resolve();
  }
  if (replyDeliveryWindows.get(chatId) === window) replyDeliveryWindows.delete(chatId);
}

/**
 * 同步按入站顺序追加发送占位；媒体解析和模型请求均在占位后进行。
 * 固定数组只决定桶数，每桶用 FIFO 追加多轮；发送积压不参与模型并发准入。
 * commit 标记完整动作链就绪，finish 标记发送完成并等待按序回收。
 * 生命周期约束见 docs/cn/04-invariants.md。
 */
export function reserveReplyDelivery(chatId: number): ReplyDeliveryTurn {
  let window: ReplyDeliveryWindow | undefined = replyDeliveryWindows.get(chatId);
  if (!window) {
    window = {
      slots: Array.from({ length: REPLY_ROUND_MAX_CONCURRENT }, (): LinkedQueue<ReplyDeliverySlot> => new LinkedQueue<ReplyDeliverySlot>()),
      head: 0,
      tail: 0,
      size: 0,
    };
    replyDeliveryWindows.set(chatId, window);
  }
  const ownedWindow: ReplyDeliveryWindow = window;
  const slot: ReplyDeliverySlot = {
    ready: Promise.withResolvers<void>(),
    released: Promise.withResolvers<void>(),
    state: "pending",
  };
  const bucket: LinkedQueue<ReplyDeliverySlot> | undefined = window.slots[window.tail];
  if (!bucket) throw new Error("AI reply delivery bucket missing.");
  bucket.push(slot);
  window.tail = (window.tail + 1) % window.slots.length;
  window.size++;
  return {
    ready: slot.ready.promise,
    commit: (): void => {
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
