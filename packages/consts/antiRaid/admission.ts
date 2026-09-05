import type {
  AdCandidateDecision,
  AdRequeueDecision,
  AdDispatchDecision,
} from "../../types/states/adDetectAdmission";

/** 广告投递准入的共享接纳结果，调用方只读。 */
export const ACCEPT_CANDIDATE: Readonly<AdCandidateDecision> = { action: "accept" };

/** 广告投递准入的共享忽略结果，调用方只读。 */
export const IGNORE_CANDIDATE: Readonly<AdCandidateDecision> = { action: "ignore" };

/** 广告投递准入的频道残留消息删除结果，调用方只读。 */
export const DELETE_STRAGGLER: Readonly<AdCandidateDecision> = { action: "deleteStraggler" };

/** 广告队列准入的共享入队结果，调用方只读。 */
export const ENQUEUE_KEY: Readonly<AdRequeueDecision> = { action: "enqueue" };

/** 广告队列准入的共享跳过结果，调用方只读。 */
export const SKIP_ENQUEUE: Readonly<AdRequeueDecision> = { action: "skip" };

/** 广告派发准入的共享许可结果，调用方只读。 */
export const DISPATCH: Readonly<AdDispatchDecision> = { action: "dispatch" };

/** 广告派发准入的共享满载结果，调用方只读。 */
export const SATURATED: Readonly<AdDispatchDecision> = { action: "saturated" };
