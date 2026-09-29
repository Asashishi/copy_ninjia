/**
 * 本轮工具状态：运行时状态区块里按轮变化的工具可用性，每个有条件的工具一行，只写事实
 * （能不能用、是否冷却、还剩几次）。模型据此怎么做由系统提示词里的
 * REPLY_ACTION_INSTRUCTION 与各工具说明规定；工具清单本身每轮恒定。
 *
 * createReplyToolset 在组装工具的同一时刻取一次快照，同一回复的工具往返复用同一个
 * 字符串。快照在回复过程中可能过期（另一轮刚占了生图冷却或用掉最后一次语音），
 * 此时以各执行器在调用时的判定为准。
 *
 * 行序固定为生图 → 语音 → 问答。部署没有生图或语音能力时对应工具不挂，也不出这一行；
 * 问答两件恒挂，问答行恒出现。整段位于稳定前缀之后，写进冷却秒数与余量不影响
 * 供应商缓存（前缀约束见 docs/cn/04-invariants.md）。
 */

import {
  groupQaToolStatus,
  IMAGE_REFERENCE_ABSENT,
  IMAGE_TOOL_STATUS_UNAUTHORIZED,
  imageReferencePresent,
  imageToolStatusAvailable,
  imageToolStatusCoolingDown,
  TOOL_STATUS_BLOCK_LABEL,
  voiceToolStatus,
} from "../../../../consts/aiChat/prompts/tools";
import { agentTtsConfig } from "../../../../config/agent";
import { getImageGenerationAvailability } from "../../../../cache/workers/aiChat/imageGeneration";
import { aiTtsRemaining } from "../../ttsUsage";
import { ttsQuotaLimit } from "../../utils/ttsUsageWindow";
import { defaultAspectRatioFor } from "./imageGeneration";
import type { AgentTtsCapabilityConfig } from "../../../../types/config";
import type { ImageGenerationAvailability } from "../../../../types/aiChat/imageGeneration";
import type { ReplyToolContext } from "../../../../types/aiChat/replies";

/** 本模块从本轮回复上下文里真正读到的字段。 */
export type ToolStatusContext = Pick<
  ReplyToolContext,
  "chatId" | "chatQa" | "mediaToolsRequested" | "imageGenerationReference" | "bypassMediaToolCooldown"
>;

/** buildToolStatusBlock 的入参：上下文子集加部署级的两项能力。 */
export interface ToolStatusParams {
  readonly ctx: ToolStatusContext;
  /** 部署配置了生图能力，generate_image 恒挂。 */
  readonly imageEnabled: boolean;
  /** 部署配置了语音合成且实现具备这项能力，send_voice 恒挂。 */
  readonly voiceEnabled: boolean;
}

/** 生图行：先看触发资格，再看群冷却，都通过才给参考素材说明。 */
function imageStatusLine(ctx: ToolStatusContext): string {
  if (!ctx.mediaToolsRequested) return IMAGE_TOOL_STATUS_UNAUTHORIZED;
  const availability: ImageGenerationAvailability = getImageGenerationAvailability({
    chatId: ctx.chatId,
    bypassCooldown: ctx.bypassMediaToolCooldown,
  });
  if (!availability.allowed) {
    return imageToolStatusCoolingDown(Math.max(1, Math.ceil(availability.retryAfterMs / 1_000)));
  }
  const reference: ReplyToolContext["imageGenerationReference"] = ctx.imageGenerationReference;
  return imageToolStatusAvailable(reference
    ? imageReferencePresent(reference.width, reference.height, defaultAspectRatioFor(reference))
    : IMAGE_REFERENCE_ABSENT);
}

/** 语音行：按当前 `agent.tts` 的 `ai` 口径上限给出剩余次数。 */
function voiceStatusLine(): string {
  const tts: AgentTtsCapabilityConfig | undefined = agentTtsConfig();
  return voiceToolStatus(aiTtsRemaining(), tts === undefined ? 0 : ttsQuotaLimit(tts, "ai"));
}

/** 拼出本轮工具状态段（含段首标签），交给运行时状态区块。 */
export function buildToolStatusBlock({ ctx, imageEnabled, voiceEnabled }: ToolStatusParams): string {
  let block: string = TOOL_STATUS_BLOCK_LABEL;
  if (imageEnabled) block += "\n" + imageStatusLine(ctx);
  if (voiceEnabled) block += "\n" + voiceStatusLine();
  return block + "\n" + groupQaToolStatus(ctx.chatQa?.size ?? 0);
}
