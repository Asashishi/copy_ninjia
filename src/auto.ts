/**
 * 自动流程入口：src/auto/ 下各自动行为处理器（消息自动流水线、复制目标的
 * 表情反应同步）的统一出口，index.ts 只从这里接线，不直接触及内部模块。
 */
export { handleIncomingMessage } from "./auto/message";
export { handleReaction } from "./auto/reactionSync";
