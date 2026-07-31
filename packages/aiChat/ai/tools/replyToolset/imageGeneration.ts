import type { FunctionDeclaration } from "@google/genai";
import {
  claimImageGeneration,
  getImageGenerationAvailability,
  releaseImageGenerationClaim,
} from "../../../../cache/workers/aiChat/imageGeneration";
import {
  DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
  IMAGE_GENERATION_ASPECT_RATIOS,
  IMAGE_GENERATION_MAX_CONSECUTIVE_FAILURES_PER_REPLY,
  IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS,
  IMAGE_GENERATION_PROMPT_MAX_CHARS,
  MAX_GENERATED_IMAGES_PER_REPLY,
} from "../../../../consts/aiChat/imageGeneration";
import { GENERATE_IMAGE_TOOL_INSTRUCTION } from "../../../../consts/aiChat/prompts/tools";
import { imageSentTagTemplate } from "../../../../consts/aiChat/prompts/transcript";
import { GENERATE_IMAGE_TOOL, REPLY_INVALIDATED_TOOL_ERROR } from "../../../../consts/tools";
import { toolError } from "../../utils/toolResult";
import { sendPhotoWithResult } from "../../../../infra/telegram";
import { isPlainRecord } from "../../../../libs/runtimeConfig";
import { sanitizeInline, truncateInline } from "../../../../libs/text";
import type { ReplyToolContext } from "../../../../types/aiChat/replies";
import type {
  GeneratedChatImage,
  ImageGenerationAspectRatio,
  ImageGenerationAvailability,
  ImageGenerationClaim,
} from "../../../../types/aiChat/imageGeneration";
import type { TelegramSendResult } from "../../../../types/telegram";
import { generateChatImage, normalizeImageAspectRatio } from "../../imageGeneration";
import { downloadTelegramVisionImage } from "../../telegramImage";
import { runMediaTask } from "../../mediaTaskRunner";
import type { VisionImage } from "../../../../types/media";

function defaultAspectRatioFor(reference: ReplyToolContext["imageGenerationReference"]): ImageGenerationAspectRatio {
  if (!reference || reference.width <= 0 || reference.height <= 0) return DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
  return normalizeImageAspectRatio(`${reference.width}:${reference.height}`) ?? DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
}

export function buildGenerateImageToolDefinition(
  ctx: Pick<ReplyToolContext, "chatId" | "imageGenerationRequested" | "imageGenerationReference" | "bypassImageGenerationCooldown">
): FunctionDeclaration {
  const availability: ImageGenerationAvailability = getImageGenerationAvailability({
    chatId: ctx.chatId,
    bypassCooldown: ctx.bypassImageGenerationCooldown,
  });
  const availabilityInstruction: string = !ctx.imageGenerationRequested
    ? "当前状态：不可生图；当前消息不是直接回复或 @ 你的触发，本轮禁止调用。"
    : ctx.bypassImageGenerationCooldown
    ? "当前状态：可以生图；由你判断当前消息是否明确要求生成或编辑图片。本轮由 superAdmin 触发，不受群冷却限制。"
    : availability.allowed
    ? "当前状态：可以生图；由你判断当前消息是否明确要求生成或编辑图片，没有明确意图就不要调用。"
    : `当前状态：暂不可生图，群冷却剩余约 ${Math.ceil(availability.retryAfterMs / 1_000)} 秒；本轮不要调用，` +
      "并且必须用 send_message 明确告诉群友当前暂时不能使用生图，请稍后再试。";
  const defaultAspectRatio: ImageGenerationAspectRatio = defaultAspectRatioFor(ctx.imageGenerationReference);
  const referenceInstruction: string = ctx.imageGenerationReference
    ? `当前触发附带一份 ${ctx.imageGenerationReference.width}×${ctx.imageGenerationReference.height} 的参考图片素材；调用时会自动交给图片模型。` +
      `prompt 要写清如何编辑或参考这份素材，不要向群友索要 URL；未指定比例时默认使用最接近原素材的 ${defaultAspectRatio}。`
    : "当前触发没有附带参考图片，本轮只能按文字 prompt 从零生成。";
  return {
    name: GENERATE_IMAGE_TOOL,
    description: `${GENERATE_IMAGE_TOOL_INSTRUCTION}\n${availabilityInstruction}\n${referenceInstruction}`,
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
            `群友要求的宽高比，例如 16:9、7:5 或 1920x1080；省略则为 ${defaultAspectRatio}。官方比例为 ${IMAGE_GENERATION_ASPECT_RATIOS.join("、")}，` +
            "其它有效比例会由执行侧自动换成最接近的官方比例。",
        },
      },
      required: ["prompt"],
    },
  };
}

