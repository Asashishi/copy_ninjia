import {
  MEDIA_PROBE_BACKOFF_BASE_MS,
  MEDIA_PROBE_BACKOFF_MAX_MS,
  MEDIA_PROBE_MAX_TRANSIENT_FAILURES,
  NO_MEDIA_INPUT_EFFECTS,
} from "../consts/aiChat/media";
import type {
  MediaInputSupport,
} from "../types/aiChat/provider";
import type {
  MediaInputResultEvent,
  MediaInputTransition,
} from "../types/states/mediaInputSupport";
import type { MediaInputModalityState } from "../types/states/mediaInputSupport";

/**
 * media 模型视觉/语音输入支持度的四档状态机（纯函数，不读时钟、不写缓存、
 * 不记日志）。状态含义与整体设计见 types/aiChat/provider.ts 的
 * MediaInputSupport；holder、探测登记与效果执行在
 * cache/workers/aiChat/mediaInputSupport.ts。
 */

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
 * 判断 nextProbeAt 在 now 时刻是否仍处于退避窗口内。
 *
 * 墙钟回拨会让 nextProbeAt 落在「比任何一档退避都远的未来」，那一刻起这个模态
 * 就再也等不到放行了。识别出来直接放行（口径同 auto/message/triggerPolicy.ts 的
 * 冷却处理：旧时间轴上的冷却点先失效，再从新时间轴重新计时）。
 */
export function isWithinMediaProbeBackoff(nextProbeAt: number, now: number): boolean {
  const remaining: number = nextProbeAt - now;
  return remaining > 0 && remaining <= MEDIA_PROBE_BACKOFF_MAX_MS;
}

/** 状态不变的归因结果；`next` 原样返回 current，调用方据此跳过整表替换。 */
function unchanged(current: MediaInputModalityState): MediaInputTransition {
  return { next: current, effects: NO_MEDIA_INPUT_EFFECTS };
}

/**
 * 归因一次真实调用的结果。旧配置代次的任何结论与旧状态代次的瞬时失败都不改写
 * 当前状态；单份媒体自己的问题（不带 mediaFailure）完全不改变模态状态。
 */
export function reduceMediaInputResult(
  current: MediaInputModalityState,
  { capability, result, attemptState, now }: MediaInputResultEvent
): MediaInputTransition {
  if (attemptState.configGeneration !== current.configGeneration) return unchanged(current);
  if (result.ok) {
    // 成功即清空失败计数与退避：端点恢复了，下一份媒体不该继续被上一轮故障拖着。
    if (current.support === "supported" && current.transientFailures === 0) return unchanged(current);
    return {
      next: {
        support: "supported",
        transientFailures: 0,
        nextProbeAt: 0,
        configGeneration: current.configGeneration,
      },
      effects: NO_MEDIA_INPUT_EFFECTS,
    };
  }

  switch (result.mediaFailure) {
    case "unsupported":
    case "misconfigured": {
      if (current.support === result.mediaFailure) return unchanged(current);
      return {
        next: {
          support: result.mediaFailure,
          transientFailures: 0,
          nextProbeAt: 0,
          configGeneration: current.configGeneration,
        },
        // 只在落定那一次记：诊断要能一眼指向 config/agent.json 的 media 段，
        // 但不能每份媒体刷一条。
        effects: result.mediaFailure === "misconfigured"
          ? [{ kind: "logMisconfiguredMediaEndpoint", capability }]
          : NO_MEDIA_INPUT_EFFECTS,
      };
    }
    case "transient": {
      // 已经落定的终局结论不被瞬时故障翻案：那两档说的是「这个端点做不到」，
      // 与网络抖动无关。
      if (isMediaInputClosed(current.support)) return unchanged(current);
      // 首次失败整体替换状态，同代次其它请求的迟到失败不再影响后续探测。
      if (attemptState !== current) return unchanged(current);
      if (isWithinMediaProbeBackoff(current.nextProbeAt, now)) return unchanged(current);
      const transientFailures: number = Math.min(
        current.transientFailures + 1,
        MEDIA_PROBE_MAX_TRANSIENT_FAILURES
      );
      return {
        next: {
          // **结论一律不动**：端点抖动既不构成能力缺失（unknown 不降级成
          // unsupported），也不推翻已经成功过的事实（supported 不退回 unknown）。
          // 变的只有退避——它挡的是「每条媒体都白付一次下载 + 一整轮 SDK 重试」。
          support: current.support,
          transientFailures,
          nextProbeAt: now + backoffMsFor(transientFailures),
          configGeneration: current.configGeneration,
        },
        effects: NO_MEDIA_INPUT_EFFECTS,
      };
    }
    default:
      // 单份媒体自己的问题（下载失败、格式不合、正文被清空、执行器满载）：
      // 不下模态结论，也不推进退避。
      return unchanged(current);
  }
}
