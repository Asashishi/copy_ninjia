import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types/chatState";

interface SentCommandMessage {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
}

let permissionAllowed: boolean = false;
const hasCommandPermission = mock((_ctx: unknown, key: string): boolean =>
  permissionAllowed && key === "isCanViewBotStatus"
);
const resolveCommandActor = mock((_ctx: unknown): CachedUser => ({
  id: 100,
  username: "viewer",
}));
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
  rssBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
}> => ({
  uptimeSeconds: 1,
  averageCpuPercent: 2,
  availableCpuCount: 3,
  rssBytes: 4,
  memoryLimitBytes: 5,
  memoryPercent: 80,
}));
const activeGagSessionCount = mock((): number => 3);

mock.module("../../packages/commands/commandActor", () => ({
  hasCommandPermission,
  resolveCommandActor,
}));
mock.module("../../packages/users/userLabel", () => ({
  formatUserLabel: (): string => "@viewer",
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
mock.module("../../packages/infra/telegram/outboundGate", () => ({ telegramOutboundStats }));
mock.module("../../packages/infra/processStatus", () => ({ readBotProcessStatus }));
mock.module("../../packages/cache/main/gag", () => ({ activeGagSessionCount }));

const { handleBotStatusCommand } = await import("../../packages/commands/botStatus");

function context(): never {
  return {
    chat: { id: -1001, type: "supergroup" },
    from: { id: 100, first_name: "Viewer", username: "viewer" },
    msg: { message_id: 10 },
    msgId: 10,
  } as never;
}

beforeEach(() => {
  permissionAllowed = false;
  for (const mocked of [
    hasCommandPermission,
    resolveCommandActor,
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
  test("无权限身份只收到临时拒绝，不能触及任何全局状态来源", async () => {
    const ctx: never = context();
    await handleBotStatusCommand(ctx);

    expect(hasCommandPermission).toHaveBeenCalledWith(ctx, "isCanViewBotStatus");
    expect(sendCommandMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: "就 @viewer 也想看本天才的全局状态？哪来的资格呀，笨蛋♡",
      replyToMessageId: 10,
    });
    expect(aiChatConfigReadiness).not.toHaveBeenCalled();
    expect(adDetectConfigReadiness).not.toHaveBeenCalled();
    expect(telegramOutboundStats).not.toHaveBeenCalled();
    expect(getChatState).not.toHaveBeenCalled();
    expect(readBotProcessStatus).not.toHaveBeenCalled();
    expect(activeGagSessionCount).not.toHaveBeenCalled();
  });

  test("获授权身份照常读取状态并返回统一临时命令消息", async () => {
    permissionAllowed = true;
    await handleBotStatusCommand(context());

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
