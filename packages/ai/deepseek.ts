/**
 * DeepSeek chat completions 的底层收发（OpenAI 兼容接口，官方 openai SDK）。
 * 与 ai/gemini.ts 平级：本文件只管发请求、记错误日志，不认识任何业务语义
 * ——提示词怎么拼、返回的 JSON 怎么收窄，都由调用方各自负责
 * （当前唯一调用方是 workers/antiRaid/adDetect/classifier.ts）。
 *
 * 走官方 SDK 而不是手写 fetch，理由同 Gemini 那边：超时与瞬时失败重试由 SDK
 * 内建，不必自己维护一份 AbortController。客户端是线程内单例，Worker 崩溃
 * 重建后由 cache/deepseek.ts 的空 holder 重新构造。
 */

import OpenAI from "openai";
import { deepSeekClientHolder } from "../cache/deepseek";
import { DEEPSEEK_API_KEY } from "../infra/config";
import { logger } from "../infra/logger";
import {
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_EMPTY_BODY_MAX_ATTEMPTS,
  DEEPSEEK_REQUEST_MAX_RETRIES,
  DEEPSEEK_REQUEST_TIMEOUT_MS,
} from "../consts/deepseek";

/**
 * 取得线程内唯一 DeepSeek 客户端；timeout/maxRetries 是每次请求各自的预算。
 *
 * 密钥是可选 env（见 infra/config.ts）：没配时 /ad_detect enable 与投递门禁
 * 都已经把判定挡在外面，走到这里说明进程启动后 env 被抽掉。这里直接抛，由
 * attemptDeepSeekJson 的 catch 记一行错并归一成「没有结论」——宁可漏判，也
 * 不能让一次凭据缺失变成凭空拉黑。
 */
function getDeepSeekClient(): OpenAI {
  if (DEEPSEEK_API_KEY === undefined) {
    throw new Error("DEEPSEEK_API_KEY is not configured; ad detection cannot run.");
  }
  deepSeekClientHolder.current ??= new OpenAI({
    apiKey: DEEPSEEK_API_KEY,
    baseURL: DEEPSEEK_API_BASE_URL,
    timeout: DEEPSEEK_REQUEST_TIMEOUT_MS,
    maxRetries: DEEPSEEK_REQUEST_MAX_RETRIES,
  });
  return deepSeekClientHolder.current;
}

export interface DeepSeekJsonRequestParams {
  /** 模型名；由调用方按自己的场景选，见各领域 consts。 */
  model: string;
  /** 系统提示词。**必须出现「json」这个词**，见下方 requestDeepSeekJson 的说明。 */
  systemPrompt: string;
  /** 本次待处理的用户内容；一律当数据，不承担指令语义。 */
  userContent: string;
  temperature: number;
  maxOutputTokens: number;
  /** 出现在错误日志里的调用名（英文），用于区分是哪条流水线出的错。 */
  errorLabel: string;
}

/** 一次尝试的结果；null 表示请求本身失败（已记日志，SDK 也已按配置重试过）。 */
interface DeepSeekAttempt {
  /** 模型正文；空串表示这一轮什么都没产出。 */
  body: string;
  /** 额度用尽收尾（finish_reason=length），正文多半只有半截。 */
  truncated: boolean;
  reasoningTokens: number | "?";
}

/** 发一次请求并收窄成 DeepSeekAttempt；异常在这里就地记日志并归一成 null。 */
async function attemptDeepSeekJson({
  model,
  systemPrompt,
  userContent,
  temperature,
  maxOutputTokens,
  errorLabel,
}: DeepSeekJsonRequestParams): Promise<DeepSeekAttempt | null> {
  try {
    const completion: OpenAI.Chat.Completions.ChatCompletion = await getDeepSeekClient().chat.completions.create({
      model,
      temperature,
      max_tokens: maxOutputTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });
    const choice: OpenAI.Chat.Completions.ChatCompletion.Choice | undefined = completion.choices[0];
    return {
      body: choice?.message.content ?? "",
      truncated: choice?.finish_reason === "length",
      reasoningTokens: completion.usage?.completion_tokens_details?.reasoning_tokens ?? "?",
    };
  } catch (error: unknown) {
    if (error instanceof OpenAI.APIError) {
      // APIError 自带状态码与服务端错误信息，拼一行足够定位（同 ai/gemini.ts）。
      logger.error(`${errorLabel} failed: ${error.status ?? "?"} ${error.message}`);
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return null;
  }
}

/**
 * 发一次要求 JSON 输出的 chat completion，正文为空或被截断时按
 * DEEPSEEK_EMPTY_BODY_MAX_ATTEMPTS 有界重来。
 *
 * 请求固定带 `response_format: { type: "json_object" }`，而 DeepSeek 会在服务端
 * 校验提示词里是否提到 json——没提到直接 400（Prompt must contain the word 'json'
 * in some form）。调用方的系统提示词因此必须自带那句要求，本函数不代为拼接：
 * 拼进来的话，模型看到的输出格式说明就分散在两处，改一处不改另一处会静默漂移。
 *
 * 「HTTP 成功但正文为空」是推理模型的固有抖动，而不是模型的判断结果：交回空串
 * 会被调用方解析成「没有结论」，与「模型认为不是广告」不可区分，成为一次没有
 * 任何日志痕迹的漏判。因此这里重试一次，两次都空才记错误日志并返回 null。
 * 截断（finish_reason=length）同样重来：那是推理把额度吃光，换一次采样通常就
 * 写得出正文，改不动的话才需要调 maxOutputTokens——日志里点名的正是这两个数。
 * @returns 模型返回的非空正文；请求失败或反复空转时为 null（已记日志）。
 */
export async function requestDeepSeekJson(params: DeepSeekJsonRequestParams): Promise<string | null> {
  for (let attempt: number = 1; attempt <= DEEPSEEK_EMPTY_BODY_MAX_ATTEMPTS; attempt++) {
    const result: DeepSeekAttempt | null = await attemptDeepSeekJson(params);
    // 请求本身失败：SDK 已按 maxRetries 重试过，日志也记了，不在这里再自旋。
    if (result === null) return null;
    if (!result.truncated && result.body.trim().length > 0) return result.body;
    if (attempt < DEEPSEEK_EMPTY_BODY_MAX_ATTEMPTS) continue;
    logger.error(
      `${params.errorLabel} produced no usable body in ${attempt} attempt(s) ` +
      `(truncated=${result.truncated}, hasPartialText=${result.body.length > 0}, ` +
      `reasoning_tokens=${result.reasoningTokens}, max_tokens=${params.maxOutputTokens}).`
    );
  }
  return null;
}
