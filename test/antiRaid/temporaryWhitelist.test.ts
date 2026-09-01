import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "grammy/types";
import type { ChatState } from "../../packages/types/chatState";
import type { AntiRaidWorkerMessage } from "../../packages/types/antiRaid";

const recorded: { readonly id: number; readonly now: number }[] = [];
const permanentIds: Set<number> = new Set<number>();
const temporaryIds: Set<number> = new Set<number>();
const workerPosts: AntiRaidWorkerMessage[] = [];
const promotions: {
  readonly id: number;
  readonly meta: { readonly firstName: string; readonly lastName: string; readonly username: string };
}[] = [];
let readinessOk: boolean = true;
let grantOnRecord: boolean = false;
let promoteOnRecord: boolean = false;

mock.module("../../packages/config/readiness", () => ({
  adDetectConfigReadiness: (): { readonly ok: boolean } => ({ ok: readinessOk }),
}));
mock.module("../../packages/infra/identityPolicy/temporaryWhitelist", () => ({
  recordTemporaryWhitelistActivity: (id: number, now: number): object => {
    recorded.push({ id, now });
    if (grantOnRecord) temporaryIds.add(id);
    return {
      activity: {
        tempWhite: grantOnRecord,
        tempWhiteAt: grantOnRecord ? now : null,
        tempWhiteCount: promoteOnRecord ? 7 : grantOnRecord ? 1 : 0,
        sendCount: 8,
        countedAt: now,
        qualifiedAt: grantOnRecord ? now : null,
      },
      queued: true,
    };
  },
  hasActiveTemporaryWhitelistAt: (id: number): boolean => temporaryIds.has(id),
  clearTemporaryWhitelistActivity: (id: number): boolean => {
    temporaryIds.delete(id);
    return true;
  },
}));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  isWhitelisted: (id: number): boolean => permanentIds.has(id),
  promoteAdBypassWhitelistMembership: (
    id: number,
    meta: { readonly firstName: string; readonly lastName: string; readonly username: string }
  ): { readonly changed: boolean; readonly queued: boolean } => {
    promotions.push({ id, meta });
    permanentIds.add(id);
    return { changed: true, queued: true };
  },
}));
mock.module("../../packages/antiRaid/workerBridge", () => ({
  postAntiRaid: (message: AntiRaidWorkerMessage): boolean => {
    workerPosts.push(message);
    return true;
  },
}));

const { recordEligibleTemporaryWhitelistActivity } = await import(
  "../../packages/antiRaid/temporaryWhitelist"
);

const ENABLED_CHAT_STATE: Readonly<ChatState> = {
  isAdDetectEnabled: true,
} as Readonly<ChatState>;

function message(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    date: 1,
    chat: { id: -1_001, type: "supergroup", title: "群" },
    from: { id: 7, is_bot: false, first_name: "Alice" },
    text: "普通发言",
    ...overrides,
  } as Message;
}

beforeEach((): void => {
  recorded.length = 0;
  permanentIds.clear();
  temporaryIds.clear();
  workerPosts.length = 0;
  promotions.length = 0;
  readinessOk = true;
  grantOnRecord = false;
  promoteOnRecord = false;
});

describe("临时白名单发言入口", () => {
  test("用户与频道马甲跨群都按实际展示身份计数", () => {
    expect(recordEligibleTemporaryWhitelistActivity({
      message: message(),
      botId: 999,
      chatState: ENABLED_CHAT_STATE,
      now: 1_000,
    })).toBeTrue();
    expect(recordEligibleTemporaryWhitelistActivity({
      message: message({
        sender_chat: { id: -2_001, type: "channel", title: "频道" },
      }),
      botId: 999,
      chatState: ENABLED_CHAT_STATE,
      now: 2_000,
    })).toBeTrue();

    expect(recorded).toEqual([
      { id: 7, now: 1_000 },
      { id: -2_001, now: 2_000 },
    ]);
  });

  test("连续第七个合格日写入永久广告免检并删除临时记录", () => {
    grantOnRecord = true;
    promoteOnRecord = true;

    expect(recordEligibleTemporaryWhitelistActivity({
      message: message(),
      botId: 999,
      chatState: ENABLED_CHAT_STATE,
      now: 7_000,
    })).toBeTrue();

    expect(promotions).toEqual([{
      id: 7,
      meta: { firstName: "Alice", lastName: "", username: "" },
    }]);
    expect(permanentIds.has(7)).toBeTrue();
    expect(temporaryIds.has(7)).toBeFalse();
  });

  test("刚进入临时白名单时只推一次 Worker 旧状态清理", () => {
    grantOnRecord = true;

    expect(recordEligibleTemporaryWhitelistActivity({
      message: message(),
      botId: 999,
      chatState: ENABLED_CHAT_STATE,
      now: 1_000,
    })).toBeTrue();
    expect(recordEligibleTemporaryWhitelistActivity({
      message: message(),
      botId: 999,
      chatState: ENABLED_CHAT_STATE,
      now: 2_000,
    })).toBeTrue();

    expect(workerPosts).toEqual([{
      type: "temporaryWhitelistGranted",
      identityId: 7,
    }]);
  });

  test("功能未就绪、自动转发、机器人自身与永久白名单均不累计", () => {
    readinessOk = false;
    expect(recordEligibleTemporaryWhitelistActivity({
      message: message(),
      botId: 999,
      chatState: ENABLED_CHAT_STATE,
      now: 1_000,
    })).toBeFalse();

    readinessOk = true;
    permanentIds.add(7);
    expect(recordEligibleTemporaryWhitelistActivity({
      message: message(),
      botId: 999,
      chatState: ENABLED_CHAT_STATE,
      now: 1_000,
    })).toBeFalse();
    expect(recordEligibleTemporaryWhitelistActivity({
      message: message({ from: { id: 999, is_bot: true, first_name: "Bot" } }),
      botId: 999,
      chatState: ENABLED_CHAT_STATE,
      now: 1_000,
    })).toBeFalse();
    expect(recordEligibleTemporaryWhitelistActivity({
      message: message({
        is_automatic_forward: true,
        sender_chat: { id: -2_001, type: "channel", title: "频道" },
      }),
      botId: 999,
      chatState: ENABLED_CHAT_STATE,
      now: 1_000,
    })).toBeFalse();
    expect(recorded).toEqual([]);
  });

  test("匿名管理员的本群身份与未开启广告检测的群不累计", () => {
    expect(recordEligibleTemporaryWhitelistActivity({
      message: message({
        sender_chat: { id: -1_001, type: "supergroup", title: "群" },
      }),
      botId: 999,
      chatState: ENABLED_CHAT_STATE,
      now: 1_000,
    })).toBeFalse();
    expect(recordEligibleTemporaryWhitelistActivity({
      message: message(),
      botId: 999,
      chatState: {} as Readonly<ChatState>,
      now: 1_000,
    })).toBeFalse();
    expect(recorded).toEqual([]);
  });
});
