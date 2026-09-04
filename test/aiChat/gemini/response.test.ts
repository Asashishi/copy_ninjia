import { afterEach, describe, expect, mock, test } from "bun:test";
import { ToolType } from "@google/genai";
import type { GenerateContentResponse } from "@google/genai";
import { countGoogleSearchCalls, responseText } from "../../../packages/aiChat/gemini/response";
import { geminiResponse } from "../../helpers/geminiResponse";

/** 覆盖 SDK getter 与本地实现全部取值分支的响应：thought part 不计入正文，
 *  functionCall 这类非文本 part 只影响 getter 的告警、不影响取值。 */
const TEXT_CASES: readonly GenerateContentResponse[] = [
  geminiResponse(),
  geminiResponse({ candidates: [{}] }),
  geminiResponse({ candidates: [{ content: { parts: [] } }] }),
  geminiResponse({ candidates: [{ content: { parts: [{ text: "你好" }] } }] }),
  geminiResponse({ candidates: [{ content: { parts: [{ text: "" }] } }] }),
  geminiResponse({ candidates: [{ content: { parts: [{ text: "前" }, { text: "后" }] } }] }),
  geminiResponse({ candidates: [{ content: { parts: [{ text: "思考", thought: true }] } }] }),
  geminiResponse({ candidates: [{ content: { parts: [{ text: "思考", thought: true }, { text: "正文" }] } }] }),
  geminiResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "send_message", args: {} } }] } }] }),
  geminiResponse({
    candidates: [{
      content: {
        parts: [
          { functionCall: { name: "send_message", args: {} } },
          { text: "带工具调用的正文" },
        ],
      },
    }],
  }),
];

describe("aiChat/gemini/response", () => {
  test("countGoogleSearchCalls：优先统计 server-side toolCall，并用查询元数据兜底", () => {
    expect(countGoogleSearchCalls(geminiResponse({
      candidates: [{
        groundingMetadata: { webSearchQueries: ["不应重复计数"] },
        content: {
          parts: [
            { toolCall: { toolType: ToolType.GOOGLE_SEARCH_WEB } },
            { toolResponse: { toolType: ToolType.GOOGLE_SEARCH_WEB } },
            { toolCall: { toolType: ToolType.URL_CONTEXT } },
            { toolCall: { toolType: ToolType.GOOGLE_SEARCH_WEB } },
          ],
        },
      }],
    }))).toBe(2);
    expect(countGoogleSearchCalls(geminiResponse({
      candidates: [{ groundingMetadata: { webSearchQueries: ["q1", "q2", "q3"] } }],
    }))).toBe(3);
    expect(countGoogleSearchCalls(geminiResponse())).toBe(0);
  });

  describe("responseText", () => {
    const warn = console.warn;
    afterEach((): void => {
      console.warn = warn;
    });

    test("取值与 SDK 的 text 访问器逐项一致", () => {
      for (const response of TEXT_CASES) {
        // getter 自己会为非文本 part 打印告警，这里只比取值，先把它按下。
        console.warn = mock((): void => {});
        const expected: string | undefined = response.text;
        console.warn = warn;
        expect(responseText(response)).toBe(expected);
      }
    });

    test("带 functionCall 的响应不再打印 SDK 那行非文本 part 告警", () => {
      // 工具轮的响应必然带 functionCall part：SDK 的 getter 每轮刷一行绕过 logger 的
      // 告警，本地实现必须一行都不打（回归这条就是本函数存在的全部理由）。
      const toolRound: GenerateContentResponse = geminiResponse({
        candidates: [{
          content: {
            parts: [
              { functionCall: { name: "send_message", args: { text: "在" } } },
              { functionCall: { name: "add_reaction", args: { emoji: "👍" } } },
            ],
          },
        }],
      });

      const warnMock = mock((..._args: unknown[]): void => {});
      console.warn = warnMock;
      expect(responseText(toolRound)).toBeUndefined();
      expect(warnMock).not.toHaveBeenCalled();

      // 同一份响应交给 SDK 的 getter 就会打印——差别只在这一处副作用。
      expect(toolRound.text).toBeUndefined();
      expect(warnMock).toHaveBeenCalledTimes(1);
    });
  });
});
