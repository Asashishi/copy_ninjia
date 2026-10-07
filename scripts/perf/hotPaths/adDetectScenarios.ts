/** 广告检测热路径场景：候选载荷的跨线程复制、正文拼接与队列容量闸；只复用真实 owner 状态与生产入口。 */

import {
  adDetectCapacitySaturated,
  adDetectQueue,
  adDetectStopping,
  inFlightAdDetectKeys,
  pendingAdBundleCount,
  queuedAdDetectKeys,
  recentlyDisposedAdKeys,
} from "../../../packages/cache/workers/antiRaid/adDetect";
import {
  AD_DETECT_LINK_URL_MAX_CHARS,
  AD_DETECT_MAX_LINK_URLS,
  AD_DETECT_MAX_PENDING_SENDERS,
  AD_DETECT_MESSAGE_MAX_CHARS,
  AD_SAMPLE_CONTEXT_MAX_CHARS,
} from "../../../packages/consts/antiRaid/adDetect";
import { enqueueAdCandidate } from "../../../packages/workers/antiRaid/adDetect/queue";
import { clearPendingAdBundles, storeBundle } from "../../../packages/workers/antiRaid/adDetect/queueState";
import { verificationKey } from "../../../packages/libs/verificationKey";
import {
  appendLinkUrls,
  boundSampleContext,
  claimSampleContextParts,
} from "../../../packages/workers/antiRaid/adDetect/bundle";
import type {
  AdCandidateEntry,
  AdCandidateMessage,
  AdMessageBundle,
  AdSampleContext,
} from "../../../packages/types/antiRaid/adDetect";
import type { Scenario } from "./types";
import { AD_SAMPLE_TEXTS } from "./adFixture";
import { BENCHMARK_CHAT_ID, BENCHMARK_EPOCH_MS, BENCHMARK_SENDER_ID } from "./fixtures";

/** 广告无元数据路径的只读空输入。 */
const EMPTY_LINK_URLS: readonly string[] = [];
/** 广告无上下文路径的只读既有条目。 */
const EMPTY_AD_ENTRIES: readonly AdCandidateEntry[] = [];

/**
 * 为容量预置创建一份真实队列形态的独立 bundle。
 *
 * 每个 sender 各自拥有 bundle、元数据、entry 与数组，保留一条已接纳但尚未判定的
 * 消息，只模拟 sender 容量边界。
 */
function createCapacityBundle(index: number): AdMessageBundle {
  const senderId: number = index + 1;
  const messageId: number = index + 1;
  return {
    key: verificationKey(BENCHMARK_CHAT_ID, senderId),
    chatId: BENCHMARK_CHAT_ID,
    senderId,
    meta: {
      firstName: `Benchmark ${senderId}`,
      lastName: "Sender",
      username: `benchmark_${senderId}`,
    },
    senderName: `Benchmark ${senderId} Sender`,
    isChannel: false,
    justJoined: false,
    entries: [{
      messageId,
      seq: 1,
      text: `capacity benchmark message ${messageId}`,
      directText: `capacity benchmark message ${messageId}`,
      receivedAt: BENCHMARK_EPOCH_MS,
      withinReferencedWarning: false,
      quote: undefined,
      replyTo: undefined,
    }],
    pendingDeleteIds: [],
    pendingDeleteOverflowed: false,
    uncheckedEvicted: false,
    nextSeq: 2,
    checkedSeq: 0,
  };
}

/** 满载拒绝输入带满所有可变载荷；正式循环不读取它们。 */
const SATURATED_CANDIDATE: AdCandidateMessage = {
  type: "adCandidate",
  chatId: BENCHMARK_CHAT_ID,
  senderId: Number.MAX_SAFE_INTEGER,
  messageId: 1,
  observedAt: BENCHMARK_EPOCH_MS,
  text: "广".repeat(AD_DETECT_MESSAGE_MAX_CHARS),
  firstName: "Rejected",
  lastName: "",
  username: "rejected",
  isChannel: false,
  isForwarded: false,
  blocked: false,
  justJoined: false,
  linkUrls: Array.from(
    { length: AD_DETECT_MAX_LINK_URLS },
    (_unused: unknown, index: number): string =>
      `https://benchmark.invalid/${index}/${"x".repeat(AD_DETECT_LINK_URL_MAX_CHARS)}`
        .slice(0, AD_DETECT_LINK_URL_MAX_CHARS)
  ),
  sampleQuote: "引".repeat(AD_SAMPLE_CONTEXT_MAX_CHARS),
  sampleReplyTo: "回".repeat(AD_SAMPLE_CONTEXT_MAX_CHARS),
};

