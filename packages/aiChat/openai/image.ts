/**
 * OpenAI 侧的生图。无参考图走 images.generate，有参考图走 images.edit——
 * 后者才接受输入图片，是 Gemini 那边「参考图 + 提示词同在一个请求里」的对等
 * 路径。
 *
 * 与 Gemini 的画幅差异在这里收口。OpenAI 官方 gpt-image-2 协议按十档发送满足
 * 16 像素倍数约束的 `size`；其它 GPT Image 模型可显式选择全系共同支持的三种
 * 标准尺寸；xAI 的 Grok Imagine 改用 `aspect_ratio`。领域侧始终按十档表达意图，
 * 三套映射都留在实现包内部，换供应商无需改调用点。
 *
 * 载荷校验（base64 规范性、大小上限、文件签名）走两家共用的
 * aiChat/ai/utils/imagePayload.ts；images 接口的响应不带权威 MIME 字段，
 * 因此按字节签名自行判定格式。OpenAI 原生请求以 output_format 钉死格式，
 * xAI 协议则用 response_format 钉死 base64 信封；解码器同时接受 PNG/JPEG。
 *
 * 注意 output_format 钉死的是 png/jpeg/webp 这一层，**不是** url-vs-base64 那层
 * 信封：后者在官方口径下由模型族决定（gpt-image 恒回 base64，dall-e 系默认回
 * url，见 SDK 的 response_format 说明）。本模块只读 base64，而
 * `agent.image.model` 是自由文本、解析器只校验非空，因此响应里只有 url 的
 * 情况必须在日志里与「模型没画出来」分开点名，见下方读取处。
 *
 * xAI 还有第二处协议差异：官方明确不支持 OpenAI SDK `images.edit()` 使用的
 * multipart 请求，参考图必须作为 base64 data URI 放进 JSON。因此 xAI edit 复用
 * 同一个 SDK 客户端的底层 `post`（保留认证、超时和重试），只替换请求体形状。
 *
 * OpenAI 原生两条分支的内容审核档位**不对称**：只有 generate 带 moderation，
 * 因为 SDK 只在 generate 的参数类型上声明了它（理由见 consts/aiChat/openai.ts 的
 * OPENAI_IMAGE_MODERATION）。xAI 官方只把 `respect_moderation` 公开为响应状态，
 * 没有公开请求级的降档或关闭字段；因此 xAI 两条分支采用其客户端可表达的最低
 * 限制——不发送任何额外审核字段，服务端最终策略仍由 xAI 决定。
 *
 * 线协议由 config/agent.ts 从 agent.image 的必填 image_protocol 解析一次并缓存。
 * 新增协议必须扩展 OpenAiImageProtocol 与下方各处穷举 switch，
 * 不得再把端点/模型特判散落到请求路径。
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
 * 两张固定 Record 让新增领域比例在编译期暴露缺项，并避免每次请求计算最近邻。
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
 * 领域十档到 xAI 官方画幅的映射。
 *
 * 七档可原样发送；5:4、4:5 分别取最近的 4:3、3:4，21:9 取最近的 20:9。
 * 用穷举 switch 让新增领域比例时由返回类型与测试一起暴露，不在低频请求里建立
 * 临时表或排序数组。
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
 * xAI JSON edit 的参考图 data URI。直接用 Bun 的 Uint8Array 编码；base64 字符串
 * 是 JSON 协议要求的唯一新增大对象。
 */
function toXAiReferenceDataUri(referenceImage: VisionImage): string {
  return `data:${referenceImage.mime};base64,${referenceImage.bytes.toBase64()}`;
}

/**
 * 按已缓存的线协议分派一次网络请求。switch 保持有限、无运行期注册表和增长型缓存；
 * OpenAiImageProtocol 新增成员时，never 断言会强制实现对应适配分支。直接传现有
 * config 与 request 上下文，避免为适配层另建投影 options 对象。
 */
async function requestOpenAiCompatibleImage(
  client: OpenAI,
  config: OpenAiAgentImageCapabilityConfig,
  {
    prompt,
    aspectRatio,
    referenceImage,
    signal,
  }: AiImageRequest
): Promise<OpenAI.Images.ImagesResponse> {
  const protocol: OpenAiImageProtocol = config.imageProtocol;
  const model: string = config.model;
  switch (protocol) {
    case "xai": {
      if (referenceImage !== undefined) {
        // xAI 单图 edit 的输出比例跟随输入图；aspect_ratio 只对纯生成与多图 edit
        // 生效。本仓一次只带一张参考图，因此这里刻意不发送一个会被忽略的字段。
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
        return client.images.edit(
          {
            model,
            image: await toReferenceUpload(referenceImage),
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

/** 日志使用的实际画幅；xAI 单参考图 edit 不发送画幅，必须明确标记为跟随输入。 */
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
 * 超时用独立的 OPENAI_IMAGE_REQUEST_TIMEOUT_MS：一次 1024px 生成常年跑到分钟
 * 级，套用聊天那份预算会在模型还在画的时候把连接掐掉。SDK 已按 maxRetries
 * 重试过这类请求失败，调用方不得再套一层完整请求。
 */
export async function generateOpenAiImage(request: AiImageRequest): Promise<GeneratedChatImage | null> {
  const {
    aspectRatio,
    referenceImage,
    signal,
  }: AiImageRequest = request;
  try {
    // 配置取一次就够：两条分支用的是同一个模型，分别取只会让「换模型时两边不一致」
    // 成为可能。取用放在 try 内，因为 config/agent.json 写坏时解析会抛——留在外面
    // 就等于让一次配置笔误把异常掀给调用方，而本函数的契约是「失败返回 null」。
    const capabilityConfig: AgentImageCapabilityConfig | undefined = getAgentDeploymentConfig().image;
    if (capabilityConfig === undefined) {
      throw new Error('Agent capability "image" is not configured.');
    }
    if (capabilityConfig.provider !== "openai") {
      throw new Error('Agent capability "image" is not configured for the OpenAI provider.');
    }
    const config: OpenAiAgentImageCapabilityConfig = capabilityConfig;
    const model: string = config.model;
    const client: OpenAI = getOpenAiClient("image");
    const protocol: OpenAiImageProtocol = config.imageProtocol;
    const response: OpenAI.Images.ImagesResponse = await requestOpenAiCompatibleImage(
      client,
      config,
      request
    );
    const entry: OpenAI.Images.Image | undefined = response.data?.[0];
    const encoded: string | undefined = entry?.b64_json;
    if (encoded === undefined) {
      // 拿不到 base64 说明服务端换了返回形态或整体空转，与「模型没画出来」不可
      // 区分，点名记一条否则查无原因。两种成因必须能在日志里分开：
      //
      // 「一条也没有」是模型/服务端空转；「有条目却只有 url」则是**配置问题**
      // ——`agent.image.model` 是自由文本，填成非 gpt-image 模型、或指向一个
      // 默认回 URL 信封的兼容网关时就是这个形状。不点名的话，日志只会说「没有
      // 载荷」，而运维手里那份配置看上去完全正常，图却每张都白计费。
      //
      // OpenAI 原生分支不改用 `response_format: "b64_json"` 去要 base64：SDK 明写该参数
      // 「isn't supported for the GPT image models, which always return
      // base64-encoded images」（node_modules/openai/resources/images.d.ts），
      // 无条件带上只会把本来正常的 gpt-image 请求打成 400。xAI 协议分支按其
      // 官方兼容文档单独携带该字段，不与这里矛盾。
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
      // 解码拒绝必须写明格式不匹配或大小越界，便于定位已经计费但无法交付的响应。
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
