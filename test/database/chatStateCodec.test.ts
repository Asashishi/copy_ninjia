import { describe, expect, test } from "bun:test";
import {
  assertTelegramChatId,
  decodeChatStateData,
  encodeChatStateData,
} from "../../packages/database/codec/chatState";
import { InputValidationError } from "../../packages/libs/inputValidation";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { botPermissions } from "../helpers/botPermissions";

describe("chat_states codec", () => {
  test("完整权限、功能开关和 lockdown 严格往返", () => {
    const permissions: BotChatPermissions = botPermissions({
      canDeleteMessages: true,
      canRestrictMembers: true,
      canPinMessages: true,
    });
    const text: string = encodeChatStateData({
      isInitEnabled: true,
      isFloodControlEnabled: true,
      botPermissions: permissions,
      lockdown: {
        phase: "reconciling",
        intentId: 2,
        announced: false,
        originalPermissions: { can_invite_users: true },
        expiresAt: 3_000,
      },
    }, "chat_states[-1001].data");
    expect(decodeChatStateData(text, "chat_states[-1001].data")).toEqual({
      quietUntil: undefined,
      lockdown: {
        phase: "reconciling",
        intentId: 2,
        announced: false,
        originalPermissions: { can_invite_users: true },
        expiresAt: 3_000,
      },
      isAIChatEnabled: undefined,
      isJATranslationEnabled: undefined,
      isAdDetectEnabled: undefined,
      isFloodControlEnabled: true,
      isAntiRaidEnabled: undefined,
      isInitEnabled: true,
      botPermissions: permissions,
      title: undefined,
      isProxySendEnabled: undefined,
    });
  });

  test("封锁公告的 message ID 必须能原样往返：重启接管的那一轮靠它删公告", () => {
    const text: string = encodeChatStateData({
      lockdown: {
        phase: "active",
        intentId: 5,
        announced: true,
        announcementMessageId: 900,
        originalPermissions: { can_invite_users: true },
        expiresAt: 9_000,
      },
    }, "chat_states[-1001].data");
    expect(decodeChatStateData(text, "chat_states[-1001].data").lockdown).toEqual({
      phase: "active",
      intentId: 5,
      announced: true,
      announcementMessageId: 900,
      originalPermissions: { can_invite_users: true },
      expiresAt: 9_000,
    });
  });

  test("权限快照必须完整，非管理员时其它权限必须全 false", () => {
    const incomplete: Record<string, boolean> = {
      ...botPermissions({ canDeleteMessages: true }),
    };
    delete incomplete.canManageTopics;
    expect(() => decodeChatStateData(
      JSON.stringify({ botPermissions: incomplete }),
      "database/storage.sqlite:chat_states[-1001].data"
    )).toThrow("$.botPermissions.canManageTopics");

    const nonAdmin: BotChatPermissions = botPermissions({
      isAdministrator: false,
      canManageChat: false,
    });
    expect(() => decodeChatStateData(
      JSON.stringify({
        botPermissions: { ...nonAdmin, canDeleteMessages: true },
      }),
      "database/storage.sqlite:chat_states[-1001].data"
    )).toThrow("$.botPermissions.canDeleteMessages");
  });

  test("旧 botIsAdmin、未知字段、空状态和非法 lockdown 一律拒绝", () => {
    expect(() => decodeChatStateData(
      JSON.stringify({ botIsAdmin: true }),
      "chat_states[-1001].data"
    )).toThrow("supported chat-state fields");
    expect(() => decodeChatStateData("{}", "chat_states[-1001].data"))
      .toThrow("a non-empty chat-state object");
    // 公告在占位落地那一刻就发出，因此 applying 阶段也可以是「已公告」。
    expect(() => decodeChatStateData(
      JSON.stringify({
        lockdown: {
          phase: "applying",
          intentId: 1,
          announced: true,
          announcementMessageId: 900,
          originalPermissions: {},
          expiresAt: 2_000,
        },
      }),
      "chat_states[-1001].data"
    )).not.toThrow();
    // message ID 只可能来自一次成功的发送。
    expect(() => decodeChatStateData(
      JSON.stringify({
        lockdown: {
          phase: "active",
          intentId: 1,
          announced: false,
          announcementMessageId: 900,
          originalPermissions: {},
          expiresAt: 2_000,
        },
      }),
      "chat_states[-1001].data"
    )).toThrow("$.lockdown.announcementMessageId");
    expect(() => decodeChatStateData(
      JSON.stringify({
        lockdown: {
          phase: "active",
          intentId: 1,
          announced: true,
          announcementMessageId: 0,
          originalPermissions: {},
          expiresAt: 2_000,
        },
      }),
      "chat_states[-1001].data"
    )).toThrow("$.lockdown.announcementMessageId");
  });

  test("chat 主键必须是负安全整数的群或频道 ID", () => {
    expect(() => assertTelegramChatId(0, "chat_states")).toThrow("$.chatId");
    expect(() => assertTelegramChatId(1, "chat_states")).toThrow("$.chatId");
    expect(() => assertTelegramChatId(Number.MAX_SAFE_INTEGER + 1, "chat_states"))
      .toThrow("$.chatId");
    expect(() => assertTelegramChatId(-1001, "chat_states")).not.toThrow();
  });
});

