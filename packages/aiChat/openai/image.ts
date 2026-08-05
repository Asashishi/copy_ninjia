/**
 * OpenAI 侧的生图。无参考图走 images.generate，有参考图走 images.edit——
 * 后者才接受输入图片，是 Gemini 那边「参考图 + 提示词同在一个请求里」的对等
 * 路径。
 *
 * 与 Gemini 的画幅差异在这里收口：gpt-image 只有三种尺寸，领域侧的十档官方
 * 宽高比按纵横比最近邻映射过去（见 pickImageSize）。映射发生在实现包内部，
 * 领域侧仍按十档表达意图，换回 Gemini 时无需改动任何调用点。
 *
 * 载荷校验（base64 规范性、大小上限、文件签名）走两家共用的
 * aiChat/ai/utils/imagePayload.ts；images 接口的响应不带权威 MIME 字段，
 * 因此按字节签名自行判定格式——输出格式由请求里的 output_format 钉死，两条
 * 分支都带，否则服务端默认值一变（gpt-image 也支持 WebP）就每次都在签名判定
 * 处落空。
 *
 * 注意 output_format 钉死的是 png/jpeg/webp 这一层，**不是** url-vs-base64 那层
 * 信封：后者在官方口径下由模型族决定（gpt-image 恒回 base64，dall-e 系默认回
 * url，见 SDK 的 response_format 说明）。本模块只读 base64，而
 * `ai_agent.models.image` 是自由文本、解析器只校验非空，因此响应里只有 url 的
 * 情况必须在日志里与「模型没画出来」分开点名，见下方读取处。
 *
 * 两条分支的内容审核档位**不对称**：只有 generate 带 moderation，因为 SDK 只在
 * generate 的参数类型上声明了它（理由见 consts/aiChat/openai.ts 的
 * OPENAI_IMAGE_MODERATION）。这是已知取舍，不是漏改。
 */

import { toFile } from "openai";
import type OpenAI from "openai";
import type { Uploadable } from "openai";
import {
  OPENAI_IMAGE_ERROR_LABEL,
  OPENAI_IMAGE_MODERATION,
  OPENAI_IMAGE_OUTPUT_FORMAT,
  OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
  OPENAI_IMAGE_SIZES,
} from "../../consts/aiChat/openai";
import { getAiAgentOpenAiConfig } from "../../config/openai";
import { logger } from "../../infra/logger";
import { aspectRatioValue, closestRatioIndex } from "../ai/utils/aspectRatio";
import { decodeGeneratedImageBySignature } from "../ai/utils/imagePayload";
import { getOpenAiClient } from "./client";
import type { AiImageRequest } from "../../types/aiChat/provider";
import type {
  GeneratedChatImage,
  GeneratedImageDecodeResult,
  ImageGenerationAspectRatio,
} from "../../types/aiChat/imageGeneration";
import type { VisionImage } from "../../types/media";

/** 画幅表对应的数值宽高比，模块加载时一次算好；理由同
 *  aiChat/ai/utils/aspectRatio.ts 的 ASPECT_RATIO_VALUES。 */
const IMAGE_SIZE_RATIOS: readonly number[] = OPENAI_IMAGE_SIZES.map(
  (entry: Readonly<{ size: string; ratio: number }>): number => entry.ratio
);

/** 官方十档宽高比映射到 gpt-image 支持的三种画幅，取纵横比最近的一档。 */
function pickImageSize(aspectRatio: ImageGenerationAspectRatio): string {
  const index: number = closestRatioIndex(aspectRatioValue(aspectRatio), IMAGE_SIZE_RATIOS);
  return OPENAI_IMAGE_SIZES[index]!.size;
}

/** 参考图转 SDK 可上传的文件句柄；扩展名跟随实际 MIME，服务端据此判格式。 */
function toReferenceUpload(referenceImage: VisionImage): Promise<Uploadable> {
  const extension: string = referenceImage.mime === "image/png" ? "png" : "jpg";
  return toFile(referenceImage.bytes, `reference.${extension}`, { type: referenceImage.mime });
}

