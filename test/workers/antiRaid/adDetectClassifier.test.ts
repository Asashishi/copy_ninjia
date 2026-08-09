import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getAdDetectAgentConfig } from "../../../packages/config/agent";

const errorLogs: string[] = [];
const requestAdDetectJson = mock(async (..._args: unknown[]): Promise<string | null> =>
  "{\"ad\": false, \"reason\": \"闲聊\"}");

mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));
mock.module("../../../packages/antiRaid/ai/provider", () => ({ requestAdDetectJson }));
mock.module("../../../packages/config/adSamples", () => ({
  getAdSampleConfig: (): readonly string[] => ["加溦拉群"],
}));

const { classifyAdText, parseAdVerdict } = await import("../../../packages/workers/antiRaid/adDetect/classifier");
const {
  AD_DETECT_MAX_OUTPUT_TOKENS,
  AD_DETECT_REASON_MAX_CHARS,
  AD_DETECT_TEMPERATURE,
} = await import("../../../packages/consts/antiRaid/adDetect");

beforeEach(() => {
  errorLogs.length = 0;
  requestAdDetectJson.mockClear();
  requestAdDetectJson.mockImplementation(async (): Promise<string | null> =>
    "{\"ad\": false, \"reason\": \"闲聊\"}");
});

describe("广告判定响应解析", () => {
  test("接受裸 JSON、代码块和前后夹带解释的输出", () => {
    expect(parseAdVerdict("{\"ad\": true, \"reason\": \"引流\"}")).toEqual({ isAd: true, reason: "引流" });
    expect(parseAdVerdict("```json\n{\"ad\": false, \"reason\": \"闲聊\"}\n```")).toEqual({ isAd: false, reason: "闲聊" });
    expect(parseAdVerdict("判定如下：{\"ad\": true, \"reason\": \"卖号\"} 完毕")).toEqual({ isAd: true, reason: "卖号" });
    // 多包一层数组同样只取里面那个对象——剥壳，而不是另一套判定语义。
    expect(parseAdVerdict("[{\"ad\": true, \"reason\": \"引流\"}]")).toEqual({ isAd: true, reason: "引流" });
  });

  test("只认真正的布尔 true，其余一律当成没判定", () => {
    // 判成 true 会把人永久拉黑，这里的宽容度必须是零。
    expect(parseAdVerdict("{\"ad\": \"true\", \"reason\": \"x\"}")).toBeNull();
    expect(parseAdVerdict("{\"ad\": 1}")).toBeNull();
    expect(parseAdVerdict("这不是 JSON")).toBeNull();
    expect(parseAdVerdict("{坏掉的 JSON")).toBeNull();
    expect(parseAdVerdict(undefined)).toBeNull();
    expect(parseAdVerdict(null)).toBeNull();
  });

  test("理由折成单行并截断，缺失时退化为空串", () => {
    expect(parseAdVerdict(`{"ad": true, "reason": "${"长".repeat(AD_DETECT_REASON_MAX_CHARS + 20)}"}`)?.reason)
      .toHaveLength(AD_DETECT_REASON_MAX_CHARS);
    expect(parseAdVerdict("{\"ad\": true, \"reason\": \"两\\n行\"}")).toEqual({ isAd: true, reason: "两 行" });
    expect(parseAdVerdict("{\"ad\": true}")).toEqual({ isAd: true, reason: "" });
  });
});

describe("广告判定请求", () => {
  test("按本领域的模型与采样参数发一次判定，部署示例进系统提示词", async () => {
    await expect(classifyAdText({ text: "1. 在吗", justJoined: false })).resolves.toEqual({ isAd: false, reason: "闲聊" });

    const params = requestAdDetectJson.mock.calls[0]?.[0] as {
      model: string;
      systemPrompt: string;
      userContent: string;
      temperature: number;
      maxOutputTokens: number;
      errorLabel: string;
    };
    expect(params.model).toBe(getAdDetectAgentConfig().model);
    expect(params.temperature).toBe(AD_DETECT_TEMPERATURE);
    expect(params.maxOutputTokens).toBe(AD_DETECT_MAX_OUTPUT_TOKENS);
    expect(params.errorLabel).toBe("Ad detection request");
    // 部署示例只进系统提示词；待判定原文只进 user 段，永远是数据。
    expect(params.systemPrompt).toContain("加溦拉群");
    // json_object 模式要求提示词提到 json，否则 DeepSeek 直接 400。
    expect(params.systemPrompt).toContain("JSON");
    expect(params.userContent).toBe("1. 在吗");
  });

  test("入群验证窗口这条系统事实只进 system 段，两侧都显式声明", async () => {
    // 模型自己看不到入群时间；只在成立时追加一句的话，它会把「这次没提」当成
    // 信息缺失去猜，而这条信号只有确证时才该加分。
    await classifyAdText({ text: "1. 加我", justJoined: true });
    const joined = requestAdDetectJson.mock.calls[0]?.[0] as { systemPrompt: string; userContent: string };
    expect(joined.systemPrompt).toContain("刚加入本群、尚未通过入群验证");
    // 正文全是用户可控内容：把系统事实混进去等于给刷屏号一个伪造它的机会。
    expect(joined.userContent).toBe("1. 加我");

    await classifyAdText({ text: "1. 加我", justJoined: false });
    const established = requestAdDetectJson.mock.calls[1]?.[0] as { systemPrompt: string };
    expect(established.systemPrompt).toContain("不在入群验证窗口内");
  });

  test("传输层已经返回 null 时不再解析，也不额外记一条日志", async () => {
    requestAdDetectJson.mockImplementation(async (): Promise<string | null> => null);
    await expect(classifyAdText({ text: "x", justJoined: false })).resolves.toBeNull();
    expect(errorLogs).toHaveLength(0);
  });

  test("看着像 JSON 却解析不出来时点名记录并当作没判定", async () => {
    requestAdDetectJson.mockImplementation(async (): Promise<string | null> => "{\"ad\" true}");
    await expect(classifyAdText({ text: "x", justJoined: false })).resolves.toBeNull();
    expect(errorLogs[0]).toContain("Ad detection response was not valid JSON");

    // 压根没有大括号的输出在解析前就被挡掉，不值得记一条日志。
    errorLogs.length = 0;
    requestAdDetectJson.mockImplementation(async (): Promise<string | null> => "我觉得不是广告");
    await expect(classifyAdText({ text: "x", justJoined: false })).resolves.toBeNull();
    expect(errorLogs).toHaveLength(0);
  });
});
