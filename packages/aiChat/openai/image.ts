/**
 * OpenAI 侧的生图。无参考图走 images.generate，有参考图走 images.edit。
 *
 * 画幅映射收在本包内：OpenAI 官方 gpt-image-2 协议（`openai`）发送满足 16 像素倍数约束的
 * `size`；`openai-standard` 取全系共同支持的标准尺寸；xAI 的 Grok Imagine 改用 `aspect_ratio`。
 * 领域侧始终按 ImageGenerationAspectRatio 表达意图（见 consts/aiChat/openai.ts 的
 * OPENAI_FLEXIBLE_IMAGE_SIZE_BY_ASPECT_RATIO、OPENAI_STANDARD_IMAGE_SIZE_BY_ASPECT_RATIO
 * 与下方 pickXAiAspectRatio）。
 *
 * 载荷校验（base64 规范性、大小上限、文件签名）走 aiChat/ai/utils/imagePayload.ts，
 * 按字节签名判定格式。OpenAI 原生请求以 output_format 指定格式，
 * xAI 协议用 response_format 指定 base64 信封；解码器同时接受 PNG/JPEG。
 *
 * 本模块只读 `b64_json`：响应里只有 url 的情况在日志里与「一条也没有」分开点名，见下方读取处。
 *
 * xAI edit 不走 SDK `images.edit()` 的 multipart 请求，参考图作为 base64 data URI 放进 JSON：
 * 复用同一个 SDK 客户端的底层 `post`（保留认证、超时和重试），只替换请求体形状。
 *
 * 内容审核档位：只有 OpenAI 原生 generate 带 moderation（SDK 只在 generate 的参数类型上声明它，
 * 见 consts/aiChat/openai.ts 的 OPENAI_IMAGE_MODERATION）；xAI 两条分支不发送审核字段。
 *
 * 线协议由 config/agentCapability.ts 从 agent.image 的必填 image_protocol 解析，随 agent
 * 配置快照缓存。
 * 新增协议必须扩展 OpenAiImageProtocol 与下方各处穷举 switch。
 */

import { toFile } from "openai";
import type OpenAI from "openai";
import type { Uploadable } from "openai";
import {
  OPENAI_IMAGE_ERROR_LABEL,
  OPENAI_IMAGE_MODERATION,
  OPENAI_IMAGE_OUTPUT_FORMAT,
  OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
  OPENAI_FLEXIBLE_IMAGE_SIZE_BY_ASPECT_RATIO,
  OPENAI_STANDARD_IMAGE_SIZE_BY_ASPECT_RATIO,
  XAI_IMAGE_RESOLUTION,
} from "../../consts/aiChat/openai";
import { getAgentDeploymentConfig } from "../../config/agent";
import { logger } from "../../infra/logger";
import { reportAiCacheUsage, reportXAiUsage } from "../../infra/aiCacheUsage";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { decodeGeneratedImageBySignature } from "../ai/utils/imagePayload";
import { getOpenAiClient } from "./client";
import type { AiImageRequest } from "../../types/aiChat/provider";
import type { AgentImageCapabilityConfig, OpenAiAgentImageCapabilityConfig, OpenAiImageProtocol } from "../../types/config";
import type {
  GeneratedChatImage,
  GeneratedImageDecodeResult,
  ImageGenerationAspectRatio,
} from "../../types/aiChat/imageGeneration";
import type { VisionImage } from "../../types/media";

/** xAI 官方支持、且本仓领域比例会实际映射到的画幅。 */
type XAiImageAspectRatio =
  | "1:1" | "3:2" | "2:3" | "3:4" | "4:3" | "9:16" | "16:9" | "20:9";

/** OpenAI SDK 原生请求中两种显式尺寸能力档。 */
type OpenAiNativeImageProtocol = Exclude<OpenAiImageProtocol, "xai">;

/** xAI generate 的 OpenAI SDK 扩展请求体；额外字段来自 xAI 官方接口。 */
interface XAiImageGenerateParams extends OpenAI.Images.ImageGenerateParamsNonStreaming {
  readonly model: string;
  readonly aspect_ratio: XAiImageAspectRatio;
  readonly resolution: string;
  readonly response_format: "b64_json";
  readonly n: 1;
}

/** xAI JSON edit 请求里的单张 data URI 输入。 */
interface XAiImageInput {
  readonly type: "image_url";
  readonly url: string;
}

/** xAI edit 不兼容 SDK 的 multipart 类型，故只描述官方 JSON 请求体。 */
interface XAiImageEditParams {
  readonly model: string;
  readonly prompt: string;
  readonly image: XAiImageInput;
  readonly resolution: string;
  readonly response_format: "b64_json";
}

/**
 * 按显式能力档读取 OpenAI 官方尺寸；不解析模型名，也不在失败后换档重试。
 * 两张固定 Record 在编译期要求覆盖全部领域比例。
 */
