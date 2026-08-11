/**
 * Owner: AI Chat Worker。
 *
 * media 模型的视觉/语音输入支持度由各自第一次真实调用确认，此后按四档状态机
 * 演进（见 types/aiChat/provider.ts 的 MediaInputSupport）：
 *
 * - `supported`：成功过一次，后续媒体直接进有界执行器。
 * - `unsupported`：端点明确说它不接受这种输入模态；本 Worker 生命周期内不再
 *   下载也不再请求。
 * - `misconfigured`：端点以 404/405 说这条路径不可调用（多半是 model 或
 *   base_url 写错）。同样停止后续请求，但**单独记一次英文诊断**——把部署笔误
 *   记成模型能力缺失，运维会去换模型，而要改的是 config/agent.json 的一行。
 * - `unknown`：还没有结论。瞬时故障（超时、429、5xx、SDK 重试耗尽）保持在这一
 *   档，只按连续失败次数进入**有限指数退避**：退避期内直接返回共享的瞬时失败，
 *   不下载媒体、不占执行器槽位；退避到期后重新放行一次真实探测。永远不会因为
 *   端点抖了几次就把模态永久关掉。
 *
 * 单份媒体自己的问题（下载不到、格式不合、正文被安全策略清空）不带
 * mediaFailure，因此完全不改变模态状态——「这一份不行」与「这一类都不行」在
 * 类型层面就是两件事。
 *
 * 容量恒定：两个模态各一个固定 shape 的状态对象、各最多一个在途探测 Promise，
 * 没有 timer，也没有按媒体增长的表。Worker 崩溃重建或进程重启后 holder 回到
 * null，按（不变的）配置快照从初始状态重新探测——配置虽然没变，外部端点的能力
 * 可能已经恢复。
 */

import { logger } from "../../../infra/logger";
import {
  MEDIA_PROBE_BACKOFF_BASE_MS,
  MEDIA_PROBE_BACKOFF_MAX_MS,
  MEDIA_PROBE_MAX_TRANSIENT_FAILURES,
} from "../../../consts/aiChat/media";
import type {
  AiTextResult,
  MediaInputCapability,
  MediaInputModalityState,
  MediaInputSupport,
  MediaInputSupportState,
} from "../../../types/aiChat/provider";

/**
 * 两种模态各自最多一个首次探测 Promise。字段在首次读取时一次性建立，之后只替换
 * 字段值，不增删 shape；Promise 完成后立即清空，因此容量恒为 0..2，不会随媒体数
 * 增长。等待者只观察结论，不另占媒体执行器槽位。Worker 重建时整个 holder 清空。
 */
interface MediaInputProbeState {
  vision: Promise<AiTextResult> | null;
  voice: Promise<AiTextResult> | null;
}

/** 从未探测过的初始状态；两个模态各取一份独立对象。 */
const INITIAL_MODALITY_STATE: MediaInputModalityState = {
  support: "unknown",
  transientFailures: 0,
  nextProbeAt: 0,
};

/** 当前 Worker 的 media 模态探测表；首次读取时一次性建立固定 shape。 */
export const mediaInputSupportCache: { current: MediaInputSupportState | null } = { current: null };

/** 当前 Worker 的首次模态探测；完成即清除，容量固定为两个字段。 */
export const mediaInputProbeCache: { current: MediaInputProbeState | null } = { current: null };

/** 读取一种模态正在进行的首次探测。 */
export function getMediaInputProbe(capability: MediaInputCapability): Promise<AiTextResult> | null {
  const state: MediaInputProbeState = mediaInputProbeCache.current ??= {
    vision: null,
    voice: null,
  };
  return state[capability];
}

/** 登记一种模态唯一的首次探测；调用方必须在任何 await 之前同步调用。 */
export function setMediaInputProbe(
  capability: MediaInputCapability,
  pending: Promise<AiTextResult>
): void {
  const state: MediaInputProbeState = mediaInputProbeCache.current ??= {
    vision: null,
    voice: null,
  };
  state[capability] = pending;
}

/**
 * 探测结束后按 Promise 身份清理。身份核对防止旧任务的 finally 误清后继探测；
 * Worker 崩溃时无需显式清理，isolate 会连 holder 一起释放。
 */
export function clearMediaInputProbe(
  capability: MediaInputCapability,
  pending: Promise<AiTextResult>
): void {
  const state: MediaInputProbeState | null = mediaInputProbeCache.current;
  if (state?.[capability] === pending) state[capability] = null;
}

