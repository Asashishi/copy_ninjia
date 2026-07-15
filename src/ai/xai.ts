/**
 * xAI /v1/responses 的底层收发与响应解析。回复流水线（workers/aiChatWorker.ts
 * 的工具往返循环）、冷消息压缩（summarizeBatch）、图片描述
 * （ai/imageDescription.ts）共用。
 *
 * responses API 的响应形状（实测确认）：顶层 status（"completed" /
 * "incomplete"）+ output 数组，成员按 type 区分——"message"（最终文本，
 * content 里嵌 "output_text" 段）、"function_call"（自定义函数调用请求，带
 * call_id/name/arguments）、"reasoning"（思考摘要）、"web_search_call"
 * （服务端已自动执行的联网搜索记录）等。多轮函数往返时要把上一轮的全部
 * output 成员原样接回 input 再附上 function_call_output，见 callGrok。
 */

import { logger } from "../infra/logger";
import { XAI_API_KEY } from "../infra/config";
import { fetchJsonWithTimeout } from "../libs/httpFetch";
import { REQUEST_TIMEOUT_MS, XAI_RESPONSES_API_URL } from "../consts/aiChat";

/**
 * POST 一次 /v1/responses。请求失败、超时或非 2xx 时返回 null（底层已记
 * 日志）；status=incomplete 的静默失败（多半是 max_output_tokens 在思考
 * 阶段被烧光，见 consts/aiChat.ts 的 REPLY_MAX_TOKENS 注释）点名记下来，
 * 否则上层只能看到「没产出」，查不到原因。
 * @param body 完整请求体（model/input/tools 等由调用方拼好）。
 * @param errorLabel 出现在错误日志里的调用名，用于区分是哪条流水线出的错。
 */
export async function requestXaiResponse(body: Record<string, unknown>, errorLabel: string): Promise<any | null> {
  const data: any = await fetchJsonWithTimeout(
    XAI_RESPONSES_API_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${XAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    },
    REQUEST_TIMEOUT_MS,
    errorLabel
  );
  if (data === null) return null;
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

/** 拼出响应里的最终文本：所有 message 成员的 output_text 段按序连接；没有则为空串。 */
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
