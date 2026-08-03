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
import {
  imageSentTagTemplate,
  SELF_ACTION_TAG_MARKERS,
  SELF_ACTION_TAG_PATTERNS,
} from "../../../../consts/aiChat/prompts/transcript";
import { TELEGRAM_CAPTION_MAX_CHARS, TELEGRAM_MESSAGE_MAX_CHARS } from "../../../../consts/telegram";
import { GENERATE_IMAGE_TOOL, REPLY_INVALIDATED_TOOL_ERROR } from "../../../../consts/tools";
import { toolError } from "../../utils/toolResult";
import { pauseForToolAction } from "../../utils/toolPause";
import { sendPhotoWithResult } from "../../../../infra/telegram";
import { isPlainRecord } from "../../../../libs/runtimeConfig";
import { sanitizeInline, truncateInline } from "../../../../libs/text";
import type { ReplyToolContext, RoundMessageState } from "../../../../types/aiChat/replies";
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
import { cleanReply } from "../../utils/replyText";
import { typingDelayMs } from "../../utils/timing";
import { isDuplicateOfSentMessage, sendDirectMessage } from "./messageState";

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

export function createGenerateImageExecutor(
  ctx: ReplyToolContext,
  state: RoundMessageState
): (argumentsJson: string) => Promise<string> {
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
    const parsed: ParsedImageArguments | null = parseArguments(argumentsJson, defaultAspectRatioFor(ctx.imageGenerationReference));
    if (!parsed) {
      return toolError(
        "Invalid image arguments: prompt must be non-empty, aspect_ratio must look like W:H, W/H, WxH, or W×H, and caption must be a string"
      );
    }
    const caption: string | null = parsed.caption;
    if (caption !== null) {
      // 图注要在生图之前就判死，别让模型白烧一次冷却：这两条都是重写 caption
      // 就能过的错误，此时还没 claim 冷却，模型改完可以立即重试。
      //
      // 伪造动作记号在图注里同样拦截。这里图确实发出去了，字面上不算撒谎，但
      // 记号的全部价值就在于「只有执行侧写得出来」——一旦模型也能合法产出这个
      // 形状，send_message 那道拦截（见 replyToolset/sendMessage.ts）就等于失效，
      // 下一轮它照样能在纯文本里照抄一遍。
      const forgedIndex: number = SELF_ACTION_TAG_PATTERNS.findIndex(
        (pattern: RegExp): boolean => pattern.test(caption)
      );
      if (forgedIndex >= 0) {
        const forgedMarker: string = SELF_ACTION_TAG_MARKERS[forgedIndex] ?? "";
        return toolError(
          `caption must not narrate an action: "${forgedMarker}" is a transcript marker the execution side writes after the action really happened. ` +
          "Just say what you want to say about the picture in your own words",
          { retryable: false }
        );
      }
      if (isDuplicateOfSentMessage(state, caption)) {
        return toolError(
          "An identical message was already sent in this round; write a different caption, or omit it and send the picture alone"
        );
      }
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

      // Bot API 对超过 caption 上限的图注是整条拒绝而不是截断，因此这里不赌：
      // 挂不上的图注不进 sendPhoto，改由下面补一条独立文本消息发出。
      const inlineCaption: string | null =
        caption !== null && caption.length <= TELEGRAM_CAPTION_MAX_CHARS ? caption : null;
      const sent: TelegramSendResult | undefined = await sendPhotoWithResult({
        chatId: ctx.chatId,
        bytes: image.bytes,
        mimeType: image.mimeType,
        replyToMessageId: ctx.replyToMessageId,
        signal: ctx.signal,
        ...(inlineCaption !== null ? { caption: inlineCaption } : {}),
      });
      if (sent === undefined) {
        consecutiveFailures++;
        return toolError("Failed to send generated image");
      }

      consecutiveFailures = 0;
      generatedImages++;
      const memoryPrompt: string = truncateInline(sanitizeInline(parsed.prompt), IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS);
      // 带图注时图和话是同一条消息（同一个 message_id），自录也必须是同一条：
      // 拆成 onImageSent + onMessageSent 会让一个 message_id 在转录里出现两次，
      // 回复链回溯到它时无从判断指的是哪一条。
      const imageTag: string = imageSentTagTemplate(memoryPrompt, ctx.imageGenerationReference !== undefined);
      // allow_sending_without_reply 可能让图片在目标已删除时退化为普通消息，
      // 自录只采用 Telegram 返回的实际回复关系。
      ctx.onImageSent(
        inlineCaption !== null ? `${imageTag}${inlineCaption}` : imageTag,
        sent.messageId,
        sent.repliedToMessageId
      );
      // 图注同样计入本轮已说过的话，模型随后再用 send_message 复述会被去重拦下。
      if (inlineCaption !== null) state.sentCanonicalTexts.set(sent.messageId, inlineCaption);

      // 超长图注的降级：图已经按无图注发出，这里补发一条独立文本。两条消息各
      // 占一个可见动作，用 actions_used 交给编排器结算（与 send_message 的手滑
      // 纠正同一条协议，见 replyToolset/orchestrator.ts）。
      let actionsUsedByTool: number = 1;
      let captionDelivery: "inline" | "separate_message" | "failed" | null =
        inlineCaption !== null ? "inline" : null;
      if (caption !== null && inlineCaption === null) {
        ctx.chatAction.set("typing");
        const invalidated: string | null = await pauseForToolAction({
          delayMs: typingDelayMs(caption),
          signal: ctx.signal,
        });
        ctx.chatAction.set("idle");
        await ctx.chatAction.settle();
        // 停顿期间轮次作废时不再补发，但图片本身已经落地，仍按成功返回——
        // 这里返回作废错误会让编排器连那张图的动作也不计。
        const captionMessageId: number | undefined = invalidated !== null
          ? undefined
          : await sendDirectMessage({
            ctx,
            state,
            text: caption,
            replyToMessageId: ctx.replyToMessageId,
          });
        if (captionMessageId === undefined) {
          captionDelivery = "failed";
        } else {
          captionDelivery = "separate_message";
          state.sentCanonicalTexts.set(captionMessageId, caption);
          actionsUsedByTool++;
        }
      }

      return JSON.stringify({
        success: true,
        message_id: sent.messageId,
        aspect_ratio: parsed.aspectRatio,
        resolution: "1K",
        actions_used: actionsUsedByTool,
        ...(captionDelivery !== null ? { caption_delivery: captionDelivery } : {}),
        ...(ctx.imageGenerationReference ? { reference_image_used: true } : {}),
      });
    } finally {
      if (!modelRequestStarted) releaseImageGenerationClaim(ctx.chatId, claim.token);
    }
  };
}
