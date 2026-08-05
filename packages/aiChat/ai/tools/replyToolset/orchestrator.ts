import type { AiToolDefinition } from "../../../../types/aiChat/provider";
import { HARD_MAX_ACTIONS_PER_REPLY } from "../../../../consts/aiChat/tools";
import {
  ACTION_TOOL_NAMES,
  REPLY_INVALIDATED_TOOL_ERROR,
  ADD_REACTION_TOOL,
  GENERATE_IMAGE_TOOL,
  SEND_MESSAGE_TOOL,
  SEND_STICKER_TOOL,
  unknownToolError,
  VIEW_STICKER_PACK_TOOL,
} from "../../../../consts/tools";
import type { ReplyToolContext, ReplyToolset } from "../../../../types/aiChat/replies";
import type { StickerPackCandidate, StickerRoundState } from "../../../../types/stickers/tools";
import { TOOL_DECLARATIONS } from "../index";
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
import type { RoundMessageState } from "../../../../types/aiChat/replies";

/** 组装工具定义、领域执行器和整轮共享的总动作预算。 */
export async function createReplyToolset(ctx: ReplyToolContext): Promise<ReplyToolset> {
  const menu: readonly StickerPackCandidate[] = await buildStickerPackMenu();
  const stickerState: StickerRoundState = createStickerRoundState();
  const messageState: RoundMessageState = createRoundMessageState();
  let actionsUsed: number = 0;

  const viewDefinition: AiToolDefinition | null = buildViewStickerPackToolDefinition(menu);
  const sendStickerDefinition: AiToolDefinition | null = buildSendStickerToolDefinition(menu);
  const addReactionDefinition: AiToolDefinition | null = buildAddReactionToolDefinition();
  const declarations: AiToolDefinition[] = [
    buildSendMessageToolDefinition(ctx.roundHasTypo),
    buildGenerateImageToolDefinition(ctx),
    ...(addReactionDefinition ? [addReactionDefinition] : []),
    ...(viewDefinition ? [viewDefinition] : []),
    ...(sendStickerDefinition ? [sendStickerDefinition] : []),
  ];
  // 只登记本轮现组装的行动工具：静态查询工具由 callTool 兜底分发，不进
  // 这份名单（见 workers/aiChat/replyModel.ts 的 toolset.has 分支）。
  const names: Set<string> = new Set(
    declarations.map((declaration: AiToolDefinition): string => declaration.name)
  );
  const functions: readonly AiToolDefinition[] = [...TOOL_DECLARATIONS, ...declarations];

  const executeSendMessage: (argumentsJson: string) => Promise<string> = createSendMessageExecutor(ctx, messageState, (): number => actionsUsed);
  const executeAddReaction: (argumentsJson: string) => Promise<string> = createAddReactionExecutor(ctx);
  const executeGenerateImage: (argumentsJson: string) => Promise<string> = createGenerateImageExecutor(ctx, messageState, (): number => actionsUsed);

  async function dispatch(name: string, argumentsJson: string): Promise<string> {
    switch (name) {
      case SEND_MESSAGE_TOOL:
        return executeSendMessage(argumentsJson);
      case ADD_REACTION_TOOL:
        return executeAddReaction(argumentsJson);
      case GENERATE_IMAGE_TOOL:
        return executeGenerateImage(argumentsJson);
      case VIEW_STICKER_PACK_TOOL:
        return viewStickerPackTool({
          chatAction: ctx.chatAction,
          menu,
          argumentsJson,
          state: stickerState,
          signal: ctx.signal,
        });
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
          signal: ctx.signal,
        });
      default:
        return toolError(unknownToolError(name));
    }
  }

  return {
    functions,
    // 服务端联网检索恒开：额度核销与耗尽后的摘挂由回复循环负责，
    // 见 workers/aiChat/replyModel.ts 的 MAX_WEB_SEARCH_CALLS_PER_REPLY 分支。
    webSearch: true,
    has: (name: string): boolean => names.has(name),
    execute: async (name: string, argumentsJson: string): Promise<string> => {
      if (!ctx.isActive()) {
        return toolError(REPLY_INVALIDATED_TOOL_ERROR);
      }
      // 这道门禁只管「还有没有额度开始一次调用」。会落地第二个动作的两个工具
      // （send_message 的手滑补字、generate_image 的超长图注独立补发）各自在
      // 执行侧按剩余预算决定要不要发那一条，因此这里比调用前的已用数就够，不必
      // 按最坏情况预留、白白吃掉最后一格（见 typoHandling.ts 的
      // TYPO_MIN_REMAINING_ACTIONS 与 imageGeneration.ts 的同名口径）。
      const isActionTool: boolean = ACTION_TOOL_NAMES.includes(name);
      if (isActionTool && actionsUsed >= HARD_MAX_ACTIONS_PER_REPLY) {
        return toolError(
          `Action limit reached: at most ${HARD_MAX_ACTIONS_PER_REPLY} actions (messages + stickers + reactions + images) per reply`
        );
      }

      const result: string = await dispatch(name, argumentsJson);
      if (isActionTool) {
        try {
          const parsed: { success?: boolean; actions_used?: unknown; } = JSON.parse(result) as { success?: boolean; actions_used?: unknown };
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
    signal: ctx.signal,
  };
}
