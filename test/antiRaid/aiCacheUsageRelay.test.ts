import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { diskIOStub } from "../helpers/diskIOMock";
import { logger } from "../../packages/infra/logger";
import { installAiCacheUsageSink } from "../../packages/infra/aiCacheUsage";
import type { AiCacheUsageDiskMessage, AdSampleDiskMessage } from "../../packages/types/diskIO/messages";

const diagnostics: (AdSampleDiskMessage | AiCacheUsageDiskMessage)[] = [];
let accepts: boolean = true;
mock.module("../../packages/infra/diskIO", () => diskIOStub({
  postDiskIODiagnostic: (message: AdSampleDiskMessage | AiCacheUsageDiskMessage): boolean => {
    diagnostics.push(message);
    return accepts;
  },
}));

const { handleAntiRaidWorkerEvent } = await import("../../packages/antiRaid/workerBridge/events");

afterEach(() => {
  accepts = true;
  diagnostics.length = 0;
  installAiCacheUsageSink(null);
});

test("Anti-Raid Worker 的缓存用量事件原样转投诊断通道，不回投 Worker", () => {
  const posted: unknown[] = [];
  const usage = {
    timestamp: 1_700_000_000_000,
    capability: "ad_detect",
    provider: "openai",
    model: "deepseek-flash",
    inputTokens: 1_200,
    cachedInputTokens: 1_152,
    outputTokens: 30,
  } as const;
  handleAntiRaidWorkerEvent({ type: "aiCacheUsage", usage }, (message: unknown): void => { posted.push(message); });
  expect(diagnostics).toEqual([{ type: "aiCacheUsage", ...usage }]);
  expect(posted).toEqual([]);
});

test("用量诊断被拒收时按能力与供应商只告警一次", () => {
  const warning = spyOn(logger, "warn").mockImplementation((): void => {});
  accepts = false;
  try {
    const event = { type: "aiCacheUsage", usage: {
      timestamp: 1, capability: "ad_detect", provider: "google", model: "fixture",
      inputTokens: 1, cachedInputTokens: 0, outputTokens: 2,
    } } as const;
    handleAntiRaidWorkerEvent(event, (): void => {});
    handleAntiRaidWorkerEvent(event, (): void => {});
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("AI token usage unavailable: capability=ad_detect, provider=google, reason=transport.");
  } finally {
    warning.mockRestore();
  }
});
