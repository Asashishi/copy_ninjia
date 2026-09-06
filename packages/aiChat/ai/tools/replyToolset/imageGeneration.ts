import type { AiToolDefinition } from "../../../../types/aiChat/provider";
import { parseToolArguments } from "../../utils/toolArgs";
import {
  claimImageGeneration,
  getImageGenerationAvailability,
  releaseImageGenerationClaim,
} from "../../../../cache/workers/aiChat/imageGeneration";
import {
  DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
  IMAGE_GENERATION_ASPECT_RATIOS,
  IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS,
  IMAGE_GENERATION_PROMPT_MAX_CHARS,
  MAX_GENERATED_IMAGES_PER_REPLY,
} from "../../../../consts/aiChat/imageGeneration";
import {
  GENERATE_IMAGE_TOOL_INSTRUCTION,
  IMAGE_REFERENCE_POINTER,
} from "../../../../consts/aiChat/prompts/tools";
import { REPLY_CONTEXT_SECTION_NAMES } from "../../../../consts/aiChat/prompts/memory";
import { imageSentTagTemplate } from "../../../../consts/aiChat/prompts/transcript";
import {
  HARD_MAX_ACTIONS_PER_REPLY,
  IMAGE_SEPARATE_CAPTION_MIN_REMAINING_ACTIONS,
} from "../../../../consts/aiChat/tools";
import { TELEGRAM_CAPTION_MAX_CHARS, TELEGRAM_MESSAGE_MAX_CHARS } from "../../../../consts/telegram";
import { GENERATE_IMAGE_TOOL, REPLY_INVALIDATED_TOOL_ERROR } from "../../../../consts/tools";
import { toolError } from "../../utils/toolResult";
import { pauseForToolAction } from "../../utils/toolPause";
import { sendPhotoWithResult } from "../../../../infra/telegram";
import { sanitizeInline, truncateInline } from "../../../../libs/text";
import type { ReplyToolContext, ReplyToolExecution, RoundMessageState } from "../../../../types/aiChat/replies";
import type { ChatActionControl } from "../../../../types/aiChat/chatAction";
import type {
  GeneratedChatImage,
  ImageGenerationAspectRatio,
  ImageGenerationAvailability,
  ImageGenerationClaim,
} from "../../../../types/aiChat/imageGeneration";
import type { TelegramSendResult } from "../../../../types/telegram";
import { generateChatImage } from "../../imageGeneration";
import { normalizeImageAspectRatio } from "../../utils/aspectRatio";
import { downloadTelegramVisionImage } from "../../telegramImage";
import { runMediaTask } from "../../mediaTaskRunner";
import type { VisionImage } from "../../../../types/media";
import { cleanReply } from "../../utils/replyText";
import { typingDelayMs } from "../../utils/timing";
import { sendDirectMessage } from "./messageState";
import { modelAuthoredTextPolicyResult } from "./modelAuthoredText";

/** 省略 aspect_ratio 时执行侧采用的比例：有参考素材就取最接近它的官方比例。
 *  参考素材文案与执行侧解析共用这一个函数，两处默认值不会漂移（见 imageReference.ts）。 */
export function defaultAspectRatioFor(reference: ReplyToolContext["imageGenerationReference"]): ImageGenerationAspectRatio {
  if (!reference || reference.width <= 0 || reference.height <= 0) return DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
  return normalizeImageAspectRatio(`${reference.width}:${reference.height}`) ?? DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
}

/**
 * generate_image 的工具声明。**整段逐字恒定**，不接受任何本轮上下文。
 *
 * 参考素材尺寸随轮变化，写进声明会让整段稳定前缀每轮换一个指纹、把供应商侧的前缀
 * 缓存打穿；那段文案住在运行时状态区块，见 imageReference.ts。群冷却连提示词都不进：
 * 剩余秒数只在调用真的发生时由执行侧算给模型（见 createGenerateImageExecutor 的冷却
 * 闸）。工具是否挂载仍由 createReplyToolset 按 mediaToolsRequested 决定。
 */
