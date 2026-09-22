import { beforeEach, describe, expect, mock, test } from "bun:test";
import { translateStates } from "../../packages/cache/main/translateState";

interface SentCommandMessage {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
}

let permissionAllowed: boolean = false;
const hasWhitelistPermission = mock((_id: number, key: string): boolean =>
  permissionAllowed && key === "isCanViewBotStatus"
);
const sendCommandMessage = mock(async (
  _params: SentCommandMessage
): Promise<number | undefined> => 1);
const aiChatConfigReadiness = mock((): Readonly<{ ok: boolean }> => ({ ok: false }));
const adDetectConfigReadiness = mock((): Readonly<{ ok: boolean }> => ({ ok: false }));
const telegramOutboundStats = mock((): Readonly<{
  active: number;
  pending: number;
  capacity: number;
}> => ({ active: 0, pending: 0, capacity: 81_920 }));
const getChatState = mock((_chatId: number): Readonly<Record<string, never>> => ({}));
const readBotProcessStatus = mock((): Readonly<{
  uptimeSeconds: number;
  averageCpuPercent: number;
  availableCpuCount: number;
  memoryFootprintBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
}> => ({
  uptimeSeconds: 1,
  averageCpuPercent: 2,
  availableCpuCount: 3,
  memoryFootprintBytes: 4,
  memoryLimitBytes: 5,
  memoryPercent: 80,
}));
const activeGagSessionCount = mock((): number => 3);

mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  hasWhitelistPermission,
}));
mock.module("../../packages/users/userLabel", () => ({
  formatActorLabel: (): string => "@viewer",
}));
mock.module("../../packages/infra/telegram", () => ({ sendCommandMessage }));
mock.module("../../packages/config/readiness", () => ({
  adDetectConfigReadiness,
  aiChatConfigReadiness,
}));
mock.module("../../packages/config/agent", () => ({
  getAdDetectAgentConfig: (): never => {
    throw new Error("unreachable ad config");
  },
  getAgentDeploymentConfig: (): never => {
    throw new Error("unreachable AI config");
  },
}));
mock.module("../../packages/infra/storage/stateStore", () => ({ getChatState }));
mock.module("../../packages/infra/telegram/outboundLifecycle", () => ({ telegramOutboundStats }));
mock.module("../../packages/infra/processStatus", () => ({ readBotProcessStatus }));
mock.module("../../packages/cache/main/gag", () => ({ activeGagSessionCount }));

const { handleBotStatusCommand } = await import("../../packages/commands/botStatus");

function context(): never {
  const chat = { id: -1001, type: "supergroup" };
  return {
    chat,
    from: { id: 100, first_name: "Viewer", username: "viewer" },
    msg: { message_id: 10, chat },
    msgId: 10,
  } as never;
}

beforeEach(() => {
  translateStates.clear();
  permissionAllowed = false;
  for (const mocked of [
    hasWhitelistPermission,
    sendCommandMessage,
    aiChatConfigReadiness,
    adDetectConfigReadiness,
    telegramOutboundStats,
    getChatState,
    readBotProcessStatus,
    activeGagSessionCount,
  ]) mocked.mockClear();
});

describe("/bot_status 白名单权限", () => {
  test("无权限身份按本群人设发送临时拒绝，不读取全局运行指标", async () => {
    const ctx: never = context();
    await handleBotStatusCommand(ctx);

    expect(hasWhitelistPermission).toHaveBeenCalledWith(100, "isCanViewBotStatus");
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: "就 @viewer 也想看本天才的全局状态？哪来的资格呀，笨蛋♡",
      replyToMessageId: 10,
    });
    expect(aiChatConfigReadiness).not.toHaveBeenCalled();
    expect(adDetectConfigReadiness).not.toHaveBeenCalled();
    expect(telegramOutboundStats).not.toHaveBeenCalled();
    expect(getChatState).toHaveBeenCalledWith(-1001);
    expect(readBotProcessStatus).not.toHaveBeenCalled();
    expect(activeGagSessionCount).not.toHaveBeenCalled();
  });

  test("获授权身份照常读取状态并返回统一临时命令消息", async () => {
    permissionAllowed = true;
    translateStates.set(-1001, [
      { translatedUser: { id: 7 }, language: "uk" }, { translatedUser: { id: 8 }, language: "ru" },
    ]);
    translateStates.set(-2002, [{ translatedUser: { id: 9 }, language: "ja" }]);
    await handleBotStatusCommand(context());
    expect(sendCommandMessage.mock.calls[0]?.[0].text).toContain("本群正赖着本天才翻译的杂鱼：2/5♡");

    expect(aiChatConfigReadiness).toHaveBeenCalledTimes(1);
    expect(adDetectConfigReadiness).toHaveBeenCalledTimes(1);
    expect(telegramOutboundStats).toHaveBeenCalledTimes(1);
    expect(getChatState).toHaveBeenCalledWith(-1001);
    expect(readBotProcessStatus).toHaveBeenCalledTimes(1);
    expect(activeGagSessionCount).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage.mock.calls[0]?.[0].text)
      .toContain("本天才的状态，杂鱼可要看仔细啦♡");
    expect(sendCommandMessage.mock.calls[0]?.[0].text)
      .toContain("正在被本天才调教的杂鱼：3/5");
  });
});
