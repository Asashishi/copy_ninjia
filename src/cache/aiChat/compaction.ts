import { createKeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";
import type { KeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";

/** 中期记忆压缩任务的运行时 owner。链和计数都不落盘；同群任务完成后自动
 * 删除。群失效时不能提前删链，否则旧任务与新任务会并发；回复代际负责让
 * 旧结果失效，链仍自然排空。Worker 重建会连同在途任务一起销毁。 */
export const compactionChains: Map<number, Promise<void>> = new Map();
/**
 * 中期记忆压缩的按群串行调度器，与 compactionChains 共享生命周期；
 * Worker 重建后重新创建，空闲群的链由执行器自动删除。
 */
export const compactionRunner: KeyedSerialTaskRunner<number> =
  createKeyedSerialTaskRunner(compactionChains);
/** 每群执行中与排队中的压缩任务数；任务 settle 后递减并在归零时删除。 */
export const compactionPendingCounts: Map<number, number> = new Map();

/** 仅在 Worker 已停止接收任务、或测试隔离时调用。 */
export function resetAiChatCompactionCache(): void {
  compactionChains.clear();
  compactionPendingCounts.clear();
}
