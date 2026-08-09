/**
 * 广告检测准入判定的输入与决策类型（判定本身见 packages/states/adDetectAdmission.ts，
 * 容器与执行留在 packages/workers/antiRaid/adDetect/queue.ts）。
 */

export interface AdCandidateAdmissionInput {
  /** 清洗、截断并接上隐藏 URL 之后的正文长度；0 表示这条没有可判定内容。 */
  readonly textLength: number;
  /** 发送者是频道马甲（没有「群成员」身份，处置走 banChatSenderChat）。 */
  readonly isChannel: boolean;
  /** Worker 侧管理员缓存**明确**认得这个发送者是本群管理员；缓存冷时为 false。 */
  readonly knownAdmin: boolean;
  /** 本轮去重窗口内这个键刚被判成广告并已发出处置。 */
  readonly recentlyDisposed: boolean;
  /** 主线程投递时这个发送者已经在永久黑名单里（封禁多半还没落地）。 */
  readonly blocked: boolean;
}

export type AdCandidateDecision =
  /** 并进这个发送者的消息串。 */
  | { readonly action: "accept" }
  /** 不参与判定，也不必再做别的。 */
  | { readonly action: "ignore" }
  /** 不参与判定，但要顺手删掉这条：见 states/adDetectAdmission.ts 的说明。 */
  | { readonly action: "deleteStraggler" };

export interface AdRequeueInput {
  /** 这一串里还有序号大于 checkedSeq 的消息，即还有没判过的内容。 */
  readonly hasUncheckedContent: boolean;
  /** 这个键此刻排在队列里。 */
  readonly queued: boolean;
  /** 这个键此刻正在等广告检测 provider 回话。 */
  readonly inFlight: boolean;
  /** 这个键在本轮去重窗口里已经排过一次队。 */
  readonly recentlyEnqueued: boolean;
  /** 去重窗口表当前的键数，用于容量硬顶判定。 */
  readonly dedupWindowSize: number;
}

export type AdRequeueDecision =
  | { readonly action: "enqueue" }
  /** 无需排队：没有新内容，或这个键已经排着/在途/本窗口判过了。 */
  | { readonly action: "skip" }
  | { readonly action: "rejectAtCapacity" };

export interface AdBundleStorageInput {
  /** 这个键已经有一串在待检表里（本次只是并进去，不占新名额）。 */
  readonly alreadyStored: boolean;
  /** 待检表当前的键数。 */
  readonly pendingSize: number;
  /** 去重窗口表当前的键数。 */
  readonly dedupWindowSize: number;
}

export type AdBundleStorageDecision =
  | { readonly action: "store" }
  | { readonly action: "rejectAtCapacity" };

export interface AdDispatchInput {
  /** 此刻正在等广告检测 provider 回话的键数。 */
  readonly inFlight: number;
}

export type AdDispatchDecision =
  | { readonly action: "dispatch" }
  | { readonly action: "saturated" };
