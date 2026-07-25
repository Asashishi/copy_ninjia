import type { FunctionDeclaration, Tool } from "@google/genai";
import { HARD_MAX_ACTIONS_PER_REPLY } from "../../../consts/aiChat/tools";
import {
  ACTION_TOOL_NAMES,
  REPLY_INVALIDATED_TOOL_ERROR,
  ADD_REACTION_TOOL,
  GENERATE_IMAGE_TOOL,
  SEND_MESSAGE_TOOL,
  SEND_STICKER_TOOL,
  unknownToolError,
  VIEW_STICKER_PACK_TOOL,
} from "../../../consts/tools";
import type { ReplyToolContext, ReplyToolset } from "../../../types/aiChat/replies";
import type { StickerPackCandidate, StickerRoundState } from "../../../types/stickers/tools";
import type { ToolDefinition } from "../../../types/tools";
import { TOOL_DEFINITIONS } from "../index";
import {
  buildSendStickerToolDefinition,
  buildStickerPackMenu,
  buildViewStickerPackToolDefinition,
  createStickerRoundState,
  sendStickerTool,
  viewStickerPackTool,
} from "../stickers";
import { buildGenerateImageToolDefinition, createGenerateImageExecutor } from "./imageGeneration";
import {
  buildAddReactionToolDefinition,
  buildSendMessageToolDefinition,
} from "./definitions";
import { createRoundMessageState } from "./messageState";
import { createAddReactionExecutor } from "./reaction";
import { createSendMessageExecutor } from "./sendMessage";
import { toolError } from "../../utils/toolResult";

/** 组装工具定义、领域执行器和整轮共享的总动作预算。 */
export async function createReplyToolset(ctx: ReplyToolContext): Promise<ReplyToolset> {
  const menu: StickerPackCandidate[] = await buildStickerPackMenu();
  const stickerState: StickerRoundState = createStickerRoundState();
  const messageState = createRoundMessageState();
  let actionsUsed: number = 0;

  const viewDefinition: ToolDefinition | null = buildViewStickerPackToolDefinition(menu);
  const sendStickerDefinition: ToolDefinition | null = buildSendStickerToolDefinition(menu);
  const addReactionDefinition: ToolDefinition | null = buildAddReactionToolDefinition();
  const definitions: ToolDefinition[] = [
    buildSendMessageToolDefinition(ctx.roundHasTypo),
    buildGenerateImageToolDefinition(ctx),
    ...(addReactionDefinition ? [addReactionDefinition] : []),
    ...(viewDefinition ? [viewDefinition] : []),
    ...(sendStickerDefinition ? [sendStickerDefinition] : []),
  ];
  const names: Set<string> = new Set(definitions.map((definition) => definition.name));
  const sdkDeclarations: FunctionDeclaration[] = [...TOOL_DEFINITIONS, ...definitions].map(
    (definition: ToolDefinition): FunctionDeclaration => ({
      name: definition.name,
      description: definition.description,
      parametersJsonSchema: definition.parameters,
    })
  );
  const tools: Tool[] = [{ googleSearch: {} }, { functionDeclarations: sdkDeclarations }];

  const executeSendMessage = createSendMessageExecutor(ctx, messageState, () => actionsUsed);
  const executeAddReaction = createAddReactionExecutor(ctx);
  const executeGenerateImage = createGenerateImageExecutor(ctx);

  async function dispatch(name: string, argumentsJson: string): Promise<string> {
    switch (name) {
      case SEND_MESSAGE_TOOL:
        return executeSendMessage(argumentsJson);
      case ADD_REACTION_TOOL:
        return executeAddReaction(argumentsJson);
      case GENERATE_IMAGE_TOOL:
        return executeGenerateImage(argumentsJson);
      case VIEW_STICKER_PACK_TOOL:
        return viewStickerPackTool({ chatAction: ctx.chatAction, menu, argumentsJson, state: stickerState });
      case SEND_STICKER_TOOL:
        return sendStickerTool({
          chatAction: ctx.chatAction,
          stickerLock: ctx.stickerLock,
          chatId: ctx.chatId,
          menu,
          argumentsJson,
          state: stickerState,
          onSent: ctx.onStickerSent,
          isActive: ctx.isActive,
        });
      default:
        return toolError(unknownToolError(name));
    }
  }

  return {
    definitions,
    tools,
    has: (name: string): boolean => names.has(name),
    execute: async (name: string, argumentsJson: string): Promise<string> => {
      if (!ctx.isActive()) {
        return toolError(REPLY_INVALIDATED_TOOL_ERROR);
      }
      if (ACTION_TOOL_NAMES.includes(name) && actionsUsed >= HARD_MAX_ACTIONS_PER_REPLY) {
        return JSON.stringify({
          error: `Action limit reached: at most ${HARD_MAX_ACTIONS_PER_REPLY} actions (messages + stickers + reactions + images) per reply`,
        });
      }

      const result: string = await dispatch(name, argumentsJson);
      if (ACTION_TOOL_NAMES.includes(name)) {
        try {
          const parsed = JSON.parse(result) as { success?: boolean; actions_used?: unknown };
          if (
            typeof parsed.actions_used === "number" &&
            Number.isFinite(parsed.actions_used) &&
            parsed.actions_used > 0
          ) {
            actionsUsed += Math.floor(parsed.actions_used);
          } else if (parsed.success) {
            actionsUsed++;
          }
        } catch {
          // 所有领域执行器都返回本地生成的 JSON；这里只做防御性兜底。
        }
      }
      return result;
    },
    actionsUsed: (): number => actionsUsed,
    isActive: ctx.isActive,
  };
}
