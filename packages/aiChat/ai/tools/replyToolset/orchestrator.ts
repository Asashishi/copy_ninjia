import type { AiToolDefinition } from "../../../../types/aiChat/provider";
import { HARD_MAX_ACTIONS_PER_REPLY } from "../../../../consts/aiChat/tools";
import {
  ACTION_TOOL_NAMES,
  REPLY_INVALIDATED_TOOL_ERROR,
  TOOL_DECLARATIONS,
  ADD_REACTION_TOOL,
  GENERATE_IMAGE_TOOL,
  GROUP_QA_ANSWER_TOOL,
  GROUP_QA_QUERY_TOOL,
  SEND_MESSAGE_TOOL,
  SEND_STICKER_TOOL,
  SEND_VOICE_TOOL,
  unknownToolError,
  VIEW_STICKER_PACK_TOOL,
} from "../../../../consts/tools";
import type {
  DirectReplyPacing,
  ReplyActionChains,
  ReplyToolContext,
  ReplyToolExecution,
  ReplyToolset,
  RoundMessageState,
} from "../../../../types/aiChat/replies";
import type { StickerPackCandidate, StickerRoundState } from "../../../../types/stickers/tools";
import {
  buildSendStickerToolDefinition,
  buildStickerPackMenu,
  buildViewStickerPackToolDefinition,
  createStickerRoundState,
  sendStickerTool,
  viewStickerPackTool,
} from "../stickers";
import { buildGenerateImageToolDefinition, createGenerateImageExecutor } from "./imageGeneration";
import { buildToolStatusBlock } from "./toolStatus";
import { buildSendVoiceToolDefinition, createSendVoiceExecutor, isSendVoiceAvailable } from "./voiceMessage";
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
import { parseToolResult, toolError } from "../../utils/toolResult";
import { imageAiProvider } from "../../../provider";
import { createReplyActionChains } from "./actionChains";
import { createDirectPacing } from "./pacing";

/**
 * 组装工具定义、领域执行器和整轮共享的总动作预算。
 *
 * 工具清单只随部署能力变化（生图、语音是否配置，贴纸菜单），与触发类型、本群问答、
 * 手滑抽签无关，同一部署同一人设下每轮逐字相同；按轮变化的可用性写进
 * buildToolStatusBlock 产出的本轮工具状态，执行器在调用时再做同样的硬性判定。
 */
