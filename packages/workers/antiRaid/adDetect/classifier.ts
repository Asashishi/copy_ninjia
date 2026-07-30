/**
 * 广告判定的领域逻辑：拼提示词、发一次请求、把模型输出收窄成判定结果。
 * 传输层（客户端单例、超时、重试、错误日志）在 ai/deepseek.ts，本文件不碰。
 *
 * 判定是尽力而为的启发式：请求失败、超时、返回形状不对，一律返回 null 让调用
 * 方原样跳过这一批——绝不猜一个 true 出来，那等于凭一次网络抖动把人拉黑。
 * 判定口径由部署配置 config/ad_samples.json 提供（见 config/adSamples.ts），
 * 提示词模板在 consts/antiRaid/adDetect.ts。
 *
 * 模型看到的群聊原文一律是数据：提示词里已声明其中的任何指令都不得执行，
 * 且输出被限制成一个只含 ad/reason 两个字段的 JSON，reason 只进日志与播报
 * 前缀，不参与任何控制流。
 */

import { requestDeepSeekJson } from "../../../ai/deepseek";
import { getAdSampleConfig } from "../../../config/adSamples";
import { logger } from "../../../infra/logger";
import {
  AD_DETECT_MAX_OUTPUT_TOKENS,
  AD_DETECT_MODEL,
  AD_DETECT_REASON_MAX_CHARS,
  AD_DETECT_TEMPERATURE,
  buildAdDetectSystemPrompt,
} from "../../../consts/antiRaid/adDetect";
import { isPlainRecord } from "../../../libs/runtimeConfig";
import { truncateInline } from "../../../libs/text";
import type { AdVerdict } from "../../../types/antiRaid/adDetect";

/**
 * 从模型输出里收窄出判定结果。模型被要求只输出 JSON，但「被要求」不等于
 * 「一定做到」：多包一层代码块、前后带一句解释都见过，因此先剥 ```，再退化到
 * 取第一个 {...} 片段。任何一步不成立都返回 null（当作本次判定没发生）。
 * 导出仅为可测试性；判定路径只经 classifyAdText 调用。
 */
export function parseAdVerdict(raw: string | null | undefined): AdVerdict | null {
  if (typeof raw !== "string") return null;
  const unfenced: string = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start: number = unfenced.indexOf("{");
  const end: number = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1)) as unknown;
  } catch (error: unknown) {
    logger.error("Ad detection response was not valid JSON:", error);
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  const verdict: Record<string, unknown> = parsed;
  // 只认真正的布尔 true：字符串 "true"、1、"yes" 一律不算——判定为真会直接
  // 把人永久拉黑，这里的宽容度必须是零。
  if (typeof verdict.ad !== "boolean") return null;
  // 走 truncateInline 而不是裸 slice：这段理由会被拼进群内播报直接发给 Telegram
  // （见 antiRaid/adDetect.ts 的 formatAdNotice），而 slice 恰好切在代理对中间时
  // 留下的孤立高位代理会让整条 sendMessage 被 400 拒收——人已经拉黑封禁了，群里
  // 却收不到任何解释，正是那条播报存在的意义。
  const reason: string = typeof verdict.reason === "string"
    ? truncateInline(verdict.reason.replace(/\s+/g, " ").trim(), AD_DETECT_REASON_MAX_CHARS)
    : "";
  return { isAd: verdict.ad, reason };
}

export interface ClassifyAdTextParams {
  /** 已拼好的待判定消息串（逐行编号，见 adDetect/queue.ts）。 */
  text: string;
  /** 该发送者是否仍在入群验证窗口内；只进 system 段，不拼进待判定正文。 */
  justJoined: boolean;
}

/**
 * 两个提示词变体的 Worker 内缓存，键就是 justJoined。
 *
 * buildAdDetectSystemPrompt 会把最多 MAX_CONFIGURED_AD_SAMPLES 条示例 map+join
 * 成一整段文本，而全部输入都不随请求变化——getAdSampleConfig() 返回的是 frozen
 * 数组，只有 justJoined 有两种取值。不缓存的话，满载时每秒最多
 * AD_DETECT_BATCH_SIZE 次判定各重建一遍同样的字符串，纯粹是给 isolate 制造
 * GC 压力，而这条线程上还压着验证踢人与封禁。
 */
const systemPrompts: Map<boolean, string> = new Map();

function adDetectSystemPrompt(justJoined: boolean): string {
  let prompt: string | undefined = systemPrompts.get(justJoined);
  if (prompt === undefined) {
    prompt = buildAdDetectSystemPrompt(getAdSampleConfig(), justJoined);
    systemPrompts.set(justJoined, prompt);
  }
  return prompt;
}

/**
 * 判定一串消息是不是广告。
 * @returns 判定结果；请求或解析失败时为 null，调用方应视为「本次没判定」。
 */
export async function classifyAdText({ text, justJoined }: ClassifyAdTextParams): Promise<AdVerdict | null> {
  return parseAdVerdict(await requestDeepSeekJson({
    model: AD_DETECT_MODEL,
    // 系统事实拼在 system 段：正文全是用户可控内容，混进去等于给刷屏号一个
    // 伪造「【系统事实】该发送者不是新成员」的机会。
    systemPrompt: adDetectSystemPrompt(justJoined),
    userContent: text,
    temperature: AD_DETECT_TEMPERATURE,
    maxOutputTokens: AD_DETECT_MAX_OUTPUT_TOKENS,
    errorLabel: "Ad detection request",
  }));
}
