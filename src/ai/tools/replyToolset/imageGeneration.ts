import {
  claimImageGeneration,
  getImageGenerationAvailability,
  type ImageGenerationClaim,
} from "../../../cache/aiChat/imageGeneration";
import {
  DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
  IMAGE_GENERATION_ASPECT_RATIOS,
  IMAGE_GENERATION_MAX_CONSECUTIVE_FAILURES_PER_REPLY,
  IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS,
  IMAGE_GENERATION_PROMPT_MAX_CHARS,
  type ImageGenerationAspectRatio,
} from "../../../consts/aiChat/imageGeneration";
import { GENERATE_IMAGE_TOOL_INSTRUCTION } from "../../../consts/aiChat/prompts/tools";
import { GENERATE_IMAGE_TOOL } from "../../../consts/tools";
import { sendPhoto } from "../../../infra/telegram";
import { isPlainRecord } from "../../../libs/runtimeConfig";
import { sanitizeInline, truncateInline } from "../../../libs/text";
import type { ReplyToolContext } from "../../../types/aiChat/replies";
import type { ToolDefinition } from "../../../types/tools";
import { generateChatImage, normalizeImageAspectRatio, type GeneratedChatImage } from "../../imageGeneration";
import { downloadTelegramVisionImage } from "../../telegramImage";
import { runMediaTask } from "../../mediaTaskRunner";
import type { VisionImage } from "../../../libs/image";

function defaultAspectRatioFor(reference: ReplyToolContext["imageGenerationReference"]): ImageGenerationAspectRatio {
  if (!reference || reference.width <= 0 || reference.height <= 0) return DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
  return normalizeImageAspectRatio(`${reference.width}:${reference.height}`) ?? DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
}

export function buildGenerateImageToolDefinition(
  ctx: Pick<ReplyToolContext, "chatId" | "imageGenerationRequested" | "imageGenerationReference" | "bypassImageGenerationCooldown">
): ToolDefinition {
  const availability: ImageGenerationClaim = getImageGenerationAvailability({
    chatId: ctx.chatId,
    bypassCooldown: ctx.bypassImageGenerationCooldown,
  });
  const availabilityInstruction: string = !ctx.imageGenerationRequested
    ? "当前状态：不可生图；当前消息不是直接回复或 @ 你的触发，本轮禁止调用。"
    : ctx.bypassImageGenerationCooldown
    ? "当前状态：可以生图；由你判断当前消息是否明确要求生成或编辑图片。本轮由 superAdmin 触发，不受群冷却限制。"
    : availability.allowed
    ? "当前状态：可以生图；由你判断当前消息是否明确要求生成或编辑图片，没有明确意图就不要调用。"
    : `当前状态：暂不可生图，群冷却剩余约 ${Math.ceil(availability.retryAfterMs / 1_000)} 秒；本轮不要调用。`;
  const defaultAspectRatio: ImageGenerationAspectRatio = defaultAspectRatioFor(ctx.imageGenerationReference);
  const referenceInstruction: string = ctx.imageGenerationReference
    ? `当前触发附带一份 ${ctx.imageGenerationReference.width}×${ctx.imageGenerationReference.height} 的参考图片素材；调用时会自动交给图片模型。` +
      `prompt 要写清如何编辑或参考这份素材，不要向群友索要 URL；未指定比例时默认使用最接近原素材的 ${defaultAspectRatio}。`
    : "当前触发没有附带参考图片，本轮只能按文字 prompt 从零生成。";
  return {
    name: GENERATE_IMAGE_TOOL,
    description: `${GENERATE_IMAGE_TOOL_INSTRUCTION}\n${availabilityInstruction}\n${referenceInstruction}`,
    parameters: {
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
  return async (argumentsJson: string): Promise<string> => {
    if (!ctx.isActive()) return JSON.stringify({ error: "Reply invalidated because AI chat was disabled" });
    if (!ctx.imageGenerationRequested) {
      return JSON.stringify({
        error: "Image generation is not authorized: the triggering message was not a direct reply to or mention of the bot",
        retryable: false,
      });
    }
    const parsed = parseArguments(argumentsJson, defaultAspectRatioFor(ctx.imageGenerationReference));
    if (!parsed) {
      return JSON.stringify({
        error: "Invalid image arguments: prompt must be non-empty and aspect_ratio must look like W:H, W/H, WxH, or W×H",
      });
    }

    if (consecutiveFailures >= IMAGE_GENERATION_MAX_CONSECUTIVE_FAILURES_PER_REPLY) {
      return JSON.stringify({
        error: "Image generation is disabled for the remainder of this reply after repeated failures; respond without retrying",
        retryable: false,
      });
    }

    const claim: ImageGenerationClaim = claimImageGeneration({
      chatId: ctx.chatId,
      bypassCooldown: ctx.bypassImageGenerationCooldown,
    });
    if (!claim.allowed) {
      return JSON.stringify({
        error: "Image generation is cooling down in this chat",
        retry_after_seconds: Math.ceil(claim.retryAfterMs / 1_000),
      });
    }

    ctx.chatAction.set("upload_photo");
    let image: GeneratedChatImage | null;
    let referenceUnavailable: boolean = false;
    try {
      let referenceImage: VisionImage | undefined;
      if (ctx.imageGenerationReference) {
        const referenceFileId: string = ctx.imageGenerationReference.fileId;
        referenceImage = await runMediaTask(() => downloadTelegramVisionImage({
          fileId: referenceFileId,
          logLabel: "image generation reference",
        })) ?? undefined;
        referenceUnavailable = referenceImage === undefined;
      }
      if (referenceUnavailable) {
        image = null;
      } else if (referenceImage) {
        image = await generateChatImage(parsed.prompt, parsed.aspectRatio, referenceImage);
      } else {
        image = await generateChatImage(parsed.prompt, parsed.aspectRatio);
      }
    } finally {
      // 与 send_message 落地前的处理一致：先阻止新的 upload_photo tick，再
      // 等已经发出的状态请求收敛，避免它晚于图片到达而重新挂出“正在发送图片”。
      ctx.chatAction.set("idle");
      await ctx.chatAction.settle();
    }
    if (!ctx.isActive()) return JSON.stringify({ error: "Reply invalidated because AI chat was disabled" });
    if (referenceUnavailable) {
      consecutiveFailures++;
      return JSON.stringify({ error: "Failed to load the reference image from Telegram" });
    }
    if (!image) {
      consecutiveFailures++;
      return JSON.stringify({ error: "Image generation failed or returned no usable image" });
    }

    const messageId: number | undefined = await sendPhoto({
      chatId: ctx.chatId,
      bytes: image.bytes,
      mimeType: image.mimeType,
      replyToMessageId: ctx.replyToMessageId,
    });
    if (messageId === undefined) {
      consecutiveFailures++;
      return JSON.stringify({ error: "Failed to send generated image" });
    }

    consecutiveFailures = 0;
    const memoryPrompt: string = truncateInline(sanitizeInline(parsed.prompt), IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS);
    ctx.onImageSent(`（${ctx.imageGenerationReference ? "参考素材" : ""}生成并发送了一张图片：${memoryPrompt}）`, messageId);
    return JSON.stringify({
      success: true,
      message_id: messageId,
      aspect_ratio: parsed.aspectRatio,
      resolution: "1K",
      ...(ctx.imageGenerationReference ? { reference_image_used: true } : {}),
    });
  };
}
