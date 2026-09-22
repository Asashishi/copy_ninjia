/**
 * Telegram 基础设施的显式公共入口：只重导出现有业务模块经本文件使用的客户端、
 * 常规动作与命令回执符号（`deleteMessageAfter` 供 test/helpers 的临时消息替身
 * 经本文件读取），不持有状态。新代码直接从 `client`、`actions/*`、
 * `commandMessages` 等叶子模块导入（见 docs/cn/03-directory-map.md 的兼容入口约定）。
 */
export {
  logApiError,
  telegramApi,
} from "./client";
export {
  answerCallbackQuery,
  editMessageText,
  sendChatAction,
  sendEphemeralMessage,
  sendMessage,
  sendMessageWithResult,
} from "./actions/messages";
export {
  copyMessage,
  sendAudioWithResult,
  sendPhotoWithResult,
  sendSticker,
} from "./actions/mediaMessages";
export {
  deleteEphemeralMessageWithOutcome,
  deleteMessage,
  deleteMessageAfter,
  deleteMessages,
  deleteMessageWithOutcome,
  drainPendingMessageDeletions,
  setMessageReaction,
  setMessageReactions,
} from "./actions/messageLifecycle";
export type { DeleteMessageOutcome } from "./actions/messageLifecycle";
export {
  banChatMember,
  banChatMemberWithOutcome,
  banChatSenderChat,
  banChatSenderChatWithOutcome,
  kickChatMemberWithOutcome,
  muteChatMemberWithOutcome,
  unbanChatMemberIfBanned,
  unbanChatSenderChat,
  unmuteChatMemberWithOutcome,
} from "./actions/moderation";
export type {
  BanChatMemberOutcome,
  KickChatMemberOutcome,
  MuteChatMemberOutcome,
  UnmuteChatMemberOutcome,
} from "./actions/moderation";
export {
  isChatMember,
  probeChatAdmin,
  probeChatMembership,
} from "./actions/membership";
export { sendCommandMessage } from "./commandMessages";
