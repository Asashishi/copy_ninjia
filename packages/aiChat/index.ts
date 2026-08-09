/** AI 闲聊主线程公开入口；监督生命周期与消息投递分别由所属模块实现。 */
export {
  flushAiMemory,
  hydrateAiMemory,
  hydrateStickerCatalog,
  initAiChat,
  invalidateAiChat,
  queryAiMood,
  switchAiMood,
  terminateAiChat,
} from "./workerBridge";
export {
  generateAndSendReply,
  recordChatMedia,
  recordChatMessage,
} from "./messageIngress";
export type { GenerateAndSendReplyParams } from "./messageIngress";
