import { resetReplyToolsetMocks } from "../../helpers/replyToolsetMocks";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { weatherCache } from "../../../packages/cache/workers/aiChat/weather";
import { GET_TOKYO_WEATHER_TOOL, TOOL_DECLARATIONS } from "../../../packages/consts/tools";
import { TOKYO_TIME_ZONE } from "../../../packages/consts/time";
import { adoptTimeZone, getTimeZone } from "../../../packages/config/time";
import { parseBotConfig } from "../../../packages/config/botInput";
import { callTool } from "../../../packages/aiChat/ai/tools";
import type { AiToolDefinition } from "../../../packages/types/aiChat/provider";
import type { ReplyToolContext, ReplyToolset } from "../../../packages/types/aiChat/replies";

const { createReplyToolset } = await import("../../../packages/aiChat/ai/tools/replyToolset/orchestrator");
const INITIAL_TIME_ZONE: string = getTimeZone();

beforeEach((): void => {
  resetReplyToolsetMocks();
  adoptTimeZone(TOKYO_TIME_ZONE);
});

afterEach((): void => {
  adoptTimeZone(INITIAL_TIME_ZONE);
  weatherCache.current = null;
});

describe("AI 静态查询工具", () => {
  test("天气缓存未就绪时返回可诊断错误", () => {
    expect(TOOL_DECLARATIONS.map((declaration) => declaration.name)).toContain(GET_TOKYO_WEATHER_TOOL);
    expect(JSON.parse(callTool(GET_TOKYO_WEATHER_TOOL))).toEqual({ error: "Weather data not available yet" });
  });

  test("返回已有天气快照，并拒绝未知工具名", () => {
    weatherCache.current = {
      currentTemperatureC: 31,
      currentCondition: "晴",
      todayMaxC: 34,
      todayMinC: 25,
      todayCondition: "晴间多云",
    };
    expect(JSON.parse(callTool(GET_TOKYO_WEATHER_TOOL))).toEqual(weatherCache.current);
    expect(JSON.parse(callTool("missing_tool"))).toEqual({ error: "Unknown tool: missing_tool" });
  });

  test.each([
    [undefined, true],
    [TOKYO_TIME_ZONE, true],
    [` ${TOKYO_TIME_ZONE} `, true],
    ["UTC", false],
    ["Asia/Shanghai", false],
    ["Asia/Seoul", false],
  ] as const)("启动时区 %s 的工具注册与执行一致", async (timeZone: string | undefined, enabled: boolean): Promise<void> => {
    adoptTimeZone(parseBotConfig({
      bot_token: "token:fixture",
      super_admin_user_id: 7,
      time_zone: timeZone,
    }).timeZone);
    weatherCache.current = {
      currentTemperatureC: 20,
      currentCondition: "晴",
      todayMaxC: 25,
      todayMinC: 15,
      todayCondition: "晴",
    };
    const context: ReplyToolContext = {
      chatId: -100800,
      replyToMessageId: 10,
      messageThreadId: undefined,
      mediaToolsRequested: false,
      bypassMediaToolCooldown: false,
      direct: false,
      chatAction: {
        set: mock((): number => 0),
        settle: mock(async (): Promise<void> => {}),
      },
      roundHasTypo: false,
      isActive: (): boolean => true,
      onMessageSent: mock((): void => {}),
      onStickerSent: mock((): void => {}),
      onImageSent: mock((): void => {}),
      onVoiceSent: mock((): void => {}),
    };
    const toolset: ReplyToolset = await createReplyToolset(context);
    expect(toolset.functions.some((declaration: AiToolDefinition): boolean => declaration.name === GET_TOKYO_WEATHER_TOOL)).toBe(enabled);
    expect(JSON.parse(callTool(GET_TOKYO_WEATHER_TOOL))).toEqual(enabled
      ? weatherCache.current
      : { error: `Unknown tool: ${GET_TOKYO_WEATHER_TOOL}` });
  });
});
