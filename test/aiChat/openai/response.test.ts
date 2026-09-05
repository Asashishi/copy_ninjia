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
import { OPENAI_EMPTY_FUNCTION_CALLS as EMPTY_FUNCTION_CALLS } from "../../../packages/consts/aiChat/openai";
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
    // 本函数的调用点在 requestOpenAiResult 的 try/catch 之外，抛出去的异常会
    // 一路穿过 session.request() 与 generateReply，被回复循环最外层的 .catch
    // 吞掉：群里整轮静默，日志里只剩一个泛化的 TypeError——恰好把这个诊断
    // 存在的意义丢干净。SDK 把 error 标成 { code, message } 必填，但兼容网关
    // 经常只给 code、或者把 error 整个写成一个字符串。
    const missingMessage: string | null = abnormalResponseDiagnostic(response({
      error: { code: "rate_limit" },
    }));
    expect(missingMessage).toContain("rate_limit");

    expect(abnormalResponseDiagnostic(response({ error: "rate limited" }))).toContain("rate limited");
    expect(abnormalResponseDiagnostic(response({ error: { message: "boom" } }))).toContain("boom");
  });

  test("error 字段是结构化对象时保留内容，序列化不出来才退成类型标记，且长度有界", () => {
    // 网关会往 message 里塞结构化的上游错误，一律 String() 成 [object Object]
    // 等于把这次诊断作废；反过来，形状不受本进程控制，长度也必须封顶。
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
    // SDK 把 output 标成必填数组；省略它的代理/自建网关会让三个遍历点
    // （诊断、函数调用抽取、检索计数）在 .length 或 for...of 处当场抛错。
    expect(abnormalResponseDiagnostic(response({ output: undefined }))).toBe("no output items");
    expect(extractFunctionCalls(response({ output: undefined }))).toBe(EMPTY_FUNCTION_CALLS);
    expect(countWebSearchCalls(response({ output: undefined }))).toBe(0);
  });

  test("status 缺失按正常处理，与 normalizedFinishReason 同一口径", () => {
    // SDK 里 `status?: ResponseStatus` 本就是可选的，OpenAI 兼容网关普遍省略它。
    // 判成异常的话，回复、记忆压缩、贴纸包摘要、媒体描述的每一个请求都会被
    // 丢弃，而日志里只有一句 status=?——因为收尾原因那边认为它正常结束。
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
    // SDK 只在响应体带 object:"response" 时才合成 output_text；无保护解引用
    // 会在 `.length` 处抛 TypeError 冲出实现包，或被清洗函数强转成字面量
    // "undefined" 混进摘要与媒体描述。
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
    // 每个回复的最后一轮按构造必然零 function call（replyModel.ts 的循环退出
    // 条件），纯文本中间轮同理——这条路才是有流量的那条。
    expect(extractFunctionCalls(response({ output: [] }))).toBe(EMPTY_FUNCTION_CALLS);
    expect(extractFunctionCalls(response({
      output: [{ type: "message" }, { type: "function_call", call_id: "", name: "dropped", arguments: "{}" }],
    }))).toBe(EMPTY_FUNCTION_CALLS);
  });
});
