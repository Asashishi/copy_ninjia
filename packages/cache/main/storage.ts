import type { StateStore } from "../../infra/storage/statePersistence";
import type { GlobalAssetState, GlobalCopyState } from "../../types/chatState";

/** state 权威存储（packages/infra/storage/stateStore.ts）的内存状态。 */

/**
 * 进程唯一 StateStore 的惰性 holder。首次持久化操作时填充，应用生命周期
 * 结束后对象保持 quiesced 直到进程退出；新进程从空 holder 创建全新 writer。
 */
export const stateStoreHolder: { current: StateStore | null } = { current: null };

/**
 * 全局 copy 权威内存镜像。启动恢复时填充，copy 命令更新；进程重建时从
 * state 主/LKG 副本恢复，容量固定为一个对象。
 */
export const globalCopyState: GlobalCopyState = { copiedUser: null };

/**
 * `state.global.assets` 的主线程权威值：三张内联缩略图与机器人默认头像直链。
 *
 * 启动恢复时从 state 主/LKG 副本填充，紧接着由 infra/storage/stateStore.ts 的
 * seedMissingAssetState 把仍为 undefined 的项补成内置常量并落盘一次；**此后运行期
 * 没有任何写入方**——没有命令改它，换图靠手工编辑 state.json 后重启。容量固定为
 * 四个可选标量，四个字段在创建时一次写齐（哪怕都是 undefined），此后只赋值不增删
 * 键：它是每次 global 状态落盘都要读的长期单例，
 * shape 不该在 loadState 之后再变一次。
 *
 * 字段缺省 = 从没设过，该项回退到代码里的内置常量（见 infra/storage/stateStore.ts
 * 的四个取值函数）。取值函数保留这层兜底而不依赖补齐：补齐只发生在主进程的启动
 * 路径上，单测与任何绕开生命周期的调用都不会经过它。只有主线程读它：内联抽签
 * 渲染与复原头像都跑在主线程，Worker 侧没有镜像。
 */
export const globalAssetState: GlobalAssetState = {
  fortuneThumbnailUrl: undefined,
  probabilityThumbnailUrl: undefined,
  gagThumbnailUrl: undefined,
  qaThumbnailUrl: undefined,
  botDefaultAvatarUrl: undefined,
};