function pickOpenAiImageSize(
  protocol: OpenAiNativeImageProtocol,
  aspectRatio: ImageGenerationAspectRatio
): string {
  switch (protocol) {
    case "openai": return OPENAI_FLEXIBLE_IMAGE_SIZE_BY_ASPECT_RATIO[aspectRatio];
    case "openai-standard": return OPENAI_STANDARD_IMAGE_SIZE_BY_ASPECT_RATIO[aspectRatio];
    default: {
      const unhandledProtocol: never = protocol;
      throw new Error(`Unsupported native OpenAI image protocol: ${String(unhandledProtocol)}`);
    }
  }
}

/**
 * 领域比例到 xAI 官方画幅的映射：5:4、4:5 分别取最近的 4:3、3:4，21:9 取最近的 20:9，
 * 其余原样发送。
 */
function pickXAiAspectRatio(aspectRatio: ImageGenerationAspectRatio): XAiImageAspectRatio {
  switch (aspectRatio) {
    case "5:4": return "4:3";
    case "4:5": return "3:4";
    case "21:9": return "20:9";
    default: return aspectRatio;
  }
}

/** 参考图转 SDK 可上传的文件句柄；扩展名跟随实际 MIME，服务端据此判格式。 */
function toReferenceUpload(referenceImage: VisionImage): Promise<Uploadable> {
  const extension: string = referenceImage.mime === "image/png" ? "png" : "jpg";
  return toFile(referenceImage.bytes, `reference.${extension}`, { type: referenceImage.mime });
}

/**
 * xAI JSON edit 的参考图 data URI，字节经 `Uint8Array.toBase64()` 编码。
 */
function toXAiReferenceDataUri(referenceImage: VisionImage): string {
  return `data:${referenceImage.mime};base64,${referenceImage.bytes.toBase64()}`;
}

/**
 * 按已缓存的线协议分派一次网络请求；OpenAiImageProtocol 新增成员时，never 断言要求补上
 * 对应分支。
 * @param signal 调用方合成好的整次调用 deadline；每个分支都把它与每次尝试的
 *   timeout 一起交给 SDK，request 自带的调用方 signal 不在这里读取。
 */
async function requestOpenAiCompatibleImage(
  config: OpenAiAgentImageCapabilityConfig,
  {
    prompt,
    aspectRatio,
    referenceImage,
  }: AiImageRequest,
  signal: AbortSignal
): Promise<OpenAI.Images.ImagesResponse> {
  const client: OpenAI = getOpenAiClient("image");
  const protocol: OpenAiImageProtocol = config.imageProtocol;
  const model: string = config.model;
  switch (protocol) {
    case "xai": {
      if (referenceImage !== undefined) {
        // xAI 单图 edit 的输出比例跟随输入图，不发送 aspect_ratio。
        const body: XAiImageEditParams = {
          model,
          prompt,
          image: { type: "image_url", url: toXAiReferenceDataUri(referenceImage) },
          resolution: XAI_IMAGE_RESOLUTION,
          response_format: "b64_json",
        };
        return client.post<OpenAI.Images.ImagesResponse>("/images/edits", {
          body,
          signal,
          timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
        });
      }
      const body: XAiImageGenerateParams = {
        model,
        prompt,
        aspect_ratio: pickXAiAspectRatio(aspectRatio),
        resolution: XAI_IMAGE_RESOLUTION,
        response_format: "b64_json",
        n: 1,
      };
      return client.images.generate(body, {
        signal,
        timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
      });
    }
    case "openai":
    case "openai-standard": {
      const size: string = pickOpenAiImageSize(protocol, aspectRatio);
      if (referenceImage !== undefined) {
        const upload: Uploadable = await toReferenceUpload(referenceImage);
        signal.throwIfAborted();
        return client.images.edit(
          {
            model,
            image: upload,
            prompt,
            size,
            output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
            n: 1,
          },
          { signal, timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS }
        );
      }
      return client.images.generate(
        {
          model,
          prompt,
          size,
          output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
          moderation: OPENAI_IMAGE_MODERATION,
          n: 1,
        },
        { signal, timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS }
      );
    }
    default: {
      const unhandledProtocol: never = protocol;
      throw new Error(`Unsupported OpenAI image protocol: ${String(unhandledProtocol)}`);
    }
  }
}

/** 日志使用的实际画幅；xAI 单参考图 edit 不发送画幅，标记为 follows-reference。 */
function imageCanvasForLog(
  protocol: OpenAiImageProtocol,
  aspectRatio: ImageGenerationAspectRatio,
  hasReferenceImage: boolean
): string {
  switch (protocol) {
    case "xai": return hasReferenceImage ? "follows-reference" : pickXAiAspectRatio(aspectRatio);
    case "openai":
    case "openai-standard": return pickOpenAiImageSize(protocol, aspectRatio);
    default: {
      const unhandledProtocol: never = protocol;
      throw new Error(`Unsupported OpenAI image protocol: ${String(unhandledProtocol)}`);
    }
  }
}

