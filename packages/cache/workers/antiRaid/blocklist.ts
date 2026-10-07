/** owner: workers/antiRaid。/block 黑名单处置（packages/workers/antiRaid/blocklistEffects.ts）的入群守卫线程侧状态。 */

/**
 * 各群的处置世代。群被停管（/init disable、机器人被移出或撤管理员，都收敛到
 * deactivateChat）时递增：在途的补扫循环每处理一个 id 就比对一次自己捕获的
 * 世代，对不上立即整批放弃。
 *
 * 生命周期：只有被停管过的群才会有条目（deactivateChat 时写入），Worker 重建
 * 时随 isolate 一起消失；重建后在途批次由主线程重投，那时世代从 0 重新开始，
 * 与新投递捕获的值一致，不影响判断。
 */
export const blocklistRemovalEpochs: Map<number, number> = new Map();

/**
 * 各群正在执行的黑名单处置任务数。任务注册时递增、settle 时递减；归零后
 * 连同处置世代删除，容量受真实在途群数约束。
 */
export const blocklistRemovalTaskCounts: Map<number, number> = new Map();

/** 群停管：让该群所有在途处置在下一次比对时放弃。 */
export function bumpBlocklistRemovalEpoch(chatId: number): void {
  if ((blocklistRemovalTaskCounts.get(chatId) ?? 0) === 0) {
    blocklistRemovalEpochs.delete(chatId);
    return;
  }
  blocklistRemovalEpochs.set(chatId, (blocklistRemovalEpochs.get(chatId) ?? 0) + 1);
}

/** 当前世代；从未停管过的群恒为 0。 */
export function currentBlocklistRemovalEpoch(chatId: number): number {
  return blocklistRemovalEpochs.get(chatId) ?? 0;
}
