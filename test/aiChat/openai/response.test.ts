/**
 * OpenAI 响应的项目级诊断：HTTP 成功但产出不可用的归一化说明、收尾原因、
 * token 腰斩判定。职责与 test/aiChat/gemini/response.test.ts 一一对应。
 */

import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import {
  abnormalResponseDiagnostic,
  countWebSearchCalls,
  extractFunctionCalls,
  isTruncatedByTokenLimit,
  normalizedFinishReason,
  responseOutputText,
} from "../../../packages/aiChat/openai/response";
import { EMPTY_FUNCTION_CALLS } from "../../../packages/consts/aiChat/tools";
import { OPENAI_ERROR_DIAGNOSTIC_MAX_CHARS } from "../../../packages/consts/aiChat/openai";

function response(overrides: Record<string, unknown>): OpenAI.Responses.Response {
  return {
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [],
    output_text: "",
    ...overrides,
  } as unknown as OpenAI.Responses.Response;
}

describe("异常产出诊断", () => {
  test("正常收尾且有 output item 时没有诊断", () => {
    expect(abnormalResponseDiagnostic(response({
      output: [{ type: "message", content: [] }],
    }))).toBeNull();
  });

  test("服务端明确报错时点名 code 与 message", () => {
    const diagnostic: string | null = abnormalResponseDiagnostic(response({
      error: { code: "server_error", message: "boom" },
    }));
    expect(diagnostic).toContain("server_error");
    expect(diagnostic).toContain("boom");
  });

  test("状态不是 completed 时附上具体原因", () => {
    expect(abnormalResponseDiagnostic(response({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    }))).toBe("status=incomplete, reason=max_output_tokens");
    expect(abnormalResponseDiagnostic(response({ status: "failed" }))).toBe("status=failed");
  });

  test("完全没有 output item 与「模型没产出」不可区分，必须点名", () => {
    expect(abnormalResponseDiagnostic(response({ output: [] }))).toBe("no output items");
  });

  test("error 缺 message 或干脆是字符串时照样出诊断，不抛 TypeError", () => {
    // SDK 把 error 标成 { code, message } 必填，但兼容网关经常只给 code、
    // 或者把 error 整个写成一个字符串。
    const missingMessage: string | null = abnormalResponseDiagnostic(response({
      error: { code: "rate_limit" },
    }));
    expect(missingMessage).toContain("rate_limit");

    expect(abnormalResponseDiagnostic(response({ error: "rate limited" }))).toContain("rate limited");
    expect(abnormalResponseDiagnostic(response({ error: { message: "boom" } }))).toContain("boom");
  });

  test("error 字段是结构化对象时保留内容，序列化不出来才退成类型标记，且长度有界", () => {
    // message 可能是网关透传的结构化上游错误体；序列化失败（如循环引用）
    // 时退化为 [unserializable object] 标记，长度另外封顶。
    expect(abnormalResponseDiagnostic(response({ error: { message: { upstream: "quota exhausted" } } })))
      .toContain("quota exhausted");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(abnormalResponseDiagnostic(response({ error: { code: "loop", message: circular } })))
      .toContain("[unserializable object]");

    const diagnostic: string | null = abnormalResponseDiagnostic(response({
      error: { message: "x".repeat(OPENAI_ERROR_DIAGNOSTIC_MAX_CHARS * 3) },
    }));
    expect(diagnostic!.length).toBeLessThan(OPENAI_ERROR_DIAGNOSTIC_MAX_CHARS * 2);
  });

  test("网关省略 output 时按「没有 output item」处理，不抛 TypeError", () => {
    // SDK 把 output 标成必填数组，省略它的兼容网关会让它是 undefined；
    // 同时覆盖诊断、函数调用抽取、检索计数三处遍历点。
    expect(abnormalResponseDiagnostic(response({ output: undefined }))).toBe("no output items");
    expect(extractFunctionCalls(response({ output: undefined }))).toBe(EMPTY_FUNCTION_CALLS);
    expect(countWebSearchCalls(response({ output: undefined }))).toBe(0);
  });

  test("status 缺失按正常处理，与 normalizedFinishReason 同一口径", () => {
    // SDK 里 status?: ResponseStatus 本就是可选的，OpenAI 兼容网关普遍省略它。
    const withoutStatus: OpenAI.Responses.Response = response({
      status: undefined,
      output: [{ type: "message", content: [] }],
    });
    expect(abnormalResponseDiagnostic(withoutStatus)).toBeNull();
    expect(normalizedFinishReason(withoutStatus)).toBeUndefined();
  });
});

describe("正文读取", () => {
  test("网关省略 output_text 时读成空串，不抛也不字符串化成 \"undefined\"", () => {
    // SDK 只在响应体带 object:"response" 时才合成 output_text，省略该字段的
    // 网关会让它是 undefined。
    expect(responseOutputText(response({ output_text: undefined }))).toBe("");
    expect(responseOutputText(response({ output_text: "正文" }))).toBe("正文");
  });
});

describe("收尾原因归一与截断判定", () => {
  test("正常收尾没有收尾原因", () => {
    expect(normalizedFinishReason(response({}))).toBeUndefined();
  });

  test("incomplete 带具体原因时拼成 status:reason", () => {
    expect(normalizedFinishReason(response({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
    }))).toBe("incomplete:content_filter");
  });

  test("只认 max_output_tokens 为 token 腰斩", () => {
    expect(isTruncatedByTokenLimit(response({ incomplete_details: { reason: "max_output_tokens" } }))).toBe(true);
    expect(isTruncatedByTokenLimit(response({ incomplete_details: { reason: "content_filter" } }))).toBe(false);
    expect(isTruncatedByTokenLimit(response({}))).toBe(false);
  });
});

describe("产出抽取", () => {
  test("按 web_search_call item 统计服务端检索次数", () => {
    expect(countWebSearchCalls(response({
      output: [
        { type: "web_search_call" },
        { type: "message" },
        { type: "web_search_call" },
      ],
    }))).toBe(2);
    expect(countWebSearchCalls(response({ output: [{ type: "message" }] }))).toBe(0);
  });

  test("只抽出带 call_id 的函数调用，并保留原始入参字符串", () => {
    expect(extractFunctionCalls(response({
      output: [
        { type: "function_call", call_id: "a", name: "send_message", arguments: '{"text":"hi"}' },
        { type: "function_call", call_id: "", name: "dropped", arguments: "{}" },
        { type: "message" },
      ],
    }))).toEqual([{ id: "a", name: "send_message", argumentsJson: '{"text":"hi"}' }]);
  });

  test("零调用交回共用空数组，不在热路径上每轮新建一个", () => {
    expect(extractFunctionCalls(response({ output: [] }))).toBe(EMPTY_FUNCTION_CALLS);
    expect(extractFunctionCalls(response({
      output: [{ type: "message" }, { type: "function_call", call_id: "", name: "dropped", arguments: "{}" }],
    }))).toBe(EMPTY_FUNCTION_CALLS);
  });
});
