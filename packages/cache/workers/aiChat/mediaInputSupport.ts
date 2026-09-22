/**
 * Owner: AI Chat Worker。
 *
 * media 模型视觉/语音输入支持度的 holder 与探测登记。四档状态机本身是纯函数，
 * 在 states/mediaInputSupport.ts；本文件只持有状态、执行它给出的效果，并把
 * 「哪一次探测正在进行」这类线程独占的运行态收在一起。
 *
 * 容量恒定：两个模态各一个固定 shape 的状态对象、各最多一个在途探测 Promise，
 * 没有 timer，也没有按媒体增长的表。Worker 崩溃重建或进程重启后 holder 回到
 * null，按当前配置快照从初始状态重新探测——外部端点的能力可能已经恢复。
 * agent.json 热重载替换 media 能力时由 resetMediaInputSupport 进入新配置代次，
 * 旧代次请求迟到的结论不再改写新状态。
 */

import { logger } from "../../../infra/logger";
import { INITIAL_MEDIA_INPUT_STATE } from "../../../consts/aiChat/media";
import {
  isWithinMediaProbeBackoff,
  reduceMediaInputResult,
} from "../../../states/mediaInputSupport";
import type {
  AiTextResult,
  MediaInputCapability,
  MediaInputSupport,
} from "../../../types/aiChat/provider";
import type {
  MediaInputEffect,
  MediaInputTransition,
} from "../../../types/states/mediaInputSupport";
import type { MediaInputModalityState, MediaInputSupportState } from "../../../types/states/mediaInputSupport";

/**
 * 两种模态各自最多一个首次探测 Promise。字段在首次读取时一次性建立，之后只替换
 * 字段值，不增删 shape；Promise 完成后立即清空，因此容量恒为 0..2，不会随媒体数
 * 增长。等待者只观察结论，不另占媒体执行器槽位。Worker 重建时整个 holder 清空。
 */
interface MediaInputProbeState {
  vision: Promise<AiTextResult> | null;
  voice: Promise<AiTextResult> | null;
}

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

/**
 * agent.json 热重载替换 media 能力后调用：两种模态回到未探测状态并进入下一配置
 * 代次，丢弃在途首次探测的登记，新请求按新配置重新探测。旧探测的等待者仍拿到
 * 旧结果，其结论由 recordMediaInputResult 按代次丢弃；旧 Promise 的清理按身份
 * 核对，不会清掉新登记。
 */
export function resetMediaInputSupport(): void {
  const configGeneration: number = supportState().vision.configGeneration + 1;
  mediaInputSupportCache.current = {
    vision: { support: "unknown", transientFailures: 0, nextProbeAt: 0, configGeneration },
    voice: { support: "unknown", transientFailures: 0, nextProbeAt: 0, configGeneration },
  };
  mediaInputProbeCache.current = null;
}

/** 取整张支持表；首次读取时按初始状态一次性建立。 */
function supportState(): MediaInputSupportState {
  return mediaInputSupportCache.current ??= {
    vision: INITIAL_MEDIA_INPUT_STATE,
    voice: INITIAL_MEDIA_INPUT_STATE,
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

/** 读取模态状态；请求接纳时保留此只读对象，完成时用对象身份核对归因代次。 */
export function getMediaInputState(capability: MediaInputCapability): MediaInputModalityState {
  return supportState()[capability];
}

/** 读取一种模态的当前结论；从未尝试时返回 unknown。 */
export function getMediaInputSupport(capability: MediaInputCapability): MediaInputSupport {
  return supportState()[capability].support;
}

/** 判断某模态此刻是否还压在退避里；判据见 states/mediaInputSupport.ts。 */
export function isMediaInputProbeCoolingDown(
  capability: MediaInputCapability,
  now: number
): boolean {
  return isWithinMediaProbeBackoff(getMediaInputState(capability).nextProbeAt, now);
}

/** 执行状态机给出的效果；当前只有 misconfigured 落定那一次的英文诊断。 */
function applyMediaInputEffect(effect: MediaInputEffect): void {
  switch (effect.kind) {
    case "logMisconfiguredMediaEndpoint":
      logger.error(
        `AI media ${effect.capability} input is disabled for this worker: the configured media endpoint reported ` +
        "that the model or API path does not exist (HTTP 404/405). Check the model and base_url of " +
        "$.agent.media in the agent configuration."
      );
      break;
  }
}

/** 单次请求归因输入；状态引用只在请求存活期间保留，不增加 owner 缓存容量。 */
export interface RecordMediaInputResultOptions {
  readonly capability: MediaInputCapability;
  readonly result: AiTextResult;
  readonly attemptState: MediaInputModalityState;
  readonly now?: number;
}

/** 把一次真实调用的结果交给状态机归因，落定新状态并执行它给出的效果。 */
export function recordMediaInputResult({
  capability,
  result,
  attemptState,
  now = Date.now(),
}: RecordMediaInputResultOptions): void {
  const current: MediaInputModalityState = getMediaInputState(capability);
  const transition: MediaInputTransition = reduceMediaInputResult(current, {
    capability,
    result,
    attemptState,
    now,
  });
  for (const effect of transition.effects) applyMediaInputEffect(effect);
  if (transition.next !== current) replaceModalityState(capability, transition.next);
}
