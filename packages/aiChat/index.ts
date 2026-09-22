/** AI 闲聊主线程公开入口；监督生命周期与消息投递分别由所属模块实现。 */
export {
  flushAiMemory,
  initAiChat,
  invalidateAiChat,
  queryAiMood,
  switchAiMood,
  syncAiChatConfig,
  terminateAiChat,
} from "./workerBridge";
export { hydrateAiMemory, hydrateStickerCatalog, resumeAiChat } from "./hydration";
export {
  generateAndSendReply,
  recordChatMedia,
  recordChatMessage,
} from "./messageIngress";
export type { GenerateAndSendReplyParams } from "./messageIngress";
