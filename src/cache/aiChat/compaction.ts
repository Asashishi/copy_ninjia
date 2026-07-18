/** 中期记忆压缩任务的运行时 owner。链和计数都不落盘；同群任务完成后自动
 * 删除。群失效时不能提前删链，否则旧任务与新任务会并发；回复代际负责让
 * 旧结果失效，链仍自然排空。Worker 重建会连同在途任务一起销毁。 */
export const compactionChains: Map<number, Promise<void>> = new Map();
export const compactionPendingCounts: Map<number, number> = new Map();

/** 仅在 Worker 已停止接收任务、或测试隔离时调用。 */
export function resetAiChatCompactionCache(): void {
  compactionChains.clear();
  compactionPendingCounts.clear();
}
