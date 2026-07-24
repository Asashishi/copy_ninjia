import type { StateStore } from "../infra/storage/stateStore";
import type { ChatState, GlobalCopyState } from "../types/chatState";

/** state 权威存储（src/infra/storage/stateStore.ts）的内存状态。 */

/**
 * 进程唯一 StateStore 的惰性 holder。首次持久化操作时填充，应用生命周期
 * 结束后对象保持 quiesced 直到进程退出；新进程从空 holder 创建全新 writer。
 */
export const stateStoreHolder: { current: StateStore | null } = { current: null };

/**
 * state.json 的群级权威内存镜像。启动恢复时填充，业务变更与退群 teardown
 * 更新或删除；进程重建时从严格校验后的主/LKG 副本恢复，群数量即容量上界。
 */
export const chatStates: Map<number, ChatState> = new Map();

/**
 * 全局 copy 权威内存镜像。启动恢复时填充，copy 命令更新；进程重建时从
 * state 主/LKG 副本恢复，容量固定为一个对象。
 */
export const globalCopyState: GlobalCopyState = { copiedUser: null };