/**
 * 调 OpenAI 生图接口生成一张图片；请求失败或无可用载荷时返回 null（已记日志）。
 *
 * 超时用独立的 OPENAI_IMAGE_REQUEST_TIMEOUT_MS：一次 1024px 生成常年跑到分钟
 * 级，套用聊天那份预算会在模型还在画的时候把连接掐掉。SDK 已按 maxRetries
 * 重试过这类请求失败，调用方不得再套一层完整请求。
 */
export async function generateOpenAiImage({
  prompt,
  aspectRatio,
  referenceImage,
  signal,
}: AiImageRequest): Promise<GeneratedChatImage | null> {
  const size: string = pickImageSize(aspectRatio);
  try {
    // 配置取一次就够：两条分支用的是同一个模型，分别取只会让「换模型时两边不一致」
    // 成为可能。取用放在 try 内，因为 config/openai.json 写坏时解析会抛——留在外面
    // 就等于让一次配置笔误把异常掀给调用方，而本函数的契约是「失败返回 null」。
    const model: string = getAiAgentOpenAiConfig().models.image;
    const client: OpenAI = getOpenAiClient();
    const response: OpenAI.Images.ImagesResponse = referenceImage
      // 两条分支的差异只有两处，都是刻意的：edit 多一张参考图，generate 多一个
      // moderation 档位（SDK 只在 generate 的参数类型上声明了它，见
      // consts/aiChat/openai.ts 的 OPENAI_IMAGE_MODERATION）。output_format 两边
      // 都钉：不钉就由服务端默认值决定，一变成 WebP 就每次都在签名校验处落空。
      ? await client.images.edit(
        {
          model,
          image: await toReferenceUpload(referenceImage),
          prompt,
          size,
          output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
          n: 1,
        },
        { signal, timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS }
      )
      : await client.images.generate(
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
    const entry: OpenAI.Images.Image | undefined = response.data?.[0];
    const encoded: string | undefined = entry?.b64_json;
    if (encoded === undefined) {
      // 拿不到 base64 说明服务端换了返回形态或整体空转，与「模型没画出来」不可
      // 区分，点名记一条否则查无原因。两种成因必须能在日志里分开：
      //
      // 「一条也没有」是模型/服务端空转；「有条目却只有 url」则是**配置问题**
      // ——`ai_agent.models.image` 是自由文本，填成非 gpt-image 模型、或指向一个
      // 默认回 URL 信封的兼容网关时就是这个形状。不点名的话，日志只会说「没有
      // 载荷」，而运维手里那份配置看上去完全正常，图却每张都白计费。
      //
      // 这里不改用 `response_format: "b64_json"` 去要 base64：SDK 明写该参数
      // 「isn't supported for the GPT image models, which always return
      // base64-encoded images」（node_modules/openai/resources/images.d.ts），
      // 无条件带上只会把本来正常的 gpt-image 请求打成 400。
      const kind: string = entry === undefined
        ? "no entries"
        : (typeof entry.url === "string" ? "url envelope instead of base64" : "entry without b64_json");
      logger.error(
        `${OPENAI_IMAGE_ERROR_LABEL} returned no usable image payload: ${kind} ` +
        `(entries=${response.data?.length ?? 0}, model=${model}, size=${size}, ` +
        `has_reference=${referenceImage !== undefined}).`
      );
      return null;
    }
    const decoded: GeneratedImageDecodeResult = decodeGeneratedImageBySignature(encoded);
    if (!decoded.ok) {
      // 这条路以前是静默的 null：图照样计费，群里报一句失败，而日志里没有一行
      // 指向「格式不匹配」还是「超出大小上限」。
      logger.error(
        `${OPENAI_IMAGE_ERROR_LABEL} returned an unusable image payload: ${decoded.reason} ` +
        `(encoded_chars=${encoded.length}, size=${size}, has_reference=${referenceImage !== undefined}).`
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
