import type { StateStore } from "../../infra/storage/stateStore";
import type { ChatState, GlobalCopyState, GlobalModelState } from "../../types/chatState";

/** state 权威存储（packages/infra/storage/stateStore.ts）的内存状态。 */

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

/**
 * `state.global.model` 的主线程权威值：生图与闲聊两项各自选定的供应商。
 *
 * 启动恢复时从 state 主/LKG 副本填充，只由 commands/imageModel.ts 与
 * commands/chatModel.ts 写入；容量固定为两个可选标量，进程重建后由 loadState
 * 重新填充。与 globalCopyState 一样是一个直接可变的块，不用 holder 包一层——
 * 它整体不会被替换，只逐字段改。两个字段在创建时就一次写齐（哪怕都是
 * undefined），此后只赋值不增删键：它是每次 currentStateSnapshot 都要读的长期
 * 单例，shape 不该在 loadState 之后再变一次。
 *
 * 字段缺省 = 从没设过，该项跟随 aiChat/provider.ts 的默认选取；它不是「上次是
 * 什么」的缓存。AI 闲聊 Worker 侧的两份只读镜像见
 * cache/workers/aiChat/imageProvider.ts 与 chatProvider.ts。
 */
export const globalModelState: GlobalModelState = { image: undefined, chat: undefined };
