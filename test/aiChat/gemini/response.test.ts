import { describe, expect, test } from "bun:test";
import { ToolType } from "@google/genai";
import { countGoogleSearchCalls } from "../../../packages/aiChat/gemini/response";
import { geminiResponse } from "../../helpers/geminiResponse";

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
});
