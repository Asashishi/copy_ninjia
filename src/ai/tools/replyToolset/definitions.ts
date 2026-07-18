import {
  ADD_REACTION_TOOL_INSTRUCTION,
  DELETE_OWN_MESSAGE_TOOL_INSTRUCTION,
  SEND_MESSAGE_TOOL_INSTRUCTION,
  TYPO_SUBSTITUTION_RULE,
} from "../../../consts/aiChat/prompts/tools";
import {
  ADD_REACTION_TOOL,
  DELETE_OWN_MESSAGE_TOOL,
  SEND_MESSAGE_TOOL,
} from "../../../consts/tools";
import type { ToolDefinition } from "../../../types/tools";
import { getReactionEmojis } from "../../reactions";

export function buildSendMessageToolDefinition(roundHasTypo: boolean): ToolDefinition {
  const properties: Record<string, unknown> = {
    text: { type: "string", description: "要发到群里的消息文本。" },
    reply_to_trigger: {
      type: "boolean",
      description: "是否以「回复」形式挂在触发你这次回复的那条消息上；省略视为 false。",
    },
  };
  const required: string[] = ["text"];
  if (roundHasTypo) {
    properties.typo_original_char = {
      type: "string",
      description:
        "本轮每次调用都必须提供：从 text 里原样抄一个已有字，只写这一个字（不要多写、不要写整句话）。" +
        "如果不想在这条消息上出错，就随便填 text 里的一个字，并让 typo_replacement_char 填成一模一样的字（会被安全" +
        "忽略，不会产生错字）。",
    };
    properties.typo_replacement_char = {
      type: "string",
      description: `typo_original_char 要被换成的那个错字，只写这一个字，不要写整句话。${TYPO_SUBSTITUTION_RULE}`,
    };
    required.push("typo_original_char", "typo_replacement_char");
  }
  return {
    name: SEND_MESSAGE_TOOL,
    description: SEND_MESSAGE_TOOL_INSTRUCTION,
    parameters: { type: "object", properties, required },
  };
}

export function buildDeleteOwnMessageToolDefinition(): ToolDefinition {
  return {
    name: DELETE_OWN_MESSAGE_TOOL,
    description: DELETE_OWN_MESSAGE_TOOL_INSTRUCTION,
    parameters: {
      type: "object",
      properties: {
        message_id: {
          type: "integer",
          description: "要撤回的消息 ID，必须来自本轮 send_message 成功结果返回的 message_id。",
        },
      },
      required: ["message_id"],
    },
  };
}

/** 反应白名单为空时不向模型提供反应工具。 */
export function buildAddReactionToolDefinition(): ToolDefinition | null {
  const reactionEmojis = getReactionEmojis();
  if (reactionEmojis.length === 0) return null;
  return {
    name: ADD_REACTION_TOOL,
    description: ADD_REACTION_TOOL_INSTRUCTION + reactionEmojis.join(" "),
    parameters: {
      type: "object",
      properties: {
        emoji: { type: "string", description: "要扣的反应 emoji，必须是清单里列出的其中一个。" },
      },
      required: ["emoji"],
    },
  };
}