/**
 * 群状态解码器剩下的拒绝分支。
 *
 * 与 identityCodecRejections.test.ts 同一条理由：这些是 AGENTS.md「不为用户行为
 * 兜底」在群状态侧的落点。上面的用例覆盖了往返与几条主干判定，这里补齐可选字段、
 * 两张权限表和 lockdown 各字段的逐条拒绝——它们写反一个比较方向不会让任何正例
 * 失败，只会让一整类坏行悄悄通过。
 */
describe("chat_states codec 的拒绝分支", () => {
  const SOURCE: string = "chat_states[-1001].data";

  function chatStateJson(override: Readonly<Record<string, unknown>>): string {
    return JSON.stringify(override);
  }

  function expectRejected(text: string, fieldPath: string): void {
    let thrown: unknown;
    try {
      decodeChatStateData(text, SOURCE);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InputValidationError);
    expect((thrown as InputValidationError).message).toContain(fieldPath);
  }

  test("可选时间戳与消息 ID 存在但非法时拒绝，缺省则放行", () => {
    // 缺省按「从没设过」处理，不得因此放宽对存在但非法值的判定。
    expect(decodeChatStateData(chatStateJson({ isInitEnabled: true }), SOURCE).quietUntil)
      .toBeUndefined();
    expectRejected(chatStateJson({ quietUntil: -1 }), "$.quietUntil");
    expectRejected(chatStateJson({ quietUntil: 1.5 }), "$.quietUntil");
    expectRejected(
      chatStateJson({
        lockdown: {
          phase: "active",
          intentId: 5,
          announced: true,
          announcementMessageId: 0,
          originalPermissions: {},
          expiresAt: 9_000,
        },
      }),
      "$.lockdown.announcementMessageId"
    );
  });

  test("群权限表只接受受支持的键与布尔值", () => {
    expectRejected(
      chatStateJson({
        lockdown: {
          phase: "active",
          intentId: 5,
          announced: false,
          originalPermissions: { can_invite_users: "yes" },
          expiresAt: 9_000,
        },
      }),
      "$.lockdown.originalPermissions.can_invite_users"
    );
    expectRejected(
      chatStateJson({
        lockdown: {
          phase: "active",
          intentId: 5,
          announced: false,
          originalPermissions: { not_a_permission: true },
          expiresAt: 9_000,
        },
      }),
      "$.lockdown.originalPermissions"
    );
  });

  test("机器人权限表整体形状不符时拒绝", () => {
    expectRejected(chatStateJson({ botPermissions: { isAdministrator: true } }), "$.botPermissions");
    expectRejected(chatStateJson({ botPermissions: [] }), "$.botPermissions");
  });

  test("lockdown 的形状、phase、intentId 与 expiresAt 逐条核对", () => {
    expectRejected(chatStateJson({ lockdown: "active" }), "$.lockdown");
    expectRejected(
      chatStateJson({
        lockdown: {
          phase: "active", intentId: 5, announced: false,
          originalPermissions: {}, expiresAt: 9_000, stray: 1,
        },
      }),
      "$.lockdown"
    );
    expectRejected(
      chatStateJson({
        lockdown: {
          phase: "paused", intentId: 5, announced: false,
          originalPermissions: {}, expiresAt: 9_000,
        },
      }),
      "$.lockdown.phase"
    );
    expectRejected(
      chatStateJson({
        lockdown: {
          phase: "active", intentId: 0, announced: false,
          originalPermissions: {}, expiresAt: 9_000,
        },
      }),
      "$.lockdown.intentId"
    );
    // expiresAt 是必填：缺了它这条封锁永远不会到期，重启接管后无从判断该不该恢复。
    expectRejected(
      chatStateJson({
        lockdown: {
          phase: "active", intentId: 5, announced: false,
          originalPermissions: {},
        },
      }),
      "$.lockdown.expiresAt"
    );
  });
});
