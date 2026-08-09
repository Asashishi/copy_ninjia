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
  recentlyEnqueued: false,
  dedupWindowSize: 0,
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

  test("本窗口刚处置过：普通账号忽略，频道马甲要顺手删这一条", () => {
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

  test("已排队/在途/本窗口排过 → 一律跳过", () => {
    for (const field of ["queued", "inFlight", "recentlyEnqueued"] as const) {
      expect(admitAdRequeue({ ...REQUEUE, [field]: true })).toEqual({ action: "skip" });
    }
  });

  test("去重表撞上硬顶 → 报容量拒绝，调用方据此记边沿日志", () => {
    expect(admitAdRequeue({ ...REQUEUE, dedupWindowSize: AD_DETECT_MAX_PENDING_SENDERS }))
      .toEqual({ action: "rejectAtCapacity" });
    expect(admitAdRequeue({ ...REQUEUE, dedupWindowSize: AD_DETECT_MAX_PENDING_SENDERS - 1 }))
      .toEqual({ action: "enqueue" });
  });

  test("容量判定排在去重之后：本窗口已排过的键即使满载也只是 skip", () => {
    // 顺序反过来的话，满载期间已接纳的键会被报成「容量拒绝」，日志把一次
    // 正常的去重跳过说成了洪泛。
    expect(admitAdRequeue({
      ...REQUEUE,
      recentlyEnqueued: true,
      dedupWindowSize: AD_DETECT_MAX_PENDING_SENDERS,
    })).toEqual({ action: "skip" });
  });
});

describe("容量闸 admitAdBundleStorage", () => {
  test("已有键的后续消息不占新名额，满载也照常合并", () => {
    expect(admitAdBundleStorage({
      alreadyStored: true,
      pendingSize: AD_DETECT_MAX_PENDING_SENDERS,
      dedupWindowSize: AD_DETECT_MAX_PENDING_SENDERS,
    })).toEqual({ action: "store" });
  });

  test("两张表任一撞顶都拒绝新的不同键，而不是淘汰队首", () => {
    // FIFO 淘汰会让先到的人在从没被判过一次的情况下消失。
    expect(admitAdBundleStorage({
      alreadyStored: false,
      pendingSize: AD_DETECT_MAX_PENDING_SENDERS,
      dedupWindowSize: 0,
    })).toEqual({ action: "rejectAtCapacity" });
    expect(admitAdBundleStorage({
      alreadyStored: false,
      pendingSize: 0,
      dedupWindowSize: AD_DETECT_MAX_PENDING_SENDERS,
    })).toEqual({ action: "rejectAtCapacity" });
    expect(admitAdBundleStorage({
      alreadyStored: false,
      pendingSize: AD_DETECT_MAX_PENDING_SENDERS - 1,
      dedupWindowSize: AD_DETECT_MAX_PENDING_SENDERS - 1,
    })).toEqual({ action: "store" });
  });
});

describe("在途闸 admitAdDispatch", () => {
  test("按全局在途数判定，不按群分配", () => {
    expect(admitAdDispatch({ inFlight: 0 })).toEqual({ action: "dispatch" });
    expect(admitAdDispatch({ inFlight: AD_DETECT_MAX_IN_FLIGHT - 1 })).toEqual({ action: "dispatch" });
    expect(admitAdDispatch({ inFlight: AD_DETECT_MAX_IN_FLIGHT })).toEqual({ action: "saturated" });
  });
});
