import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "grammy/types";
import type { AntiRaidWorkerMessage } from "../../packages/types/antiRaid";
import { TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD, TEMPORARY_AD_BYPASS_REQUIRED_DAYS } from "../../packages/consts/temporaryAdBypass";

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
mock.module("../../packages/infra/identityPolicy/temporaryAdBypass", () => ({
  recordTemporaryAdBypassActivity: (id: number, now: number): object => {
    recorded.push({ id, now });
    if (grantOnRecord) temporaryIds.add(id);
    return {
      adBypass: grantOnRecord,
      adBypassGrantedAt: grantOnRecord ? now : null,
      qualifiedDays: promoteOnRecord ? TEMPORARY_AD_BYPASS_REQUIRED_DAYS : grantOnRecord ? 1 : 0,
      sendCount: TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD + 1,
      countedAt: now,
      qualifiedAt: grantOnRecord ? now : null,
    };
  },
  hasActiveTemporaryAdBypassAt: (id: number): boolean => temporaryIds.has(id),
  clearTemporaryAdBypassActivity: (id: number): boolean => {
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
mock.module("../../packages/antiRaid/workerBridge/controller", () => ({
  postAntiRaid: (message: AntiRaidWorkerMessage): boolean => {
    workerPosts.push(message);
    return true;
  },
}));

const { recordEligibleTemporaryAdBypassActivity } = await import(
  "../../packages/antiRaid/temporaryAdBypass"
);

/**
 * 以通过共同前置判定的消息事实调用累计入口；展示身份按夹具自己的 sender_chat / from 取，
 * 前置判定本身的用例在 test/workers/antiRaid/adDetectMain.test.ts。
 */
function record(input: Message, now: number): boolean {
  return recordEligibleTemporaryAdBypassActivity({
    message: input,
    botId: 999,
    now,
    senderId: input.sender_chat?.id ?? input.from!.id,
    senderChat: input.sender_chat,
  });
}

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

describe("临时广告免检发言入口", () => {
  test("用户与频道马甲跨群都按实际展示身份计数", () => {
    expect(record(message(), 1_000)).toBeTrue();
    expect(record(message({
      sender_chat: { id: -2_001, type: "channel", title: "频道" },
    }), 2_000)).toBeTrue();

    expect(recorded).toEqual([
      { id: 7, now: 1_000 },
      { id: -2_001, now: 2_000 },
    ]);
  });

  test("连续第七个合格日写入永久广告免检并删除临时记录", () => {
    grantOnRecord = true;
    promoteOnRecord = true;

    expect(record(message(), 7_000)).toBeTrue();

    expect(promotions).toEqual([{
      id: 7,
      meta: { firstName: "Alice", lastName: "", username: "" },
    }]);
    expect(permanentIds.has(7)).toBeTrue();
    expect(temporaryIds.has(7)).toBeFalse();
  });

  test("刚进入临时广告免检时只推一次 Worker 旧状态清理", () => {
    grantOnRecord = true;

    expect(record(message(), 1_000)).toBeTrue();
    expect(record(message(), 2_000)).toBeTrue();

    expect(workerPosts).toEqual([{
      type: "temporaryAdBypassGranted",
      identityId: 7,
    }]);
  });

  test("永久白名单身份不累计", () => {
    permanentIds.add(7);
    expect(record(message(), 1_000)).toBeFalse();
    expect(recorded).toEqual([]);
  });
});
