/**
 * Gemini 侧的生歌：调 Lyria 系模型写一首完整歌曲。
 *
 * **这条不走 generateContent，走 Interactions API**（`ai.interactions.create`，
 * @google/genai 2.12.0 起提供，SDK 内部对 `lyria-3-*` 的响应信封有专门处理）。
 * 因此它不能复用 client.ts 的 requestGeminiResult：那条封装的失败归一化、安全
 * 档位与 candidate 诊断全部按 GenerateContentResponse 的形状写，套在这里只会
 * 把「有没有音频」这个唯一要判的问题埋掉。
 *
 * 两处必须显式传参、不能沿用客户端默认值：
 * - 超时。SDK 的 next-gen 客户端只继承构造期的 `httpOptions.timeout`（本仓是
 *   150 秒，见 consts/aiChat/gemini.ts），而整曲合成是分钟级；不显式加长就等于
 *   每次都在服务端已经开始出账之后自己挂断。
 * - 重试。`httpOptions.retryOptions` 根本不传递到这条端点，这里按
 *   GEMINI_SONG_REQUEST_ATTEMPTS 显式声明为「不重试」，理由见该常量注释。
 *
 * **超时预算由本文件自己合成，不能只交给 SDK 的 `timeout` 选项。** 2.12.0 的
 * interactions 桥接把请求选项整个并进 fetch 选项，随后只在**没有 signal 时**才
 * 启用自己那份超时（`if (!fetchOptions?.signal && conf.timeout_ms > 0)`）。本轮
 * 回复恒带 invalidate signal，于是那条 `timeout` 会被静默跳过，一次挂住的请求
 * 就再没有任何 deadline——它会一直占着这一轮的心跳与工具轮次。因此这里用
 * `AbortSignal.any` 把调用方的 signal 与一份独立的超时合成一个再传下去，口径
 * 同 aiChat/ai/telegramImage.ts 的 withTimeout。`timeout` 仍照传：没有调用方
 * signal 的路径上它是有效的，两道一起兜住。
 *
 * 失败一律返回 null 并记一行英文错误日志，绝不抛错：调用方（生歌工具）要靠这个
 * null 决定是否核销冷却，一次逃逸的异常会连同同一轮里排队的其余工具调用一起
 * 消失（口径同 aiChat/ai/tools/replyToolset/orchestrator.ts 的说明）。
 */

import type { GoogleGenAI } from "@google/genai";
import {
  GEMINI_SONG_ERROR_LABEL,
  GEMINI_SONG_REQUEST_ATTEMPTS,
  GEMINI_SONG_REQUEST_TIMEOUT_MS,
} from "../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../config/agent";
import { logger } from "../../infra/logger";
import { decodeGeneratedSong } from "../ai/utils/songPayload";
import { getGeminiClient } from "./client";
import type { AiSongRequest } from "../../types/aiChat/provider";
import type { GeneratedChatSong, GeneratedSongDecodeResult } from "../../types/aiChat/songGeneration";

/**
 * `interactions.create` 交回的结果里本次真正要读的那一个字段。
 *
 * 手写这层收窄而不是直接用 SDK 的返回类型：那个类型是
 * `GoogleGenAIResponseWithSdkHttpResponse<Interaction & {...}>`，字段几十个且
 * `output_audio` 的 `data`/`mime_type` 都是可选，逐层可选链会把「音频到底在不在」
 * 这件事散进四五个判断里。这里一次收窄，下面只处理「有没有」。
 *
 * `output_text`（Lyria 一并回的歌词）刻意不收：群里只发这首歌本身，歌词既不进
 * caption 也不另发一条，读进来就是一份没有消费方的字符串。
 */
interface SongInteractionOutput {
  readonly output_audio?: { readonly data?: string | undefined; readonly mime_type?: string | undefined } | undefined;
}

/**
 * 生成一首歌；无可用音频载荷时返回 null。
 *
 * prompt 直接作为 `input` 的纯文本交给模型：Lyria 的创作说明本来就是一整段自然
 * 语言，拆成 content block 数组不会多表达任何东西（多模态输入是给图片参考用的，
 * 本项目的生歌工具不接受参考素材）。
 */
export async function generateGeminiSong({ prompt, signal }: AiSongRequest): Promise<GeneratedChatSong | null> {
  let interaction: SongInteractionOutput;
  // 每次调用现取一份独立的超时预算再与调用方的 signal 合成，理由见模块头注。
  const timeoutSignal: AbortSignal = AbortSignal.timeout(GEMINI_SONG_REQUEST_TIMEOUT_MS);
  const requestSignal: AbortSignal = signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal]);
  try {
    const client: GoogleGenAI = getGeminiClient("song");
    const model: string | undefined = getAgentDeploymentConfig().song?.model;
    if (model === undefined) throw new Error('Agent capability "song" is not configured.');
    // 模型名在 try 内部求值：这份部署配置一旦写坏，getAgentDeploymentConfig()
    // 会抛，而它必须落进本函数的 catch 归一成一次普通失败（口径同 client.ts 的
    // requestGeminiResult 收闭包而不收拼好对象的理由）。
    interaction = await client.interactions.create(
      {
        model,
        input: prompt,
      },
      {
        timeout: GEMINI_SONG_REQUEST_TIMEOUT_MS,
        maxRetries: GEMINI_SONG_REQUEST_ATTEMPTS - 1,
        signal: requestSignal,
      }
    );
  } catch (error: unknown) {
    // 判的是**调用方**那个 signal，不是合成后的：本轮被作废（`/ai_chat disable`、
    // 群拆除）不是故障，静默收尾；而超时是真的出了问题——那次生成已经在服务端
    // 出过账，必须留下一行才查得到。
    if (signal?.aborted === true) return null;
    logger.error(`Error calling ${GEMINI_SONG_ERROR_LABEL}:`, error);
    return null;
  }

  const encoded: string | undefined = interaction.output_audio?.data;
  if (encoded === undefined) {
    // HTTP 成功却没有音频：内容过滤、配额或模型空转，对调用方与「请求失败」不可
    // 区分，不点名就查无原因（口径同 client.ts 的 abnormalFinishDiagnostic）。
    logger.error(`${GEMINI_SONG_ERROR_LABEL} returned no audio payload.`);
    return null;
  }
  const decoded: GeneratedSongDecodeResult = decodeGeneratedSong(
    encoded,
    interaction.output_audio?.mime_type
  );
  if (!decoded.ok) {
    logger.error(`${GEMINI_SONG_ERROR_LABEL} returned an unusable audio payload: ${decoded.reason}.`);
    return null;
  }
  return decoded.song;
}
