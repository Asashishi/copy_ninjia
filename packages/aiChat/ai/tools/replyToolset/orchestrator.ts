import type { AiToolDefinition } from "../../../../types/aiChat/provider";
import { HARD_MAX_ACTIONS_PER_REPLY } from "../../../../consts/aiChat/tools";
import {
  ACTION_TOOL_NAMES,
  REPLY_INVALIDATED_TOOL_ERROR,
  ADD_REACTION_TOOL,
  GENERATE_IMAGE_TOOL,
  GENERATE_SONG_TOOL,
  GROUP_QA_ANSWER_TOOL,
  GROUP_QA_QUERY_TOOL,
  SEND_MESSAGE_TOOL,
  SEND_STICKER_TOOL,
  unknownToolError,
  VIEW_STICKER_PACK_TOOL,
} from "../../../../consts/tools";
import type { ReplyActionChains, ReplyToolContext, ReplyToolExecution, ReplyToolset } from "../../../../types/aiChat/replies";
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
import { buildImageReferenceBlock } from "./imageReference";
import { buildGenerateSongToolDefinition, createGenerateSongExecutor } from "./songGeneration";
import {
  buildAddReactionToolDefinition,
  buildSendMessageToolDefinition,
} from "./definitions";
import { createRoundMessageState } from "./messageState";
import { createAddReactionExecutor } from "./reaction";
import { createSendMessageExecutor } from "./sendMessage";
import {
  buildGroupQaToolDefinitions,
  executeGroupQaAnswer,
  executeGroupQaQuery,
} from "./groupQa";
import { toolError } from "../../utils/toolResult";
import { imageAiProvider, songAiProvider } from "../../../provider";
import type { RoundMessageState } from "../../../../types/aiChat/replies";
import { createReplyActionChains, toolResultActions } from "./actionChains";

