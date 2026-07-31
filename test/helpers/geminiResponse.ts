import { GenerateContentResponse } from "@google/genai";
import type {
  Candidate,
  GenerateContentResponsePromptFeedback,
  GenerateContentResponseUsageMetadata,
} from "@google/genai";

export interface GeminiResponseFixture {
  candidates?: Candidate[];
  promptFeedback?: GenerateContentResponsePromptFeedback;
  usageMetadata?: GenerateContentResponseUsageMetadata;
}

/** 用真实 SDK 响应类承载夹具，确保 text/functionCalls 访问器与生产环境一致。 */
export function geminiResponse(fixture: GeminiResponseFixture = {}): GenerateContentResponse {
  const response: GenerateContentResponse = new GenerateContentResponse();
  response.candidates = fixture.candidates;
  response.promptFeedback = fixture.promptFeedback;
  response.usageMetadata = fixture.usageMetadata;
  return response;
}
