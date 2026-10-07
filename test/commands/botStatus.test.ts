import { TTS_DEFAULT_BOT_LANGUAGE, TTS_DEFAULT_STYLE } from "../../packages/consts/aiChat/voiceMessage";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildBotStatusMessage,
  formatBotMemory,
  formatBotUptime,
} from "../../packages/commands/botStatus";
import type { BotStatusSnapshot } from "../../packages/commands/botStatus";
import { BOT_CHAT_PERMISSION_KEYS } from "../../packages/consts/botAdmin";
import { MAX_SUMMARY_ROUNDS, VERBATIM_CONTEXT_MAX } from "../../packages/consts/aiChat/memory";
import {
  BOT_STATUS_COLD_MEMORY_WEIGHT,
  BOT_STATUS_DECIMAL_PLACES,
  BOT_STATUS_FEATURE_KEYS,
  BOT_STATUS_HOT_MEMORY_WEIGHT,
  BOT_STATUS_PERCENT_SCALE,
} from "../../packages/consts/botStatus";
import { TELEGRAM_429_RETRY_QUEUE_MAX } from "../../packages/consts/telegram";
import { GAG_SESSION_MAX } from "../../packages/consts/gag";
import { TRANSLATE_CHAT_USER_LIMIT } from "../../packages/consts/translate";
import { botPermissions } from "../helpers/botPermissions";
import { chatStateOf } from "../helpers/chatState";
import { botAtmosphereState } from "../../packages/cache/main/atmosphere";
import type { Atmosphere } from "../../packages/types/atmosphere";
import { parseMarkdownV2 } from "../helpers/markdownV2";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import type { ParsedMarkdownV2 } from "../helpers/markdownV2";
import type { AtmosphereNotices } from "../../packages/types/atmosphereNotices";

const PLAIN: Readonly<AtmosphereNotices> = ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS;
const TEASING: Readonly<AtmosphereNotices> = ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS;

/** 夹具里热记忆占上限的一半、冷记忆摘要占满上限时，按两段权重加权求和得到的展示百分比。 */
const expectedContextUsagePercent: string = `${(
  (BOT_STATUS_HOT_MEMORY_WEIGHT * 0.5 + BOT_STATUS_COLD_MEMORY_WEIGHT * 1) * BOT_STATUS_PERCENT_SCALE
).toFixed(BOT_STATUS_DECIMAL_PLACES)}%`;

/** 按 Telegram 的 MarkdownV2 解析口径还原回执的可见正文与实体；原文会被拒收时直接抛错。 */
function renderStatus(snapshot: BotStatusSnapshot): ParsedMarkdownV2 {
  return parseMarkdownV2(buildBotStatusMessage(snapshot).text);
}

/** 在指定的本进程文案风格下执行，结束后还原 preload 接管的值。 */
function withAtmosphere<T>(atmosphere: Atmosphere, run: () => T): T {
  const previous: Atmosphere | null = botAtmosphereState.current;
  botAtmosphereState.current = atmosphere;
  try {
    return run();
  } finally {
    botAtmosphereState.current = previous;
  }
}

function statusSnapshot(): BotStatusSnapshot {
  return {
    chatId: -1001234567890,
    aiReady: true,
    aiConfig: {
      text: {
        provider: "openai",
        apiKey: "secret-text-key",
        baseUrl: "https://secret-text.example/v1",
        headers: undefined,
        model: "openai/gpt-status",
      },
      summary: {
        provider: "google",
        apiKey: "secret-summary-key",
        baseUrl: undefined,
        headers: undefined,
        model: "gemini-summary",
      },
      media: {
        provider: "google",
        apiKey: "secret-media-key",
        baseUrl: undefined,
        headers: undefined,
        model: "gemini-media",
      },
      tts: {
        provider: "google",
        apiKey: "secret-tts-key",
        baseUrl: undefined,
        headers: undefined,
        model: "gemini-tts",
        speechProtocol: undefined,
        voice: "Leda",
        style: TTS_DEFAULT_STYLE,
        language: undefined,
        botLanguage: TTS_DEFAULT_BOT_LANGUAGE,
        dailyLimit: 100,
        dailyReserveQuota: 25,
      },
    },
    adDetectReady: true,
    adDetectConfig: {
      provider: "openai",
      apiKey: "secret-ad-key",
      baseUrl: "https://secret-ad.example/v1",
      headers: undefined,
      model: "ad-model",
    },
    chatState: chatStateOf({
      isInitEnabled: true,
      isAIChatEnabled: true,
      isAdDetectEnabled: true,
      isAntiRaidEnabled: true,
      botPermissions: botPermissions({ canDeleteMessages: true }),
    }),
    telegramActive: 7,
    telegramPending: 1_024,
    telegramCapacity: TELEGRAM_429_RETRY_QUEUE_MAX,
    activeGagSessions: 3,
    activeTranslateSessions: 2,
    aiContextUsage: { bufferedCount: VERBATIM_CONTEXT_MAX / 2, summaryCount: MAX_SUMMARY_ROUNDS },
    processStatus: {
      uptimeSeconds: 183_845,
      averageCpuPercent: 12.345,
      availableCpuCount: 6,
      memoryFootprintBytes: 512 * 1_024 * 1_024,
      memoryLimitBytes: 8 * 1_024 * 1_024 * 1_024,
      memoryPercent: 6.25,
    },
  };
}