export function buildGenerateImageToolDefinition(): AiToolDefinition {
  return {
    name: GENERATE_IMAGE_TOOL,
    description: `${GENERATE_IMAGE_TOOL_INSTRUCTION}\n${IMAGE_REFERENCE_POINTER}`,
    parametersJsonSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          maxLength: IMAGE_GENERATION_PROMPT_MAX_CHARS,
          description: "交给图片模型的完整独立画面提示词，应包含主体、场景、构图、风格、光线和需要呈现的文字。",
        },
        aspect_ratio: {
          type: "string",
          description:
            `群友要求的宽高比，例如 16:9、7:5 或 1920x1080；省略则按 ${REPLY_CONTEXT_SECTION_NAMES.runtimeState} 区块给出的默认比例。` +
            `官方比例为 ${IMAGE_GENERATION_ASPECT_RATIOS.join("、")}，` +
            "其它有效比例会由执行侧自动换成最接近的官方比例。",
        },
        caption: {
          type: "string",
          maxLength: TELEGRAM_MESSAGE_MAX_CHARS,
          description:
            "随图一起发出的图注：连图带话是同一条消息，不用再单独调用 send_message 说一遍。" +
            "写你想对群友说的原话，不要写画面描述或对工具的解释——画面说明属于 prompt。" +
            `没什么要说的就省略，只发图。尽量控制在 ${TELEGRAM_CAPTION_MAX_CHARS} 字以内；` +
            "超出这个长度 Telegram 不允许挂在图上，执行侧会自动拆成「图 + 一条独立文字消息」两条发出，多占一个动作。",
        },
      },
      required: ["prompt"],
    },
  };
}

/** 解析后的生图入参；caption 已走过 send_message 同一套正文清洗，缺省为 null。 */
interface ParsedImageArguments {
  prompt: string;
  aspectRatio: ImageGenerationAspectRatio;
  caption: string | null;
}

function parseArguments(
  argumentsJson: string,
  defaultAspectRatio: ImageGenerationAspectRatio
): ParsedImageArguments | null {
  const parsed: Record<string, unknown> | null = parseToolArguments(argumentsJson);
  if (parsed === null || typeof parsed.prompt !== "string") return null;
  const prompt: string = parsed.prompt.trim();
  if (!prompt || prompt.length > IMAGE_GENERATION_PROMPT_MAX_CHARS) return null;
  if (parsed.aspect_ratio !== undefined && typeof parsed.aspect_ratio !== "string") return null;
  // caption 是「省略就只发图」的纯可选字段，因此 null 和 undefined 一样按没写
  // 处理：模型把可选参数填成 null 很常见，为此整条调用报参数错误会让它白跑一
  // 轮，还得从一句「caption must be a string」里猜出自己其实什么都不用改。
  if (parsed.caption !== undefined && parsed.caption !== null && typeof parsed.caption !== "string") return null;
  const requestedAspectRatio: string | undefined = parsed.aspect_ratio;
  const aspectRatio: ImageGenerationAspectRatio | null = requestedAspectRatio === undefined || requestedAspectRatio.trim() === ""
    ? defaultAspectRatio
    : normalizeImageAspectRatio(requestedAspectRatio);
  // 图注和 send_message 的 text 一样是群友直接看到的原话，因此共用 cleanReply：
  // 去掉引用标记、代码围栏和整句包裹引号，并按文本消息上限兜底截断。清洗后
  // 只剩空串时按「没写图注」处理，不当成参数错误——只发图本来就是合法调用。
  const caption: string | null = typeof parsed.caption === "string" ? cleanReply(parsed.caption) : null;
  return aspectRatio ? { prompt, aspectRatio, caption } : null;
}

