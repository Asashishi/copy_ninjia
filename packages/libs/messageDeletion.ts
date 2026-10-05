import type { DeleteMessageOutcome } from "../types/telegram";

/**
 * 这次删除之后消息是否已不在群里：删掉了，或本来就不存在 / 不可删。纯判定，不接触 Telegram
 * 客户端；只看成败的删除、gag 与 wed 的状态机消息、验证处置的残留清理共用这一份口径。
 */
export function isMessageDeletionSettled(outcome: DeleteMessageOutcome): boolean {
  return outcome === "deleted" || outcome === "gone";
}
