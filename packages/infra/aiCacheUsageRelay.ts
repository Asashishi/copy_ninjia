import type { AiCacheUsage } from "../types/aiCache";
import { postDiskIODiagnostic } from "./diskIO";
import { warnAiUsageUnavailable } from "./aiCacheUsage";

/** 主线程接管业务 Worker 的用量事件；统一诊断信封与拒收原因，不在来源 Worker 重复计数。 */
export function relayAiCacheUsage(usage: AiCacheUsage): void {
  if (!postDiskIODiagnostic({ type: "aiCacheUsage", ...usage })) {
    warnAiUsageUnavailable(usage.capability, usage.provider, "transport");
  }
}
