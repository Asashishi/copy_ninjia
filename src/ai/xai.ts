/**
 * xAI /v1/responses 的底层收发与响应解析。回复流水线（workers/aiChatWorker.ts
 * 的工具往返循环）、冷消息压缩（summarizeBatch）、图片描述
 * （ai/imageDescription.ts）共用。
 *
 * 收发走官方 openai SDK（xAI 的 responses 接口对 OpenAI 的 Responses API
 * 协议兼容，官方 quickstart 也是这么示范的）而不是手写 fetch：SDK 自带
 * 超时、瞬时失败（网络错误/5xx）的自动重试，比自己维护一份 AbortController
 * 省心。已用真实请求逐项验证过 SDK 的 client.responses.create 在 xAI 上
 * 行为与直接打原始 REST 接口一致——web_search（服务端工具）与自定义函数
 * （客户端工具）能混用同一次请求、视觉输入（input_image）能用、多轮函数
 * 调用往返（配合推理模型的 reasoning 成员一并带回）也正常，这几点是
 * @ai-sdk/xai 等其它 JS 封装明确不支持或未文档化的，所以选了直接用
 * openai 包而不是那些更高层的抽象。
 *
 * responses API 的响应形状（实测确认）：顶层 status（"completed" /
 * "incomplete"）+ output 数组，成员按 type 区分——"message"（最终文本，
 * content 里嵌 "output_text" 段）、"function_call"（自定义函数调用请求，带
 * call_id/name/arguments）、"reasoning"（思考摘要）、"web_search_call"
 * （服务端已自动执行的联网搜索记录）等。多轮函数往返时要把上一轮的全部
 * output 成员原样接回 input 再附上 function_call_output，见 callGrok。
 */

import OpenAI, { APIError } from "openai";
import { logger } from "../infra/logger";
import { XAI_API_KEY } from "../infra/config";
import { REQUEST_TIMEOUT_MS, XAI_BASE_URL } from "../consts/aiChat";

/** 进程内唯一的 xAI 客户端实例（timeout 是每次请求/每次重试各自的预算，
 *  不是所有重试共享一个硬顶，见 consts/aiChat.ts 的 REQUEST_TIMEOUT_MS 注释）。
 *  Worker 线程各自 import 本文件会各自拿到一份独立实例，符合现状——本来
 *  就没有跨线程共享 xAI 调用状态的需求。 */
const client: OpenAI = new OpenAI({ apiKey: XAI_API_KEY, baseURL: XAI_BASE_URL, timeout: REQUEST_TIMEOUT_MS });

/**
 * 调一次 responses 接口。请求失败、超时或非 2xx 时返回 null（已记日志）；
 * status=incomplete 的静默失败（多半是 max_output_tokens 在思考阶段被烧光，
 * 见 consts/aiChat.ts 的 REPLY_MAX_TOKENS 注释）点名记下来，否则上层只能
 * 看到「没产出」，查不到原因。
 * @param body 完整请求体（model/input/tools 等由调用方拼好）。body 里的
 *   input/tools 形状是按 xAI 的原始 API 文档拼的，跟 openai SDK 自己的
 *   类型定义not 100% 对得上（比如 xAI 的内置工具是 `{ type: "web_search" }`，
 *   openai 自家的内置工具类型名不同），所以整体按 any 传，不较真类型。
 * @param errorLabel 出现在错误日志里的调用名，用于区分是哪条流水线出的错。
 */
export async function requestXaiResponse(body: Record<string, unknown>, errorLabel: string): Promise<any | null> {
  let data: any;
  try {
    data = await client.responses.create(body as any);
  } catch (error: unknown) {
    if (error instanceof APIError) {
      // error.message 已经是 SDK 拼好的「{status} {msg}」（HTTP 错误）或纯
      // msg（无 HTTP 响应的网络/超时错误，此时 status 是 undefined），直接
      // 用它——前面再拼一次 error.status 会把状态码打印两遍，网络错误时
      // 还会多出一个字面量 "undefined"。
      logger.error(`${errorLabel} error: ${error.message}`);
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return null;
  }

  if (data.status === "incomplete" && !extractOutputText(data)) {
    logger.error(
      `${errorLabel} returned an incomplete response with no output text ` +
      `(reason: ${data.incomplete_details?.reason ?? "unknown"}, ` +
      `reasoning_tokens=${data.usage?.output_tokens_details?.reasoning_tokens ?? "?"}, ` +
      `max_output_tokens=${body.max_output_tokens ?? "?"}).`
    );
  }
  return data;
}

/** 拼出响应里的最终文本：所有 message 成员的 output_text 段按序连接；没有则为空串。
 *  SDK 的响应对象本身带一个 output_text 便捷属性，效果一样，这里仍手写遍历
 *  ——纯函数，不依赖 SDK 响应类的具体实现，测试用的手搭 fixture 也能直接跑。 */
export function extractOutputText(data: any): string {
  const parts: string[] = [];
  for (const item of data?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const piece of item.content ?? []) {
      if (piece?.type === "output_text" && typeof piece.text === "string") {
        parts.push(piece.text);
      }
    }
  }
  return parts.join("");
}

/** 取出响应里所有待执行的自定义函数调用（内置服务端工具不在此列，它们已在 xAI 侧执行完）。 */
export function extractFunctionCalls(data: any): any[] {
  const output: any[] = Array.isArray(data?.output) ? data.output : [];
  return output.filter((item: any) => item?.type === "function_call");
}
