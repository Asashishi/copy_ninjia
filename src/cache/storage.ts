/** 状态持久化（src/infra/storage.ts）的内存状态。 */

/** 串行化落盘的 promise 链尾：保证同一时刻只有一次实际写入 state.json 在途。 */
export const persistChainState: { chain: Promise<void> } = { chain: Promise.resolve() };
