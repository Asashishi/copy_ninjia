/** 热路径性能门禁的场景名与 GC 分档合同。 */

export type HotPathProfileScenarioName =
  | "incoming-message-spine"
  | "ai-media-direct-trigger"
  | "sender-stable-username"
  | "luck-receipt-fast-path"
  | "ai-activity-window"
  | "flood-window-steady"
  | "join-timestamp-window"
  | "mention-facts-plain"
  | "ad-capacity-reject"
  | "identity-permission-read";

/** 按进程可用 CPU 数匹配的热路径 GC 暂停预算。 */
export interface HotPathGcCpuBudget {
  readonly minCpuCount: number;
  readonly maxPausePercent: number;
}
