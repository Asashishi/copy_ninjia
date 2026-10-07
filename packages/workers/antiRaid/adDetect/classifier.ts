/**
 * 广告判定的领域逻辑：拼提示词、发一次请求、把模型输出收窄成判定结果。
 * 传输层（客户端单例、超时、重试、错误日志）在 ./ai/provider.ts，本文件不碰。
 *
 * 判定是尽力而为的启发式：请求失败、超时、返回形状不对，一律返回 null，调用
 * 方原样跳过这一批，不猜 true。
 * 判定口径由部署配置 config/dynamic/ad_samples.json 提供（见 config/adSamples.ts），
 * 提示词模板在 consts/antiRaid/adDetect.ts。
 *
 * 模型看到的群聊原文一律是数据：提示词里已声明其中的任何指令都不得执行，
 * 且输出被限制成一个只含 ad/reason 两个字段的 JSON，reason 只进日志与播报
 * 前缀，不参与任何控制流。
 */

import { requestAdDetectJson } from "./ai/provider";
import { adDetectPrompts } from "../../../cache/workers/antiRaid/adDetect";
import { getAdSampleConfig } from "../../../config/adSamples";
import { logger } from "../../../infra/logger";
import {
  AD_DETECT_MAX_OUTPUT_TOKENS,
  AD_DETECT_REASON_MAX_CHARS,
  AD_DETECT_TEMPERATURE,
  adDetectFact,
  buildAdDetectInstructions,
} from "../../../consts/antiRaid/adDetect";
import { isPlainRecord } from "../../../libs/record";
import { truncateInline } from "../../../libs/text";
import type { AdDetectPrompts, AdVerdict } from "../../../types/antiRaid/adDetect";
import { getAdDetectAgentConfig } from "../../../config/agent";

/**
 * 从模型输出里收窄出判定结果：优先用正则认出并剥掉 ```json 围栏，再退化到
 * 截取首个 `{` 至末个 `}` 的候选片段。任何一步不成立都返回 null（当作本次判定没发生）。
 * 导出仅为可测试性；判定路径只经 classifyAdText 调用。
 */
export function parseAdVerdict(raw: string | null | undefined): AdVerdict | null {
  if (typeof raw !== "string") return null;
  const trimmed: string = raw.trim();
  // 裸对象优先；只有整个响应不是裸对象时才按 Markdown 围栏剥壳。
  const fenced: RegExpExecArray | null = trimmed.startsWith("{") && trimmed.endsWith("}")
    ? null
    : /(?:^|[\r\n])[ \t]*```json[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?[ \t]*```(?=[ \t]*(?:[\r\n]|$))/i.exec(trimmed);
  const normalized: string = fenced?.[1]?.trim() ?? trimmed;
  const start: number = normalized.indexOf("{");
  const end: number = normalized.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized.slice(start, end + 1)) as unknown;
  } catch (error: unknown) {
    logger.error("Ad detection response was not valid JSON:", error);
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  const verdict: Record<string, unknown> = parsed;
  // ad 字段必须是布尔值，字符串 "true"、1、"yes" 都按无效处理。
  if (typeof verdict.ad !== "boolean") return null;
  // reason 经 truncateInline 按代理对安全截断，会被拼进群内播报
  // （见 antiRaid/adDetect.ts 的 formatAdNotice）。
  const reason: string = typeof verdict.reason === "string"
    ? truncateInline(verdict.reason.replace(/\s+/g, " ").trim(), AD_DETECT_REASON_MAX_CHARS)
    : "";
  return { isAd: verdict.ad, reason };
}

export interface ClassifyAdTextParams {
  /** 已拼好的待判定消息串（逐行编号，见 adDetect/queue.ts）。 */
  text: string;
  /** 该发送者是否仍在入群验证窗口内；作为独立的系统事实行交给传输，不拼进待判定正文。 */
  justJoined: boolean;
}

/**
 * 按当前示例快照拼好的判定提示词，Worker 内缓存一份（见 cache/workers/antiRaid/adDetect.ts）：
 * 规则与示例段，以及两个系统事实变体的完整系统提示词（规则与示例段在前、换行、事实在最后），
 * 后者供 OpenAI 兼容路径直接使用。示例快照替换时由 config.ts 清空，下一次判定重建。
 */
function currentAdDetectPrompts(): AdDetectPrompts {
  if (adDetectPrompts.current !== null) return adDetectPrompts.current;
  const instructions: string = buildAdDetectInstructions(getAdSampleConfig());
  const prompts: AdDetectPrompts = {
    instructions,
    justJoinedSystemPrompt: `${instructions}\n${adDetectFact(true)}`,
    establishedSystemPrompt: `${instructions}\n${adDetectFact(false)}`,
  };
  adDetectPrompts.current = prompts;
  return prompts;
}

/**
 * 判定一串消息是不是广告。
 * @returns 判定结果；请求或解析失败时为 null，调用方应视为「本次没判定」。
 */
export async function classifyAdText({ text, justJoined }: ClassifyAdTextParams): Promise<AdVerdict | null> {
  const prompts: AdDetectPrompts = currentAdDetectPrompts();
  return parseAdVerdict(await requestAdDetectJson({
    model: getAdDetectAgentConfig().model,
    instructions: prompts.instructions,
    // 系统事实与正文分开交给传输，不拼进用户可控的正文。
    fact: adDetectFact(justJoined),
    systemPrompt: justJoined ? prompts.justJoinedSystemPrompt : prompts.establishedSystemPrompt,
    userContent: text,
    temperature: AD_DETECT_TEMPERATURE,
    maxOutputTokens: AD_DETECT_MAX_OUTPUT_TOKENS,
    errorLabel: "Ad detection request",
  }));
}