/** 组装工具定义、领域执行器和整轮共享的总动作预算。 */
export async function createReplyToolset(ctx: ReplyToolContext, deliveryReady?: Promise<void>): Promise<ReplyToolset> {
  const menu: readonly StickerPackCandidate[] = await buildStickerPackMenu(ctx.signal);
  const stickerState: StickerRoundState = createStickerRoundState();
  const messageState: RoundMessageState = createRoundMessageState();
  let actionsUsed: number = 0;
  const chains: ReplyActionChains = createReplyActionChains(ctx, deliveryReady);

  const viewDefinition: AiToolDefinition | null = buildViewStickerPackToolDefinition(menu);
  const sendStickerDefinition: AiToolDefinition | null = buildSendStickerToolDefinition(menu);
  const addReactionDefinition: AiToolDefinition | null = buildAddReactionToolDefinition();
  // 重媒体工具只在直接触发轮查询供应商能力并挂载；随机插话与非直接媒体评价
  // 不读取对应 provider，也不向模型暴露工具 schema。
  const imageEnabled: boolean = ctx.mediaToolsRequested && imageAiProvider() !== null;
  const songEnabled: boolean = ctx.mediaToolsRequested && songAiProvider()?.generateSong !== undefined;
  const declarations: AiToolDefinition[] = [
    buildSendMessageToolDefinition(ctx.roundHasTypo),
  ];
  if (imageEnabled) declarations.push(buildGenerateImageToolDefinition());
  if (songEnabled) declarations.push(buildGenerateSongToolDefinition());
  if (addReactionDefinition !== null) declarations.push(addReactionDefinition);
  if (viewDefinition !== null) declarations.push(viewDefinition);
  if (sendStickerDefinition !== null) declarations.push(sendStickerDefinition);
  // 本群没登记问答时这里是空数组，两个工具都不挂——模型看不到的工具不会被调用。
  declarations.push(...buildGroupQaToolDefinitions(ctx.chatQa));
  // 只登记本轮现组装的行动工具：静态查询工具由 callTool 兜底分发，不进
  // 这份名单（见 workers/aiChat/replyModel.ts 的 toolset.has 分支）。
  const names: Set<string> = new Set<string>();
  for (const declaration of declarations) names.add(declaration.name);
  const functions: readonly AiToolDefinition[] = [...TOOL_DECLARATIONS, ...declarations];

  const executeSendMessage: (argumentsJson: string) => ReplyToolExecution = createSendMessageExecutor(ctx, messageState, (): number => actionsUsed);
  const executeAddReaction: (argumentsJson: string) => ReplyToolExecution = createAddReactionExecutor(ctx);
  const executeGenerateImage: ((argumentsJson: string) => ReplyToolExecution) | null = imageEnabled
    ? createGenerateImageExecutor(ctx, messageState, (): number => actionsUsed)
    : null;
  // 生歌执行器只与已挂载的工具一同创建；未挂载的名称按未知工具处理。
  const executeGenerateSong: ((argumentsJson: string) => ReplyToolExecution) | null =
    songEnabled ? createGenerateSongExecutor(ctx, messageState) : null;

  function dispatch(name: string, argumentsJson: string): ReplyToolExecution {
    switch (name) {
      case SEND_MESSAGE_TOOL:
        return executeSendMessage(argumentsJson);
      case ADD_REACTION_TOOL:
        return executeAddReaction(argumentsJson);
      case GENERATE_IMAGE_TOOL:
        return executeGenerateImage === null
          ? toolError(unknownToolError(name))
          : executeGenerateImage(argumentsJson);
      case GENERATE_SONG_TOOL:
        return executeGenerateSong === null
          ? toolError(unknownToolError(name))
          : executeGenerateSong(argumentsJson);
      case GROUP_QA_QUERY_TOOL:
        return executeGroupQaQuery(ctx.chatQa);
      case GROUP_QA_ANSWER_TOOL:
        return executeGroupQaAnswer(ctx.chatQa, argumentsJson);
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
          messageThreadId: ctx.messageThreadId,
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
    // 本轮生图参考素材文案。与 declarations 同一时刻取快照，交给运行时状态区块渲染
    // （见 imageReference.ts 与 workers/aiChat/runtimeState.ts）；没挂生图工具时是空串，
    // 那一段因此与不含生图的轮次逐字相同。生图/生歌的群冷却不在提示词里，只由两个
    // 执行器在调用时判定。
    imageReference: buildImageReferenceBlock({ ctx, imageEnabled }),
    // 服务端联网检索恒开：次数是写进提示词的软限制，回复循环只记账并在超出时
    // 点名，不摘工具（见 workers/aiChat/replyModel.ts 与 consts/aiChat/tools.ts）。
    webSearch: true,
    has: (name: string): boolean => names.has(name),
    execute: (name: string, argumentsJson: string): Promise<string> => {
      if (!ctx.isActive()) {
        return Promise.resolve(toolError(REPLY_INVALIDATED_TOOL_ERROR));
      }
      // 校验和接纳同步执行，正文与附加动作先占额度再让模型继续。
      // 已接纳动作由独立调用链执行，失败不退额度给模型重复投递。
      const isActionTool: boolean = ACTION_TOOL_NAMES.includes(name);
      if (isActionTool && actionsUsed >= HARD_MAX_ACTIONS_PER_REPLY) {
        return Promise.resolve(toolError(
          `Action limit reached: at most ${HARD_MAX_ACTIONS_PER_REPLY} actions (messages + stickers + reactions + images + songs) per reply`
        ));
      }

      const execution: ReplyToolExecution = dispatch(name, argumentsJson);
      const result: string = typeof execution === "string" ? execution : execution.result;
      if (isActionTool) actionsUsed += toolResultActions(result);
      if (typeof execution !== "string") chains.start(name, execution);
      return Promise.resolve(result);
    },
    actionsUsed: (): number => actionsUsed,
    settle: (): Promise<void> => chains.settle(),
    actionsCompleted: (): number => chains.completed(),
    isActive: ctx.isActive,
    signal: ctx.signal,
  };
}
