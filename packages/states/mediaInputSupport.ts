import {
  MEDIA_PROBE_BACKOFF_BASE_MS,
  MEDIA_PROBE_BACKOFF_MAX_MS,
  MEDIA_PROBE_MAX_TRANSIENT_FAILURES,
  NO_MEDIA_INPUT_EFFECTS,
} from "../consts/aiChat/media";
import { isPendingWithin } from "../libs/clockWindow";
import { cappedExponentialMs } from "../libs/backoff";
import type {
  MediaInputSupport,
} from "../types/aiChat/provider";
import type {
  MediaInputResultEvent,
  MediaInputTransition,
  MediaInputModalityState,
} from "../types/states/mediaInputSupport";

/**
 * media 模型视觉/语音输入支持度的状态机（纯函数，不读时钟、不写缓存、
 * 不记日志）。状态含义与整体设计见 types/aiChat/provider.ts 的
 * MediaInputSupport；holder、探测登记与效果执行在
 * cache/workers/aiChat/mediaInputSupport.ts。
 */

/** 不支持与配置错误都阻止新请求；同配置代次的在途成功仍可恢复支持结论。 */
export function isMediaInputClosed(support: MediaInputSupport): boolean {
  return support === "unsupported" || support === "misconfigured";
}

/** 第 n 次连续瞬时失败对应的退避时长；指数增长并封顶。 */
function backoffMsFor(transientFailures: number): number {
  return cappedExponentialMs(MEDIA_PROBE_BACKOFF_BASE_MS, transientFailures - 1, MEDIA_PROBE_BACKOFF_MAX_MS);
}

/**
 * 判断 nextProbeAt 在 now 时刻是否仍处于退避窗口内。
 *
 * nextProbeAt 比 now 远于 MEDIA_PROBE_BACKOFF_MAX_MS 视为墙钟回拨，直接放行
 * （libs/clockWindow.ts 的 isPendingWithin，口径同 auto/message/triggerPolicy.ts 的冷却处理：
 * 旧时间轴上的冷却点先失效，再从新时间轴重新计时）。
 */
export function isWithinMediaProbeBackoff(nextProbeAt: number, now: number): boolean {
  return isPendingWithin(nextProbeAt, now, MEDIA_PROBE_BACKOFF_MAX_MS);
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
    // 成功即清空失败计数与退避。
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
        // 只在结论落定那一次输出诊断。
        effects: result.mediaFailure === "misconfigured"
          ? [{ kind: "logMisconfiguredMediaEndpoint", capability }]
          : NO_MEDIA_INPUT_EFFECTS,
      };
    }
    case "transient": {
      // 已落定的关闭结论不被瞬时故障改写。
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
          // 结论不动（unknown 不降级成 unsupported，supported 不退回 unknown），
          // 只更新退避。
          support: current.support,
          transientFailures,
          nextProbeAt: now + backoffMsFor(transientFailures),
          configGeneration: current.configGeneration,
        },
        effects: NO_MEDIA_INPUT_EFFECTS,
      };
    }
    default:
      // 单份媒体自己的问题（下载失败、格式不合、正文被清空、执行器满载）
      // 不改变模态结论，也不推进退避。
      return unchanged(current);
  }
}
