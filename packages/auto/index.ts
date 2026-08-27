/**
 * 自动流程入口：packages/auto/ 下各自动行为处理器（消息自动流水线、复制目标的
 * 表情反应同步）的统一出口，app/registerHandlers.ts 只从这里接线，不直接
 * 触及内部模块。
 */
export { handleIncomingMessageMiddleware } from "./message";
export { handleReaction } from "./reactionSync";
