/**
 * 广告检测的四道准入闸（纯规则）。抽出来的意义在于：`docs/cn/04-invariants.md`
 * 要求「待检所有权由 pendingAdMessages、adDetectQueue 与 queuedAdDetectKeys
 * 共同表达，三者必须同步增删」，而那份一致性此前只靠注释和散落的 mutation
 * 维持——判定集中之后，「该不该动这三张表」才有了唯一一个可以直接考的答案。
 */

import { describe, expect, test } from "bun:test";
import {
  admitAdBundleStorage,
  admitAdCandidate,
  admitAdDispatch,
  admitAdRequeue,
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
  knownAdmin: false,
  recentlyDisposed: false,
  blocked: false,
};

const REQUEUE: AdRequeueInput = {
  hasUncheckedContent: true,
  queued: false,
  inFlight: false,
};

describe("投递闸 admitAdCandidate", () => {
  test("正常消息接纳", () => {
    expect(admitAdCandidate(CANDIDATE)).toEqual({ action: "accept" });
  });

  test("没有可判定正文的一律忽略", () => {
    expect(admitAdCandidate({ ...CANDIDATE, textLength: 0 })).toEqual({ action: "ignore" });
  });

  test("缓存明确认得的管理员挡在额度之外；频道马甲不走这道闸", () => {
    // 处置与 /block 同权且不可逆，而管理员转发合作方链接就足以被读成推广。
    expect(admitAdCandidate({ ...CANDIDATE, knownAdmin: true })).toEqual({ action: "ignore" });
    // 频道马甲没有「群成员」身份，管理员表里不会有它。
    expect(admitAdCandidate({ ...CANDIDATE, knownAdmin: true, isChannel: true })).toEqual({ action: "accept" });
  });

  test("自身 TTL 内刚处置过：普通账号忽略，频道马甲要顺手删这一条", () => {
    // banChatSenderChat 没有 revoke_messages，这段跨线程空档里频道新发的广告
    // 既不会被那次封禁带走，也不会再有第二次判定来删它。
    expect(admitAdCandidate({ ...CANDIDATE, recentlyDisposed: true })).toEqual({ action: "ignore" });
    expect(admitAdCandidate({ ...CANDIDATE, recentlyDisposed: true, isChannel: true }))
      .toEqual({ action: "deleteStraggler" });
  });

  test("空正文优先于其余判据：连删都不必删", () => {
    expect(admitAdCandidate({ textLength: 0, isChannel: true, knownAdmin: false, recentlyDisposed: true, blocked: false }))
      .toEqual({ action: "ignore" });
  });
});

describe("排队闸 admitAdRequeue", () => {
  test("有未判定内容且不在任何表里 → 入队", () => {
    expect(admitAdRequeue(REQUEUE)).toEqual({ action: "enqueue" });
  });

  test("没有未判定内容就不排队：重排一个判完的键只会白烧一次额度", () => {
    expect(admitAdRequeue({ ...REQUEUE, hasUncheckedContent: false })).toEqual({ action: "skip" });
  });

  test("已排队或在途 → 一律跳过", () => {
    for (const field of ["queued", "inFlight"] as const) {
      expect(admitAdRequeue({ ...REQUEUE, [field]: true })).toEqual({ action: "skip" });
    }
  });

  test("排队闸没有容量判据：队列每键最多一个位置，长度天然被待检硬顶兜住", () => {
    // 曾经另有一张与队列并行的 TTL 认领表，它撞顶会让这里返回容量拒绝——而
    // 认领一旦漏还就成孤儿，把补排永久挡在门外。判据收敛到队列本身之后，
    // 走到这一步的键必定已在 pendingAdMessages 里，容量在那道闸就判完了。
    expect(admitAdRequeue(REQUEUE)).toEqual({ action: "enqueue" });
  });
});

describe("容量闸 admitAdBundleStorage", () => {
  test("已有键的后续消息不占新名额，满载也照常合并", () => {
    expect(admitAdBundleStorage({
      alreadyStored: true,
      pendingSize: AD_DETECT_MAX_PENDING_SENDERS,
    })).toEqual({ action: "store" });
  });

  test("待检表撞顶时拒绝新的不同键，而不是淘汰队首", () => {
    // FIFO 淘汰会让先到的人在从没被判过一次的情况下消失。
    expect(admitAdBundleStorage({
      alreadyStored: false,
      pendingSize: AD_DETECT_MAX_PENDING_SENDERS,
    })).toEqual({ action: "rejectAtCapacity" });
    expect(admitAdBundleStorage({
      alreadyStored: false,
      pendingSize: AD_DETECT_MAX_PENDING_SENDERS - 1,
    })).toEqual({ action: "store" });
  });

  test("待检表是唯一一张会撞上接纳硬顶的表", () => {
    // 判据只剩 pendingSize 一个：曾经并行的 TTL 认领表撑顶也会拒绝新键，
    // 而它可以在 pending 远未满时因孤儿认领假性撑顶，把正常发言判成洪泛。
    expect(isNewAdBundleAtCapacity(AD_DETECT_MAX_PENDING_SENDERS)).toBe(true);
    expect(isNewAdBundleAtCapacity(AD_DETECT_MAX_PENDING_SENDERS - 1)).toBe(false);
  });
});

describe("在途闸 admitAdDispatch", () => {
  test("按全局在途数判定，不按群分配", () => {
    expect(admitAdDispatch({ inFlight: 0 })).toEqual({ action: "dispatch" });
    expect(admitAdDispatch({ inFlight: AD_DETECT_MAX_IN_FLIGHT - 1 })).toEqual({ action: "dispatch" });
    expect(admitAdDispatch({ inFlight: AD_DETECT_MAX_IN_FLIGHT })).toEqual({ action: "saturated" });
  });
});