describe("/bot_status", () => {
  // 除点名语气的用例外，本组使用普通通知文案。
  const preloaded: Atmosphere | null = botAtmosphereState.current;
  beforeEach(() => { botAtmosphereState.current = "plain"; });
  afterEach(() => { botAtmosphereState.current = preloaded; });

  test("只展示已配置的模型名和本群开启项，不泄漏密钥或端点", () => {
    const text: string = renderStatus(statusSnapshot()).text;

    expect(text).toStartWith(ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS.statusTitle);
    expect(text).toContain(ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS.statusModels);
    expect(text).toContain(`${PLAIN.statusModelText("gpt-status")}\n`);
    expect(text).toContain(`${PLAIN.statusModelSummary("gemini-summary")}\n`);
    expect(text).toContain(`${PLAIN.statusModelMedia("gemini-media")}\n`);
    expect(text).toContain(`${PLAIN.statusModelTts("gemini-tts")}\n`);
    expect(text).toContain(`${PLAIN.statusModelAdDetect("ad-model")}\n`);
    expect(text).not.toContain(PLAIN.statusModelImage(""));
    expect(text).not.toContain(PLAIN.statusModelWebSearch(""));
    expect(text).not.toContain("已配置");
    expect(text).not.toContain("未配置");
    expect(text).toContain(
      `${PLAIN.statusTelegram}\n${PLAIN.statusTelegramActive(7)}\n` +
      PLAIN.statusTelegramPending(1024, TELEGRAM_429_RETRY_QUEUE_MAX)
    );
    expect(text).not.toContain("openai");
    expect(text).not.toContain("google");
    // 本群一组：id 在前，翻译会话占用在最后，不再展示提示词状态。
    expect(text).toContain(
      `${PLAIN.statusChatIdLabel}-1001234567890\n` +
      PLAIN.statusContextUsage(expectedContextUsagePercent) + "\n" +
      PLAIN.statusGag(3, GAG_SESSION_MAX) + "\n" +
      PLAIN.statusTranslate(2, TRANSLATE_CHAT_USER_LIMIT) + "\n\n"
    );
    expect(text).not.toContain("提示词");
    expect(text).toContain(PLAIN.statusProcess);
    expect(text).toContain(PLAIN.statusUptime(PLAIN.statusUptimeWithDays(2, "03:04:05")));
    expect(text).toContain(PLAIN.statusCpu("12.35%", 6));
    expect(text).not.toContain("运行期平均");
    expect(text).toContain(PLAIN.statusMemory("512.00 MiB", "8.00 GiB", "6.25%"));
    expect(text).toContain('"isAIChatEnabled": true');
    expect(text).toContain('"isAntiRaidEnabled": true');
    expect(text).toContain('"isTranslationEnabled": false');
    expect(text).not.toContain("secret-");
    expect(text).not.toContain("example/v1");
    // 上下文容量按两段记忆的占用加权折算成百分比；只给百分比，两段记忆的原始条数不对群友外露。
    expect(text).not.toContain("滑动热记忆");
    expect(text).not.toContain("冷记忆摘要");
  });

  test("上下文利用率：只占满热记忆或只占满冷记忆摘要时，各自只贡献自己的权重", () => {
    const percentLine = (weight: number): string =>
      ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS.statusContextUsage(
        `${(weight * BOT_STATUS_PERCENT_SCALE).toFixed(BOT_STATUS_DECIMAL_PLACES)}%`
      );
    const hotOnly: string = renderStatus({
      ...statusSnapshot(),
      aiContextUsage: { bufferedCount: VERBATIM_CONTEXT_MAX, summaryCount: 0 },
    }).text;
    const coldOnly: string = renderStatus({
      ...statusSnapshot(),
      aiContextUsage: { bufferedCount: 0, summaryCount: MAX_SUMMARY_ROUNDS },
    }).text;

    expect(hotOnly).toContain(percentLine(BOT_STATUS_HOT_MEMORY_WEIGHT));
    expect(coldOnly).toContain(percentLine(BOT_STATUS_COLD_MEMORY_WEIGHT));
  });

  test("配置了 web_search 时联网检索行展示它的模型名，不显示余量", () => {
    const snapshot: BotStatusSnapshot = statusSnapshot();
    const text: string = renderStatus({
      ...snapshot,
      aiConfig: {
        ...snapshot.aiConfig!,
        webSearch: {
          provider: "openai",
          apiKey: "secret-search-key",
          baseUrl: undefined,
          headers: undefined,
          model: "openai/gpt-search",
          maxCallsPerUse: 7,
        },
      },
    }).text;
    expect(text).toContain(`${PLAIN.statusModelTts("gemini-tts")}\n${PLAIN.statusModelWebSearch("gpt-search")}\n`);
    expect(text).not.toContain("secret-search-key");
  });

  test("可选生图已配置时展示模型，未配置的语音与广告检测不占行", () => {
    const snapshot: BotStatusSnapshot = statusSnapshot();
    const text: string = renderStatus({
      ...snapshot,
      aiConfig: {
        ...snapshot.aiConfig!,
        image: {
          provider: "google",
          apiKey: "secret-image-key",
          baseUrl: undefined,
          headers: undefined,
          model: "google/imagen-status",
          imageProtocol: undefined,
        },
        tts: undefined,
      },
      adDetectReady: false,
      adDetectConfig: null,
    }).text;

    expect(text).toContain(`${PLAIN.statusModelImage("imagen-status")}\n`);
    expect(text).not.toContain(PLAIN.statusModelTts(""));
    expect(text).not.toContain(PLAIN.statusModelAdDetect(""));
    expect(text).not.toContain("secret-image-key");
  });

  test("xai 语音协议没有模型名，语音合成行展示音色", () => {
    const snapshot: BotStatusSnapshot = statusSnapshot();
    const text: string = renderStatus({
      ...snapshot,
      aiConfig: {
        ...snapshot.aiConfig!,
        tts: {
          provider: "openai",
          apiKey: "secret-xai-key",
          baseUrl: undefined,
          headers: undefined,
          model: undefined,
          speechProtocol: "xai",
          voice: "ara",
          style: undefined,
          language: "auto",
          botLanguage: TTS_DEFAULT_BOT_LANGUAGE,
          dailyLimit: 100,
          dailyReserveQuota: 25,
        },
      },
    }).text;
    expect(text).toContain(`${PLAIN.statusModelTts("ara")}\n`);
    expect(text).not.toContain("secret-xai-key");
  });

  test("部署能力不可用时省略模型能力段，群功能仍完整展示", () => {
    const text: string = withAtmosphere("teasing", (): string => renderStatus({
      ...statusSnapshot(),
      aiReady: false,
      aiConfig: null,
      adDetectReady: false,
      adDetectConfig: null,
      chatState: chatStateOf(),
      telegramActive: 0,
      telegramPending: 0,
      aiContextUsage: undefined,
    }).text);

    expect(text).not.toContain(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.statusModels);
    expect(text).not.toContain("AI 对话能力：");
    expect(text).not.toContain(TEASING.statusModelAdDetect(""));
    expect(text).toContain(TEASING.statusTelegram);
    // 镜像没有条目就是「此刻没有可展示的上下文」，按 0 展示而不是沿用旧值。
    expect(text).toContain(
      `${TEASING.statusChatIdLabel}-1001234567890\n` +
      TEASING.statusContextUsage("0.00%") + "\n" +
      TEASING.statusGag(3, GAG_SESSION_MAX) + "\n" +
      TEASING.statusTranslate(2, TRANSLATE_CHAT_USER_LIMIT) + "\n\n"
    );
    expect(text).toEndWith(
      `${TEASING.statusFeatures}\n` +
      "{\n" +
      '  "isInitEnabled": false,\n' +
      '  "isAIChatEnabled": false,\n' +
      '  "isTranslationEnabled": false,\n' +
      '  "isAdDetectEnabled": false,\n' +
      '  "isFloodControlEnabled": false,\n' +
      '  "isAntiRaidEnabled": false,\n' +
      '  "isProxySendEnabled": false\n' +
      "}"
    );
  });

  test("对话能力不可用但广告检测可用时只列广告模型", () => {
    const text: string = renderStatus({
      ...statusSnapshot(),
      aiReady: false,
      aiConfig: null,
    }).text;

    expect(text).toContain(`${PLAIN.statusModels}\n${PLAIN.statusModelAdDetect("ad-model")}\n`);
    expect(text).not.toContain(PLAIN.statusModelText(""));
    expect(text).not.toContain("AI 对话能力：");
  });

  test("本群权限块只列已经拥有的位，键给英文字段名、值给中文名", () => {
    const message: ParsedMarkdownV2 = renderStatus(statusSnapshot());
    const entity = message.entities[1]!;
    expect(message.entities).toHaveLength(3);
    expect(entity.type).toBe("pre");
    expect(entity).toMatchObject({ language: "json" });
    const json: string = message.text.slice(
      entity.offset,
      entity.offset + entity.length
    );
    expect(message.text).toContain(`${PLAIN.statusPermissions}\n${json}`);
    // 快照是「管理员 + 通用管理能力 + 删除消息」，顺序仍随权限清单。
    expect(JSON.parse(json)).toEqual({
      isAdministrator: "管理员身份",
      canManageChat: "管理聊天",
      canDeleteMessages: "删除消息",
    });
    expect(Object.keys(JSON.parse(json) as Record<string, string>)).toEqual(
      [...BOT_CHAT_PERMISSION_KEYS].filter((key: string): boolean =>
        key === "isAdministrator" ||
        key === "canManageChat" ||
        key === "canDeleteMessages"
      )
    );
    expect(json).not.toContain("canRestrictMembers");
    expect(json).not.toContain("否");
  });

  test("一位权限都没有时给出空对象，仍是一个完整的 JSON 块", () => {
    const snapshot: BotStatusSnapshot = statusSnapshot();
    const message: ParsedMarkdownV2 = renderStatus({
      ...snapshot,
      chatState: {
        ...snapshot.chatState,
        botPermissions: botPermissions({
          isAdministrator: false,
          canManageChat: false,
        }),
      },
    });

    expect(message.entities).toHaveLength(3);
    expect(message.text).toContain(`${PLAIN.statusPermissions}\n{}`);
  });

  test("权限尚未确证时不出 JSON 块，也不留下空的代码块", () => {
    const snapshot: BotStatusSnapshot = statusSnapshot();
    const message: ParsedMarkdownV2 = renderStatus({
      ...snapshot,
      chatState: { ...snapshot.chatState, botPermissions: undefined },
    });

    // 权限块缺席时只剩本群 id 与功能块两个实体。
    expect(message.entities.map((entity) => entity.type)).toEqual(["code", "pre"]);
    expect(message.text).toContain(`${PLAIN.statusPermissions}\n${PLAIN.statusPermissionsUnknown}`);
  });

  test("功能块逐项给出本群开关的真假，键与顺序随 BOT_STATUS_FEATURE_KEYS", () => {
    const message: ParsedMarkdownV2 = renderStatus(statusSnapshot());
    const entity = message.entities[2]!;
    expect(entity.type).toBe("pre");
    expect(entity).toMatchObject({ language: "json" });
    const json: string = message.text.slice(entity.offset, entity.offset + entity.length);
    expect(message.text).toContain(`${PLAIN.statusFeatures}\n${json}`);
    const parsed = JSON.parse(json) as Record<string, boolean>;
    expect(Object.keys(parsed)).toEqual([...BOT_STATUS_FEATURE_KEYS]);
    // 快照开着监听、AI 闲聊、广告检测与入群验证；没设过的开关照样列出来，给 false。
    expect(parsed).toEqual({
      isInitEnabled: true,
      isAIChatEnabled: true,
      isTranslationEnabled: false,
      isAdDetectEnabled: true,
      isFloodControlEnabled: false,
      isAntiRaidEnabled: true,
      isProxySendEnabled: false,
    });
  });

  test("本群 id 是恰好框住 id 的内联代码，两种语气下都能被 Telegram 解析", () => {
    for (const atmosphere of ["teasing", "plain"] as readonly Atmosphere[]) {
      const message: ParsedMarkdownV2 = withAtmosphere(atmosphere, (): ParsedMarkdownV2 => renderStatus(statusSnapshot()));
      const code = message.entities[0]!;
      expect(code.type).toBe("code");
      expect(message.text.slice(code.offset, code.offset + code.length)).toBe("-1001234567890");
      expect(message.text.slice(0, code.offset)).toEndWith(ATMOSPHERE_TEXTS[atmosphere].NOTICE_TEXTS.statusChatIdLabel);
      expect(code.offset).toBeLessThan(message.entities[1]!.offset);
    }
  });

  test("模型名里的 MarkdownV2 保留字符按字面显示，不形成格式或链接", () => {
    const snapshot: BotStatusSnapshot = statusSnapshot();
    const model: string = "m*o_d[e](l)~`>#+-=|{}.!";
    const message: ParsedMarkdownV2 = renderStatus({
      ...snapshot,
      aiConfig: { ...snapshot.aiConfig!, text: { ...snapshot.aiConfig!.text, model } },
    });

    expect(message.text).toContain(`${PLAIN.statusModelText(model)}\n`);
    expect(message.entities.map((entity) => entity.type)).toEqual(["code", "pre", "pre"]);
  });

  test("模型名中的换行被收敛且超长标签受限", () => {
    const snapshot: BotStatusSnapshot = statusSnapshot();
    const text: string = renderStatus({
      ...snapshot,
      aiConfig: {
        ...snapshot.aiConfig!,
        text: {
          ...snapshot.aiConfig!.text,
          model: `${"m".repeat(120)}\nforged heading`,
        },
      },
    }).text;

    expect(text).not.toContain("\nforged heading");
    expect(text).toContain("…");
  });

  test("运行时长、容量单位和不可用内存上限均稳定格式化", () => {
    expect(formatBotUptime(59.9, ATMOSPHERE_TEXTS.plain)).toBe("00:00:59");
    expect(formatBotUptime(Number.NaN, ATMOSPHERE_TEXTS.plain)).toBe("00:00:00");
    expect(formatBotMemory(512)).toBe("512 B");
    expect(formatBotMemory(2_048)).toBe("2.00 KiB");

    const text: string = renderStatus({
      ...statusSnapshot(),
      processStatus: {
        uptimeSeconds: 0,
        averageCpuPercent: Number.NaN,
        availableCpuCount: 1,
        memoryFootprintBytes: 0,
        memoryLimitBytes: 0,
        memoryPercent: Number.NaN,
      },
    }).text;
    expect(text).toContain(PLAIN.statusCpu("0.00%", 1));
    expect(text).toContain(PLAIN.statusMemoryNoLimit("0 B"));
  });

  test("调侃风格下进程、模型与出站各行都走调侃文案，数值照常展示", () => {
    const text: string = withAtmosphere("teasing", (): string => renderStatus(statusSnapshot()).text);

    expect(text).toContain(TEASING.statusCpu("12.35%", 6));
    expect(text).toContain(TEASING.statusUptime(TEASING.statusUptimeWithDays(2, "03:04:05")));
    expect(text).toContain(TEASING.statusMemory("512.00 MiB", "8.00 GiB", "6.25%"));
    expect(text).toContain(`${TEASING.statusModelText("gpt-status")}\n`);
    expect(text).toContain(`${TEASING.statusModelAdDetect("ad-model")}\n`);
    expect(text).toContain(
      `${TEASING.statusTelegram}\n${TEASING.statusTelegramActive(7)}\n` +
      TEASING.statusTelegramPending(1024, TELEGRAM_429_RETRY_QUEUE_MAX)
    );
    expect(text).not.toContain(PLAIN.statusTelegram);
    expect(text).not.toContain(PLAIN.statusModelText(""));
  });

  test("无法采样当前内存占用时显示不可用，其他状态仍完整展示", () => {
    const snapshot: BotStatusSnapshot = statusSnapshot();
    const text: string = renderStatus({
      ...snapshot,
      processStatus: { ...snapshot.processStatus, memoryFootprintBytes: null },
    }).text;
    expect(text).toContain(PLAIN.statusMemoryUnavailable);
    expect(text).not.toContain("RSS");
    expect(text).toContain(PLAIN.statusUptime(""));
    expect(text).toContain(ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS.statusModels);
  });
});
