import {
  claimImageGeneration,
  getImageGenerationAvailability,
  type ImageGenerationClaim,
} from "../../../cache/aiChat/imageGeneration";
import {
  IMAGE_GENERATION_ASPECT_RATIOS,
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

export function buildGenerateImageToolDefinition(
  ctx: Pick<ReplyToolContext, "chatId" | "bypassImageGenerationCooldown">
): ToolDefinition {
  const availability: ImageGenerationClaim = getImageGenerationAvailability({
    chatId: ctx.chatId,
    bypassCooldown: ctx.bypassImageGenerationCooldown,
  });
  const availabilityInstruction: string = ctx.bypassImageGenerationCooldown
    ? "当前状态：可以生图；本轮由 superAdmin 触发，不受群冷却限制。"
    : availability.allowed
    ? "当前状态：可以生图。"
    : `当前状态：暂不可生图，群冷却剩余约 ${Math.ceil(availability.retryAfterMs / 1_000)} 秒；本轮不要调用。`;
  return {
    name: GENERATE_IMAGE_TOOL,
    description: `${GENERATE_IMAGE_TOOL_INSTRUCTION}\n${availabilityInstruction}`,
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
            `群友要求的宽高比，例如 16:9、7:5 或 1920x1080；省略则为 1:1。官方比例为 ${IMAGE_GENERATION_ASPECT_RATIOS.join("、")}，` +
            "其它有效比例会由执行侧自动换成最接近的官方比例。",
        },
      },
      required: ["prompt"],
    },
  };
}

function parseArguments(argumentsJson: string): { prompt: string; aspectRatio: ImageGenerationAspectRatio } | null {
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
  const aspectRatio: ImageGenerationAspectRatio | null = normalizeImageAspectRatio(parsed.aspect_ratio);
  return aspectRatio ? { prompt, aspectRatio } : null;
}

export function createGenerateImageExecutor(ctx: ReplyToolContext): (argumentsJson: string) => Promise<string> {
  return async (argumentsJson: string): Promise<string> => {
    if (!ctx.isActive()) return JSON.stringify({ error: "Reply invalidated because AI chat was disabled" });
    const parsed = parseArguments(argumentsJson);
    if (!parsed) {
      return JSON.stringify({
        error: "Invalid image arguments: prompt must be non-empty and aspect_ratio must look like W:H, W/H, WxH, or W×H",
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

    const image: GeneratedChatImage | null = await generateChatImage(parsed.prompt, parsed.aspectRatio);
    if (!ctx.isActive()) return JSON.stringify({ error: "Reply invalidated because AI chat was disabled" });
    if (!image) return JSON.stringify({ error: "Image generation failed or returned no usable image" });

    const messageId: number | undefined = await sendPhoto({
      chatId: ctx.chatId,
      bytes: image.bytes,
      mimeType: image.mimeType,
      replyToMessageId: ctx.replyToMessageId,
    });
    if (messageId === undefined) return JSON.stringify({ error: "Failed to send generated image" });

    const memoryPrompt: string = truncateInline(sanitizeInline(parsed.prompt), IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS);
    ctx.onImageSent(`（生成并发送了一张图片：${memoryPrompt}）`, messageId);
    return JSON.stringify({ success: true, message_id: messageId, aspect_ratio: parsed.aspectRatio, resolution: "1K" });
  };
}
