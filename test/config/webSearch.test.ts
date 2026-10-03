/** 独立 web_search 的调用上限严格解析；字段只属于该能力，与 text 内建搜索预算独立。 */
import { describe, expect, test } from "bun:test";
import { parseAgentDeploymentConfig } from "../../packages/config/agent";
import { parseWebSearchCapability } from "../../packages/config/agentCapability";
import { WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE } from "../../packages/consts/agent";
import type { AgentProvider, AgentWebSearchCapabilityConfig } from "../../packages/types/config";

/** 本文件自建的通用能力夹具。 */
const CAPABILITY: Readonly<Record<string, string>> = { provider: "openai", api_key: "fixture-key", model: "fixture-model" };

describe("web_search.max_calls_per_use", () => {
  test.each(["google", "openai", "anthropic"] as const)("%s 按配置解析；缺省时补齐独立默认值", (provider: AgentProvider) => {
    const config: AgentWebSearchCapabilityConfig = parseWebSearchCapability({ ...CAPABILITY, provider, max_calls_per_use: 7 }, "agent.json");
    expect(config.provider).toBe(provider);
    expect(config.maxCallsPerUse).toBe(7);
    expect(parseWebSearchCapability({ ...CAPABILITY, provider }, "agent.json").maxCallsPerUse)
      .toBe(WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE);
  });

  test.each([0, -1, 1.5, "7", "", null, true, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "存在但非法的值 %j 必须拒绝，不回填默认值",
    (value: unknown) => {
      expect(() => parseWebSearchCapability({ ...CAPABILITY, max_calls_per_use: value }, "config/dynamic/agent.json"))
        .toThrow("config/dynamic/agent.json: $.agent.web_search.max_calls_per_use must be a positive safe integer.");
    }
  );

  test("接受正安全整数边界，拒绝未知字段与其它能力上的 max_calls_per_use", () => {
    for (const maxCallsPerUse of [1, Number.MAX_SAFE_INTEGER]) {
      expect(parseWebSearchCapability({ ...CAPABILITY, max_calls_per_use: maxCallsPerUse }, "agent.json").maxCallsPerUse)
        .toBe(maxCallsPerUse);
    }
    expect(() => parseWebSearchCapability({ ...CAPABILITY, max_call_per_use: 7 }, "agent.json"))
      .toThrow("$.agent.web_search must be exactly");
    expect(() => parseAgentDeploymentConfig({
      text: { ...CAPABILITY, max_calls_per_use: 7 }, summary: CAPABILITY, media: CAPABILITY,
    }, "agent.json")).toThrow("$.agent.text must be exactly");
  });
});

/** 配置解析结果的只读约束仅做编译期检查，不执行赋值。 */
const assertReadonly = (): void => {
  const config: AgentWebSearchCapabilityConfig = parseWebSearchCapability(CAPABILITY, "agent.json");
  // @ts-expect-error 解析后的调用上限不可变。
  config.maxCallsPerUse = 1;
};
void assertReadonly;
