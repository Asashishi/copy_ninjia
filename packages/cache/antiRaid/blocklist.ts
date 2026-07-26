/** /block 黑名单处置（packages/workers/antiRaid/blocklistEffects.ts）的入群守卫线程侧状态。 */

/**
 * 各群的处置世代。群被停管（/init disable、机器人被移出或撤管理员，都收敛到
 * deactivateChat）时递增：在途的补扫循环每处理一个 id 就比对一次自己捕获的
 * 世代，对不上立即整批放弃——群已经不归本机器人管了，还在那里一个个封人是
 * 越权，而补扫是 O(名单长度) 次请求，跑完可能是几分钟以后的事。
 *
 * 生命周期：只有被停管过的群才会有条目（deactivateChat 时写入），Worker 重建
 * 时随 isolate 一起消失；重建后在途批次由主线程重投，那时世代从 0 重新开始，
 * 与新投递捕获的值一致，不影响判断。
 */
export const blocklistRemovalEpochs: Map<number, number> = new Map();

/** 群停管：让该群所有在途处置在下一次比对时放弃。 */
export function bumpBlocklistRemovalEpoch(chatId: number): void {
  blocklistRemovalEpochs.set(chatId, (blocklistRemovalEpochs.get(chatId) ?? 0) + 1);
}

/** 当前世代；从未停管过的群恒为 0。 */
export function currentBlocklistRemovalEpoch(chatId: number): number {
  return blocklistRemovalEpochs.get(chatId) ?? 0;
}
