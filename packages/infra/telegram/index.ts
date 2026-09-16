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
  banChatMember,
  banChatMemberWithOutcome,
  banChatSenderChat,
  banChatSenderChatWithOutcome,
  copyMessage,
  deleteEphemeralMessageWithOutcome,
  deleteMessage,
  deleteMessageAfter,
  deleteMessages,
  deleteMessageWithOutcome,
  drainPendingMessageDeletions,
  editMessageText,
  isChatMember,
  kickChatMemberWithOutcome,
  muteChatMemberWithOutcome,
  probeChatAdmin,
  probeChatMembership,
  sendAudioWithResult,
  sendChatAction,
  sendEphemeralMessage,
  sendMessage,
  sendMessageWithResult,
  sendPhotoWithResult,
  sendSticker,
  setMessageReaction,
  setMessageReactions,
  unbanChatMemberIfBanned,
  unbanChatSenderChat,
  unmuteChatMemberWithOutcome,
} from "./actions";
export type {
  BanChatMemberOutcome,
  DeleteMessageOutcome,
  KickChatMemberOutcome,
  MuteChatMemberOutcome,
  UnmuteChatMemberOutcome,
} from "./actions";
export { sendCommandMessage } from "./commandMessages";
