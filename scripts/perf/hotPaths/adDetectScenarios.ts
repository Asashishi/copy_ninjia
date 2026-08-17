/** 广告检测队列热路径场景；只复用真实 owner 状态与生产入口。 */

import {
  adDetectCapacitySaturated,
  adDetectQueue,
  adDetectStopping,
  inFlightAdDetectKeys,
  pendingAdMessages,
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
import type { AdCandidateMessage } from "../../../packages/types/antiRaid";
import type { AdMessageBundle } from "../../../packages/types/antiRaid/adDetect";
import type { Scenario } from "./types";
import { BENCHMARK_CHAT_ID, BENCHMARK_EPOCH_MS } from "./fixtures";

/**
 * 为容量预置创建一份真实队列形态的独立 bundle。
 *
 * 每个 sender 都必须拥有自己的 bundle、元数据、entry 与数组；共享空对象会把
 * 满载 Map 的 retained heap 严重低估。这里保留一条已经接纳但尚未判定的消息，
 * 只模拟 sender 容量边界，不在默认门禁里同时制造每 sender 15 条的极端峰值。
 */
function createCapacityBundle(index: number): AdMessageBundle {
  const senderId: number = index + 1;
  const messageId: number = index + 1;
  return {
    chatId: BENCHMARK_CHAT_ID,
    senderId,
    label: `benchmark sender ${senderId}`,
    meta: {
      firstName: `Benchmark ${senderId}`,
      lastName: "Sender",
      username: `benchmark_${senderId}`,
    },
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
    nextSeq: 2,
    checkedSeq: 0,
  };
}

/** 满载拒绝输入故意带满所有可变载荷；正式循环不得读取它们。 */
const SATURATED_CANDIDATE: AdCandidateMessage = {
  type: "adCandidate",
  chatId: BENCHMARK_CHAT_ID,
  senderId: Number.MAX_SAFE_INTEGER,
  messageId: 1,
  text: "广".repeat(AD_DETECT_MESSAGE_MAX_CHARS),
  linkUrls: Array.from(
    { length: AD_DETECT_MAX_LINK_URLS },
    (_unused: unknown, index: number): string =>
      `https://benchmark.invalid/${index}/${"x".repeat(AD_DETECT_LINK_URL_MAX_CHARS)}`
        .slice(0, AD_DETECT_LINK_URL_MAX_CHARS)
  ),
  sampleContext: {
    quote: "引".repeat(AD_SAMPLE_CONTEXT_MAX_CHARS),
    replyTo: "回".repeat(AD_SAMPLE_CONTEXT_MAX_CHARS),
  },
  label: "benchmark rejected sender",
  meta: { firstName: "Rejected", lastName: "", username: "rejected" },
  isChannel: false,
  isForwarded: false,
  blocked: false,
  justJoined: false,
};

/** 清空本场景触及的 Anti-Raid Worker owner 状态。 */
function resetAdCapacityScenario(): void {
  adDetectQueue.clear();
  queuedAdDetectKeys.clear();
  recentlyDisposedAdKeys.clear();
  pendingAdMessages.clear();
  inFlightAdDetectKeys.clear();
  adDetectCapacitySaturated.current = false;
  adDetectStopping.current = false;
}

/** 预置合法上限数量的 key；所有分配都发生在正式计时之前。 */
function prepareAdCapacityScenario(): void {
  for (
    let index: number = 0;
    index < AD_DETECT_MAX_PENDING_SENDERS;
    index++
  ) {
    pendingAdMessages.set(
      `benchmark-capacity:${index}`,
      createCapacityBundle(index)
    );
  }
  // 满载边沿日志只记第一次；本场景量的是稳态拒绝，不把一次 I/O 摊进热循环。
  adDetectCapacitySaturated.current = true;
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
        // 两种真实发送者路径都覆盖：普通账号在 pending 硬顶直接返回，频道马甲
        // 还要查处置 TTL 才能决定是否删除尾随消息。senderId 与身份种类都轮换，
        // 防止 JSC 证明固定 key 永远 miss 后把无副作用拒绝折叠掉；对象 shape 不变。
        const isChannel: boolean = (index & 1) === 0;
        SATURATED_CANDIDATE.senderId = isChannel
          ? -1 - (index & 1_023)
          : Number.MAX_SAFE_INTEGER - (index & 1_023);
        SATURATED_CANDIDATE.isChannel = isChannel;
        enqueueAdCandidate(SATURATED_CANDIDATE, BENCHMARK_EPOCH_MS);
        checksum += pendingAdMessages.size + (isChannel ? 1 : 0);
      }
      return checksum;
    },
    probes: { enqueueAdCandidate },
  };
}