/**
 * 调 OpenAI 生图接口生成一张图片；请求失败或无可用载荷时返回 null（已记日志）。
 *
 * 超时用独立的 OPENAI_IMAGE_REQUEST_TIMEOUT_MS，它同时是每次尝试的
 * timeout 与整次调用（含 SDK 全部重试与退避）的 deadline，见
 * docs/cn/04-invariants.md「AI 闲聊运行时」。deadline 到期按普通请求失败记日志；
 * 只有调用方 signal 中止才静默返回。SDK 已按 maxRetries 重试过这类请求失败，
 * 调用方不得再套一层完整请求。
 */
export async function generateOpenAiImage(request: AiImageRequest): Promise<GeneratedChatImage | null> {
  const {
    aspectRatio,
    referenceImage,
    signal,
  }: AiImageRequest = request;
  try {
    signal?.throwIfAborted();
    // 配置取一次，两条分支共用；取用放在 try 内，读取抛错按失败返回 null。
    const capabilityConfig: AgentImageCapabilityConfig | undefined = getAgentDeploymentConfig().image;
    if (capabilityConfig === undefined) {
      throw new Error('Agent capability "image" is not configured.');
    }
    if (capabilityConfig.provider !== "openai") {
      throw new Error('Agent capability "image" is not configured for the OpenAI provider.');
    }
    const config: OpenAiAgentImageCapabilityConfig = capabilityConfig;
    const model: string = config.model;
    const protocol: OpenAiImageProtocol = config.imageProtocol;
    // SDK 的 timeout 是每次尝试各自的期限；同一份合成 signal 同时交给 SDK 与外层
    // 等待：网络层据此停止后续尝试，调用方在整次 deadline 到期或上游取消时立即结算。
    const requestSignal: AbortSignal = signalWithTimeout(signal, OPENAI_IMAGE_REQUEST_TIMEOUT_MS);
    requestSignal.throwIfAborted();
    const response: OpenAI.Images.ImagesResponse = await raceAbortOrThrow(
      requestOpenAiCompatibleImage(config, request, requestSignal)
        .then((result: OpenAI.Images.ImagesResponse): OpenAI.Images.ImagesResponse => {
          // xAI 生图可能只给费用不给 token，按 xAI 的 usage 口径判断记哪一种；OpenAI 原生只记 token。
          if (protocol === "xai") {
            reportXAiUsage({ capability: "image", model, usage: result.usage });
          } else {
            reportAiCacheUsage({
              capability: "image", provider: "openai", model,
              inputTokens: result.usage?.input_tokens,
              cachedInputTokens: undefined,
              outputTokens: result.usage?.output_tokens,
            });
          }
          return result;
        }),
      requestSignal
    );
    const entry: OpenAI.Images.Image | undefined = response.data?.[0];
    const encoded: string | undefined = entry?.b64_json;
    if (encoded === undefined) {
      // 拿不到 base64 时记日志并区分成因：「一条也没有」是模型或服务端空转；
      // 「有条目却只有 url」说明 `agent.image.model` 指向了默认回 URL 信封的模型或网关。
      const kind: string = entry === undefined
        ? "no entries"
        : (typeof entry.url === "string" ? "url envelope instead of base64" : "entry without b64_json");
      const canvas: string = imageCanvasForLog(protocol, aspectRatio, referenceImage !== undefined);
      logger.error(
        `${OPENAI_IMAGE_ERROR_LABEL} returned no usable image payload: ${kind} ` +
        `(entries=${response.data?.length ?? 0}, model=${model}, canvas=${canvas}, ` +
        `has_reference=${referenceImage !== undefined}).`
      );
      return null;
    }
    const decoded: GeneratedImageDecodeResult = decodeGeneratedImageBySignature(encoded);
    if (!decoded.ok) {
      // 解码被拒时日志写明 reason（格式不匹配或大小越界）。
      const canvas: string = imageCanvasForLog(protocol, aspectRatio, referenceImage !== undefined);
      logger.error(
        `${OPENAI_IMAGE_ERROR_LABEL} returned an unusable image payload: ${decoded.reason} ` +
        `(encoded_chars=${encoded.length}, canvas=${canvas}, has_reference=${referenceImage !== undefined}).`
      );
      return null;
    }
    return decoded.image;
  } catch (error: unknown) {
    if (signal?.aborted === true) return null;
    logger.error(`Error calling ${OPENAI_IMAGE_ERROR_LABEL}:`, error);
    return null;
  }
}
