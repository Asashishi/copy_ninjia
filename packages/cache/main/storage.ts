import type { StateStore } from "../../infra/storage/statePersistence";
import type { GlobalAssetState, GlobalCopyState } from "../../types/chatState";

/** owner: main。state 权威存储（packages/infra/storage/stateStore.ts）的内存状态。 */

/**
 * 进程唯一 StateStore 的惰性 holder。首次持久化操作时填充，应用生命周期
 * 结束后对象保持 quiesced 直到进程退出；新进程从空 holder 创建全新 writer。
 */
export const stateStoreHolder: { current: StateStore | null } = { current: null };

/**
 * 全局 copy 权威内存镜像。启动恢复时填充，copy 命令更新；进程重建时从
 * state 主/LKG 副本恢复，容量固定为一个对象。
 *
 * 四个字段在创建时一次写齐（哪怕都是 undefined），此后只赋值不增删键：
 * activeCopyTargetIdIn 跑在每条群消息和每次反应更新上（见
 * infra/storage/stateStore.ts），shape 不该在 /copy 或 loadState 之后再变一次。
 * `JSON.stringify` 丢弃 undefined，因此写齐键不会改变 state.json 的内容。
 * 三元组（copiedUser / copyMode / copyChatId）必须整体写：读取方按
 * `copiedUser === null || copyChatId !== chatId` 判定，拆开写会出现「有目标但
 * 还没记群」的中间态。唯一的两个写入边界是 stateStore.ts 的 adoptCopyTarget 与
 * clearCopyTarget。
 */
export const globalCopyState: GlobalCopyState = {
  lastCopyTime: undefined,
  copiedUser: null,
  copyMode: undefined,
  copyChatId: undefined,
};

/**
 * `state.global.assets` 的主线程权威值：三张内联缩略图、机器人默认头像直链与随机
 * 图片目录。
 *
 * 启动恢复时从 state 主/LKG 副本填充，紧接着由 infra/storage/stateStore.ts 的
 * seedMissingAssetState 把仍为 undefined 的项补成内置常量并落盘一次；**此后运行期
 * 没有任何写入方**——没有命令改它，换图靠手工编辑 state.json 后重启。容量固定为
 * 五个可选标量，五个字段在创建时一次写齐（哪怕都是 undefined），此后只赋值不增删
 * 键：它是每次 global 状态落盘都要读的长期单例，
 * shape 不该在 loadState 之后再变一次。字段的创建顺序就是 state.json 中
 * `global.assets` 的写出顺序，`randomHImageDir` 在首位。
 *
 * 字段缺省 = 从没设过，该项回退到代码里的内置常量（见 infra/storage/stateStore.ts
 * 的五个取值函数）。取值函数保留这层兜底而不依赖补齐：补齐只发生在主进程的启动
 * 路径上，单测与任何绕开生命周期的调用都不会经过它。只有主线程读它：内联抽签
 * 渲染与复原头像都跑在主线程，Worker 侧没有镜像。
 */
export const globalAssetState: GlobalAssetState = {
  randomHImageDir: undefined,
  fortuneThumbnailUrl: undefined,
  probabilityThumbnailUrl: undefined,
  gagThumbnailUrl: undefined,
  botDefaultAvatarUrl: undefined,
};
