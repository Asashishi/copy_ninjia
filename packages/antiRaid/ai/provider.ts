/** ad_detect 按配置选择 Google 或 OpenAI 兼容传输，不做运行时故障切换。 */

import { getAdDetectAgentConfig } from "../../config/agent";
import { requestOpenAiAdDetectJson } from "./openai";
import { requestGoogleAdDetectJson } from "./google";
import type { AdDetectJsonRequestParams } from "../../types/antiRaid/adDetect";
import type { AgentProvider } from "../../types/config";

type AdDetectRequest = (params: AdDetectJsonRequestParams) => Promise<string | null>;

/** provider 到广告检测传输的穷举映射；扩展 AgentProvider 时编译器会要求补项。 */
const AD_DETECT_PROVIDERS: Readonly<Record<AgentProvider, AdDetectRequest>> = {
  google: requestGoogleAdDetectJson,
  openai: requestOpenAiAdDetectJson,
};

/** 按 ad_detect.provider 发起一次结构化判定请求。 */
export function requestAdDetectJson(
  params: AdDetectJsonRequestParams
): Promise<string | null> {
  return AD_DETECT_PROVIDERS[getAdDetectAgentConfig().provider](params);
}