/** 取整张支持表；首次读取时按初始状态一次性建立。 */
function supportState(): MediaInputSupportState {
  return mediaInputSupportCache.current ??= {
    vision: INITIAL_MODALITY_STATE,
    voice: INITIAL_MODALITY_STATE,
  };
}

/** 整体替换一种模态的状态；另一模态原样带过，表的 shape 恒定。 */
function replaceModalityState(
  capability: MediaInputCapability,
  next: MediaInputModalityState
): void {
  const state: MediaInputSupportState = supportState();
  mediaInputSupportCache.current = capability === "vision"
    ? { vision: next, voice: state.voice }
    : { vision: state.vision, voice: next };
}

/** 读取一种模态的完整状态；从未尝试时返回初始状态。 */
function getMediaInputState(capability: MediaInputCapability): MediaInputModalityState {
  return supportState()[capability];
}

/** 读取一种模态的当前结论；从未尝试时返回 unknown。 */
export function getMediaInputSupport(capability: MediaInputCapability): MediaInputSupport {
  return supportState()[capability].support;
}

/** 两档终局结论都不再下载、也不再请求，只是成因不同。 */
export function isMediaInputClosed(support: MediaInputSupport): boolean {
  return support === "unsupported" || support === "misconfigured";
}

/** 第 n 次连续瞬时失败对应的退避时长；指数增长并封顶。 */
function backoffMsFor(transientFailures: number): number {
  const scaled: number = MEDIA_PROBE_BACKOFF_BASE_MS * 2 ** (transientFailures - 1);
  return Math.min(scaled, MEDIA_PROBE_BACKOFF_MAX_MS);
}

/**
 * 判断某模态此刻是否还压在退避里。
 *
 * 墙钟回拨会让 nextProbeAt 落在「比任何一档退避都远的未来」，那一刻起这个模态
 * 就再也等不到放行了。识别出来直接放行（口径同 auto/message/triggerPolicy.ts 的
 * 冷却处理：旧时间轴上的冷却点先失效，再从新时间轴重新计时）。
 */
export function isMediaInputProbeCoolingDown(
  capability: MediaInputCapability,
  now: number
): boolean {
  const remaining: number = getMediaInputState(capability).nextProbeAt - now;
  return remaining > 0 && remaining <= MEDIA_PROBE_BACKOFF_MAX_MS;
}

/**
 * 记录一次真实调用的结果并推进模态状态机。
 *
 * @param now 调用方传入的时刻，与退避判定共用同一口径，便于测试固定时间轴。
 */
export function recordMediaInputResult(
  capability: MediaInputCapability,
  result: AiTextResult,
  now: number = Date.now()
): void {
  const current: MediaInputModalityState = getMediaInputState(capability);
  if (result.ok) {
    // 成功即清空失败计数与退避：端点恢复了，下一份媒体不该继续被上一轮故障拖着。
    if (current.support === "supported" && current.transientFailures === 0) return;
    replaceModalityState(capability, { support: "supported", transientFailures: 0, nextProbeAt: 0 });
    return;
  }

  switch (result.mediaFailure) {
    case "unsupported":
    case "misconfigured": {
      if (current.support === result.mediaFailure) return;
      if (result.mediaFailure === "misconfigured") {
        // 只在落定那一次记：诊断要能一眼指向 config/agent.json 的 media 段，
        // 但不能每份媒体刷一条。
        logger.error(
          `AI media ${capability} input is disabled for this worker: the configured media endpoint reported ` +
          "that the model or API path does not exist (HTTP 404/405). Check the model and base_url of " +
          "$.agent.media in the agent configuration."
        );
      }
      replaceModalityState(capability, {
        support: result.mediaFailure,
        transientFailures: 0,
        nextProbeAt: 0,
      });
      return;
    }
    case "transient": {
      // 已经落定的终局结论不被瞬时故障翻案：那两档说的是「这个端点做不到」，
      // 与网络抖动无关。
      if (isMediaInputClosed(current.support)) return;
      const transientFailures: number = Math.min(
        current.transientFailures + 1,
        MEDIA_PROBE_MAX_TRANSIENT_FAILURES
      );
      replaceModalityState(capability, {
        // **结论一律不动**：端点抖动既不构成能力缺失（unknown 不降级成
        // unsupported），也不推翻已经成功过的事实（supported 不退回 unknown）。
        // 变的只有退避——它挡的是「每条媒体都白付一次下载 + 一整轮 SDK 重试」。
        support: current.support,
        transientFailures,
        nextProbeAt: now + backoffMsFor(transientFailures),
      });
      break;
    }
    default:
      // 单份媒体自己的问题（下载失败、格式不合、正文被清空、执行器满载）：
      // 不下模态结论，也不推进退避。
      break;
  }
}
