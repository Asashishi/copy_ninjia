import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "grammy/types";
import { buildFloodCandidate } from "../../packages/antiRaid/floodControl";
import type { FloodCandidateMessage } from "../../packages/types/antiRaid/protocol";
import type { ChatState } from "../../packages/types/chatState";
import { chatStateCache } from "../../packages/cache/main/chatState";
import { whitelistEntryCache } from "../../packages/cache/main/identityStorage";
import { temporaryWhitelistActivityCache } from
  "../../packages/cache/main/temporaryWhitelist";
import { SUPER_ADMIN_USER_ID } from "../../packages/config/telegram";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";

const BOT_ID: number = 99;
/** 固定的主线程观测时刻；投递载荷原样带给 Worker 当窗口时刻。 */
const OBSERVED_AT: number = 1_700_000_000_000;

function groupMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    date: 0,
    chat: { id: -1001, type: "supergroup", title: "群" },
    from: { id: 7, is_bot: false, first_name: "刷屏怪" },
    text: "spam",
    ...overrides,
  } as Message;
}

/** 收敛一次投递判定；本文件只关心门禁与标签，时刻固定不参与断言以外的逻辑。 */
function candidate(
  message: Message = groupMessage(),
  chatState?: Readonly<ChatState>
): FloodCandidateMessage | undefined {
  return buildFloodCandidate({ message, botId: BOT_ID, now: OBSERVED_AT, chatState });
}

beforeEach(() => {
  chatStateCache.clear();
  chatStateCache.set(-1001, { isFloodControlEnabled: true });
  whitelistEntryCache.clear();
  temporaryWhitelistActivityCache.clear();
});

afterEach(() => {
  chatStateCache.clear();
  whitelistEntryCache.clear();
  temporaryWhitelistActivityCache.clear();
});

describe("刷屏计数的主线程投递门禁", () => {
  test("按群缺省关闭，只有显式开启后才投递", () => {
    chatStateCache.clear();
    expect(candidate(groupMessage())).toBeUndefined();

    chatStateCache.set(-1001, { isFloodControlEnabled: true });
    expect(candidate(groupMessage())?.type).toBe("floodCandidate");
  });

  test("调用方预读的群状态直接驱动门禁，省略它时本函数自行查表", () => {
    const expected: FloodCandidateMessage | undefined = candidate();
    chatStateCache.clear();

    expect(candidate(groupMessage(), { isFloodControlEnabled: true })).toEqual(expected);
    expect(candidate()).toBeUndefined();
  });

  test("超级群里的真实用户收敛成投递，标签按可见发送者算好", () => {
    expect(candidate(groupMessage())).toEqual({
      type: "floodCandidate",
      chatId: -1001,
      userId: 7,
      observedAt: OBSERVED_AT,
      label: "刷屏怪",
    });

    // 有公开用户名时优先用 @username，与其它播报同源（users/userLabel.ts）。
    const named: FloodCandidateMessage | undefined = candidate(
      groupMessage({ from: { id: 7, is_bot: false, first_name: "刷屏怪", username: "noisy" } } as Partial<Message>)
    );
    expect(named?.label).toBe("@noisy");
  });

  test("只认超级群：restrictChatMember 在普通群和私聊里根本不适用", () => {
    expect(candidate(
      groupMessage({ chat: { id: -1002, type: "group", title: "普通群" } } as Partial<Message>)
    )).toBeUndefined();
    expect(candidate(
      groupMessage({ chat: { id: 7, type: "private", first_name: "私聊" } } as Partial<Message>)
    )).toBeUndefined();
  });

  test("频道马甲与匿名管理员没有可禁言的成员身份，一律不投递", () => {
    expect(candidate(
      groupMessage({ sender_chat: { id: -1009, type: "channel", title: "马甲" } } as Partial<Message>)
    )).toBeUndefined();
    // 拿当前群当皮套的匿名管理员：sender_chat.id === chat.id。
    expect(candidate(
      groupMessage({ sender_chat: { id: -1001, type: "supergroup", title: "群" } } as Partial<Message>)
    )).toBeUndefined();
  });

  test("机器人自己、没有发送者、超级管理员和获授豁免的白名单身份都不计数", () => {
    expect(candidate(
      groupMessage({ from: { id: BOT_ID, is_bot: true, first_name: "本天才" } } as Partial<Message>)
    )).toBeUndefined();
    expect(candidate(groupMessage({ from: undefined }))).toBeUndefined();
    expect(candidate(
      groupMessage({ from: { id: SUPER_ADMIN_USER_ID, is_bot: false, first_name: "超管" } } as Partial<Message>)
    )).toBeUndefined();

    whitelistEntryCache.set(7, {
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "刷屏怪", lastName: "", username: "" },
    });
    expect(candidate(groupMessage())).toBeUndefined();
    whitelistEntryCache.set(7, {
      permissions: {
        ...DEFAULT_WHITELIST_PERMISSIONS,
        isCanBypassFloodControl: false,
      },
      meta: { firstName: "刷屏怪", lastName: "", username: "" },
    });
    expect(candidate(groupMessage())?.userId).toBe(7);

    whitelistEntryCache.set(7, null);
    temporaryWhitelistActivityCache.set(7, {
      tempWhite: true,
      tempWhiteAt: 1,
      tempWhiteCount: 7,
      sendCount: 8,
      countedAt: 1,
      qualifiedAt: 1,
    });
    expect(candidate(groupMessage())?.userId).toBe(7);
  });
});
