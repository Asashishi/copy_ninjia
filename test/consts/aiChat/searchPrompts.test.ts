/**
 * 联网查证三段文案的供应商中立性。
 *
 * 这份守卫针对一个真实踩过的坑：文案里写死 `googleSearch` 之后，走 OpenAI 的
 * 部署等于在告诉模型「去调用一个它工具清单里根本不存在的工具」，模型可能据此
 * 认定自己没有检索能力而整轮放弃查证——而且这类失效不会报错，只会表现成
 * 「机器人开始凭印象讲事实」。
 *
 * 两家的真名都不许出现在提示词里，统一用 WEB_SEARCH_TOOL_LABEL。
 */

import { describe, expect, test } from "bun:test";
import {
  buildGroundedWebSearchInstruction,
  buildWebSearchInstruction,
  WEB_SEARCH_EXHAUSTED_INSTRUCTION,
  WEB_SEARCH_TOOL_LABEL,
} from "../../../packages/consts/aiChat/prompts/search";
import { REPLY_ACTION_INSTRUCTION } from "../../../packages/consts/aiChat/prompts/tools";
import { MAX_WEB_SEARCH_CALLS_PER_REPLY } from "../../../packages/consts/aiChat/tools";

/** 两家服务端检索工具的真名；任何一个出现在提示词里都是 bug。 */
const PROVIDER_TOOL_NAMES: readonly string[] = ["googleSearch", "web_search", "Google Search"];

const ALL_SEARCH_PROMPTS: readonly string[] = [
  buildWebSearchInstruction(MAX_WEB_SEARCH_CALLS_PER_REPLY),
  buildGroundedWebSearchInstruction(1),
  WEB_SEARCH_EXHAUSTED_INSTRUCTION,
];

describe("联网查证文案不绑定任何一家供应商", () => {
  test("三段文案都不出现供应商的工具真名", () => {
    for (const prompt of ALL_SEARCH_PROMPTS) {
      for (const name of PROVIDER_TOOL_NAMES) {
        expect(prompt).not.toContain(name);
      }
    }
  });

  test("三段文案都用统一的中立称呼指代检索工具", () => {
    for (const prompt of ALL_SEARCH_PROMPTS) {
      expect(prompt).toContain(WEB_SEARCH_TOOL_LABEL);
    }
  });

  test("动作工具说明里的查证前置要求同样走统一称呼", () => {
    expect(REPLY_ACTION_INSTRUCTION).toContain(WEB_SEARCH_TOOL_LABEL);
    for (const name of PROVIDER_TOOL_NAMES) {
      expect(REPLY_ACTION_INSTRUCTION).not.toContain(name);
    }
  });

  test("额度上限在三段文案里都以同一个常量表述", () => {
    expect(buildWebSearchInstruction(3)).toContain(`最多调用 ${MAX_WEB_SEARCH_CALLS_PER_REPLY} 次`);
    expect(buildGroundedWebSearchInstruction(1)).toContain(`最多调用 ${MAX_WEB_SEARCH_CALLS_PER_REPLY} 次`);
    expect(WEB_SEARCH_EXHAUSTED_INSTRUCTION).toContain(`已经达到 ${MAX_WEB_SEARCH_CALLS_PER_REPLY} 次`);
  });
});
