/**
 * 广告检测的五道准入闸（纯规则）。抽出来的意义在于：`docs/cn/04-invariants.md`
 * 要求「待检所有权由 pendingAdMessages、adDetectQueue 与 queuedAdDetectKeys
 * 共同表达，三者必须同步增删」。本文件直接验证集中准入判定与这项不变量。
 */

import { describe, expect, test } from "bun:test";
import {
  admitAdCandidate,
  admitAdRequeue,
  isAdDispatchSaturated,
  isKnownAdminCandidate,
  isNewAdBundleAtCapacity,
} from "../../packages/states/adDetectAdmission";
import {
  AD_DETECT_MAX_IN_FLIGHT,
  AD_DETECT_MAX_PENDING_SENDERS,
} from "../../packages/consts/antiRaid/adDetect";
import type {
  AdCandidateAdmissionInput,
  AdRequeueInput,
} from "../../packages/types/states/adDetectAdmission";

const CANDIDATE: AdCandidateAdmissionInput = {
  textLength: 10,
  isChannel: false,
  recentlyDisposed: false,
  blocked: false,
};

const REQUEUE: AdRequeueInput = {
  hasUncheckedContent: true,
  queued: false,
  inFlight: false,
};

describe("管理员闸 isKnownAdminCandidate", () => {
  test("缓存明确认得的管理员挡在额度之外；缓存冷时照常送检", () => {
    expect(isKnownAdminCandidate(false, true)).toBe(true);
    expect(isKnownAdminCandidate(false, false)).toBe(false);
  });

  test("频道马甲不走这道闸：它没有「群成员」身份", () => {
    expect(isKnownAdminCandidate(true, true)).toBe(false);
  });
});

describe("投递闸 admitAdCandidate", () => {
  test("正常消息接纳", () => {
    expect(admitAdCandidate(CANDIDATE)).toBe("accept");
  });

  test("没有可判定正文的一律忽略", () => {
    expect(admitAdCandidate({ ...CANDIDATE, textLength: 0 })).toBe("ignore");
  });

  test("自身 TTL 内刚处置过：普通账号忽略，频道马甲要顺手删这一条", () => {
    // banChatSenderChat 没有 revoke_messages，跨线程空档里频道新发的广告
    // 不会被那次封禁带走，也不会再有第二次判定来删它。
    expect(admitAdCandidate({ ...CANDIDATE, recentlyDisposed: true })).toBe("ignore");
    expect(admitAdCandidate({ ...CANDIDATE, recentlyDisposed: true, isChannel: true }))
      .toBe("deleteStraggler");
  });

  test("空正文优先于其余判据：连删都不必删", () => {
    expect(admitAdCandidate({ textLength: 0, isChannel: true, recentlyDisposed: true, blocked: false }))
      .toBe("ignore");
  });
});

describe("排队闸 admitAdRequeue", () => {
  test("有未判定内容且不在任何表里 → 入队", () => {
    expect(admitAdRequeue(REQUEUE)).toBe("enqueue");
  });

  test("没有未判定内容就不排队：重排一个判完的键只会白烧一次额度", () => {
    expect(admitAdRequeue({ ...REQUEUE, hasUncheckedContent: false })).toBe("skip");
  });

  test("已排队或在途 → 一律跳过", () => {
    for (const field of ["queued", "inFlight"] as const) {
      expect(admitAdRequeue({ ...REQUEUE, [field]: true })).toBe("skip");
    }
  });

  test("排队闸没有容量判据：队列每键最多一个位置，长度天然被待检硬顶兜住", () => {
    // 走到这一步的键必定已在 pendingAdMessages 里，容量已由待检硬顶判完。
    expect(admitAdRequeue(REQUEUE)).toBe("enqueue");
  });
});

describe("容量闸 isNewAdBundleAtCapacity", () => {
  test("待检表撞顶时拒绝新的不同键，而不是淘汰队首", () => {
    // 已有键的后续消息由调用方按 existing !== undefined 直接跳过本闸，不占新名额。
    expect(isNewAdBundleAtCapacity(AD_DETECT_MAX_PENDING_SENDERS)).toBe(true);
    expect(isNewAdBundleAtCapacity(AD_DETECT_MAX_PENDING_SENDERS - 1)).toBe(false);
  });

  test("待检表是唯一一张会撞上接纳硬顶的表", () => {
    expect(isNewAdBundleAtCapacity(AD_DETECT_MAX_PENDING_SENDERS)).toBe(true);
    expect(isNewAdBundleAtCapacity(AD_DETECT_MAX_PENDING_SENDERS - 1)).toBe(false);
  });
});

describe("在途闸 isAdDispatchSaturated", () => {
  test("按全局在途数判定，不按群分配", () => {
    expect(isAdDispatchSaturated(0)).toBe(false);
    expect(isAdDispatchSaturated(AD_DETECT_MAX_IN_FLIGHT - 1)).toBe(false);
    expect(isAdDispatchSaturated(AD_DETECT_MAX_IN_FLIGHT)).toBe(true);
  });
});
