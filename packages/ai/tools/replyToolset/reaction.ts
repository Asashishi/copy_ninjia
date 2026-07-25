import { MAX_REACTIONS_PER_REPLY } from "../../../consts/aiChat/tools";
import { REPLY_INVALIDATED_TOOL_ERROR } from "../../../consts/tools";
import { toolError } from "../../utils/toolResult";
import { setMessageReaction } from "../../../infra/telegram";
import type { ReplyToolContext } from "../../../types/aiChat/replies";
import { getReactionEmojis } from "../../reactions";
import { parseStringField } from "../../utils/toolArgs";

export function createAddReactionExecutor(
  ctx: ReplyToolContext
): (argumentsJson: string) => Promise<string> {
  const reactionEmojis: readonly string[] = getReactionEmojis();
  let reactionCount: number = 0;
  return async (argumentsJson: string): Promise<string> => {
    if (!ctx.isActive()) {
      return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    }
    const emoji: string | null = parseStringField(argumentsJson, "emoji");
    if (emoji === null || !reactionEmojis.includes(emoji)) {
      return toolError("Invalid reaction emoji: pick one from the list");
    }
    if (reactionCount >= MAX_REACTIONS_PER_REPLY) {
      return toolError(
        `Reaction limit reached: at most ${MAX_REACTIONS_PER_REPLY} reaction per reply`
      );
    }
    const sent: boolean = await setMessageReaction({ chatId: ctx.chatId, messageId: ctx.replyToMessageId, emoji });
    if (!sent) return toolError("Failed to set reaction");
    reactionCount++;
    return JSON.stringify({ success: true });
  };
}