/** 清空本场景触及的 Anti-Raid Worker owner 状态。 */
function resetAdCapacityScenario(): void {
  adDetectQueue.clear();
  queuedAdDetectKeys.clear();
  recentlyDisposedAdKeys.clear();
  clearPendingAdBundles();
  inFlightAdDetectKeys.clear();
  adDetectCapacitySaturated.current = false;
  adDetectStopping.current = false;
}

/** 预置合法上限数量的 key；所有分配都发生在正式计时之前。 */
function prepareAdCapacityScenario(): void {
  // 先置位满载边沿，预置时不写边沿日志；本场景量稳态拒绝。
  adDetectCapacitySaturated.current = true;
  for (
    let index: number = 0;
    index < AD_DETECT_MAX_PENDING_SENDERS;
    index++
  ) {
    storeBundle(createCapacityBundle(index));
  }
}

/** 满载新 key 应在正文/URL/上下文整形之前以 O(1) 返回。 */
export function createAdCapacityRejectScenario(): Scenario {
  return {
    iterations: 500_000,
    prepare: prepareAdCapacityScenario,
    reset: resetAdCapacityScenario,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index++) {
        // 覆盖两种发送者路径：普通账号在 pending 硬顶直接返回，频道马甲还要查处置
        // TTL。senderId 与身份种类逐轮轮换，对象 shape 不变。
        const isChannel: boolean = (index & 1) === 0;
        SATURATED_CANDIDATE.senderId = isChannel
          ? -1 - (index & 1_023)
          : Number.MAX_SAFE_INTEGER - (index & 1_023);
        SATURATED_CANDIDATE.isChannel = isChannel;
        // 不传 now，使用载荷自带的 observedAt 默认值，与生产一致。
        enqueueAdCandidate(SATURATED_CANDIDATE);
        checksum += pendingAdBundleCount.current + (isChannel ? 1 : 0);
      }
      return checksum;
    },
    probes: { enqueueAdCandidate },
  };
}

export function adEmptyMetadataScenario(): Scenario {
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const sample: string = AD_SAMPLE_TEXTS[index % AD_SAMPLE_TEXTS.length] ?? "";
        const linkedText: string = appendLinkUrls(sample, EMPTY_LINK_URLS);
        const context: AdSampleContext | undefined = boundSampleContext(undefined, undefined);
        const text: string = context === undefined
          ? linkedText
          : claimSampleContextParts(linkedText, context, EMPTY_AD_ENTRIES);
        checksum += text.length;
      }
      return checksum;
    },
    // 无元数据分支：boundSampleContext 恒返回 undefined，不调用
    // claimSampleContextParts，因此不登记它。
    probes: { appendLinkUrls, boundSampleContext },
  };
}

/**
 * 一条普通群消息的广告候选跨线程复制成本。字面量按 antiRaid/adCandidate.ts 的
 * buildAdCandidate 的键序写全。
 */
export function adWireCloneScenario(): Scenario {
  const message: AdCandidateMessage = {
    type: "adCandidate",
    chatId: BENCHMARK_CHAT_ID,
    senderId: BENCHMARK_SENDER_ID,
    messageId: 1,
    observedAt: BENCHMARK_EPOCH_MS,
    text: "ordinary message",
    firstName: "Stable",
    lastName: "",
    username: "stable_user",
    isChannel: false,
    isForwarded: false,
    blocked: false,
    justJoined: false,
    linkUrls: undefined,
    sampleQuote: undefined,
    sampleReplyTo: undefined,
  };
  return {
    iterations: 200_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const cloned: AdCandidateMessage = structuredClone(message);
        checksum += cloned.text.length;
      }
      return checksum;
    },
  };
}