/**
 * 冷却未过时回给模型的统一提示。
 *
 * 调用入口的只读判定与 claim 落空（同群并发轮抢在前面）共用这一段：模型的提示词里
 * 没有任何冷却状态，这条工具结果是它唯一一次知道「还要等多久」的机会，两条路径的
 * 文案与秒数口径因此必须同源。
 * @param retryAfterMs 冷却剩余毫秒，由生图冷却表给出。
 */
function coolingDownError(retryAfterMs: number): string {
  const retryAfterSeconds: number = Math.ceil(retryAfterMs / 1_000);
  return toolError("Image generation is cooling down in this chat", {
    retry_after_seconds: retryAfterSeconds,
    retryable: false,
    required_action:
      `必须使用 send_message 明确告诉群友当前暂时不能使用生图，请约 ${retryAfterSeconds} 秒后再试；` +
      "本轮不要再次调用 generate_image。",
  });
}

export function createGenerateImageExecutor(
  ctx: ReplyToolContext,
  state: RoundMessageState,
  getActionsUsed: () => number
): (argumentsJson: string) => ReplyToolExecution {
  let acceptedImages: number = 0;
  return (argumentsJson: string): ReplyToolExecution => {
    if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    if (!ctx.mediaToolsRequested) {
      return toolError(
        "Image generation is not authorized: the triggering message was not a direct reply to or mention of the bot",
        { retryable: false }
      );
    }
    if (acceptedImages >= MAX_GENERATED_IMAGES_PER_REPLY) {
      return toolError(
        `Image limit reached: at most ${MAX_GENERATED_IMAGES_PER_REPLY} generated image per reply`,
        { retryable: false }
      );
    }
    // 冷却整条不进提示词，模型是在不知道本轮还剩多久的情况下调用的：因此在解析参数、
    // 下载参考图和请求模型之前先做一次只读判定，冷却中直接把剩余秒数回给它。真正的
    // 原子闸仍是下面的 claim——只读判定与 claim 之间同群另一轮可能抢先占位，那条路径
    // 回同一段文案。
    const availability: ImageGenerationAvailability = getImageGenerationAvailability({
      chatId: ctx.chatId,
      bypassCooldown: ctx.bypassMediaToolCooldown,
    });
    if (!availability.allowed) return coolingDownError(availability.retryAfterMs);
    const parsed: ParsedImageArguments | null = parseArguments(argumentsJson, defaultAspectRatioFor(ctx.imageGenerationReference));
    if (!parsed) {
      return toolError(
        "Invalid image arguments: prompt must be non-empty, aspect_ratio must look like W:H, W/H, WxH, or W×H, and caption must be a string"
      );
    }
    const caption: string | null = parsed.caption;
    if (caption !== null) {
      // 在实际生成和 claim 冷却前完成硬校验，拒绝的 caption 不产生账单或冷却。
      const policyResult: string | null = modelAuthoredTextPolicyResult(caption, state, "picture");
      if (policyResult !== null) return policyResult;
    }

    const claim: ImageGenerationClaim = claimImageGeneration({
      chatId: ctx.chatId,
      bypassCooldown: ctx.bypassMediaToolCooldown,
    });
    if (!claim.allowed) return coolingDownError(claim.retryAfterMs);
    acceptedImages++;
    const inlineCaption: string | null =
      caption !== null && caption.length <= TELEGRAM_CAPTION_MAX_CHARS ? caption : null;
    const captionBudgetLeft: boolean =
      HARD_MAX_ACTIONS_PER_REPLY - getActionsUsed() >= IMAGE_SEPARATE_CAPTION_MIN_REMAINING_ACTIONS;
    const separateCaption: boolean = caption !== null && inlineCaption === null && captionBudgetLeft;
    if (caption !== null && (inlineCaption !== null || separateCaption)) state.acceptedCanonicalTexts.add(caption);
    return {
      result: JSON.stringify({
        success: true,
        queued: true,
        actions_used: separateCaption ? 2 : 1,
        aspect_ratio: parsed.aspectRatio,
        ...(caption !== null ? { caption_delivery: inlineCaption !== null ? "inline" : separateCaption ? "separate_message" : "no_action_budget" } : {}),
      }),
      run: async (chatAction: ChatActionControl): Promise<string> => {
        let modelRequestStarted: boolean = false;
        try {
          if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
          chatAction.set("upload_photo");
          let image: GeneratedChatImage | null;
          let referenceUnavailable: boolean = false;
          try {
            let referenceImage: VisionImage | undefined;
            if (ctx.imageGenerationReference) {
              const referenceFileId: string = ctx.imageGenerationReference.fileId;
              referenceImage = await runMediaTask((): Promise<VisionImage | null> => downloadTelegramVisionImage({
                fileId: referenceFileId,
                logLabel: "image generation reference",
                signal: ctx.signal,
              })) ?? undefined;
              referenceUnavailable = referenceImage === undefined;
            }
            if (referenceUnavailable) {
              image = null;
            } else {
              if (!ctx.isActive()) {
                return toolError(REPLY_INVALIDATED_TOOL_ERROR);
              }
              modelRequestStarted = true;
              image = await generateChatImage({
                prompt: parsed.prompt,
                aspectRatio: parsed.aspectRatio,
                referenceImage,
                signal: ctx.signal,
              });
            }
          } finally {
            chatAction.set("idle");
            await chatAction.settle();
          }
          if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
          if (referenceUnavailable) {
            return toolError("Failed to load the reference image from Telegram");
          }
          if (!image) {
            return toolError("Image generation failed or returned no usable image", {
              retryable: false,
            });
          }

          const sent: TelegramSendResult | undefined = await sendPhotoWithResult({
            chatId: ctx.chatId,
            bytes: image.bytes,
            mimeType: image.mimeType,
            replyToMessageId: ctx.replyToMessageId,
            signal: ctx.signal,
            messageThreadId: ctx.messageThreadId,
            ...(inlineCaption !== null ? { caption: inlineCaption } : {}),
          });
          if (sent === undefined) {
            return toolError("Failed to send generated image", { retryable: false });
          }

          const memoryPrompt: string = truncateInline(sanitizeInline(parsed.prompt), IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS);
          const imageTag: string = imageSentTagTemplate(memoryPrompt, ctx.imageGenerationReference !== undefined);

          ctx.onImageSent(
            inlineCaption !== null ? `${imageTag}${inlineCaption}` : imageTag,
            sent.messageId,
            sent.repliedToMessageId
          );

          let actionsUsedByTool: number = 1;
          let captionDelivery: "inline" | "separate_message" | "failed" | "no_action_budget" | null =
            inlineCaption !== null ? "inline" : null;

          if (caption !== null && inlineCaption === null && !captionBudgetLeft) {
            captionDelivery = "no_action_budget";
          } else if (caption !== null && inlineCaption === null) {
            chatAction.set("typing");
            const invalidated: string | null = await pauseForToolAction({
              delayMs: typingDelayMs(caption),
              signal: ctx.signal,
            });
            chatAction.set("idle");
            await chatAction.settle();

            const captionMessageId: number | undefined = invalidated !== null
              ? undefined
              : await sendDirectMessage({
                ctx,
                text: caption,
                replyToMessageId: ctx.replyToMessageId,
              });
            if (captionMessageId === undefined) {
              captionDelivery = "failed";
            } else {
              captionDelivery = "separate_message";
              actionsUsedByTool++;
            }
          }

          return JSON.stringify({
            success: true,
            message_id: sent.messageId,
            aspect_ratio: parsed.aspectRatio,
            actions_used: actionsUsedByTool,
            ...(captionDelivery !== null ? { caption_delivery: captionDelivery } : {}),
            ...(ctx.imageGenerationReference ? { reference_image_used: true } : {}),
          });
        } finally {
          if (!modelRequestStarted) releaseImageGenerationClaim(ctx.chatId, claim.token);
        }
      },
    };
  };
}
