import type { FlushResult } from "../../consts/lifecycle";

/** Anti-Raid 主线程与 Worker 的 mailbox barrier 等待表。 */
export const pendingAntiRaidBarriers: Map<number, (result: FlushResult) => void> = new Map();
export const antiRaidBarrierSequence: { nextId: number } = { nextId: 1 };
