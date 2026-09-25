import { describe, expect, test } from "bun:test";
import {
  buildBotStatusMessage,
  formatBotMemory,
  formatBotUptime,
} from "../../packages/commands/botStatus";
import type {
  BotStatusMessage,
  BotStatusSnapshot,
} from "../../packages/commands/botStatus";
import { BOT_CHAT_PERMISSION_KEYS } from "../../packages/consts/botAdmin";
import { BOT_STATUS_FEATURE_KEYS } from "../../packages/consts/botStatus";
import { botPermissions } from "../helpers/botPermissions";
import { chatStateOf } from "../helpers/chatState";

function statusSnapshot(): BotStatusSnapshot {
  return {
    chatId: -1001234567890,
    aiReady: true,
    aiConfig: {
      text: {
        provider: "openai",
        apiKey: "secret-text-key",
        baseUrl: "https://secret-text.example/v1",
        model: "openai/gpt-status",
      },
      summary: {
        provider: "google",
        apiKey: "secret-summary-key",
        baseUrl: undefined,
        model: "gemini-summary",
      },
      media: {
        provider: "google",
        apiKey: "secret-media-key",
        baseUrl: undefined,
        model: "gemini-media",
      },
      tts: {
        provider: "google",
        apiKey: "secret-tts-key",
        baseUrl: undefined,
        model: "gemini-tts",
        voice: "Leda",
      },
    },
    adDetectReady: true,
    adDetectConfig: {
      provider: "openai",
      apiKey: "secret-ad-key",
      baseUrl: "https://secret-ad.example/v1",
      model: "ad-model",
    },
    chatState: chatStateOf({
      isInitEnabled: true,
      isAIChatEnabled: true,
      aiPersona: "secret-persona\n本群的自定义提示词正文",
      isAdDetectEnabled: true,
      isAntiRaidEnabled: true,
      botPermissions: botPermissions({ canDeleteMessages: true }),
    }),
    telegramActive: 7,
    telegramPending: 1_024,
    telegramCapacity: 81_920,
    activeGagSessions: 3,
    activeTranslateSessions: 2,
    aiContextUsage: { bufferedCount: 128, summaryCount: 3 },
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
  test("只展示模型路由、总闸状态和本群开启项，不泄漏密钥或端点", () => {
    const text: string = buildBotStatusMessage(statusSnapshot()).text;

    expect(text).toStartWith("机器人状态");
    expect(text).toContain("全局模型能力：");
    expect(text).toContain("群聊正文：已配置 · gpt-status\n");
    expect(text).toContain("图片生成：未配置");
    expect(text).toContain("语音合成：已配置 · gemini-tts\n");
    expect(text).toContain("广告检测：已配置 · ad-model\n");
    expect(text).toContain("Telegram 出站：\n• 处理中 7\n• 429 退避排队 1024/81920");
    expect(text).not.toContain("本群的自定义提示词正文");
    expect(text).not.toContain("openai");
    expect(text).not.toContain("google");
    // 本群一组：id 在前，提示词状态在最后。
    expect(text).toContain(
      "• 本群 ID：-1001234567890\n" +
      "• AI 上下文利用率：47.86%\n" +
      "• 当前 gag 会话：3/5\n" +
      "• 本群翻译人数：2/5 人\n" +
      "• 本群自定义提示词：已设置\n"
    );
    expect(text).toContain("本机进程：");
    expect(text).toContain("Bot 运行时长：2 天 03:04:05");
    expect(text).toContain("CPU：12.35% (6 Core)");
    expect(text).not.toContain("运行期平均");
    expect(text).toContain("当前内存占用：512.00 MiB / 8.00 GiB（6.25%）");
    expect(text).toContain('"isAIChatEnabled": true');
    expect(text).toContain('"isAntiRaidEnabled": true');
    expect(text).toContain('"isTranslationEnabled": false');
    expect(text).not.toContain("secret-");
    expect(text).not.toContain("example/v1");
    // 上下文容量 = 0.7 × 128/256 + 0.3 × 3/7 = 47.86%；只给百分比，两段记忆的
    // 原始条数属于记忆分层的内部机制，不对群友外露。
    expect(text).not.toContain("滑动热记忆");
    expect(text).not.toContain("冷记忆摘要");
  });

  test("部署能力不可用和群功能全关时给出明确状态", () => {
    const text: string = buildBotStatusMessage({
      ...statusSnapshot(),
      aiReady: false,
      aiConfig: null,
      adDetectReady: false,
      adDetectConfig: null,
      chatState: chatStateOf(),
      telegramActive: 0,
      telegramPending: 0,
      aiContextUsage: undefined,
    }).text;

    expect(text).toContain("AI 对话能力：不可用（部署配置未就绪）");
    expect(text).toContain("广告检测：不可用（部署配置未就绪）");
    // 镜像没有条目就是「此刻没有可展示的上下文」，按 0 展示而不是沿用旧值。
    expect(text).toContain(
      "• 本群 ID：-1001234567890\n" +
      "• 猫娘大脑利用率：0.00%\n" +
      "• 正在被本天才调教的杂鱼：3/5\n" +
      "• 本群正赖着本天才翻译的杂鱼：2/5♡\n" +
      "• 本群专属提示词：未设置，本天才就用默认人设啦，笨蛋♡\n"
    );
    expect(text).toEndWith(
      "本群的开关都摆这儿了，连这个都记不住吗，笨蛋♡：\n" +
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

  test("本群权限块只列已经拥有的位，键给英文字段名、值给中文名", () => {
    // 发送边界不设 parse_mode，围栏只会原样显示；范围必须由实体标出。
    const message: BotStatusMessage = buildBotStatusMessage(statusSnapshot());
    const entity = message.entities[1]!;
    expect(message.entities).toHaveLength(3);
    expect(entity.type).toBe("pre");
    expect(entity).toMatchObject({ language: "json" });
    const json: string = message.text.slice(
      entity.offset,
      entity.offset + entity.length
    );
    expect(message.text).toContain(`机器人在本群的权限：\n${json}`);
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
    const message: BotStatusMessage = buildBotStatusMessage({
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
    expect(message.text).toContain("机器人在本群的权限：\n{}");
  });

  test("权限尚未确证时不出 JSON 块，也不留下空的 pre 实体", () => {
    const snapshot: BotStatusSnapshot = statusSnapshot();
    const message: BotStatusMessage = buildBotStatusMessage({
      ...snapshot,
      chatState: { ...snapshot.chatState, botPermissions: undefined },
    });

    // 权限块缺席时只剩本群 id 与功能块两个实体。
    expect(message.entities.map((entity) => entity.type)).toEqual(["code", "pre"]);
    expect(message.text).toContain(
      "机器人在本群的权限：\n• 尚未确认本群权限"
    );
  });

  test("功能块逐项给出本群开关的真假，键与顺序随 BOT_STATUS_FEATURE_KEYS", () => {
    const message: BotStatusMessage = buildBotStatusMessage(statusSnapshot());
    const entity = message.entities[2]!;
    expect(entity.type).toBe("pre");
    expect(entity).toMatchObject({ language: "json" });
    const json: string = message.text.slice(entity.offset, entity.offset + entity.length);
    expect(message.text).toContain(`本群功能开关：\n${json}`);
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

  test("本群 id 用 code 实体恰好框住，两种语气下偏移都按 UTF-16 计", () => {
    for (const aiPersona of [undefined, "自定义人设"]) {
      const snapshot: BotStatusSnapshot = statusSnapshot();
      const message: BotStatusMessage = buildBotStatusMessage({
        ...snapshot,
        chatState: { ...snapshot.chatState, aiPersona },
      });
      const code = message.entities[0]!;
      expect(code.type).toBe("code");
      expect(message.text.slice(code.offset, code.offset + code.length)).toBe("-1001234567890");
      expect(message.text.slice(0, code.offset)).toEndWith("• 本群 ID：");
      expect(code.offset).toBeLessThan(message.entities[1]!.offset);
    }
  });

  test("模型名中的换行被收敛且超长标签受限", () => {
    const snapshot: BotStatusSnapshot = statusSnapshot();
    const text: string = buildBotStatusMessage({
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
    expect(formatBotUptime(59.9)).toBe("00:00:59");
    expect(formatBotUptime(Number.NaN)).toBe("00:00:00");
    expect(formatBotMemory(512)).toBe("512 B");
    expect(formatBotMemory(2_048)).toBe("2.00 KiB");

    const text: string = buildBotStatusMessage({
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
    expect(text).toContain("CPU：0.00% (1 Core)");
    expect(text).toContain("当前内存占用：0 B（本机上限不可用）");
  });

  test("无法采样当前内存占用时显示不可用，其他状态仍完整展示", () => {
    const snapshot: BotStatusSnapshot = statusSnapshot();
    const text: string = buildBotStatusMessage({
      ...snapshot,
      processStatus: { ...snapshot.processStatus, memoryFootprintBytes: null },
    }).text;
    expect(text).toContain("当前内存占用：不可用");
    expect(text).not.toContain("RSS");
    expect(text).toContain("Bot 运行时长");
    expect(text).toContain("全局模型能力");
  });
});