function parseArguments(
  argumentsJson: string,
  defaultAspectRatio: ImageGenerationAspectRatio
): { prompt: string; aspectRatio: ImageGenerationAspectRatio } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed) || typeof parsed.prompt !== "string") return null;
  const prompt: string = parsed.prompt.trim();
  if (!prompt || prompt.length > IMAGE_GENERATION_PROMPT_MAX_CHARS) return null;
  if (parsed.aspect_ratio !== undefined && typeof parsed.aspect_ratio !== "string") return null;
  const requestedAspectRatio: string | undefined = parsed.aspect_ratio;
  const aspectRatio: ImageGenerationAspectRatio | null = requestedAspectRatio === undefined || requestedAspectRatio.trim() === ""
    ? defaultAspectRatio
    : normalizeImageAspectRatio(requestedAspectRatio);
  return aspectRatio ? { prompt, aspectRatio } : null;
}

export function createGenerateImageExecutor(ctx: ReplyToolContext): (argumentsJson: string) => Promise<string> {
  let consecutiveFailures: number = 0;
  let generatedImages: number = 0;
  return async (argumentsJson: string): Promise<string> => {
    if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    if (!ctx.imageGenerationRequested) {
      return toolError(
        "Image generation is not authorized: the triggering message was not a direct reply to or mention of the bot",
        { retryable: false }
      );
    }
    if (generatedImages >= MAX_GENERATED_IMAGES_PER_REPLY) {
      return toolError(
        `Image limit reached: at most ${MAX_GENERATED_IMAGES_PER_REPLY} generated image per reply`,
        { retryable: false }
      );
    }
    const parsed: { prompt: string; aspectRatio: ImageGenerationAspectRatio; } | null = parseArguments(argumentsJson, defaultAspectRatioFor(ctx.imageGenerationReference));
    if (!parsed) {
      return toolError(
        "Invalid image arguments: prompt must be non-empty and aspect_ratio must look like W:H, W/H, WxH, or W×H"
      );
    }

    if (consecutiveFailures >= IMAGE_GENERATION_MAX_CONSECUTIVE_FAILURES_PER_REPLY) {
      return toolError(
        "Image generation is disabled for the remainder of this reply after repeated failures; respond without retrying",
        { retryable: false }
      );
    }

    const claim: ImageGenerationClaim = claimImageGeneration({
      chatId: ctx.chatId,
      bypassCooldown: ctx.bypassImageGenerationCooldown,
    });
    if (!claim.allowed) {
      const retryAfterSeconds: number = Math.ceil(claim.retryAfterMs / 1_000);
      return toolError("Image generation is cooling down in this chat", {
        retry_after_seconds: retryAfterSeconds,
        retryable: false,
        required_action:
          `必须使用 send_message 明确告诉群友当前暂时不能使用生图，请约 ${retryAfterSeconds} 秒后再试；` +
          "本轮不要再次调用 generate_image。",
      });
    }

    let modelRequestStarted: boolean = false;
    try {
      ctx.chatAction.set("upload_photo");
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
        // 与 send_message 落地前的处理一致：先阻止新的 upload_photo tick，再
        // 等已经发出的状态请求收敛，避免它晚于图片到达而重新挂出“正在发送图片”。
        ctx.chatAction.set("idle");
        await ctx.chatAction.settle();
      }
      if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
      if (referenceUnavailable) {
        consecutiveFailures++;
        return toolError("Failed to load the reference image from Telegram");
      }
      if (!image) {
        consecutiveFailures++;
        return toolError("Image generation failed or returned no usable image");
      }

      const sent: TelegramSendResult | undefined = await sendPhotoWithResult({
        chatId: ctx.chatId,
        bytes: image.bytes,
        mimeType: image.mimeType,
        replyToMessageId: ctx.replyToMessageId,
        signal: ctx.signal,
      });
      if (sent === undefined) {
        consecutiveFailures++;
        return toolError("Failed to send generated image");
      }

      consecutiveFailures = 0;
      generatedImages++;
      const memoryPrompt: string = truncateInline(sanitizeInline(parsed.prompt), IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS);
      // allow_sending_without_reply 可能让图片在目标已删除时退化为普通消息，
      // 自录只采用 Telegram 返回的实际回复关系。
      ctx.onImageSent(
        imageSentTagTemplate(memoryPrompt, ctx.imageGenerationReference !== undefined),
        sent.messageId,
        sent.repliedToMessageId
      );
      return JSON.stringify({
        success: true,
        message_id: sent.messageId,
        aspect_ratio: parsed.aspectRatio,
        resolution: "1K",
        ...(ctx.imageGenerationReference ? { reference_image_used: true } : {}),
      });
    } finally {
      if (!modelRequestStarted) releaseImageGenerationClaim(ctx.chatId, claim.token);
    }
  };
}