export async function createReplyToolset(ctx: ReplyToolContext, deliveryReady?: Promise<void>): Promise<ReplyToolset> {
  const menu: readonly StickerPackCandidate[] = await buildStickerPackMenu(ctx.signal);
  const stickerState: StickerRoundState = createStickerRoundState();
  const messageState: RoundMessageState = createRoundMessageState();
  let actionsUsed: number = 0;
  // 直接轮的节奏（见 pacing.ts 的 createDirectPacing）；有序并行轮为 null，链上每一步都做拟人停顿。
  const directPacing: DirectReplyPacing | null = ctx.direct ? createDirectPacing(ctx.chatAction, ctx.signal) : null;
  const chains: ReplyActionChains = createReplyActionChains(ctx, deliveryReady, directPacing);
  // 直接轮：上一批工具调用里看过贴纸包，下一次请求模型就是在挑贴纸。
  let choosingSticker: boolean = false;

  const viewDefinition: AiToolDefinition | null = buildViewStickerPackToolDefinition(menu);
  const sendStickerDefinition: AiToolDefinition | null = buildSendStickerToolDefinition(menu);
  // 生图与语音只看部署能力：本轮能不能用（直接触发资格、群冷却、每日余量）写进
  // 本轮工具状态，由执行器在调用时兜底拒绝，不摘挂工具。
  const imageEnabled: boolean = imageAiProvider() !== null;
  const voiceEnabled: boolean = isSendVoiceAvailable();
  const declarations: AiToolDefinition[] = [
    buildSendMessageToolDefinition(),
  ];
  if (imageEnabled) declarations.push(buildGenerateImageToolDefinition());
  if (voiceEnabled) declarations.push(buildSendVoiceToolDefinition());
  declarations.push(buildAddReactionToolDefinition());
  if (viewDefinition !== null) declarations.push(viewDefinition);
  if (sendStickerDefinition !== null) declarations.push(sendStickerDefinition);
  // 问答两件恒挂；本群有没有登记写在本轮工具状态里，没登记时执行器返回空清单。
  declarations.push(...buildGroupQaToolDefinitions());
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
  // 语音执行器只与已挂载的工具一同创建；未挂载的名称按未知工具处理。准入通过后在后台开始合成，
  // 交回接纳回执与投递步骤；窗口到点仍在合成时，投递步骤经 chains.defer 转入后台（见 voiceMessage.ts）。
  const executeSendVoice: ((argumentsJson: string) => ReplyToolExecution) | null =
    voiceEnabled ? createSendVoiceExecutor(ctx, chains) : null;

  /** 记下一次执行的回执：动作工具按回执占额度，接纳的动作交给串行链投递。 */
  function accept(name: string, isActionTool: boolean, execution: ReplyToolExecution): string {
    const result: string = typeof execution === "string" ? execution : execution.result;
    if (isActionTool) actionsUsed += parseToolResult(result).actionsUsed;
    if (typeof execution !== "string") chains.start(name, execution.run);
    return result;
  }

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
      case SEND_VOICE_TOOL:
        return executeSendVoice === null
          ? toolError(unknownToolError(name))
          : executeSendVoice(argumentsJson);
      case GROUP_QA_QUERY_TOOL:
        return executeGroupQaQuery(ctx.chatQa);
      case GROUP_QA_ANSWER_TOOL:
        return executeGroupQaAnswer(ctx.chatQa, argumentsJson);
      case VIEW_STICKER_PACK_TOOL: {
        const viewedBefore: number = stickerState.viewedPackIntents.size;
        const result: string = viewStickerPackTool({
          menu,
          argumentsJson,
          state: stickerState,
          signal: ctx.signal,
        });
        if (stickerState.viewedPackIntents.size > viewedBefore) choosingSticker = true;
        return result;
      }
      case SEND_STICKER_TOOL:
        return sendStickerTool({
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
    // 与 declarations 同一时刻取快照，交给运行时状态区块渲染（见 toolStatus.ts 与
    // workers/aiChat/runtimeState.ts）；前缀缓存约束见 docs/cn/04-invariants.md。
    toolStatus: buildToolStatusBlock({ ctx, imageEnabled, voiceEnabled }),
    // 服务端联网检索恒开，挂载约束见 docs/cn/04-invariants.md；回复循环只记账并在
    // 超出软限制时点名（见 workers/aiChat/replyModel.ts 与 consts/aiChat/tools.ts）。
    webSearch: true,
    has: (name: string): boolean => names.has(name),
    // 直接轮从请求模型起亮状态（串行链忙时由链上的步骤掌管，排空后再亮）。还没接纳过动作的请求亮
    // 「正在输入」，交回的第一条文字直接发出；刚看过贴纸包的那次请求是在挑贴纸，亮「正在选择贴纸」；
    // 其余请求多半是收尾，不亮状态，之后交回的动作都做拟人停顿。
    beforeModelRequest: (): void => {
      if (directPacing === null || !ctx.isActive()) return;
      directPacing.beforeModelRequest(choosingSticker ? "choose_sticker" : actionsUsed === 0 ? "typing" : "idle");
      choosingSticker = false;
    },
    afterModel: (): void => {
      directPacing?.endModel();
    },
    execute: (name: string, argumentsJson: string): string => {
      if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
      // 校验和接纳在调用时完成，两种轮次相同：动作按接纳回执先占额度，当场交回模型继续；
      // 拟人停顿、语音合成的等待与发送都由串行链执行，失败只记日志，不退额度给模型重复投递。
      const isActionTool: boolean = ACTION_TOOL_NAMES.includes(name);
      if (isActionTool && actionsUsed >= HARD_MAX_ACTIONS_PER_REPLY) {
        return toolError(
          `Action limit reached: at most ${HARD_MAX_ACTIONS_PER_REPLY} actions (messages + stickers + reactions + images + voices) per reply`
        );
      }
      return accept(name, isActionTool, dispatch(name, argumentsJson));
    },
    actionsUsed: (): number => actionsUsed,
    settle: (): Promise<void> => chains.settle(),
    actionsCompleted: (): number => chains.completed(),
    isActive: ctx.isActive,
    signal: ctx.signal,
  };
}
