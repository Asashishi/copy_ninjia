import type { AiToolDefinition } from "../../../../types/aiChat/provider";
import { HARD_MAX_ACTIONS_PER_REPLY } from "../../../../consts/aiChat/tools";
import {
  ACTION_TOOL_NAMES,
  REPLY_INVALIDATED_TOOL_ERROR,
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
  PreparedReplyAction,
  ReplyActionChains,
  ReplyActionPause,
  ReplyToolContext,
  ReplyToolExecution,
  ReplyToolset,
  RoundMessageState,
} from "../../../../types/aiChat/replies";
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
import { logger } from "../../../../infra/logger";
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
  const chains: ReplyActionChains = createReplyActionChains(ctx, deliveryReady);
  // 直接轮：上一批工具调用里看过贴纸包，下一次请求模型就是在挑贴纸。
  let choosingSticker: boolean = false;
  const directPacing: DirectReplyPacing = createDirectPacing(ctx.chatAction, ctx.signal);

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
  // 语音执行器只与已挂载的工具一同创建；未挂载的名称按未知工具处理。准入通过后它自己投递（直接轮
  // 在调用内发出，有序并行轮排进串行链），交回最多等前台窗口的回执 Promise（见 voiceMessage.ts）。
  const executeSendVoice: ((argumentsJson: string) => string | Promise<string>) | null =
    voiceEnabled ? createSendVoiceExecutor(ctx, chains) : null;

  /**
   * 直接轮：在工具调用内执行动作，按直接轮节奏切挡与停顿（见 pacing.ts 的 createDirectPacing，只有
   * send_message 算文字），把真实结果交回模型并经 chains.record 记账；send_voice 交来的是已在调用内
   * 投递并记账的结果。执行抛错时记英文日志并回不可重试错误。无论结果如何，动作执行完都收回挡位并
   * 开始静默。
   */
  async function runDirect(name: string, execution: PreparedReplyAction | Promise<string>): Promise<string> {
    const pause: ReplyActionPause = directPacing.startAction(name === SEND_MESSAGE_TOOL);
    try {
      if (execution instanceof Promise) return await execution;
      const result: string = await execution.run(ctx.chatAction, pause);
      chains.record(name, result);
      return result;
    } catch (error: unknown) {
      if (ctx.isActive()) logger.error(`AI reply action failed (chat ${ctx.chatId}, tool ${name}):`, error);
      return toolError(`Action ${name} failed unexpectedly`, { retryable: false });
    } finally {
      directPacing.endAction();
    }
  }

  /** 调用内等结果的动作（send_voice，以及直接轮的全部动作）：按交回模型的结果占额度。 */
  function settleInCall(isActionTool: boolean, pending: Promise<string>): Promise<string> {
    return pending.then((result: string): string => {
      if (isActionTool) actionsUsed += parseToolResult(result).actionsUsed;
      return result;
    });
  }

  /** 记下一次执行的回执：动作工具按回执占额度，接纳的动作交给串行链投递。 */
  function accept(name: string, isActionTool: boolean, execution: ReplyToolExecution): string {
    const result: string = typeof execution === "string" ? execution : execution.result;
    if (isActionTool) actionsUsed += parseToolResult(result).actionsUsed;
    if (typeof execution !== "string") chains.start(name, execution.run);
    return result;
  }

  function dispatch(name: string, argumentsJson: string): ReplyToolExecution | Promise<string> {
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
    // 直接轮从请求模型起亮状态，直到模型交回的动作在调用内执行时切到各自的挡位。还没执行过动作的
    // 请求亮「正在输入」，交回的第一条文字直接发出；刚看过贴纸包的那次请求是在挑贴纸，亮「正在选择
    // 贴纸」；其余请求多半是收尾，不亮状态，之后交回的动作都做拟人停顿。
    beforeModelRequest: (): void => {
      if (!ctx.direct || !ctx.isActive()) return;
      directPacing.beforeModelRequest(choosingSticker ? "choose_sticker" : actionsUsed === 0 ? "typing" : "idle");
      choosingSticker = false;
    },
    afterModel: (): void => {
      if (ctx.direct) directPacing.endModel();
    },
    execute: (name: string, argumentsJson: string): Promise<string> => {
      if (!ctx.isActive()) {
        return Promise.resolve(toolError(REPLY_INVALIDATED_TOOL_ERROR));
      }
      // 校验和接纳在调用时完成。有序并行轮：正文与附加动作按接纳回执先占额度再让模型继续，
      // 由串行链投递，投递失败不退额度给模型重复投递；send_voice 的投递在调用时就按顺序排进
      // 串行链，回执最多等合成一个前台窗口（VOICE_FOREGROUND_WAIT_MS）。直接轮：动作在调用内
      // 执行，按真实结果占额度。模型的函数调用按顺序逐个执行，等待期间不会有第二个 execute 进来。
      const isActionTool: boolean = ACTION_TOOL_NAMES.includes(name);
      if (isActionTool && actionsUsed >= HARD_MAX_ACTIONS_PER_REPLY) {
        return Promise.resolve(toolError(
          `Action limit reached: at most ${HARD_MAX_ACTIONS_PER_REPLY} actions (messages + stickers + reactions + images + voices) per reply`
        ));
      }

      const dispatched: ReplyToolExecution | Promise<string> = dispatch(name, argumentsJson);
      if (ctx.direct && typeof dispatched !== "string") {
        return settleInCall(isActionTool, runDirect(name, dispatched));
      }
      if (dispatched instanceof Promise) return settleInCall(isActionTool, dispatched);
      return Promise.resolve(accept(name, isActionTool, dispatched));
    },
    actionsUsed: (): number => actionsUsed,
    settle: (): Promise<void> => chains.settle(),
    actionsCompleted: (): number => chains.completed(),
    isActive: ctx.isActive,
    signal: ctx.signal,
  };
}
