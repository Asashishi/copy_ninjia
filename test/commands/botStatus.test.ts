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
import { botPermissions } from "../helpers/botPermissions";

function statusSnapshot(): BotStatusSnapshot {
  return {
    aiReady: true,
    aiConfig: {
      text: {
        provider: "openai",
        apiKey: "secret-text-key",
        baseUrl: "https://secret-text.example/v1",
        model: "gpt-status",
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
    },
    adDetectReady: true,
    adDetectConfig: {
      provider: "openai",
      apiKey: "secret-ad-key",
      baseUrl: "https://secret-ad.example/v1",
      model: "ad-model",
    },
    chatState: {
      isInitEnabled: true,
      isAIChatEnabled: true,
      isAdDetectEnabled: true,
      isAntiRaidEnabled: true,
      botPermissions: botPermissions({ canDeleteMessages: true }),
    },
    telegramActive: 7,
    telegramPending: 1_024,
    telegramCapacity: 81_920,
    activeGagSessions: 3,
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

    expect(text).toStartWith("本天才的状态，杂鱼可要看仔细啦♡");
    expect(text).toContain("全局模型能力，本天才会的可多着呢♡：");
    expect(text).toContain("群聊正文：已配置 · openai / gpt-status");
    expect(text).toContain("图片生成：未配置");
    expect(text).toContain("歌曲生成：未配置");
    expect(text).toContain("广告检测：已配置 · openai / ad-model");
    expect(text).toContain("Telegram 出站：\n• 处理中 7\n• 429 退避排队 1024/81920");
    expect(text).toContain("正在被本天才调教的杂鱼：3/5");
    expect(text).toContain("本机进程，本天才当然精神得很♡：");
    expect(text).toContain("Bot 运行时长：2 天 03:04:05");
    expect(text).toContain("CPU：12.35% (6 Core)");
    expect(text).not.toContain("运行期平均");
    expect(text).toContain("当前内存占用：512.00 MiB / 8.00 GiB（6.25%）");
    expect(text).toContain("• AI 闲聊");
    expect(text).toContain("• 入群验证与防冲群");
    expect(text).not.toContain("secret-");
    expect(text).not.toContain("example/v1");
    expect(text).not.toContain("日语翻译");
  });

  test("部署能力不可用和群功能全关时给出明确状态", () => {
    const text: string = buildBotStatusMessage({
      ...statusSnapshot(),
      aiReady: false,
      aiConfig: null,
      adDetectReady: false,
      adDetectConfig: null,
      chatState: {},
      telegramActive: 0,
      telegramPending: 0,
    }).text;

    expect(text).toContain("AI 对话能力：不可用（部署配置未就绪）");
    expect(text).toContain("广告检测：不可用（部署配置未就绪）");
    expect(text).toEndWith("本群已开启，连这个都记不住吗，笨蛋♡：\n• 无");
  });

  test("本群权限块只列已经拥有的位，键给英文字段名、值给中文名", () => {
    // 发送边界不设 parse_mode，围栏只会原样显示；范围必须由实体标出。
    const message: BotStatusMessage = buildBotStatusMessage(statusSnapshot());
    const entity = message.entities[0]!;
    expect(message.entities).toHaveLength(1);
    expect(entity.type).toBe("pre");
    expect(entity).toMatchObject({ language: "json" });
    const json: string = message.text.slice(
      entity.offset,
      entity.offset + entity.length
    );
    expect(message.text).toContain(`本天才在这个群的权柄：\n${json}`);
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

    expect(message.entities).toHaveLength(1);
    expect(message.text).toContain("本天才在这个群的权柄：\n{}");
  });

  test("权限尚未确证时不出 JSON 块，也不留下空实体", () => {
    const snapshot: BotStatusSnapshot = statusSnapshot();
    const message: BotStatusMessage = buildBotStatusMessage({
      ...snapshot,
      chatState: { ...snapshot.chatState, botPermissions: undefined },
    });

    expect(message.entities).toHaveLength(0);
    expect(message.text).toContain(
      "本天才在这个群的权柄：\n• 还没确证呢，等本天才在这个群有了身份再来看吧♡"
    );
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
