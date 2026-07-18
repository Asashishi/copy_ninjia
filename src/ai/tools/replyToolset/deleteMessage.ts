import {
  TYPO_RECALL_DELETE_MAX_MS,
  TYPO_RECALL_DELETE_MIN_MS,
} from "../../../consts/aiChat/tools";
import { deleteMessage } from "../../../infra/telegram";
import { sleep } from "../../../libs/sleep";
import type { ReplyToolContext } from "../../../types/aiChat/replies";
import { randomDelayMs } from "../../utils/timing";
import { parsePositiveIntegerField } from "../../utils/toolArgs";
import { forgetSentMessage, type RoundMessageState } from "./messageState";

export function createDeleteOwnMessageExecutor(
  ctx: ReplyToolContext,
  state: RoundMessageState
): (argumentsJson: string) => Promise<string> {
  return async (argumentsJson: string): Promise<string> => {
    const messageId: number | null = parsePositiveIntegerField(argumentsJson, "message_id");
    if (messageId === null) return JSON.stringify({ error: "Invalid message_id" });
    if (!state.deletableMessageIds.has(messageId)) {
      return JSON.stringify({
        error: "Message is not deletable in this reply: only message_id values returned by this round's send_message can be deleted",
      });
    }

    await sleep(randomDelayMs(TYPO_RECALL_DELETE_MIN_MS, TYPO_RECALL_DELETE_MAX_MS));
    if (!ctx.isActive()) {
      return JSON.stringify({ error: "Reply invalidated because AI chat was disabled" });
    }
    const deleted: boolean = await deleteMessage(ctx.chatId, messageId);
    if (!deleted) return JSON.stringify({ error: "Failed to delete message" });
    forgetSentMessage(state, messageId);
    return JSON.stringify({ success: true });
  };
}
