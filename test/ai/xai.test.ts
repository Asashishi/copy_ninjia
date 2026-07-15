import { describe, expect, mock, test } from "bun:test";

/**
 * xai.ts 经 infra/config -> 环境变量、libs/httpFetch -> infra/logger ->
 * infra/diskIO，后者在模块顶层就会 `new Worker(...)`：单测里绝不能让它真的
 * 跑起来（理由同 test/commands/luckChallenge.test.ts 的模块头注释），先
 * mock 掉再动态 import。
 */
mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: mock((..._args: unknown[]): void => {}),
  onDiskIORespawn: mock((..._args: unknown[]): void => {}),
  relayLogMessage: mock((..._args: unknown[]): void => {}),
}));

const { extractFunctionCalls, extractOutputText } = await import("../../src/ai/xai");

/** 按实测的 /v1/responses 响应形状裁剪的夹具（reasoning/web_search_call/message 混排）。 */
const RESPONSE_FIXTURE = {
  status: "completed",
  output: [
    { type: "reasoning", summary: [{ text: "thinking..." }], status: "completed" },
    { type: "web_search_call", status: "completed", action: { type: "search", query: "Tokyo weather" } },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "今天东京" }, { type: "output_text", text: "晴。" }] },
    { type: "function_call", call_id: "call-abc-0", name: "get_current_time", arguments: "{}", status: "completed" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "热死了。" }] },
  ],
};

describe("ai/xai 响应解析", () => {
  test("extractOutputText：跨多个 message 成员按序拼接全部 output_text 段", () => {
    expect(extractOutputText(RESPONSE_FIXTURE)).toBe("今天东京晴。热死了。");
  });

  test("extractOutputText：无 message 成员 / 形状异常时返回空串", () => {
    expect(extractOutputText({ status: "completed", output: [{ type: "reasoning" }] })).toBe("");
    expect(extractOutputText({})).toBe("");
    expect(extractOutputText(null)).toBe("");
  });

  test("extractFunctionCalls：只取 function_call 成员（web_search_call 是服务端已执行的，不算）", () => {
    const calls = extractFunctionCalls(RESPONSE_FIXTURE);
    expect(calls.length).toBe(1);
    expect(calls[0].call_id).toBe("call-abc-0");
    expect(calls[0].name).toBe("get_current_time");
  });

  test("extractFunctionCalls：无调用时返回空数组", () => {
    expect(extractFunctionCalls({ output: [] })).toEqual([]);
    expect(extractFunctionCalls(undefined)).toEqual([]);
  });
});
