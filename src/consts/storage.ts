import type { ChatState } from "../types";

/** 状态持久化（src/infra/storage.ts）的常量。文件路径见 paths.ts。 */

/**
 * 默认（空）的群聊状态，用于本群从未写过任何状态时的只读查询。
 * 冻结它：这个对象在所有没有状态的群之间共享，若有调用方误对它赋值，
 * 会静默污染所有这些群的查询结果——冻结后误写会直接抛错暴露问题。
 */
export const DEFAULT_CHAT_STATE: Readonly<ChatState> = Object.freeze({});
