import type { AiToolDefinition } from "../../../../types/aiChat/provider";
import {
  ADD_REACTION_TOOL_INSTRUCTION,
  SEND_MESSAGE_TOOL_INSTRUCTION,
} from "../../../../consts/aiChat/prompts/tools";
import {
  ADD_REACTION_TOOL,
  SEND_MESSAGE_TOOL,
} from "../../../../consts/tools";

/**
 * send_message 的工具声明，每轮逐字恒定。
 *
 * 手滑的两个字段恒声明为可选：抽中与否只体现在回复任务的 TYPO_REQUIRED_INSTRUCTION 里，
 * 字段说明只写「回复任务要求时才填」，不写手滑规则本身。没抽中的轮次模型即使填了，
 * 执行侧也按原文发送（见 typoHandling.ts 的 decideMessageTypo）。
 */
export function buildSendMessageToolDefinition(): AiToolDefinition {
  return {
    name: SEND_MESSAGE_TOOL,
    description: SEND_MESSAGE_TOOL_INSTRUCTION,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要发到群里的消息文本。" },
        reply_to_trigger: {
          type: "boolean",
          description: "是否以「回复」形式挂在触发你这次回复的那条消息上；省略视为 false。",
        },
        typo_original_char: {
          type: "string",
          description: "只在回复任务区块明确要求时填写：从 text 里原样抄的一个字。其余情况省略本字段。",
        },
        typo_replacement_char: {
          type: "string",
          description: "只在回复任务区块明确要求时填写：替换 typo_original_char 的那一个字。其余情况省略本字段。",
        },
      },
      required: ["text"],
    },
  };
}

export function buildAddReactionToolDefinition(): AiToolDefinition {
  return {
    name: ADD_REACTION_TOOL,
    description: ADD_REACTION_TOOL_INSTRUCTION,
    parametersJsonSchema: {
      type: "object",
      properties: {
        emoji: { type: "string", description: "要扣的反应 emoji，必须是清单里列出的其中一个。" },
      },
      required: ["emoji"],
    },
  };
}
